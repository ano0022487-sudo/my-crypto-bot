const express = require('express');
const ccxt = require('ccxt');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 初始化 OKX 交易所物件
const exchange = new ccxt.okx({
    apiKey: process.env.OKX_API_KEY,
    secret: process.env.OKX_SECRET_KEY,
    password: process.env.OKX_PASSPHRASE,
    options: {
        defaultType: 'swap' // 永續合約模式
    }
});

// 1. 防休眠機制：讓 UptimeRobot 定期請求
app.get('/', (req, res) => {
    res.status(200).send('Bot is active and running.');
});

// 2. SNR 策略接收端：接收訊號並以 2U 金額下單
app.post('/webhook', async (req, res) => {
    try {
        const { symbol, signal } = req.body;
        
        console.log(`收到訊號: ${signal} on ${symbol}`);

        // 取得最新幣價
        const ticker = await exchange.fetchTicker(symbol);
        const currentPrice = ticker.last;

        // 計算 2U 的對應數量
        const amount = parseFloat((2 / currentPrice).toFixed(4));
        const side = signal === 'BUY' ? 'buy' : 'sell';

        // 執行下單
        const order = await exchange.createOrder(symbol, 'market', side, amount);

        console.log('下單成功:', order.id);
        res.status(200).json({ success: true, orderId: order.id });

    } catch (error) {
        console.error('下單失敗:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Bot server listening on port ${PORT}`);
});
