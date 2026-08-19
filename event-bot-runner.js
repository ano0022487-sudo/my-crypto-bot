'use strict';

/*
  OKX Event Contract launcher.

  PAPER-ONLY SAFETY MODE:
  - LIVE_TRADING is forcibly disabled at runtime.
  - Telegram polling is disabled; notification-only mode.
  - This runner does not depend on a specific order-sizing function, so it
    remains compatible with the current event-bot.js build.
  - Adds a read-only /stats endpoint for paper-trade statistics.
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

  /* Read-only paper statistics endpoint. */
  const statsRoute = "app.get('/stats',(req,res)=>{try{const trades=Array.isArray(state.trades)?state.trades:[];const wins=trades.filter(t=>Number(t.pnl)>0).length;const losses=trades.filter(t=>Number(t.pnl)<0).length;const pnl=trades.reduce((s,t)=>s+Number(t.pnl||0),0);const grossWin=trades.filter(t=>Number(t.pnl)>0).reduce((s,t)=>s+Number(t.pnl),0);const grossLoss=trades.filter(t=>Number(t.pnl)<0).reduce((s,t)=>s+Number(t.pnl),0);res.json({ok:true,mode:'PAPER',day:state.day,startCapital:Number(state.startEquity||0),paperEquity:Number(state.paperEquity||0),realizedPnl:Number(state.realizedPnl||pnl),tradeCount:trades.length,wins,losses,winRate:trades.length?wins/trades.length:0,grossWin,grossLoss,avgWin:wins?grossWin/wins:0,avgLoss:losses?grossLoss/losses:0,consecutiveLosses:Number(state.consecutiveLosses||0),halted:Boolean(state.halted),openPosition:Boolean(state.position),trades});}catch(e){res.status(500).json({ok:false,error:e.message});}});";
  const healthPattern = /app\.get\('\/health'/;
  if (healthPattern.test(code)) {
    code = code.replace(healthPattern, statsRoute + "app.get('/health'");
  } else {
    throw new Error('[Runner] /health route not found; refusing to inject /stats');
  }

  const versionMatch = code.match(/OKX EVENT CONTRACT SNR BOT - ([^*\n]+)/);
  console.log(`[Runner] event-bot source loaded: ${versionMatch ? versionMatch[1].trim() : 'unknown-version'}`);
  console.log('[Runner] PAPER-ONLY mode forced: LIVE_TRADING=false');
  console.log('[Runner] Telegram polling forced OFF');
  console.log('[Runner] /stats endpoint injected for paper-trade analysis');

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
