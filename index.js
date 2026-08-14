const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Telegram Bot 設定
const rawToken = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_TOKEN = rawToken.trim().replace(/['"]+/g, '');
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// OKX API 金鑰設定
const API_KEY = process.env.OK_ACCESS_KEY;
const SECRET_KEY = process.env.OK_ACCESS_SECRET;
const PASSPHRASE = process.env.OKX_PASSPHRASE;
const BASE_URL = 'https://www.okx.com';

// 策略與風控參數 (本金 55U 配置)
const CHECK_INTERVAL = 60000;         // 每 1 分鐘檢查一次
const LEVERAGE = 3;                   // 3 倍槓桿
const STOP_LOSS_PCT = 0.01;           // 1% 止損
const TAKE_PROFIT_PCT = 0.03;         // 3% 止盈
const MARGIN_PER_TRADE = 15;          // 每單保證金 15U

// 最多 20 個主流永續合約幣種
const SYMBOLS = [
    { targetSpot: 'BTC-USDT', swapSymbol: 'BTC-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'ETH-USDT', swapSymbol: 'ETH-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'SOL-USDT', swapSymbol: 'SOL-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'XRP-USDT', swapSymbol: 'XRP-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'DOGE-USDT', swapSymbol: 'DOGE-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'ADA-USDT', swapSymbol: 'ADA-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'AVAX-USDT', swapSymbol: 'AVAX-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'LINK-USDT', swapSymbol: 'LINK-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'DOT-USDT', swapSymbol: 'DOT-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'NEAR-USDT', swapSymbol: 'NEAR-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'LTC-USDT', swapSymbol: 'LTC-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'UNI-USDT', swapSymbol: 'UNI-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'BCH-USDT', swapSymbol: 'BCH-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'ATOM-USDT', swapSymbol: 'ATOM-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'ETC-USDT', swapSymbol: 'ETC-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'FIL-USDT', swapSymbol: 'FIL-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'APT-USDT', swapSymbol: 'APT-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'ARB-USDT', swapSymbol: 'ARB-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'OP-USDT', swapSymbol: 'OP-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
    { targetSpot: 'SUI-USDT', swapSymbol: 'SUI-USDT-SWAP', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } }
];

function generateSignature(timestamp, method, requestPath, body = '') {
    if (!SECRET_KEY) throw new Error('API Secret 未設定');
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
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

// 設定槓桿
async function setLeverage(symbol) {
    try {
        const requestPath = '/api/v5/account/set-leverage';
        const timestamp = new Date().toISOString();
        const bodyData = JSON.stringify({ instId: symbol, lever: LEVERAGE.toString(), mgnMode: 'cross' });
        const signature = generateSignature(timestamp, 'POST', requestPath, bodyData);
        await axiosWithRetry({
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
    } catch (e) {
        // 忽略重複設定錯誤
    }
}

// 簡單均線趨勢判斷
function analyzeTrend(candles) {
    const closes = candles.map(c => parseFloat(c[4]));
    const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
    const current = closes[closes.length - 1];
    return current > sma ? 'BULL' : 'BEAR';
}

// 開倉並發送 Telegram 通知
async function openOrder(item, side, reason, entryPrice) {
    try {
        await setLeverage(item.swapSymbol);
        const requestPath = '/api/v5/trade/order';
        const timestamp = new Date().toISOString();
        
        const positionValue = MARGIN_PER_TRADE * LEVERAGE;
        const sz = (positionValue / entryPrice).toFixed(2);

        const bodyData = JSON.stringify({
            instId: item.swapSymbol,
            tdMode: 'cross',
            side: side,
            ordType: 'market',
            sz: sz > 0 ? sz.toString() : '1'
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
            const sl = side === 'buy' ? entryPrice * (1 - STOP_LOSS_PCT) : entryPrice * (1 + STOP_LOSS_PCT);
            const tp = side === 'buy' ? entryPrice * (1 + TAKE_PROFIT_PCT) : entryPrice * (1 - TAKE_PROFIT_PCT);

            item.position = { active: true, side: side, entryPrice: entryPrice, stopLossPrice: sl, takeProfitPrice: tp };
            
            if (process.env.TELEGRAM_CHAT_ID) {
                bot.sendMessage(process.env.TELEGRAM_CHAT_ID, 
                    `🚀 【多空機器人開倉通知】\n` +
                    `標的：${item.targetSpot}\n` +
                    `方向：${side.toUpperCase()}\n` +
                    `原因：${reason}\n` +
                    `進場價：${entryPrice}\n` +
                    `止損價：${sl.toFixed(2)} | 止盈價：${tp.toFixed(2)}`
                ).catch(() => {});
            }
        }
    } catch (error) {
        console.error('下單失敗:', error.message);
    }
}

// 平倉並發送 Telegram 通知
async function closeOrder(item, reason, currentPrice) {
    try {
        const requestPath = '/api/v5/trade/order';
        const timestamp = new Date().toISOString();
        const closeSide = item.position.side === 'buy' ? 'sell' : 'buy';
        
        const bodyData = JSON.stringify({
            instId: item.swapSymbol,
            tdMode: 'cross',
            side: closeSide,
            ordType: 'market',
            sz: '1'
        });

        const signature = generateSignature(timestamp, 'POST', requestPath, bodyData);
        await axiosWithRetry({
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

        if (process.env.TELEGRAM_CHAT_ID) {
            bot.sendMessage(process.env.TELEGRAM_CHAT_ID, 
                `🛡 【機器人平倉通知】\n` +
                `標的：${item.targetSpot}\n` +
                `方向：${item.position.side.toUpperCase()}\n` +
                `原因：${reason}\n` +
                `現價：${currentPrice}`
            ).catch(() => {});
        }
        item.position = { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 };
    } catch (error) {
        console.error('平倉失敗:', error.message);
    }
}

// 核心多周期檢測與風控邏輯
async function processItem(item) {
    try {
        const [res4h, res15m] = await Promise.all([
            axiosWithRetry({ method: 'GET', url: `${BASE_URL}/api/v5/market/candles?instId=${item.targetSpot}&bar=4h&limit=30` }),
            axiosWithRetry({ method: 'GET', url: `${BASE_URL}/api/v5/market/candles?instId=${item.targetSpot}&bar=15m&limit=30` })
        ]);

        const candles4h = res4h.data.data;
        const candles15m = res15m.data.data;
        if (!candles4h || !candles15m || candles4h.length < 20 || candles15m.length < 20) return;

        const trend4h = analyzeTrend(candles4h);
        const trend15m = analyzeTrend(candles15m);
        const currentClose = parseFloat(candles15m[0][4]);

        // 持倉中的止盈止損監控
        if (item.position.active) {
            if (item.position.side === 'buy') {
                if (currentClose >= item.position.takeProfitPrice) {
                    await closeOrder(item, '多單觸及 3% 止盈', currentClose);
                } else if (currentClose <= item.position.stopLossPrice) {
                    await closeOrder(item, '多單觸及 1% 止損', currentClose);
                }
            } else if (item.position.side === 'sell') {
                if (currentClose <= item.position.takeProfitPrice) {
                    await closeOrder(item, '空單觸及 3% 止盈', currentClose);
                } else if (currentClose >= item.position.stopLossPrice) {
                    await closeOrder(item, '空單觸及 1% 止損', currentClose);
                }
            }
            return;
        }

        // 多空雙向共振進場
        if (trend4h === 'BULL' && trend15m === 'BULL') {
            await openOrder(item, 'buy', '4H與15M同步看多 (雙向做多)', currentClose);
        } else if (trend4h === 'BEAR' && trend15m === 'BEAR') {
            await openOrder(item, 'sell', '4H與15M同步看空 (雙向做空)', currentClose);
        }

    } catch (error) {
        console.error(`策略運算錯誤 (${item.targetSpot}):`, error.message);
    }
}

async function runLoop() {
    for (const item of SYMBOLS) {
        await processItem(item);
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
}

setInterval(runLoop, CHECK_INTERVAL);

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚀 多空雙向智慧交易機器人已成功啟動並連線！');
});

app.get('/', (req, res) => res.status(200).send('Multi-Direction Bot Active with Telegram Notifications.'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
