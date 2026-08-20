// PURE-1H-BAYESIAN + HALF-KELLY VERSION
// Strategy: 1H conditional probability + Bayes theorem + EV + half-Kelly sizing.
// Technical indicators removed: RSI, MACD, EMA, Bollinger, SNR, volume and multi-timeframe gates.
// Existing discovery/execution infrastructure must remain intact; only scoring/sizing is replaced.

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const PORT = Number(process.env.PORT || 10000);
const MODE = String(process.env.TRADING_MODE || 'PAPER').toUpperCase();
const TIMEFRAME = '1H';
const MIN_PROB = 0.75;
const MIN_ENTRY = 0.25;
const MAX_ENTRY = 0.40;
const MIN_EV = 0;
const HALF_KELLY = 0.5;
const MIN_STAKE = 0.01;
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
function normalPdf(x,m,s) { const sd=Math.max(s,1e-8); const z=(x-m)/sd; return Math.exp(-0.5*z*z)/(sd*Math.sqrt(2*Math.PI)); }
function bayesProbability(returns) {
  const r=(returns||[]).filter(Number.isFinite); if(r.length<20)return {probability:0.5,prior:0.5};
  const up=r.filter(x=>x>0), down=r.filter(x=>x<=0);
  const priorUp=(up.length+1)/(r.length+2), priorDown=1-priorUp;
  const muUp=mean(up), muDown=mean(down), sdUp=stdev(up,muUp), sdDown=stdev(down,muDown), x=r[r.length-1];
  const lu=normalPdf(x,muUp,sdUp), ld=normalPdf(x,muDown,sdDown), den=lu*priorUp+ld*priorDown;
  return { probability:den>0?(lu*priorUp)/den:priorUp, prior:priorUp, likelihoodUp:lu, likelihoodDown:ld, evidence:x };
}

// Standard Kelly for binary contract with entry price c:
// b=(1-c)/c, q=1-p, fKelly=(b*p-q)/b = (p-c)/(1-c).
// Half-Kelly fraction = 0.5*fKelly.
function halfKellyFraction(probability, entry) {
  const p=Number(probability), c=Number(entry);
  if(!Number.isFinite(p)||!Number.isFinite(c)||c<=0||c>=1||p<=c) return 0;
  const b=(1-c)/c;
  const q=1-p;
  const fullKelly=(b*p-q)/b;
  return Math.max(0, HALF_KELLY*fullKelly);
}

function calculateStake(bankroll, probability, entry) {
  const balance=Math.max(0, Number(bankroll)||0);
  const fraction=halfKellyFraction(probability,entry);
  const rawStake=balance*fraction;
  const stake=Math.max(0, Math.min(balance, Math.floor(rawStake*100)/100));
  return { bankroll:balance, fraction, rawStake, stake };
}

// The model expects each 1H candidate to expose returns1h, yesPrice and noPrice.
// targetStake is the mathematical stake for the existing execution layer to consume.
function score1hBayesian(ev) {
  if(!ev || ev.timeframe !== TIMEFRAME) return null;
  const b=bayesProbability(ev.returns1h);
  const yes=Number(ev.yesPrice), no=Number(ev.noPrice);
  const side=b.probability>=0.5?'yes':'no';
  const p=side==='yes'?b.probability:1-b.probability;
  const entry=side==='yes'?yes:no;
  if(!(entry>=MIN_ENTRY&&entry<=MAX_ENTRY)||p<MIN_PROB)return null;
  const EV=p/entry-1;
  if(!(EV>MIN_EV))return null;

  const bankroll=Number.isFinite(Number(ev.bankroll)) ? Number(ev.bankroll) : Number(state.balance || 20);
  const sizing=calculateStake(bankroll,p,entry);
  if(sizing.stake < MIN_STAKE) return null;

  return {
    ...ev,
    side,
    entryPx:entry,
    modelProb:p,
    ev:EV,
    bayes:b,
    score:EV,
    bankroll:sizing.bankroll,
    kellyFraction:sizing.fraction*2,
    halfKellyFraction:sizing.fraction,
    targetStake:sizing.stake
  };
}

function statsText(){
 const t=Array.isArray(state.trades)?state.trades:[];
 const w=t.filter(x=>String(x.result).toUpperCase()==='WIN').length;
 const l=t.filter(x=>String(x.result).toUpperCase()==='LOSS').length;
 const pnl=t.reduce((s,x)=>s+Number(x.pnl||0),0);
 const balance=Number(state.balance||20);
 return `📊 PAPER 統計\n\n交易筆數：${t.length}\n勝場：${w}\n敗場：${l}\n勝率：${t.length?(w/t.length*100).toFixed(2):'0.00'}%\n累計 PnL：${pnl.toFixed(4)}U\n目前資金：${balance.toFixed(4)}U\n策略：純 1H Bayesian + Half-Kelly\nP(UP|X)=P(X|UP)P(UP)/P(X)\nEV=P/Entry-1\nStake=Bankroll×Half-Kelly`;
}

const app=express();
app.get('/',(_,res)=>res.json({ok:true,mode:MODE,strategy:'PURE-1H-BAYESIAN-HALF-KELLY',trades:state.trades.length,balance:Number(state.balance||20)}));
app.listen(PORT,()=>log(`[HTTP] listening on ${PORT}`));

if(TOKEN){
 const bot=new TelegramBot(TOKEN,{polling:true});
 bot.onText(/^\/start$/,m=>bot.sendMessage(m.chat.id,'✅ OKX Event Contract Bot\n模式：PAPER\n策略：純 1H Bayesian + Half-Kelly\n資金配置：Half-Kelly'));
 bot.onText(/^\/stats$/,m=>bot.sendMessage(m.chat.id,statsText()));
 bot.onText(/^\/status$/,m=>bot.sendMessage(m.chat.id,`🟢 RUNNING\nMode: ${MODE}\nStrategy: PURE-1H-BAYESIAN-HALF-KELLY\nTrades: ${state.trades.length}\nBankroll: ${Number(state.balance||20).toFixed(4)}U\nCooldown: ${Date.now()<cooldownUntil?'YES':'NO'}`));
 bot.onText(/^\/trades$/,m=>{const a=state.trades.slice(-10).reverse();bot.sendMessage(m.chat.id,a.length?a.map((x,i)=>`${i+1}. ${x.instId||x.symbol||'-'} ${x.result||'-'} PnL=${Number(x.pnl||0).toFixed(4)}U`).join('\n'):'目前沒有交易資料。');});
 bot.onText(/^\/help$/,m=>bot.sendMessage(m.chat.id,'/start\n/stats\n/status\n/trades\n/help'));
 bot.on('polling_error',e=>console.error('[TELEGRAM ERROR]',e.message));
 log('[TELEGRAM] polling enabled');
} else log('[TELEGRAM] token missing; notifications disabled');

module.exports={score1hBayesian,bayesProbability,halfKellyFraction,calculateStake,statsText,saveState,loadState};
