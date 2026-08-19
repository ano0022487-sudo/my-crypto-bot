'use strict';

/* OKX Event Contract launcher - PAPER ONLY */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) throw new Error('找不到 event-bot.js: ' + source);
  let code = fs.readFileSync(source, 'utf8');

  process.env.LIVE_TRADING = 'false';
  const livePattern = /const\s+LIVE_TRADING\s*=\s*[^;]+;/;
  if (!livePattern.test(code)) throw new Error('[Runner] LIVE_TRADING declaration not found');
  code = code.replace(livePattern, 'const LIVE_TRADING = false;');

  // Only this runner instance owns Telegram polling.
  code = code.replace(/polling\s*:\s*(true|false)/g, 'polling: true');
  const telegramConstructPattern = /new\s+TelegramBot\s*\(\s*([^,]+),\s*\{\s*polling\s*:\s*true\s*\}\s*\)/g;
  let telegramConstructCount = 0;
  code = code.replace(telegramConstructPattern, (full, tokenExpr) => {
    telegramConstructCount += 1;
    return telegramConstructCount === 1
      ? `new TelegramBot(${tokenExpr}, { polling: true })`
      : `new TelegramBot(${tokenExpr}, { polling: false })`;
  });

  const forcedConfig = `
// [RUNNER FORCED CONFIG]
const TARGET_STAKE=1;
const MIN_EDGE=0.15;
const MIN_SCORE=90;
const MIN_MODEL_PROB=0.75;
const MIN_ENTRY_PRICE=0.25;
const MAX_ENTRY_PRICE=0.45;
const EARLY_TP_PCT=0.30;
const EARLY_SL_PCT=0.25;
const MIN_MINUTES_TO_EXPIRY=2;
const MAX_MINUTES_TO_EXPIRY=20;
const DAILY_LOSS_PCT=0.10;
const MAX_CONSECUTIVE_LOSSES=2;
`;
  const cfgMarker = 'const TARGET_STAKE=';
  const cfgStart = code.indexOf(cfgMarker);
  if (cfgStart < 0) throw new Error('[Runner] strategy config not found');
  const cfgEnd = code.indexOf(';', code.indexOf('MAX_CONSECUTIVE_LOSSES=', cfgStart));
  if (cfgEnd < 0) throw new Error('[Runner] strategy config boundary not found');
  code = code.slice(0, cfgStart) + forcedConfig.trim() + code.slice(cfgEnd + 1);

  const orderMarker = 'const order=await placeEventOrder(c,equity);';
  if (!code.includes(orderMarker)) throw new Error('[Runner] placeEventOrder call not found');
  const finalGate = `
// [RUNNER FINAL PRE-ORDER GATE]
const __entryPx = Number(c && c.entryPx);
const __score = Number(c && c.score);
const __model = Number(c && c.modelProb);
const __edge = Number(c && c.edge);
const __gateFail = [];
if (!Number.isFinite(__score) || __score < MIN_SCORE) __gateFail.push('score ' + __score + '<' + MIN_SCORE);
if (!Number.isFinite(__model) || __model < MIN_MODEL_PROB) __gateFail.push('model ' + (__model * 100).toFixed(1) + '%<' + (MIN_MODEL_PROB * 100).toFixed(1) + '%');
if (!Number.isFinite(__edge) || __edge < MIN_EDGE) __gateFail.push('edge ' + (__edge * 100).toFixed(1) + '%<' + (MIN_EDGE * 100).toFixed(1) + '%');
if (!Number.isFinite(__entryPx) || __entryPx < MIN_ENTRY_PRICE || __entryPx > MAX_ENTRY_PRICE) __gateFail.push('entry ' + __entryPx + ' outside ' + MIN_ENTRY_PRICE + '-' + MAX_ENTRY_PRICE);
if (__gateFail.length) {
  console.log('[EVENT FINAL REJECT]', JSON.stringify({instId:c&&c.inst&&c.inst.instId,reasons:__gateFail,score:__score,model:Number.isFinite(__model)?__model*100:null,edge:Number.isFinite(__edge)?__edge*100:null,entryPx:__entryPx}));
  return;
}
console.log('[EVENT FINAL PASS]', JSON.stringify({instId:c&&c.inst&&c.inst.instId,score:__score,model:__model*100,edge:__edge*100,entryPx:__entryPx}));
`;
  code = code.replace(orderMarker, finalGate + '\n' + orderMarker);

  if (!code.includes("app.get('/stats'")) {
    const statsRoute = `
app.get('/stats', (req, res) => {
  try {
    const trades = Array.isArray(state.trades) ? state.trades : [];
    const wins = trades.filter(t => Number(t.pnl) > 0).length;
    const losses = trades.filter(t => Number(t.pnl) < 0).length;
    const pnl = trades.reduce((s,t) => s + Number(t.pnl || 0), 0);
    const grossWin = trades.filter(t => Number(t.pnl)>0).reduce((s,t)=>s+Number(t.pnl),0);
    const grossLoss = trades.filter(t => Number(t.pnl)<0).reduce((s,t)=>s+Number(t.pnl),0);
    res.json({ok:true,mode:'PAPER',day:state.day,startCapital:Number(state.startEquity||0),paperEquity:Number(state.paperEquity||0),realizedPnl:Number(state.realizedPnl||pnl),tradeCount:trades.length,wins,losses,winRate:trades.length?wins/trades.length*100:0,grossWin,grossLoss,avgWin:wins?grossWin/wins:0,avgLoss:losses?grossLoss/losses:0,consecutiveLosses:Number(state.consecutiveLosses||0),halted:Boolean(state.halted),openPosition:Boolean(state.position),trades});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
`;
    const healthMarker = "app.get('/health'";
    if (code.includes(healthMarker)) code = code.replace(healthMarker, statsRoute + healthMarker);
    else {
      const listenMarker = 'app.listen(';
      if (!code.includes(listenMarker)) throw new Error('[Runner] app.listen marker not found');
      code = code.replace(listenMarker, statsRoute + '\n' + listenMarker);
    }
  }

  if (!code.includes('[Telegram COMMAND HANDLER INSTALLED]')) {
    const handler = `
/* [Telegram COMMAND HANDLER INSTALLED] */
if (bot) {
  const sendPaperStats = async (chatId) => {
    try {
      const trades=Array.isArray(state.trades)?state.trades:[];
      const wins=trades.filter(t=>Number(t.pnl)>0).length;
      const losses=trades.filter(t=>Number(t.pnl)<0).length;
      const pnl=trades.reduce((s,t)=>s+Number(t.pnl||0),0);
      const grossWin=trades.filter(t=>Number(t.pnl)>0).reduce((s,t)=>s+Number(t.pnl),0);
      const grossLoss=trades.filter(t=>Number(t.pnl)<0).reduce((s,t)=>s+Number(t.pnl),0);
      const winRate=trades.length?wins/trades.length*100:0;
      const equity=Number(state.paperEquity||0);
      const start=Number(state.startEquity||0);
      const nl=String.fromCharCode(10);
      const text=['📊 PAPER 統計','','交易筆數：'+trades.length,'勝場：'+wins,'敗場：'+losses,'勝率：'+winRate.toFixed(1)+'%','累計 PnL：'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U','起始資金：'+start.toFixed(2)+'U','目前資金：'+equity.toFixed(4)+'U','總獲利：+'+grossWin.toFixed(4)+'U','總虧損：'+grossLoss.toFixed(4)+'U','平均獲利：+'+(wins?(grossWin/wins).toFixed(4):'0.0000')+'U','平均虧損：'+(losses?(grossLoss/losses).toFixed(4):'0.0000')+'U','目前連敗：'+Number(state.consecutiveLosses||0),'停機鎖定：'+(state.halted?'是':'否'),'持倉：'+(state.position?state.position.inst.instId:'無'),'','模式：PAPER','','策略：1U / Score≥90 / Model≥75% / Edge≥15% / Entry 0.25-0.45'].join(nl);
      await bot.sendMessage(chatId,text);
    } catch(err) { console.error('[Telegram COMMAND ERROR]',err.message||err); }
  };
  bot.onText(/^\\/(stats|stat|統計)(?:@[^\\s]+)?$/i,async msg=>{const chatId=String(msg&&msg.chat&&msg.chat.id||'').trim();if(chatId)await sendPaperStats(chatId);});
  bot.onText(/^\\/(start|help)(?:@[^\\s]+)?$/i,async msg=>{const chatId=String(msg&&msg.chat&&msg.chat.id||'').trim();if(!chatId)return;try{const nl=String.fromCharCode(10);const helpText=['OKX Event Bot','','模式：PAPER（模擬盤）','','可用指令：','/stats','/stat','/統計','','查詢目前模擬交易統計。'].join(nl);await bot.sendMessage(chatId,helpText);}catch(err){console.error('[Telegram COMMAND ERROR]',err.message||err);}});
  bot.on('polling_error',err=>console.error('[Telegram polling_error]',err.message||err));
}
`;
    const botStart=code.indexOf('const bot=');
    if(botStart<0) throw new Error('[Runner] bot declaration not found');
    const botEnd=code.indexOf('\n',botStart);
    if(botEnd<0) throw new Error('[Runner] bot declaration boundary not found');
    code=code.slice(0,botEnd+1)+handler+code.slice(botEnd+1);
  }

  console.log('[Runner] PAPER-ONLY mode forced: LIVE_TRADING=false');
  console.log('[Runner] Strategy forced: 1U / Score>=90 / Model>=75% / Edge>=15% / Entry 0.25-0.45');
  console.log('[Runner] Risk forced: daily loss 10% / max consecutive losses 2');
  console.log('[Runner] Event expiry forced: 2-20 minutes');
  console.log('[Runner] FINAL PRE-ORDER GATE: score/model/edge/entry checked immediately before placeEventOrder');
  console.log('[Runner] Telegram command handlers installed: /stats /stat /統計 /start /help');
  console.log('[Runner] /stats HTTP endpoint installed');

  if(!code.includes('const LIVE_TRADING = false;')) throw new Error('[Runner] PAPER guard failed');

  const runtimeModule=new Module(source,module);
  runtimeModule.filename=source;
  runtimeModule.paths=Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code,source);
} catch(err) {
  console.error('[Runner Error]',err);
  process.exitCode=1;
}
