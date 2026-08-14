const TelegramBot = require('node-telegram-bot-api');

// 讀取在 Render 設定的 TELEGRAM_BOT_TOKEN
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("錯誤：找不到 TELEGRAM_BOT_TOKEN 環境變數！");
  process.exit(1);
}

// 建立 Telegram Bot
const bot = new TelegramBot(token, { polling: true });

console.log("Telegram 機器人已順利啟動！");

// 當收到任何訊息時回應
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `你好！我是你的 OKX 交易機器人，已順利連線囉！`);
});
