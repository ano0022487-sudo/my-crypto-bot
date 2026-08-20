'use strict';

/* OKX Event Contract launcher - PAPER ONLY */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');
const SINGLETON_LOCK = path.join('/tmp', 'okx-event-bot.singleton.lock');
let singletonFd = null;

function acquireSingleton() {
  try {
    singletonFd = fs.openSync(SINGLETON_LOCK, 'wx');
    fs.writeFileSync(singletonFd, String(process.pid), 'utf8');
    const release = () => {
      try { if (singletonFd !== null) fs.closeSync(singletonFd); } catch (_) {}
      try { if (fs.existsSync(SINGLETON_LOCK)) fs.unlinkSync(SINGLETON_LOCK); } catch (_) {}
    };
    process.once('exit', release);
    process.once('SIGTERM', () => { release(); process.exit(0); });
    process.once('SIGINT', () => { release(); process.exit(0); });
    console.log(`[Runner] Singleton lock acquired pid=${process.pid}`);
    return true;
  } catch (e) {
    try {
      const oldPid = Number(fs.readFileSync(SINGLETON_LOCK, 'utf8').trim());
      if (Number.isInteger(oldPid) && oldPid > 0) {
        try {
          process.kill(oldPid, 0);
          console.error(`[Runner] Another bot process is already running pid=${oldPid}; refusing duplicate startup.`);
          return false;
        } catch (_) {
          try { fs.unlinkSync(SINGLETON_LOCK); } catch (_) {}
          return acquireSingleton();
        }
      }
      try { fs.unlinkSync(SINGLETON_LOCK); } catch (_) {}
      return acquireSingleton();
    } catch (_) {
      console.error('[Runner] Singleton lock exists; refusing duplicate startup.');
      return false;
    }
  }
}

if (!acquireSingleton()) {
  process.exitCode = 0;
  return;
}

try {
  if (!fs.existsSync(source)) throw new Error('找不到 event-bot.js: ' + source);
  let code = fs.readFileSync(source, 'utf8');

  process.env.LIVE_TRADING = 'false';
  const livePattern = /const\s+LIVE_TRADING\s*=\s*[^;]+;/;
  if (!livePattern.test(code)) throw new Error('[Runner] LIVE_TRADING declaration not found');
  code = code.replace(livePattern, 'const LIVE_TRADING = false;');

  // Telegram uses webhook mode. Polling is deliberately disabled so there is
  // exactly one update delivery mechanism and no getUpdates 409 conflicts.
  code = code.replace(/polling\s*:\s*(true|false)/g, 'polling: false');
  code = code.replace(/new\s+TelegramBot\s*\(\s*([^,]+),\s*\{\s*polling\s*:\s*(true|false)\s*\}\s*\)/g,
    (full, tokenExpr) => `new TelegramBot(${tokenExpr}, { polling: false })`);

  const webhookBlock = `
// [RUNNER TELEGRAM WEBHOOK]
// Render provides RENDER_EXTERNAL_URL on hosted services. A custom
// TELEGRAM_WEBHOOK_URL may be supplied when a different public HTTPS URL is used.
const __telegramWebhookBase = String(process.env.TELEGRAM_WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\\/$/, '');
const __telegramWebhookPath = '/telegram/webhook';
if (bot && app && __telegramWebhookBase) {
  app.post(__telegramWebhookPath, (req, res) => {
    try {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      console.error('[Telegram webhook process error]', err.message || err);
      res.sendStatus(500);
    }
  });
  const __telegramWebhookUrl = __telegramWebhookBase + __telegramWebhookPath;
  bot.deleteWebHook().catch(() => {}).then(() => bot.setWebHook(__telegramWebhookUrl)).then(() => {
    console.log('[Telegram] Webhook enabled:', __telegramWebhookUrl);
  }).catch(err => {
    console.error('[Telegram webhook setup error]', err.message || err);
  });
} else if (bot) {
  console.warn('[Telegram] Webhook not configured: set TELEGRAM_WEBHOOK_URL or RENDER_EXTERNAL_URL');
}
`;
  const botDeclaration = 'const bot=TG_TOKEN?new TelegramBot(TG_TOKEN,{polling:false}):null;';
  if (!code.includes(botDeclaration)) throw new Error('[Runner] Telegram bot declaration not found after polling conversion');
  code = code.replace(botDeclaration, botDeclaration + webhookBlock);

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
const MAX_CONSECUTIVE_LOSSES=3;
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

  // event-bot.js owns its Telegram commands. Do not inject another copy.
  // Webhook delivery reaches the same bot instance via bot.processUpdate().
  if (!code.includes('bot.onText(/^\\/(stats|stat|統計)')) {
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
  console.log('[Runner] Risk forced: daily loss 10% / max consecutive losses 3 / cooldown 30 minutes');
  console.log('[Runner] Event expiry forced: 2-20 minutes');
  console.log('[Runner] FINAL PRE-ORDER GATE: score/model/edge/entry checked immediately before placeEventOrder');
  console.log('[Runner] Telegram mode: WEBHOOK (polling disabled; no getUpdates)');
  console.log('[Runner] Telegram command handlers: /stats /stat /統計 /start /help');
  console.log('[Runner] /stats HTTP endpoint installed');
  console.log('[Runner] Singleton protection enabled; only one bot process may run per container.');

  if(!code.includes('const LIVE_TRADING = false;')) throw new Error('[Runner] PAPER guard failed');

  const runtimeModule=new Module(source,module);
  runtimeModule.filename=source;
  runtimeModule.paths=Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code,source);
} catch(err) {
  console.error('[Runner Error]',err);
  process.exitCode=1;
}
