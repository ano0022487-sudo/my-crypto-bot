const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 初始化 Telegram 機器人
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// 機密憑證配置
const API_KEY = process.env.OKX_API_KEY;
const SECRET_KEY = process.env.OKX_SECRET_KEY;
const PASSPHRASE = process.env.OKX_PASSPHRASE;
const BASE_URL = 'https://www.okx.com';

// 交易策略參數配置
const TARGET_SPOT = 'BTC-USDT';               // 策略分析的標的現貨
const EVENT_SYMBOL_CALL = 'BTC-USDT-260814-60000-C'; // 看漲事件合約代碼
const EVENT_SYMBOL_PUT  = 'BTC-USDT-260814-60000-P'; // 看跌事件合約代碼
const CHECK_INTERVAL = 60000;                 // 每 60 秒 (1分鐘) 檢查一次市場
const ORDER_SIZE = '2';                       // 每次下單單位 (固定 2U/張數)

// 產生 OKX V5 API 簽名
function generateSignature(timestamp, method, requestPath, body = '') {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
}

// 發送事件合約訂單至 OKX
async function placeEventOrder(symbol, side, reason) {
    try {
        const requestPath = '/api/v5/trade/order';
        const timestamp = new Date().toISOString();
        
        const bodyData = JSON.stringify({
            instId: symbol,
            tdMode: 'cross',
            side: side,
            ordType: 'market',
            sz: ORDER_SIZE
        });

        const signature = generateSignature(timestamp, 'POST', requestPath, bodyData);
        
        const response = await axios.post(`${BASE_URL}${requestPath}`, bodyData, {
            headers: {
                'OK-ACCESS-KEY': API_KEY,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': PASSPHRASE,
                'Content-Type': 'application/json'
            }
        });

        const resData = response.data;
        console.log(`[下單回應] 觸發原因: ${reason} | 回傳內容:`, JSON.stringify(resData));

        // 透過 Telegram 發送交易成功通知
        if (resData.code === '0') {
            const orderId = resData.data[0].ordId;
            bot.sendMessage(process.env.TELEGRAM_CHAT_ID || '', 
                `🚀 【SNR 自動下單通知】\n觸發訊號：${reason}\n下單方向：${side.toUpperCase()}\n合約標的：${symbol}\n交易數量：${ORDER_SIZE}\n訂單編號：${orderId}`
            ).catch(() => {});
        } else {
            console.error('OKX 拒絕下單:', resData.msg);
        }
    } catch (error) {
        console.error('下單請求失敗:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

// SNR (支撐與阻力) 策略核心演算法
async function checkSNRStrategy() {
    try {
        // 抓取近 20 根 1 分鐘 K 線
        const res = await axios.get(`${BASE_URL}/api/v5/market/candles?instId=${TARGET_SPOT}&bar=1m&limit=20`);
        const candles = res.data.data;

        if (!candles || candles.length < 20) {
            console.log('K 線數據缺乏，跳過本次檢查');
            return;
        }

        // 解析歷史最高價、最低價與最新收盤價 (OKX 格式: [ts, open, high, low, close, ...])
        const highs = candles.map(c => parseFloat(c[2]));
        const lows = candles.map(c => parseFloat(c[3]));
        const currentClose = parseFloat(candles[0][4]);

        // 排除最新未完成之 K 線，計算前 19 根 K 線之阻力位 (Resistance) 與支撐位 (Support)
        const resistance = Math.max(...highs.slice(1));
        const support = Math.min(...lows.slice(1));

        console.log(`[SNR 輪詢監控] 現價: ${currentClose} | 阻力位(高點): ${resistance} | 支撐位(低點): ${support}`);

        // 突破阻力位：觸發看漲事件合約買入
        if (currentClose > resistance) {
            console.log('▶ 突破 Resistance 阻力位，觸發買漲指令');
            await placeEventOrder(EVENT_SYMBOL_CALL, 'buy', `突破阻力位 ${resistance}`);
        } 
        // 跌破支撐位：觸發看跌事件合約買入
        else if (currentClose < support) {
            console.log('▶ 跌破 Support 支撐位，觸發買跌指令');
            await placeEventOrder(EVENT_SYMBOL_PUT, 'buy', `跌破支撐位 ${support}`);
        }
    } catch (error) {
        console.error('SNR 策略計算發生錯誤:', error.message);
    }
}

// 啟動背景定時任務 (自動抓取價格並進行 SNR 判定)
setInterval(checkSNRStrategy, CHECK_INTERVAL);

// Telegram 互動指令
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '2U SNR 高勝率事件合約機器人已順利啟動運作中！');
});

// 防休眠與健康檢查端點 (Keep-Alive Endpoint)
app.get('/', (req, res) => {
    res.status(200).send('2U Event Contract Bot running with SNR strategy.');
});

// 手動測試 Webhook 端點 (備用)
app.post('/webhook', async (req, res) => {
    console.log('收到外部 Webhook 觸發:', req.body);
    res.status(200).json({ success: true, message: 'Webhook received' });
});

app.listen(PORT, () => {
    console.log(`伺服器運作中，通訊埠: ${PORT}`);
});
