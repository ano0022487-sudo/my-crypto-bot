'use strict';

/*
  OKX Event Contract launcher.

  PAPER-ONLY SAFETY MODE:
  - LIVE_TRADING is forcibly disabled at runtime.
  - Telegram polling is enabled only for commands/notifications.
  - Only the configured TELEGRAM_CHAT_ID may use /stats.
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

  /* Enable Telegram polling so the bot can receive /stats commands. */
  code = code.replace(/polling\s*:\s*true/g, 'polling: true');

  /* Read-only paper statistics endpoint. */
  const statsRoute = "app.get('/stats',(req,res)=>{try{const trades=Array.isArray(state.trades)?state.trades:[];const wins=trades.filter(t=>Number(t.pnl)>0).length;const losses=trades.filter(t=>Number(t.pnl)<0).length;const pnl=trades.reduce((s,t)=>s+Number(t.pnl||0),0);const grossWin=trades.filter(t=>Number(t.pnl)>0).reduce((s,t)=>s+Number(t.pnl),0);const grossLoss=trades.filter(t=>Number(t.pnl)<0).reduce((s,t)=>s+Number(t.pnl),0);res.json({ok:true,mode:'PAPER',day:state.day,startCapital:Number(state.startEquity||0),paperEquity:Number(state.paperEquity||0),realizedPnl:Number(state.realizedPnl||pnl),tradeCount:trades.length,wins,losses,winRate:trades.length?wins/trades.length:0,grossWin,grossLoss,avgWin:wins?grossWin/wins:0,avgLoss:losses?grossLoss/losses:0,consecutiveLosses:Number(state.consecutiveLosses||0),halted:Boolean(state.halted),openPosition:Boolean(state.position),trades});}catch(e){res.status(500).json({ok:false,error:e.message});}});";
  const healthPattern = /app\.get\('\/health'/;
  if (healthPattern.test(code)) {
    code = code.replace(healthPattern, statsRoute + "app.get('/health'");
  } else {
    throw new Error('[Runner] /health route not found; refusing to inject /stats');
  }

  /* Telegram /stats command. Read-only: it cannot place or cancel orders. */
  const telegramStatsHandler = `
if (bot) {
  bot.onText(/^\\/stats(?:@\\w+)?$/i, async (msg) => {
    try {
      const configuredChat = String(process.env.TELEGRAM_CHAT_ID || '').trim();
      const chatId = String(msg.chat.id);
      if (!configuredChat || chatId !== configuredChat) return;

      const trades = Array.isArray(state.trades) ? state.trades : [];
      const wins = trades.filter(t => Number(t.pnl) > 0).length;
      const losses = trades.filter(t => Number(t.pnl) < 0).length;
      const pnl = trades.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
      const grossWin = trades.filter(t => Number(t.pnl) > 0).reduce((sum, t) => sum + Number(t.pnl), 0);
      const grossLoss = trades.filter(t => Number(t.pnl) < 0).reduce((sum, t) => sum + Number(t.pnl), 0);
      const winRate = trades.length ? wins / trades.length * 100 : 0;
      const avgWin = wins ? grossWin / wins : 0;
      const avgLoss = losses ? grossLoss / losses : 0;
      const equity = Number(state.paperEquity || 0);
      const start = Number(state.startEquity || 0);

      const text =
        '📊 PAPER 統計\\n\\n' +
        '交易筆數：' + trades.length + '\\n' +
        '勝場：' + wins + '\\n' +
        '敗場：' + losses + '\\n' +
        '勝率：' + winRate.toFixed(1) + '%\\n' +
        '累計 PnL：' + (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + 'U\\n' +
        '起始資金：' + start.toFixed(2) + 'U\\n' +
        '目前資金：' + equity.toFixed(4) + 'U\\n' +
        '總獲利：+' + grossWin.toFixed(4) + 'U\\n' +
        '總虧損：' + grossLoss.toFixed(4) + 'U\\n' +
        '平均獲利：+' + avgWin.toFixed(4) + 'U\\n' +
        '平均虧損：' + avgLoss.toFixed(4) + 'U\\n' +
        '目前連敗：' + Number(state.consecutiveLosses || 0) + '\\n' +
        '停機鎖定：' + (state.halted ? '是' : '否') + '\\n' +
        '持倉：' + (state.position ? state.position.inst.instId : '無') + '\\n\\n' +
        '模式：PAPER';

      await bot.sendMessage(chatId, text);
    } catch (err) {
      console.error('[Telegram /stats]', err.message || err);
    }
  });
}
`;

  const telegramMarker = /if\(bot\)bot\.on\('polling_error',[\s\S]*?\);/;
  if (telegramMarker.test(code)) {
    code = code.replace(telegramMarker, match => match + telegramStatsHandler);
  } else {
    throw new Error('[Runner] Telegram polling_error handler not found; refusing to inject /stats command');
  }

  const versionMatch = code.match(/OKX EVENT CONTRACT SNR BOT - ([^*\n]+)/);
  console.log(`[Runner] event-bot source loaded: ${versionMatch ? versionMatch[1].trim() : 'unknown-version'}`);
  console.log('[Runner] PAPER-ONLY mode forced: LIVE_TRADING=false');
  console.log('[Runner] Telegram polling enabled for /stats command');
  console.log('[Runner] /stats endpoint injected for paper-trade analysis');

  /* Final safety assertion before compiling the bot. */
  if (!code.includes('const LIVE_TRADING=false;')) {
    throw new Error('[Runner] PAPER-ONLY guard failed');
  }

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
