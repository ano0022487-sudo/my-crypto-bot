const express = require('express');
const ccxt = require('ccxt');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 初始化 Telegram 機器人
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// 初始化 OKX 交易所物件 (改為事件合約模式)
const exchange = new ccxt.okx({
    apiKey: process.env.OKX_API_KEY,
    secret: process.env.OKX_SECRET_KEY,
    password: process.env.OKX_PASSPHRASE,
    options: {
        defaultType: 'events' // 重要：切換為事件合約模式
    }
});

// Telegram 監聽
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '2U 高勝率事件合約機器人已連線運作中');
});

// 防休眠
app.get('/', (req, res) => res.status(200).send('Bot is active.'));

// 接收 TradingView Webhook
app.post('/webhook', async (req, res) => {
    try {
        // symbol 範例: "BTC-USDT-260814-60000-C" (請依照 OKX 事件合約格式填寫)
        const { symbol, signal } = req.body; 
        
        console.log(`收到訊號: ${signal} on ${symbol}`);

        // 事件合約下單參數
        // side: 410 (買漲), 411 (買跌) 等 (需參考 OKX API 文件對應碼)
        // 這裡示範使用 createOrder，但事件合約可能需要透過 params 指定 instType
        const order = await exchange.createOrder(symbol, 'market', signal === 'BUY' ? 'buy' : 'sell', 1, null, {
            'instType': 'EVENTS'
        });

        console.log('事件合約下單成功:', order.id);
        res.status(200).json({ success: true, orderId: order.id });
    } catch (error) {
        console.error('下單失敗:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
