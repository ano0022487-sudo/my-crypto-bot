'use strict';

/* OKX Event Contract launcher - PAPER ONLY / STRICT FILTERS */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) throw new Error('找不到 event-bot.js: ' + source);

  let code = fs.readFileSync(source, 'utf8');

  // HARD SAFETY: runner can never start live trading.
  process.env.LIVE_TRADING = 'false';
  const livePattern = /const\s+LIVE_TRADING\s*=\s*[^;]+;/;
  if (!livePattern.test(code)) throw new Error('[Runner] LIVE_TRADING declaration not found');
  code = code.replace(livePattern, 'const LIVE_TRADING = false;');

  // Strategy/risk profile for PAPER validation.
  const replacements = [
    ['const TARGET_STAKE=5;', 'const TARGET_STAKE=2;'],
    ["process.env.MIN_EDGE||0.10", "process.env.MIN_EDGE||0.15"],
    ["process.env.MIN_SCORE||85", "process.env.MIN_SCORE||90"],
    ["process.env.MIN_MODEL_PROB||0.70", "process.env.MIN_MODEL_PROB||0.75"],
    ["process.env.MIN_ENTRY_PRICE||0.15", "process.env.MIN_ENTRY_PRICE||0.25"],
    ["process.env.MAX_ENTRY_PRICE||0.90", "process.env.MAX_ENTRY_PRICE||0.75"],
    ["process.env.DAILY_LOSS_PCT||0.20", "process.env.DAILY_LOSS_PCT||0.10"],
    ["process.env.MAX_CONSECUTIVE_LOSSES||3", "process.env.MAX_CONSECUTIVE_LOSSES||2"],
    ["let reject=null;", "let reject=null; if(model.score<0+MIN_SCORE)reject=`score ${model.score}<${MIN_SCORE}`; else if(modelProb<MIN_MODEL_PROB)reject=`model ${(modelProb*100).toFixed(1)}%<${MIN_MODEL_PROB*100}%`; else if(edge<MIN_EDGE)reject=`edge ${(edge*100).toFixed(1)}%<${MIN_EDGE*100}%`; else if(entryPx<MIN_ENTRY_PRICE||entryPx>MAX_ENTRY_PRICE)reject=`entry ${entryPx.toFixed(4)} outside ${MIN_ENTRY_PRICE}-${MAX_ENTRY_PRICE}`;"]
  ];
  for (const [from, to] of replacements) {
    if (!code.includes(from)) throw new Error('[Runner] Strategy pattern not found: ' + from);
    code = code.split(from).join(to);
  }

  // Force Telegram polling on.
  code = code.replace(/polling\s*:\s*(true|false)/g, 'polling: true');

  // Read-only PAPER statistics endpoint.
  if (!code.includes("app.get('/stats'")) {
    const statsRoute = `
app.get('/stats', (req, res) => {
  try {
    const trades = Array.isArray(state.trades) ? state.trades : [];
    const wins = trades.filter(t => Number(t.pnl) > 0).length;
    const losses = trades.filter(t => Number(t.pnl) < 0).length;
    const pnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
    const grossWin = trades.filter(t => Number(t.pnl) > 0).reduce((s, t) => s + Number(t.pnl), 0);
    const grossLoss = trades.filter(t => Number(t.pnl) < 0).reduce((s, t) => s + Number(t.pnl), 0);
    res.json({ok:true,mode:'PAPER',day:state.day,startCapital:Number(state.startEquity||0),paperEquity:Number(state.paperEquity||0),realizedPnl:Number(state.realizedPnl||pnl),tradeCount:trades.length,wins,losses,winRate:trades.length?wins/trades.length*100:0,grossWin,grossLoss,avgWin:wins?grossWin/wins:0,avgLoss:losses?grossLoss/losses:0,consecutiveLosses:Number(state.consecutiveLosses||0),halted:Boolean(state.halted),openPosition:Boolean(state.position),trades});
  } catch (e) { res.status(500).json({ok:false,error:e.message}); }
});
`;
    if (code.includes("app.get('/health'")) code = code.replace("app.get('/health'", statsRoute + "app.get('/health'");
    else if (code.includes('app.listen(')) code = code.replace('app.listen(', statsRoute + '\napp.listen(');
    else throw new Error('[Runner] HTTP route insertion point not found');
  }

  // Telegram command handler. Use a real newline character at runtime.
  if (!code.includes('[Telegram COMMAND HANDLER INSTALLED]')) {
    const handler = `
/* [Telegram COMMAND HANDLER INSTALLED] */
if (bot) {
  const sendPaperStats = async (chatId) => {
    try {
      const trades = Array.isArray(state.trades) ? state.trades : [];
      const wins = trades.filter(t => Number(t.pnl) > 0).length;
      const losses = trades.filter(t => Number(t.pnl) < 0).length;
      const pnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
      const grossWin = trades.filter(t => Number(t.pnl) > 0).reduce((s, t) => s + Number(t.pnl), 0);
      const grossLoss = trades.filter(t => Number(t.pnl) < 0).reduce((s, t) => s + Number(t.pnl), 0);
      const winRate = trades.length ? wins / trades.length * 100 : 0;
      const equity = Number(state.paperEquity || 0);
      const start = Number(state.startEquity || 0);
      const nl = String.fromCharCode(10);
      const text = [
        '📊 PAPER 統計', '',
        '交易筆數：' + trades.length, '勝場：' + wins, '敗場：' + losses,
        '勝率：' + winRate.toFixed(1) + '%',
        '累計 PnL：' + (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + 'U',
        '起始資金：' + start.toFixed(2) + 'U', '目前資金：' + equity.toFixed(4) + 'U',
        '總獲利：+' + grossWin.toFixed(4) + 'U', '總虧損：' + grossLoss.toFixed(4) + 'U',
        '平均獲利：+' + (wins ? (grossWin / wins).toFixed(4) : '0.0000') + 'U',
        '平均虧損：' + (losses ? (grossLoss / losses).toFixed(4) : '0.0000') + 'U',
        '目前連敗：' + Number(state.consecutiveLosses || 0), '停機鎖定：' + (state.halted ? '是' : '否'),
        '持倉：' + (state.position ? state.position.inst.instId : '無'), '', '模式：PAPER', '',
        '策略：2U / Score≥90 / Model≥75% / Edge≥15% / Entry 0.25-0.75'
      ].join(nl);
      await bot.sendMessage(chatId, text);
      console.log('[Telegram COMMAND] /stats replied to ' + chatId);
    } catch (err) { console.error('[Telegram COMMAND ERROR]', err.message || err); }
  };
  bot.onText(/^\\/(stats|stat|統計)(?:@[^\\s]+)?$/i, async (msg) => { const chatId = String(msg && msg.chat && msg.chat.id || '').trim(); if (chatId) await sendPaperStats(chatId); });
  bot.onText(/^\\/(start|help)(?:@[^\\s]+)?$/i, async (msg) => {
    const chatId = String(msg && msg.chat && msg.chat.id || '').trim(); if (!chatId) return;
    try { const nl=String.fromCharCode(10); const helpText=['OKX Event Bot','','模式：PAPER（模擬盤）','','目前策略：','單筆 2U','Score ≥ 90','Model ≥ 75%','Edge ≥ 15%','Entry 0.25～0.75','','可用指令：','/stats','/stat','/統計','','查詢目前模擬交易統計。'].join(nl); await bot.sendMessage(chatId,helpText); console.log('[Telegram COMMAND] /start or /help replied to '+chatId); }
    catch (err) { console.error('[Telegram COMMAND ERROR]', err.message || err); }
  });
  bot.on('polling_error',(err)=>console.error('[Telegram polling_error]',err.message||err));
}
`;
    const botStart=code.indexOf('const bot=');
    if(botStart<0) throw new Error('[Runner] bot declaration not found');
    const botEnd=code.indexOf('\n',botStart);
    if(botEnd<0) throw new Error('[Runner] bot declaration boundary not found');
    code=code.slice(0,botEnd+1)+handler+code.slice(botEnd+1);
  }

  console.log('[Runner] PAPER-ONLY mode forced: LIVE_TRADING=false');
  console.log('[Runner] Strategy forced: 2U / Score>=90 / Model>=75% / Edge>=15% / Entry 0.25-0.75');
  console.log('[Runner] Risk forced: daily loss 10% / max consecutive losses 2');
  console.log('[Runner] HARD ENTRY GATE: score/model/edge/entry are checked immediately before candidate PASS');
  console.log('[Runner] Telegram command handlers installed: /stats /stat /統計 /start /help');
  console.log('[Runner] /stats HTTP endpoint installed');

  if(!code.includes('const LIVE_TRADING = false;')) throw new Error('[Runner] PAPER guard failed');
  if(!code.includes('const TARGET_STAKE=2;')) throw new Error('[Runner] stake guard failed');

  const runtimeModule=new Module(source,module);
  runtimeModule.filename=source;
  runtimeModule.paths=Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code,source);
} catch(err) { console.error('[Runner Error]',err); process.exitCode=1; }
