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

// 追蹤當前持倉狀態、移動停損與目標價
let currentPosition = {
    active: false,
    symbol: null,
    side: null,
    entryPrice: 0,
    stopLossPrice: 0,
    takeProfitPrice: 0,
    highestPrice: 0 // 用於追蹤移動停損的最高現價
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

// 帶重試機制的 API 請求包裝函式
async function axiosWithRetry(config, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios(config);
        } catch (error) {
            if (i === retries - 1) throw error;
            console.warn(`API 請求失敗，進行第 ${i + 1} 次重試... 錯誤: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
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
        const response = await axiosWithRetry({
            method: 'POST',
            url: `${BASE_URL}${requestPath}`,
            data: bodyData,
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
            
            currentPosition = {
                active: true,
                symbol: symbol,
                side: side,
                entryPrice: entryPrice,
                stopLossPrice: stopLoss,
                takeProfitPrice: takeProfit,
                highestPrice: entryPrice
            };

            bot.sendMessage(process.env.TELEGRAM_CHAT_ID || '', 
                `🚀 【終極版開倉通知】\n條件：${reason}\n標的：${symbol}\n進場價：${entryPrice}\n初始止損：${stopLoss}\n目標止盈：${takeProfit}\n訂單編號：${orderId}`
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
        const response = await axiosWithRetry({
            method: 'POST',
            url: `${BASE_URL}${requestPath}`,
            data: bodyData,
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
                `🛡 【終極版平倉通知】\n原因：${reason}\n標的：${currentPosition.symbol}\n現價：${currentPrice}`
            ).catch(() => {});
        }

        currentPosition = { active: false, symbol: null, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0, highestPrice: 0 };
    } catch (error) {
        console.error('平倉失敗:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

async function checkOptimizedStrategy() {
    try {
        const res = await axiosWithRetry({
            method: 'GET',
            url: `${BASE_URL}/api/v5/market/candles?instId=${TARGET_SPOT}&bar=1m&limit=30`
        });
        const candles = res.data.data;

        if (!candles || candles.length < 30) return;

        const highs = candles.map(c => parseFloat(c[2]));
        const lows = candles.map(c => parseFloat(c[3]));
        const closes = candles.map(c => parseFloat(c[4])).reverse();
        const currentClose = parseFloat(candles[0][4]);

        const resistance = Math.max(...highs.slice(1, 20));
        const support = Math.min(...lows.slice(1, 20));
        const rsiValue = calculateRSI(closes, 14);

        console.log(`[終極監控] 現價: ${currentClose} | 阻力: ${resistance} | 支撐: ${support} | RSI: ${rsiValue.toFixed(1)}`);

        // 持倉中的動態移動停損與停利監控
        if (currentPosition.active) {
            if (currentPosition.side === 'buy') {
                // 更新最高價以實現移動停損
                if (currentClose > currentPosition.highestPrice) {
                    currentPosition.highestPrice = currentClose;
                    // 當獲利擴大時，將止損線往上拉高（鎖住利潤）
                    const trailingBuffer = (currentClose - currentPosition.entryPrice) * 0.5;
                    if (currentPosition.entryPrice + trailingBuffer > currentPosition.stopLossPrice) {
                        currentPosition.stopLossPrice = currentPosition.entryPrice + trailingBuffer;
                        console.log(`📈 觸發移動停損上調，新止損價: ${currentPosition.stopLossPrice.toFixed(2)}`);
                    }
                }

                if (currentClose >= currentPosition.takeProfitPrice) {
                    await closePosition(`觸及目標止盈價 (${currentPosition.takeProfitPrice})`, currentClose);
                } else if (currentClose <= currentPosition.stopLossPrice) {
                    await closePosition(`觸及移動停損/止損價 (${currentPosition.stopLossPrice.toFixed(2)})`, currentClose);
                }
            }
            return;
        }

        // 開倉條件
        if (currentClose > resistance && rsiValue > 55 && rsiValue < 78) {
            const stopLossPrice = support;
            const risk = currentClose - stopLossPrice;
            const takeProfitPrice = currentClose + (risk * 2); // 放大至 2 倍報酬比
            
            await placeEventOrder(EVENT_SYMBOL_CALL, 'buy', `SNR 突破 + RSI (${rsiValue.toFixed(1)})`, currentClose, stopLossPrice, takeProfitPrice);
        } 
        else if (currentClose < support && rsiValue < 45 && rsiValue > 22) {
            const stopLossPrice = resistance;
            const risk = stopLossPrice - currentClose;
            const takeProfitPrice = currentClose - (risk * 2);
            
            await placeEventOrder(EVENT_SYMBOL_PUT, 'buy', `SNR 跌破 + RSI (${rsiValue.toFixed(1)})`, currentClose, stopLossPrice, takeProfitPrice);
        }
    } catch (error) {
        console.error('策略運算錯誤:', error.message);
    }
}

setInterval(checkOptimizedStrategy, CHECK_INTERVAL);

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚀 終極完整版機器人（含移動停損與防斷線重試）已啟動！');
});

app.get('/', (req, res) => res.status(200).send('Ultimate Bot Active.'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
