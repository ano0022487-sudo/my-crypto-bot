// PURE-1H-BAYESIAN VERSION
// Strategy: 1H conditional probability + Bayes theorem + EV.
// Technical indicators removed: RSI, MACD, EMA, Bollinger, SNR, volume and multi-timeframe gates.
// Existing discovery/execution infrastructure must remain intact; only the scoring model is replaced.

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const PORT = Number(process.env.PORT || 10000);
const MODE = String(process.env.TRADING_MODE || 'PAPER').toUpperCase();
const STAKE = 1;
const TIMEFRAME = '1H';
const MIN_PROB = 0.75;
const MIN_ENTRY = 0.25;
const MAX_ENTRY = 0.40;
const COOLDOWN_MS = 30 * 60 * 1000;
const STATE_FILE = path.join(__dirname, 'bot-state.json');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';

let state = loadState();
let loopRunning = false;
let cooldownUntil = 0;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { trades: [], usedEvents: [], balance: 20, wins: 0, losses: 0, pnl: 0, consecutiveLosses: 0 }; }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function log(msg, obj) { console.log(obj === undefined ? msg : `${msg} ${JSON.stringify(obj)}`); }

// Bayes: P(UP|X)=P(X|UP)P(UP)/[P(X|UP)P(UP)+P(X|DOWN)P(DOWN)]
// EV = P(win)/Entry - 1
function mean(xs) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function stdev(xs,m) { if(xs.length<2)return 1e-8; return Math.max(Math.sqrt(xs.reduce((a,x)=>a+(x-m)**2,0)/xs.length),1e-8); }
function normalPdf(x,m,s) { const z=(x-m)/Math.max(s,1e-8); return Math.exp(-0.5*z*z)/(Math.max(s,1e-8)*Math.sqrt(2*Math.PI)); }
function bayesProbability(returns) {
  const r=(returns||[]).filter(Number.isFinite); if(r.length<20)return {probability:0.5,prior:0.5};
  const up=r.filter(x=>x>0), down=r.filter(x=>x<=0);
  const priorUp=(up.length+1)/(r.length+2), priorDown=1-priorUp;
  const muUp=mean(up), muDown=mean(down), sdUp=stdev(up,muUp), sdDown=stdev(down,muDown), x=r[r.length-1];
  const lu=normalPdf(x,muUp,sdUp), ld=normalPdf(x,muDown,sdDown), den=lu*priorUp+ld*priorDown;
  return { probability:den>0?(lu*priorUp)/den:priorUp, prior:priorUp, likelihoodUp:lu, likelihoodDown:ld, evidence:x };
}

// Keep the repository's existing OKX discovery/execution functions unchanged when integrating this model.
// The model expects each 1H candidate to expose returns1h, yesPrice and noPrice.
function score1hBayesian(ev) {
  if(!ev || ev.timeframe !== TIMEFRAME) return null;
  const b=bayesProbability(ev.returns1h);
  const yes=Number(ev.yesPrice), no=Number(ev.noPrice);
  const side=b.probability>=0.5?'yes':'no';
  const p=side==='yes'?b.probability:1-b.probability;
  const entry=side==='yes'?yes:no;
  if(!(entry>=MIN_ENTRY&&entry<=MAX_ENTRY)||p<MIN_PROB)return null;
  const EV=p/entry-1;
  if(!(EV>0))return null;
  return {...ev,side,entryPx:entry,modelProb:p,ev,bayes:b,score:EV};
}

function statsText(){
 const t=Array.isArray(state.trades)?state.trades:[];
 const w=t.filter(x=>String(x.result).toUpperCase()==='WIN').length;
 const l=t.filter(x=>String(x.result).toUpperCase()==='LOSS').length;
 const pnl=t.reduce((s,x)=>s+Number(x.pnl||0),0);
 return `📊 PAPER 統計\n\n交易筆數：${t.length}\n勝場：${w}\n敗場：${l}\n勝率：${t.length?(w/t.length*100).toFixed(2):'0.00'}%\n累計 PnL：${pnl.toFixed(4)}U\n目前資金：${(20+pnl).toFixed(4)}U\n策略：純 1H Bayesian\nP(A|B)=P(B|A)P(A)/P(B)\nEV=P/Entry-1`;
}

const app=express();
app.get('/',(_,res)=>res.json({ok:true,mode:MODE,strategy:'PURE-1H-BAYESIAN',trades:state.trades.length}));
app.listen(PORT,()=>log(`[HTTP] listening on ${PORT}`));

if(TOKEN){
 const bot=new TelegramBot(TOKEN,{polling:true});
 bot.onText(/^\/start$/,m=>bot.sendMessage(m.chat.id,'✅ OKX Event Contract Bot\n模式：PAPER\n策略：純 1H Bayesian\n每筆：1U'));
 bot.onText(/^\/stats$/,m=>bot.sendMessage(m.chat.id,statsText()));
 bot.onText(/^\/status$/,m=>bot.sendMessage(m.chat.id,`🟢 RUNNING\nMode: ${MODE}\nStrategy: PURE-1H-BAYESIAN\nTrades: ${state.trades.length}\nCooldown: ${Date.now()<cooldownUntil?'YES':'NO'}`));
 bot.onText(/^\/trades$/,m=>{const r=t=>state.trades.slice(-10).reverse();const a=r();bot.sendMessage(m.chat.id,a.length?a.map((x,i)=>`${i+1}. ${x.instId||x.symbol||'-'} ${x.result||'-'} PnL=${Number(x.pnl||0).toFixed(4)}U`).join('\n'):'目前沒有交易資料。');});
 bot.onText(/^\/help$/,m=>bot.sendMessage(m.chat.id,'/start\n/stats\n/status\n/trades\n/help'));
 bot.on('polling_error',e=>console.error('[TELEGRAM ERROR]',e.message));
 log('[TELEGRAM] polling enabled');
} else log('[TELEGRAM] token missing; notifications disabled');

// Single loop guard retained. Existing execution pipeline should call score1hBayesian()
// when building candidates; no second loop is created here.
module.exports={score1hBayesian,bayesProbability,statsText,saveState,loadState};
