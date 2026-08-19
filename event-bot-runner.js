'use strict';

/*
  OKX Event Contract launcher.
  The trading logic lives in event-bot.js.
  This runner only disables Telegram polling so Render cannot create
  a second getUpdates consumer. It intentionally does not patch trading
  constants or strategy code at runtime.
*/

const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) {
    throw new Error(`找不到 event-bot.js: ${source}`);
  }

  let code = fs.readFileSync(source, 'utf8');

  // Notification-only Telegram mode on Render.
  code = code.replace(/polling\s*:\s*true/g, 'polling: false');

  // Defensive runtime patch in case a future event-bot.js uses startPolling.
  try {
    const TelegramBot = require('node-telegram-bot-api');
    TelegramBot.prototype.startPolling = async function () {
      console.log('[Telegram] polling disabled; notification-only mode');
      return this;
    };
  } catch (err) {
    console.error('[Runner Telegram Patch Error]', err.message || err);
  }

  console.log('[Runner] event-bot.js loaded without strategy patches');
  console.log('[Runner] Telegram polling forced OFF');

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
