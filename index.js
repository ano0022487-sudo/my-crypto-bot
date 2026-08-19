'use strict';

/*
  OKX Event Contract launcher.
  4H = main direction, 15m = trend confirmation, 5m = entry signal.
  Both 5m and 15m event series are eligible.
  Risk: 3 consecutive losses -> 30 minute cooldown -> automatic resume.
  Entry optimization: prefer 0.25-0.35 and rank by expiry reward/risk.
*/

require('./runtime-diagnostics.js');
const fs = require('fs');
const originalReadFileSync = fs.readFileSync;

fs.readFileSync = function(file, encoding, ...rest) {
  const result = originalReadFileSync.call(fs, file, encoding, ...rest);
  if (typeof file === 'string' && /event-bot\.js$/.test(file) && typeof result === 'string') {
    let code = result;

    code = code.replace(
      "function getConfiguredSeries(){return EVENT_SERIES.split(',').map(x=>x.trim()).filter(Boolean);}",
      "function getConfiguredSeries(){const configured=EVENT_SERIES.split(',').map(x=>x.trim()).filter(Boolean);return [...new Set([...configured,...ASSETS.flatMap(c=>[`${c}-UPDOWN-5MIN`,`${c}-UPDOWN-15MIN`])])];}"
    );

    code = code.replace(
      /function generatedSeries\(\)\{return ASSETS\.map\(c=>`\$\{c\}-UPDOWN-15MIN`\);\}/,
      "function generatedSeries(){return ASSETS.flatMap(c=>[`${c}-UPDOWN-5MIN`,`${c}-UPDOWN-15MIN`]);}"
    );

    code = code.replace(
      "async function getCandles(instId,bar,limit=100){return confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit}));}",
      "const __TF4H={}; async function getCandles(instId,bar,limit=100){const rows=confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit})); if(bar==='4H') __TF4H[instId]=rows; return rows;}"
    );

    code = code.replace(
      "async function getCandles(instId,bar,limit=100){const rows=confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit})); if(bar==='4H') __TF4H[instId]=rows; return rows;}",
      "async function getCandles(instId,bar,limit=100){const rows=confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit})); if(bar==='4H') __TF4H[instId]=rows; if(bar==='15m'){try{__TF4H[instId]=confirmed(await publicGet('/api/v5/market/candles',{instId,bar:'4H',limit:100}));}catch(e){console.error('[4H context]',e.message);}} return rows;}"
    );

    const start = code.indexOf('function modelProbability(');
    const end = code.indexOf('\nasync function getEquity(', start);
    if (start >= 0 && end > start) {
      const replacement = `function modelProbability(price,strike,c5,c15){
  const cl5=closes(c5),cl15=closes(c15);
  const instKey=Object.keys(__TF4H).find(k=>__TF4H[k]===c15);
  const c4=instKey?__TF4H[instKey]:null;
  const cl4=c4?closes(c4):[];
  const e20_4=ema(cl4,20),e50_4=ema(cl4,50);
  const e20_15=ema(cl15,20),e50_15=ema(cl15,50);
  const e9_5=ema(cl5,9),e20_5=ema(cl5,20);
  const r=rsi(cl5),a=atr(c5);
  let up=0,down=0;
  const upReasons=[],downReasons=[],signals=[];
  const main4h=e20_4&&e50_4?(e20_4>e50_4?'UP':'DOWN'):null;
  const trend15=e20_15&&e50_15?(e20_15>e50_15?'UP':'DOWN'):null;
  const entry5=e9_5&&e20_5?(e9_5>e20_5?'UP':'DOWN'):null;
  if(main4h==='UP'){up+=35;upReasons.push('4H main direction');signals.push('4H UP');}
  if(main4h==='DOWN'){down+=35;downReasons.push('4H main direction');signals.push('4H DOWN');}
  if(trend15==='UP'){up+=25;upReasons.push('15m trend confirmation');signals.push('15m UP');}
  if(trend15==='DOWN'){down+=25;downReasons.push('15m trend confirmation');signals.push('15m DOWN');}
  if(main4h&&trend15&&main4h!==trend15){
    return {score:0,upProbability:0.5,downProbability:0.5,reasons:[],signals:['4H/15m direction conflict'],direction:null,atr:a,volumeRatio:1,confirmation:{score:0,bestWeight:0,confidenceGap:0,optionalMissing:['4H/15m conflict']}};
  }
  if(entry5==='UP'){up+=20;upReasons.push('5m entry signal');signals.push('5m ENTRY UP');}
  if(entry5==='DOWN'){down+=20;downReasons.push('5m entry signal');signals.push('5m ENTRY DOWN');}
  if(r!==null){
    if(r>=52&&r<=72){up+=8;upReasons.push('5m RSI');signals.push('5m RSI bullish');}
    else if(r<=48&&r>=28){down+=8;downReasons.push('5m RSI');signals.push('5m RSI bearish');}
  }
  const direction=up>=down?'UP':'DOWN';
  const best=direction==='UP'?up:down;
  const opposing=direction==='UP'?down:up;
  const confidenceGap=Math.max(0,best-opposing);
  const score=Math.round(Math.min(100,45+best*0.95+Math.min(10,confidenceGap*0.10)));
  const probUp=Math.min(0.94,Math.max(0.06,0.50+(up-down)*0.008));
  return {score,upProbability:probUp,downProbability:1-probUp,reasons:direction==='UP'?upReasons:downReasons,signals,direction,atr:a,volumeRatio:1,confirmation:{score,bestWeight:best,confidenceGap,optionalMissing:c4?[]:['4H data']}};
}
`;
      code = code.slice(0,start)+replacement+code.slice(end);
    }

    /* Prefer Event entries in the 0.25-0.35 band. Theoretical expiry reward/risk is
       (1-entry)/entry for a correct binary settlement, so lower entry is preferred.
       We do not force a false 1:3 guarantee: 1:3 is reached at entry <= 0.25. */
    code = code.replace(
      "function validPrice(p){return Number.isFinite(p)&&p>=MIN_ENTRY_PRICE&&p<=MAX_ENTRY_PRICE;}",
      "const PREFERRED_ENTRY_MIN=0.25,PREFERRED_ENTRY_MAX=0.35,MAX_ENTRY_FOR_SELECTION=0.40,MIN_EXPIRY_RR=2.00; function expiryRewardRisk(p){return Number.isFinite(p)&&p>0&&p<1?(1-p)/p:0;} function validPrice(p){return Number.isFinite(p)&&p>=PREFERRED_ENTRY_MIN&&p<=MAX_ENTRY_FOR_SELECTION&&expiryRewardRisk(p)>=MIN_EXPIRY_RR;}"
    );

    /* Add explicit entry economics to each candidate and prefer the 0.25-0.35 band. */
    code = code.replace(
      "candidates.push({inst,seriesId:inst.seriesId,coin,underlying,side,entryPx,modelProb,marketProb:entryPx,edge,score:model.score,reasons:model.reasons,signals:model.signals,confirmation:model.confirmation,strikePx:strike,underlyingPrice:price,expiry:getExpiry(inst),minutesToExpiry:mins,atr:model.atr});",
      "const expiryRR=expiryRewardRisk(entryPx),preferredEntry=entryPx>=PREFERRED_ENTRY_MIN&&entryPx<=PREFERRED_ENTRY_MAX; candidates.push({inst,seriesId:inst.seriesId,coin,underlying,side,entryPx,modelProb,marketProb:entryPx,edge,score:model.score,reasons:model.reasons,signals:model.signals,confirmation:model.confirmation,strikePx:strike,underlyingPrice:price,expiry:getExpiry(inst),minutesToExpiry:mins,atr:model.atr,expiryRR,preferredEntry});"
    );

    code = code.replace(
      "console.log('[EVENT PASS]',JSON.stringify({instId:inst.instId,side,entryPx,score:model.score,model:Number((modelProb*100).toFixed(1)),edge:Number((edge*100).toFixed(1)),reasons:model.reasons,signals:model.signals}));",
      "console.log('[EVENT PASS]',JSON.stringify({instId:inst.instId,side,entryPx,expiryRR:Number(expiryRR.toFixed(2)),preferredEntry,score:model.score,model:Number((modelProb*100).toFixed(1)),edge:Number((edge*100).toFixed(1)),reasons:model.reasons,signals:model.signals}));"
    );

    code = code.replace(
      "return candidates.sort((a,b)=>b.edge-a.edge||b.score-a.score);",
      "return candidates.sort((a,b)=>Number(b.preferredEntry)-Number(a.preferredEntry)||b.expiryRR-a.expiryRR||b.edge-a.edge||b.score-a.score);"
    );

    const cooldownPatch = `const COOLDOWN_MS = 30 * 60 * 1000;
function riskBlocked(){
  resetDaily();
  if(state.cooldownUntil && Date.now() >= Number(state.cooldownUntil)){
    state.cooldownUntil = 0;
    state.halted = false;
    state.consecutiveLosses = 0;
    saveState();
    console.log('[RISK] 30-minute cooldown complete; trading resumed');
  }
  if(state.cooldownUntil && Date.now() < Number(state.cooldownUntil)) return true;
  if(state.halted || state.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES){
    state.halted = true;
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
    saveState();
    console.log('[RISK] 3 consecutive losses; cooldown 30 minutes');
    return true;
  }
  return false;
}`;

    code = code.replace(
      /function riskBlocked\(\)\{resetDaily\(\);return state\.halted\|\|state\.consecutiveLosses>=MAX_CONSECUTIVE_LOSSES;\}/,
      cooldownPatch
    );

    return code;
  }
  return result;
};

require('./event-bot-runner.js');
