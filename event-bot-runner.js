'use strict';

/*
  OKX Event Contract launcher.

  PAPER-ONLY SAFETY MODE:
  - LIVE_TRADING is forcibly disabled at runtime.
  - Telegram polling is disabled; notification-only mode.
  - This runner does not depend on a specific order-sizing function, so it
    remains compatible with the current event-bot.js build.
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

  /* HARD FORCE PAPER MODE.
     This takes precedence over Render's LIVE_TRADING environment variable. */
  process.env.LIVE_TRADING = 'false';

  const livePattern = /const LIVE_TRADING\s*=\s*[^;]+;/;
  if (livePattern.test(code)) {
    code = code.replace(livePattern, 'const LIVE_TRADING=false;');
  } else {
    throw new Error('[Runner] LIVE_TRADING declaration not found; refusing to start');
  }

  /* Disable Telegram long polling to prevent ETELEGRAM 409 conflicts. */
  code = code.replace(/polling\s*:\s*true/g, 'polling: false');

  const versionMatch = code.match(/OKX EVENT CONTRACT SNR BOT - ([^*\n]+)/);
  console.log(`[Runner] event-bot source loaded: ${versionMatch ? versionMatch[1].trim() : 'unknown-version'}`);
  console.log('[Runner] PAPER-ONLY mode forced: LIVE_TRADING=false');
  console.log('[Runner] Telegram polling forced OFF');

  /* Final safety assertion before compiling the bot. */
  if (!code.includes('const LIVE_TRADING=false;')) {
    throw new Error('[Runner] PAPER-ONLY guard failed');
  }

  try {
    const TelegramBot = require('node-telegram-bot-api');
    TelegramBot.prototype.startPolling = async function () {
      console.log('[Telegram] polling disabled; notification-only mode');
      return this;
    };
  } catch (err) {
    console.error('[Runner Telegram Patch Error]', err.message || err);
  }

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
