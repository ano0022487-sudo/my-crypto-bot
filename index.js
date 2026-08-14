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

const CHECK_INTERVAL = 60000;
const ORDER_SIZE = '2';

// 定義雙幣種監控清單與對應合約
const ASSETS = [
    {
        targetSpot: 'BTC-USDT',
        callSymbol: 'BTC-USDT-260814-60000-C',
        putSymbol: 'BTC-USDT-260814-60000-P',
        position: { active: false, symbol: null, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0, highestPrice: 0 }
    },
    {
        targetSpot: 'ETH-USDT',
        callSymbol: 'ETH-USDT-260814-3000-C',
        putSymbol: 'ETH-USDT-260814-3000-P',
        position: { active: false, symbol: null, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0, highestPrice: 0 }
    }
];

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

async function axiosWithRetry(config, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios(config);
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function placeEventOrder(asset, symbol, side, reason, entryPrice, stopLoss, takeProfit) {
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
            
            asset.position = {
                active: true,
                symbol: symbol,
                side: side,
                entryPrice: entryPrice,
                stopLossPrice: stopLoss,
                takeProfitPrice: takeProfit,
                highestPrice: entryPrice
            };

            bot.sendMessage(process.env.TELEGRAM_CHAT_ID || '', 
                `🚀 【多幣種開倉通知】\n標的：${asset.targetSpot} (${symbol})\n條件：${reason}\n進場價：${entryPrice}\n訂單編號：${orderId}`
            ).catch(() => {});
        }
    } catch (error) {
        console.error('下單失敗:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

async function closePosition(asset, reason, currentPrice) {
    try {
        const requestPath = '/api/v5/trade/order';
        const timestamp = new Date().toISOString();
        const closeSide = asset.position.side === 'buy' ? 'sell' : 'buy';

        const bodyData = JSON.stringify({
            instId: asset.position.symbol,
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
                `🛡 【多幣種平倉通知】\n標的：${asset.targetSpot}\n原因：${reason}\n現價：${currentPrice}`
            ).catch(() => {});
        }

        asset.position = { active: false, symbol: null, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0, highestPrice: 0 };
    } catch (error) {
        console.error('平倉失敗:', error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

async function checkAssetStrategy(asset) {
    try {
        const res = await axiosWithRetry({
            method: 'GET',
            url: `${BASE_URL}/api/v5/market/candles?instId=${asset.targetSpot}&bar=1m&limit=30`
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

        console.log(`[${asset.targetSpot}] 現價: ${currentClose} | 阻力: ${resistance} | 支撐: ${support} | RSI: ${rsiValue.toFixed(1)}`);

        if (asset.position.active) {
            if (asset.position.side === 'buy') {
                if (currentClose > asset.position.highestPrice) {
                    asset.position.highestPrice = currentClose;
                    const trailingBuffer = (currentClose - asset.position.entryPrice) * 0.5;
                    if (asset.position.entryPrice + trailingBuffer > asset.position.stopLossPrice) {
                        asset.position.stopLossPrice = asset.position.entryPrice + trailingBuffer;
                    }
                }

                if (currentClose >= asset.position.takeProfitPrice) {
                    await closePosition(asset, `觸及目標止盈價 (${asset.position.takeProfitPrice})`, currentClose);
                } else if (currentClose <= asset.position.stopLossPrice) {
                    await closePosition(asset, `觸及移動停損價 (${asset.position.stopLossPrice.toFixed(2)})`, currentClose);
                }
            }
            return;
        }

        if (currentClose > resistance && rsiValue > 55 && rsiValue < 78) {
            const stopLossPrice = support;
            const risk = currentClose - stopLossPrice;
            const takeProfitPrice = currentClose + (risk * 2);
            await placeEventOrder(asset, asset.callSymbol, 'buy', `SNR 突破 + RSI (${rsiValue.toFixed(1)})`, currentClose, stopLossPrice, takeProfitPrice);
        } 
        else if (currentClose < support && rsiValue < 45 && rsiValue > 22) {
            const stopLossPrice = resistance;
            const risk = stopLossPrice - currentClose;
            const takeProfitPrice = currentClose - (risk * 2);
            await placeEventOrder(asset, asset.putSymbol, 'buy', `SNR 跌破 + RSI (${rsiValue.toFixed(1)})`, currentClose, stopLossPrice, takeProfitPrice);
        }
    } catch (error) {
        console.error(`策略運算錯誤 (${asset.targetSpot}):`, error.message);
    }
}

async function runAllStrategies() {
    for (const asset of ASSETS) {
        await checkAssetStrategy(asset);
    }
}

setInterval(runAllStrategies, CHECK_INTERVAL);

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚀 雙幣種 (BTC + ETH) 智慧機器人已啟動！');
});

app.get('/', (req, res) => res.status(200).send('Multi-Asset Bot Active.'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
