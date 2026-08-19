'use strict';

/*
  OKX Event Contract launcher.
  The trading logic lives in event-bot.js.
  This runner disables Telegram polling and adds a hard runtime guard
  so an unexpected 0.1-contract order can never reach LIVE trading.
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

  code = code.replace(/polling\s*:\s*true/g, 'polling: false');

  const versionMatch = code.match(/OKX EVENT CONTRACT SNR BOT - ([^*\n]+)/);
  console.log(`[Runner] event-bot source loaded: ${versionMatch ? versionMatch[1].trim() : 'unknown-version'}`);

  if (!code.includes('const TARGET_STAKE=5;') || !code.includes('function calcOrderSize(')) {
    throw new Error('[Runner] event-bot.js is not the expected Fixed 5U build');
  }

  /*
    Hard safety guard:
    5U target means the calculated order must represent at least 4.50U.
    A 0.1-contract order is explicitly rejected.
  */
  const sizingPattern = /const sz=calcOrderSize\(px,inst\),actualStake=px\*sz;/;
  if (!sizingPattern.test(code)) {
    throw new Error('[Runner] required order sizing expression not found');
  }

  code = code.replace(
    sizingPattern,
    `const sz=calcOrderSize(px,inst),actualStake=px*sz;console.log('[RUNNER SIZE GUARD]',JSON.stringify({targetStake:5,entryPx:px,contracts:sz,actualStake}));if(!(sz>0.1&&actualStake>=4.5)){throw new Error(\`[RUNNER SIZE GUARD] blocked order: contracts=\${sz}, actualStake=\${actualStake}\`);}`
  );

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
  console.log('[Runner] Hard 5U order-size guard enabled');
  console.log('[Runner] Telegram polling forced OFF');

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
