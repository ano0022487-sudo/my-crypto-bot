const axios = require('axios');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const technicalindicators = require('technicalindicators');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.send('2U 高勝率事件合約機器人持續運作中'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web 伺服器已在連接埠 ${PORT} 啟動，防止 Render 休眠`);
});

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
  if (CONFIG.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    bot.sendMessage(process.env.TELEGRAM_CHAT_ID, text).catch(() => {});
  }
}

function getSignature(timestamp, method, requestPath, body) {
  const message = timestamp + method + requestPath + body;
  return crypto.createHmac('sha256', CONFIG.OKX_SECRET_KEY).update(message).digest('base64');
}

async function getEventInstrument() {
  try {
    const res = await axios.get(`${CONFIG.OKX_BASE_URL}/api/v5/public/instruments?instType=OPTION&uly=BTC-USDT`);
    const instruments = res.data.data;
    if (!instruments || instruments.length === 0) return null;
    return instruments[0].instId;
  } catch (err) {
    console.error('獲取合約代碼失敗', err.message);
    return null;
  }
}

async function placeEventOrder(side, instId) {
  try {
    const method = 'POST';
    const requestPath = '/api/v5/trade/order';
    const bodyObj = {
      instId: instId,
      tdMode: 'cash',
      side: side,
      ordType: 'market',
      sz: '2' // 每筆下單固定 2U 規模
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
    sendLog(`高勝率事件合約 2U 下單成功：${JSON.stringify(response.data)}`);
  } catch (err) {
    sendLog(`下單失敗：${err.response?.data?.msg || err.message}`);
  }
}

async function checkHighWinRateStrategy() {
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

    const sma50 = technicalindicators.SMA.calculate({ values: closes, period: 50 });
    const currentSMA = sma50[sma50.length - 1];

    const rsiValues = technicalindicators.RSI.calculate({ values: closes, period: 14 });
    const currentRSI = rsiValues[rsiValues.length - 1];

    const eventInstId = await getEventInstrument();
    if (!eventInstId) return;

    const isAtSupport = currentPrice <= support * 1.002;
    const isAtResistance = currentPrice >= resistance * 0.998;

    if (currentPrice > currentSMA && isAtSupport && currentRSI < 30) {
      sendLog(`[2U 高勝率訊號] 多頭回踩支撐 現價 $${currentPrice} RSI ${currentRSI.toFixed(1)}`);
      await placeEventOrder('buy', eventInstId);
    } else if (currentPrice < currentSMA && isAtResistance && currentRSI > 70) {
      sendLog(`[2U 高勝率訊號] 空頭反彈阻力 現價 $${currentPrice} RSI ${currentRSI.toFixed(1)}`);
      await placeEventOrder('sell', eventInstId);
    } else {
      console.log(`目前價格 $${currentPrice} 尚未滿足 2U 策略甜蜜點`);
    }

  } catch (err) {
    console.error('策略運算異常', err.message);
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '2U 高勝率事件合約機器人已連線運作中');
});

setInterval(checkHighWinRateStrategy, 15 * 60 * 1000);
checkHighWinRateStrategy();
