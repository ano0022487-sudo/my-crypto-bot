'use strict';

// Stable launcher for the OKX Event Contract bot.
// Loads event-bot.js from the project directory so dependencies resolve from
// the project's node_modules.
const fs = require('fs');
const path = require('path');
const Module = require('module');

// The Event bot only sends Telegram notifications; it does not need to
// receive Telegram updates. Disable node-telegram-bot-api polling here so
// Render cannot conflict with another running instance of the same bot token.
// This keeps bot.sendMessage() available while preventing getUpdates calls.
try {
  const TelegramBot = require('node-telegram-bot-api');
  TelegramBot.prototype.startPolling = async function () {
    console.log('[Telegram] polling disabled; notification-only mode');
    return this;
  };
} catch (err) {
  console.error('[Runner Telegram Patch Error]', err.message || err);
}

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) {
    throw new Error(`找不到 event-bot.js: ${source}`);
  }

  const code = fs.readFileSync(source, 'utf8');

  // Compile from the real project directory so require('express'), axios,
  // and node-telegram-bot-api resolve from /opt/render/project/src/node_modules.
  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);

} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
