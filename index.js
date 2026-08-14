const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.TELEGRAM_BOT_TOKEN;
const url = process.env.RENDER_EXTERNAL_URL;
const port = process.env.PORT || 3000;

if (!token) {
  console.error('錯誤：未設定 TELEGRAM_BOT_TOKEN 環境變數！');
  process.exit(1);
}

const app = express();
app.use(express.json());

const bot = new TelegramBot(token);
const webhookPath = `/bot${token}`;

if (url) {
  bot.setWebHook(`${url}${webhookPath}`);
}

app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Crypto Bot 正在運行中！');
});

app.listen(port, () => {
  console.log(`伺服器已啟動，正在監聽 Port ${port}`);
});

// ==================== 交易排程邏輯 ====================

let tradeInterval = null;
let activeChatId = null;

// 執行模擬合約交易的核心函式
function executeContractTrade() {
  const amount = 2; // 固定一次 2U
  console.log(`[自動執行] 正在送出事件合約交易，金額：${amount}U`);

  if (activeChatId) {
    bot.sendMessage(activeChatId, `[自動執行] 已成功下單事件合約，投入金額：${amount}U`);
  }
}

// 監聽 /start 指令
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '加密貨幣機器人已啟動。輸入 /start_trade 開始每 5 分鐘執行 2U 交易，輸入 /stop_trade 停止。');
});

// 啟動每 5 分鐘一次的排程
bot.onText(/\/start_trade/, (msg) => {
  const chatId = msg.chat.id;
  activeChatId = chatId;

  if (tradeInterval) {
    clearInterval(tradeInterval);
  }

  // 設定每 5 分鐘 (300000 毫秒) 執行一次
  tradeInterval = setInterval(executeContractTrade, 5 * 60 * 1000);

  bot.sendMessage(chatId, '已啟動自動事件合約排程：每 5 分鐘執行一次，每次 2U。');
});

// 停止排程
bot.onText(/\/stop_trade/, (msg) => {
  const chatId = msg.chat.id;

  if (tradeInterval) {
    clearInterval(tradeInterval);
    tradeInterval = null;
    bot.sendMessage(chatId, '已停止自動事件合約排程。');
  } else {
    bot.sendMessage(chatId, '目前沒有正在執行的排程。');
  }
});
