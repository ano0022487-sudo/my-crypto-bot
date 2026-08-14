const axios = require('axios');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const technicalindicators = require('technicalindicators');

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  OKX_API_KEY: process.env.OKX_API_KEY,
  OKX_SECRET_KEY: process.env.OKX_SECRET_KEY,
  OKX_PASSPHRASE: process.env.OKX_PASSPHRASE,
  OKX_BASE_URL: 'https://www.okx.com',
  TIMEFRAME: '15m'
};

const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });

function sendLog(text) {
  console.log(text);
  if (CONFIG.TELEGRAM_TOKEN) {
    bot.sendMessage(process.env.TELEGRAM_CHAT_ID || '', text).catch(() => {});
  }
}

function getSignature(timestamp, method, requestPath, body) {
  const message = timestamp + method + requestPath + body;
  return crypto.createHmac('sha256', CONFIG.OKX_SECRET_KEY).update(message).digest('base64');
}

async function placeOkxOrder(side, instId) {
  try {
    const method = 'POST';
    const requestPath = '/api/v5/trade/order';
    const bodyObj = {
      instId: instId,
      tdMode: 'cash',
      side: side,
      ordType: 'market',
      sz: '2'
    };
    const body = JSON.stringify(bodyObj);
    const timestamp = new Date().toISOString();
    const sign = getSignature(timestamp, method, requestPath, body);

    const headers = {
      'OK-ACCESS-KEY': CONFIG.OKX_API_KEY,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': CONFIG.OKX_PASSPHRASE,
      'Content-Type': 'application/json'
    };

    const response = await axios.post(`${CONFIG.OKX_BASE_URL}${requestPath}`, body, { headers });
    sendLog(`下單成功回應：${JSON.stringify(response.data)}`);
  } catch (err) {
    sendLog(`下單失敗：${err.response?.data?.msg || err.message}`);
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
      sendLog(`觸發買入 現價 $${currentPrice} 支撐 $${support} RSI ${currentRSI.toFixed(1)} 金額 2U`);
      await placeOkxOrder('buy', targetInstId);
    } else if (isAtResistance && currentRSI > 65) {
      sendLog(`觸發賣出 現價 $${currentPrice} 阻力 $${resistance} RSI ${currentRSI.toFixed(1)} 金額 2U`);
      await placeOkxOrder('sell', targetInstId);
    } else {
      console.log(`目前價格 $${currentPrice} 未達進場點位`);
    }

  } catch (err) {
    console.error('執行策略發生異常', err.message);
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'OKX 機器人已連線 策略運作中 15m SNR + RSI (每筆 2U)');
});

setInterval(checkSNRAndTrade, 15 * 60 * 1000);
checkSNRAndTrade();
