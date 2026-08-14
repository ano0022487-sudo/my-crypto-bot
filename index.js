const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// 1. 創立一個虛設的 HTTP 服務，讓 Render 掃描 Port 成功
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('OK')).listen(PORT, () => {
  console.log(`Port ${PORT} 已監聽！`);
});

// 2. 你的 Telegram 機器人
const token = 'YOUR_TELEGRAM_BOT_TOKEN'; // 8839544439:AAG0wvZ0QeRWHbZovwCOPNHaRVipTeh6vpM
const bot = new TelegramBot(token, { polling: true });

console.log('Telegram 機器人已順利啟動！');

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '你好！我是你的 OKX 交易機器人，已順利連線囉！');
});
