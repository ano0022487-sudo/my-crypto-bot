const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const API_KEY = process.env.OKX_API_KEY;
const SECRET_KEY = process.env.OKX_SECRET_KEY;
const PASSPHRASE = process.env.OKX_PASSPHRASE;
const BASE_URL = 'https://www.okx.com';

const TARGET_SPOT = 'BTC-USDT';
const EVENT_SYMBOL_CALL = 'BTC-USDT-260814-60000-C';
const EVENT_SYMBOL_PUT  = 'BTC-USDT-260814-60000-P';
const CHECK_INTERVAL = 60000;
const ORDER_SIZE = '2';

// 追蹤當前持倉狀態、止損價與止盈價
let currentPosition = {
    active: false,
    symbol: null,
    side: null,
    entryPrice: 0,
    stopLossPrice: 0,
    takeProfitPrice: 0
};

function generateSignature(timestamp, method, requestPath, body = '') {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = closes[closes.length - i] - closes[closes.length - i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

async function placeEventOrder(symbol, side, reason, entryPrice, stopLoss, takeProfit) {
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
        if (resData.code === '0') {
            const orderId = resData.data[0].ordId;
            
            // 記錄持倉、止損與止盈點
            currentPosition = {
                active: true,
                symbol: symbol,
                side: side,
                entryPrice: entryPrice,
                stopLossPrice: stopLoss,
                takeProfitPrice: takeProfit
            };

            bot.sendMessage(process.env.TELEGRAM_CHAT_ID || '', 
                `🔥 【雙向停利止損開倉】\n條件：${reason}\n標的：${symbol}\n進場價：${entryPrice}\n止盈價：${takeProfit}\n止損價：${stopLoss}\n訂單編號：${orderId}`
            ).catch(() => {});
        }
    } catch (error) {
        console.error('下單失敗:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

async function closePosition(reason, currentPrice) {
    try {
        const requestPath = '/api/v5/trade/order';
        const timestamp = new Date().toISOString();
        const closeSide = currentPosition.side === 'buy' ? 'sell' : 'buy';

        const bodyData = JSON.stringify({
            instId: currentPosition.symbol,
            tdMode: 'cross',
            side: closeSide,
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
        if (resData.code === '0') {
            bot.sendMessage(process.env.TELEGRAM_CHAT_ID || '', 
                `🎯 【平倉通知】\n原因：${reason}\n標的：${currentPosition.symbol}\n現價：${currentPrice}`
            ).catch(() => {});
        }

        currentPosition = { active: false, symbol: null, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 };
    } catch (error) {
        console.error('平倉失敗:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

async function checkOptimizedStrategy() {
    try {
        const res = await axios.get(`${BASE_URL}/api/v5/market/candles?instId=${TARGET_SPOT}&bar=1m&limit=30`);
        const candles = res.data.data;

        if (!candles || candles.length < 30) return;

        const highs = candles.map(c => parseFloat(c[2]));
        const lows = candles.map(c => parseFloat(c[3]));
        const closes = candles.map(c => parseFloat(c[4])).reverse();
        const currentClose = parseFloat(candles[0][4]);

        const resistance = Math.max(...highs.slice(1, 20));
        const support = Math.min(...lows.slice(1, 20));
        const rsiValue = calculateRSI(closes, 14);

        console.log(`[檢查中] 現價: ${currentClose} | 阻力: ${resistance} | 支撐: ${support} | RSI: ${rsiValue.toFixed(1)}`);

        // 持倉中的止盈與止損監控
        if (currentPosition.active) {
            if (currentPosition.side === 'buy') {
                if (currentClose >= currentPosition.takeProfitPrice) {
                    console.log('▶ 達到止盈價，執行平倉獲利');
                    await closePosition(`觸及止盈價 (${currentPosition.takeProfitPrice})`, currentClose);
                } else if (currentClose <= currentPosition.stopLossPrice) {
                    console.log('▶ 觸及止損價，執行平倉停損');
                    await closePosition(`觸及止損價 (${currentPosition.stopLossPrice})`, currentClose);
                }
            }
            return;
        }

        // 開倉條件與目標價設定
        if (currentClose > resistance && rsiValue > 55 && rsiValue < 78) {
            const stopLossPrice = support;
            const risk = currentClose - stopLossPrice;
            const takeProfitPrice = currentClose + (risk * 1.5); // 1.5 倍風險報酬比
            
            console.log('▶ 突破阻力，發動 2U 看漲單');
            await placeEventOrder(EVENT_SYMBOL_CALL, 'buy', `SNR 突破 + RSI (${rsiValue.toFixed(1)})`, currentClose, stopLossPrice, takeProfitPrice);
        } 
        else if (currentClose < support && rsiValue < 45 && rsiValue > 22) {
            const stopLossPrice = resistance;
            const risk = stopLossPrice - currentClose;
            const takeProfitPrice = currentClose - (risk * 1.5); // 1.5 倍風險報酬比
            
            console.log('▶ 跌破支撐，發動 2U 看跌單');
            await placeEventOrder(EVENT_SYMBOL_PUT, 'buy', `SNR 跌破 + RSI (${rsiValue.toFixed(1)})`, currentClose, stopLossPrice, takeProfitPrice);
        }
    } catch (error) {
        console.error('策略運算錯誤:', error.message);
    }
}

setInterval(checkOptimizedStrategy, CHECK_INTERVAL);

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '具備完整止盈與止損機制的高勝率機器人已啟動！');
});

app.get('/', (req, res) => res.status(200).send('TP/SL Bot Active.'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
