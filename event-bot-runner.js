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

  // Runtime marker: confirms Render is executing the current event-bot.js.
  const versionMatch = code.match(/OKX EVENT CONTRACT SNR BOT - ([^*\n]+)/);
  console.log(`[Runner] event-bot source loaded: ${versionMatch ? versionMatch[1].trim() : 'unknown-version'}`);

  // Hard safety check: the deployed source must contain the fixed 5U sizing logic.
  if (!code.includes('const TARGET_STAKE=5;') || !code.includes('function calcOrderSize(')) {
    throw new Error('[Runner] event-bot.js is not the expected Fixed 5U build');
  }

  // Notification-only Telegram mode on Render.
  try {
    const TelegramBot = require('node-telegram-bot-api');
    TelegramBot.prototype.startPolling = async function () {
      console.log('[Telegram] polling disabled; notification-only mode');
      return this;
    };
  } catch (err) {
    console.error('[Runner Telegram Patch Error]', err.message || err);
  }

  console.log('[Runner] Fixed 5U build verified');
  console.log('[Runner] Telegram polling forced OFF');

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
