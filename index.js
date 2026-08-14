const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const technicalindicators = require('technicalindicators');

// ==================== 1. 環境變數驗證 ====================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OKX_API_KEY = process.env.OKX_API_KEY;
const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY;
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE;

if (!TELEGRAM_TOKEN || !OKX_API_KEY || !OKX_SECRET_KEY || !OKX_PASSPHRASE) {
    console.error('❌ 錯誤：未檢測到完整環境變數！');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
let MY_CHAT_ID = null;

// ==================== 2. 安全交易參數設定 (單筆 2U) ====================
const CONFIG = {
    BASE_SYMBOL: 'BTC-USDT',
    TIMEFRAME: '15m',
    TRADE_AMOUNT_USDT: 2,   // 已設定為單筆 2 USDT
    OKX_BASE_URL: 'https://www.okx.com',
};

// ==================== 3. OKX V5 API 簽名生成器 ====================
function getOkxHeader(method, requestPath, body = '') {
    const timestamp = new Date().toISOString();
    const message = timestamp + method + requestPath + body;
    const hmac = crypto.createHmac('sha256', OKX_SECRET_KEY);
    const signature = hmac.update(message).digest('base64');

    return {
        'OK-ACCESS-KEY': OKX_API_KEY,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
        'Content-Type': 'application/json',
    };
}

// ==================== 4. Telegram 監聽與通知 ====================
bot.onText(/\/start/, (msg) => {
    MY_CHAT_ID = msg.chat.id;
    const welcomeMsg = `🤖 **[OKX 事件合約自動交易機器人]**\n\n` +
                       `✅ 系統狀態：熱運作中\n` +
                       `💵 單筆下單：${CONFIG.TRADE_AMOUNT_USDT} USDT (55U 本金防護模式)\n` +
                       `📊 策略指標：SNR 支撐阻力 + RSI 雙重對照\n\n` +
                       `每 15 分鐘將自動進行市場掃描與觸發下單！`;
    bot.sendMessage(MY_CHAT_ID, welcomeMsg, { parse_mode: 'Markdown' });
});

function sendLog(msg) {
    console.log(msg);
    if (MY_CHAT_ID) {
        bot.sendMessage(MY_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(err => console.error(err.message));
    }
}

// ==================== 5. 下單執行：OKX 事件合約 API ====================
async function placeEventContractOrder(side, targetInstId) {
    const requestPath = '/api/v5/trade/order';
    const url = CONFIG.OKX_BASE_URL + requestPath;
    
    const bodyData = {
        instId: targetInstId,
        tdMode: 'cash',
        side: side,
        ordType: 'market',
        sz: CONFIG.TRADE_AMOUNT_USDT.toString()
    };

    const bodyString = JSON.stringify(bodyData);
    const headers = getOkxHeader('POST', requestPath, bodyString);

    try {
        const response = await axios.post(url, bodyData, { headers });
        if (response.data && response.data.code === '0') {
            sendLog(`✅ **[事件合約下單成功]**\n合約：\`${targetInstId}\`\n方向：${side.toUpperCase()}\n投入金額：${CONFIG.TRADE_AMOUNT_USDT} USDT`);
        } else {
            sendLog(`❌ **[事件合約下單失敗]**\n錯誤碼：${response.data.code}\n訊息：${response.data.msg}`);
        }
    } catch (error) {
        sendLog(`⚠️ **[API 連線異常]**：${error.message}`);
    }
}

// ==================== 6. SNR + RSI 分析核心 ====================
async function checkSNRAndTrade() {
    try {
        // 🟢 正確寫法：抓取 BTC-USDT 的永續合約 (SWAP)
const eventInstUrl = `${CONFIG.OKX_BASE_URL}/api/v5/public/instruments?instType=SWAP&instId=BTC-USDT-SWAP`;
const eventRes = await axios.get(eventInstUrl);
const activeEvents = eventRes.data.data;

if (!activeEvents || activeEvents.length === 0) return;
const targetInstId = 'BTC-USDT-SWAP'; // 直接鎖定永續合約代碼
        const res = await axios.get(klineUrl);
        const rawData = res.data.data;
        if (!rawData || rawData.length < 50) return;

        const candles = rawData.reverse();
        const closes = candles.map(c => parseFloat(c[4]));
        const highs = candles.map(c => parseFloat(c[1]));
        const lows = candles.map(c => parseFloat(c[2]));
        const currentPrice = closes[closes.length - 1];

        const pastHighs = highs.slice(-51, -1);
        const pastLows = lows.slice(-51, -1);
        const resistance = Math.max(...pastHighs);
        const support = Math.min(...pastLows);

        const rsiValues = technicalindicators.RSI.calculate({ values: closes, period: 14 });
        const currentRSI = rsiValues[rsiValues.length - 1];

        const isAtSupport = currentPrice <= support * 1.002;
        const isAtResistance = currentPrice >= resistance * 0.998;

        const eventInstUrl = `${CONFIG.OKX_BASE_URL}/api/v5/public/instruments?instType=ANY&instFamily=${CONFIG.BASE_SYMBOL}`;
        const eventRes = await axios.get(eventInstUrl);
        const activeEvents = eventRes.data.data;

        if (!activeEvents || activeEvents.length === 0) return;
        const targetInstId = activeEvents[0].instId;

        // 🟢 看漲觸發
        if (isAtSupport && currentRSI < 35) {
            sendLog(`🟢 **[觸發看漲事件合約 (Buy)]**\n現價：$${currentPrice} | 支撐：$${support}\nRSI：${currentRSI.toFixed(1)}\n單筆下單：${CONFIG.TRADE_AMOUNT_USDT} USDT`);
            await placeEventContractOrder('buy', targetInstId);
        }
        // 🔴 看跌觸發
        else if (isAtResistance && currentRSI > 65) {
            sendLog(`🔴 **[觸發看跌事件合約 (Sell)]**\n現價：$${currentPrice} | 阻力：$${resistance}\nRSI：${currentRSI.toFixed(1)}\n單筆下單：${CONFIG.TRADE_AMOUNT_USDT} USDT`);
            await placeEventContractOrder('sell', targetInstId);
        }

    } catch (err) {
        console.error('執行策略發生異常：', err.message);
    }
}

setInterval(checkSNRAndTrade, 15 * 60 * 1000);
checkSNRAndTrade();
