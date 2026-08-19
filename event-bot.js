'use strict';

/* OKX Event Contract Bot
   Risk/sizing patch: fixed 1U stake, 3-loss/30m cooldown, consistent PnL accounting. */

const fs=require('fs');
const path=require('path');
const STATE_FILE=path.join(__dirname,'event-bot-state.json');
const TARGET_STAKE=1;
const MAX_CONSECUTIVE_LOSSES=3;
const COOLDOWN_MS=30*60*1000;
const DAILY_LOSS_PCT=0.20;
const PREFERRED_ENTRY_MIN=0.25;
const PREFERRED_ENTRY_MAX=0.35;
const MAX_ENTRY_PRICE=0.40;
const MIN_EXPIRY_RR=2;

function loadState(){try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));}catch(e){return {startEquity:20,consecutiveLosses:0,cooldownUntil:0,halted:false,trades:[],dailyStart:20};}}
let state=loadState();
function saveState(){fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2));}
function expiryRewardRisk(p){return Number.isFinite(p)&&p>0&&p<1?(1-p)/p:0;}
function validEntry(p){return Number.isFinite(p)&&p>=PREFERRED_ENTRY_MIN&&p<=MAX_ENTRY_PRICE&&expiryRewardRisk(p)>=MIN_EXPIRY_RR;}
function entryPriority(p){if(p>=PREFERRED_ENTRY_MIN&&p<=PREFERRED_ENTRY_MAX)return 2;if(p<=0.40)return 1;return 0;}
function contractsForStake(entryPx){if(!Number.isFinite(entryPx)||entryPx<=0)return 0;return Math.floor((TARGET_STAKE/entryPx)*10)/10;}
function actualStake(entryPx,contracts){return Number((entryPx*contracts).toFixed(4));}
function calcPnl(side,entryPx,exitPx,contracts){if(!Number.isFinite(entryPx)||!Number.isFinite(exitPx)||!Number.isFinite(contracts))return 0;const delta=side==='YES'?exitPx-entryPx:entryPx-exitPx;return Number((delta*contracts).toFixed(4));}
function resetDaily(){const today=new Date().toISOString().slice(0,10);if(state.dailyDate!==today){state.dailyDate=today;state.dailyStart=state.currentEquity??state.startEquity;state.dailyLossLocked=false;saveState();}}
function currentDailyLossPct(){const start=Number(state.dailyStart||state.startEquity||20),eq=Number(state.currentEquity||start);return start>0?Math.max(0,(start-eq)/start):0;}
function riskBlocked(){
  resetDaily();
  const now=Date.now();
  if(state.cooldownUntil&&now>=Number(state.cooldownUntil)){state.cooldownUntil=0;state.halted=false;state.consecutiveLosses=0;saveState();console.log('[RISK] cooldown complete; trading resumed');}
  if(state.cooldownUntil&&now<Number(state.cooldownUntil))return true;
  if(Number(state.consecutiveLosses)>=MAX_CONSECUTIVE_LOSSES){state.halted=true;state.cooldownUntil=now+COOLDOWN_MS;saveState();console.log('[RISK] 3 consecutive losses; cooldown 30 minutes');return true;}
  if(state.halted){state.halted=false;saveState();}
  if(currentDailyLossPct()>=DAILY_LOSS_PCT){state.dailyLossLocked=true;saveState();console.log('[RISK] daily loss limit reached');return true;}
  return false;
}
function recordTrade(trade){
  const pnl=Number(trade.pnl||0);
  state.trades=Array.isArray(state.trades)?state.trades:[];
  state.trades.push({...trade,pnl});
  state.currentEquity=Number((Number(state.currentEquity??state.startEquity??20)+pnl).toFixed(4));
  if(pnl<0)state.consecutiveLosses++;else if(pnl>0)state.consecutiveLosses=0;
  saveState();
  return pnl;
}
function buildOrder(entryPx){
  const contracts=contractsForStake(entryPx);
  const requestedStake=TARGET_STAKE;
  const actual=actualStake(entryPx,contracts);
  return {targetStake:TARGET_STAKE,requestedStake,contracts,actualStake:actual,entryPx,expiryRR:expiryRewardRisk(entryPx),entryPriority:entryPriority(entryPx)};
}
function selectCandidate(candidates){
  return candidates.filter(c=>validEntry(c.entryPx)).sort((a,b)=>entryPriority(b.entryPx)-entryPriority(a.entryPx)||expiryRewardRisk(b.entryPx)-expiryRewardRisk(a.entryPx)||Number(b.edge||0)-Number(a.edge||0)||Number(b.score||0)-Number(a.score||0));
}

/* The existing signal, market-data, Telegram and OKX functions remain unchanged in the upstream bot.
   This guard module is intentionally self-contained so the runner can call the helpers above. */
module.exports={state,saveState,riskBlocked,recordTrade,buildOrder,selectCandidate,calcPnl,contractsForStake,actualStake,expiryRewardRisk};
