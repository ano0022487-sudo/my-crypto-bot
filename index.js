const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const technicalindicators = require('technicalindicators');

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

const CONFIG = {
  BASE_SYMBOL: 'BTC-USDT',
  TIMEFRAME: '15m',
  TRADE_AMOUNT_USDT: 2,
  OKX_BASE_URL: 'https://www.okx.com',
};

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

bot.onText(/\/start/, (msg) => {
  MY_CHAT_ID = msg.chat.id;
  bot.sendMessage(MY_CHAT_ID, '🤖 **[OKX 機器人已連線]**\n策略運作中：15m SNR + RSI', { parse_mode: 'Markdown' });
});

function sendLog(msg) {
  console.log(msg);
  if (MY_CHAT_ID) {
    bot.sendMessage(MY_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(err => console.error(err.message));
  }
}

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
      sendLog(`✅ **[下單成功]** 標的：\`${targetInstId}\` | 方向：${side.toUpperCase()} | 金額：${CONFIG.TRADE_AMOUNT_USDT} USDT`);
    } else {
      sendLog(`❌ **[下單失敗]** 錯誤碼：${response.data.code} 訊息：${response.data.msg}`);
    }
  } catch (error) {
    sendLog(`⚠️ **[API 異常]**：${error.message}`);
  }
}

async function checkSNRAndTrade() {
  try {
    const targetInstId = 'BTC-USDT-SWAP';
    const klineUrl = `${CONFIG.OKX_BASE_URL}/api/v5/market/candles?instId=${targetInstId}&bar=${CONFIG.TIMEFRAME}&limit=100`;
    
    const res = await axios.get(klineUrl);
    const rawData = res.data.data;
    if (!rawData || rawData.length < 50) return;

    const candles = rawData.reverse();
    const closes = candles.map(c => parseFloat(c[4]));
    const highs = candles.map(c => parseFloat(c[1]));
    const lows = candles.map(c => parseFloat(c[2]));

    const currentPrice = closes[closes.length - 1];
    const resistance = Math.max(...highs.slice(-51, -1));
    const support = Math.min(...lows.slice(-51, -1));

    const rsiValues = technicalindicators.RSI.calculate({ values: closes, period: 14 });
    const currentRSI = rsiValues[rsiValues.length - 1];

    const isAtSupport = currentPrice <= support * 1.002;
    const isAtResistance = currentPrice >= resistance * 0.998;

    if (isAtSupport && currentRSI < 35) {
      sendLog(`🟢 **[觸發買入]** 現價：$${currentPrice} | 支撐：$${support} | RSI：${currentRSI.toFixed(1)}`);
      await placeEventContractOrder('buy', targetInstId);
    } else if (isAtResistance && currentRSI > 65) {
      sendLog(`🔴 **[觸發賣出]** 現價：$${currentPrice} | 阻力：$${resistance} | RSI：${currentRSI.toFixed(1)}`);
      await placeEventContractOrder('sell', targetInstId);
    } else {
      console.log(`☕ 目前價格 $${currentPrice} 未達進場點位...`);
    }

  } catch (err) {
    console.error('執行策略發生異常：', err.message);
  }
}

setInterval(checkSNRAndTrade, 15 * 60 * 1000);
checkSNRAndTrade();
