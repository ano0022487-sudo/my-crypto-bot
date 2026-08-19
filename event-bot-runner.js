'use strict';

/* OKX Event Contract launcher - PAPER ONLY */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) throw new Error(`找不到 event-bot.js: ${source}`);

  let code = fs.readFileSync(source, 'utf8');

  // HARD SAFETY: this runner can never start live trading.
  process.env.LIVE_TRADING = 'false';
  const livePattern = /const LIVE_TRADING\s*=\s*[^;]+;/;
  if (!livePattern.test(code)) throw new Error('[Runner] LIVE_TRADING declaration not found');
  code = code.replace(livePattern, 'const LIVE_TRADING=false;');

  // Force Telegram polling on.
  code = code.replace(/polling\s*:\s*(true|false)/g, 'polling: true');

  // Read-only HTTP statistics endpoint.
  const statsRoute = `
app.get('/stats',(req,res)=>{try{
 const trades=Array.isArray(state.trades)?state.trades:[];
 const wins=trades.filter(t=>Number(t.pnl)>0).length;
 const losses=trades.filter(t=>Number(t.pnl)<0).length;
 const pnl=trades.reduce((s,t)=>s+Number(t.pnl||0),0);
 const grossWin=trades.filter(t=>Number(t.pnl)>0).reduce((s,t)=>s+Number(t.pnl),0);
 const grossLoss=trades.filter(t=>Number(t.pnl)<0).reduce((s,t)=>s+Number(t.pnl),0);
 res.json({ok:true,mode:'PAPER',day:state.day,startCapital:Number(state.startEquity||0),paperEquity:Number(state.paperEquity||0),realizedPnl:Number(state.realizedPnl||pnl),tradeCount:trades.length,wins,losses,winRate:trades.length?wins/trades.length*100:0,grossWin,grossLoss,avgWin:wins?grossWin/wins:0,avgLoss:losses?grossLoss/losses:0,consecutiveLosses:Number(state.consecutiveLosses||0),halted:Boolean(state.halted),openPosition:Boolean(state.position),trades});
}catch(e){res.status(500).json({ok:false,error:e.message});}});
`;

  if (!code.includes("app.get('/stats'")) {
    const marker = "app.get('/health'";
    if (!code.includes(marker)) throw new Error('[Runner] /health route not found');
    code = code.replace(marker, statsRoute + marker);
  }

  // Install Telegram command handler directly after bot creation.
  // Do not depend on onText; message events are more reliable for this bot.
  const handler = `
if (bot) {
  bot.on('message', async (msg) => {
    try {
      const raw = String(msg && msg.text || '').trim();
      const command = raw.split(/\\s+/)[0].split('@')[0].toLowerCase();
      if (command !== '/stats' && command !== '/stat' && command !== '/統計') return;

      const chatId = String(msg && msg.chat && msg.chat.id || '').trim();
      const configuredChat = String(process.env.TELEGRAM_CHAT_ID || '').trim();
      console.log('[Telegram COMMAND]', JSON.stringify({command,chatId,configuredChat}));

      if (!chatId) return;
      if (configuredChat && chatId !== configuredChat) {
        console.log('[Telegram COMMAND] ignored: unauthorized chat');
        return;
      }

      const trades = Array.isArray(state.trades) ? state.trades : [];
      const wins = trades.filter(t => Number(t.pnl) > 0).length;
      const losses = trades.filter(t => Number(t.pnl) < 0).length;
      const pnl = trades.reduce((s,t) => s + Number(t.pnl || 0), 0);
      const grossWin = trades.filter(t => Number(t.pnl) > 0).reduce((s,t) => s + Number(t.pnl), 0);
      const grossLoss = trades.filter(t => Number(t.pnl) < 0).reduce((s,t) => s + Number(t.pnl), 0);
      const winRate = trades.length ? wins / trades.length * 100 : 0;
      const equity = Number(state.paperEquity || 0);
      const start = Number(state.startEquity || 0);

      const text = [
        '📊 PAPER 統計',
        '',
        `交易筆數：${trades.length}`,
        `勝場：${wins}`,
        `敗場：${losses}`,
        `勝率：${winRate.toFixed(1)}%`,
        `累計 PnL：${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}U`,
        `起始資金：${start.toFixed(2)}U`,
        `目前資金：${equity.toFixed(4)}U`,
        `總獲利：+${grossWin.toFixed(4)}U`,
        `總虧損：${grossLoss.toFixed(4)}U`,
        `平均獲利：+${wins ? (grossWin/wins).toFixed(4) : '0.0000'}U`,
        `平均虧損：${losses ? (grossLoss/losses).toFixed(4) : '0.0000'}U`,
        `目前連敗：${Number(state.consecutiveLosses || 0)}`,
        `停機鎖定：${state.halted ? '是' : '否'}`,
        `持倉：${state.position ? state.position.inst.instId : '無'}`,
        '',
        '模式：PAPER'
      ].join('\\n');

      await bot.sendMessage(chatId, text);
    } catch (err) {
      console.error('[Telegram COMMAND ERROR]', err.message || err);
    }
  });
}
`;

  // Inject exactly once, immediately after the bot declaration.
  const botMarker = /const bot=.*?;\n/;
  if (!botMarker.test(code)) throw new Error('[Runner] bot declaration not found');
  if (!code.includes("[Telegram COMMAND]")) {
    code = code.replace(botMarker, match => match + handler);
  }

  console.log('[Runner] PAPER-ONLY mode forced: LIVE_TRADING=false');
  console.log('[Runner] Telegram /stats,/stat,/統計 handler installed');
  console.log('[Runner] /stats HTTP endpoint installed');

  if (!code.includes('const LIVE_TRADING=false;')) throw new Error('[Runner] PAPER guard failed');

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
