'use strict';

/* OKX Event Contract launcher.
   4H = main direction, 15m = trend confirmation, 5m = entry signal.
   5m/15m events eligible. Entry preference 0.25-0.35.
   Risk: 3 consecutive losses -> 30 minute cooldown -> automatic resume. */

require('./runtime-diagnostics.js');
const fs=require('fs');
const originalReadFileSync=fs.readFileSync;

fs.readFileSync=function(file,encoding,...rest){
  const result=originalReadFileSync.call(fs,file,encoding,...rest);

  /* Telegram polling is intentionally disabled at the runtime boundary.
     Notifications still use bot.sendMessage(), but getUpdates is not started.
     This prevents Render/old instances from competing for the same Telegram
     update stream and producing ETELEGRAM 409 Conflict. */
  if(typeof file==='string'&&/event-bot-runner\.js$/.test(file)&&typeof result==='string'){
    return result.replace("code = code.replace(/polling\\s*:\\s*(true|false)/g, 'polling: true');","code = code.replace(/polling\\s*:\\s*(true|false)/g, 'polling: false');");
  }

  if(typeof file==='string'&&/event-bot\.js$/.test(file)&&typeof result==='string'){
    let code=result;

    code=code.replace("function getConfiguredSeries(){return EVENT_SERIES.split(',').map(x=>x.trim()).filter(Boolean);}","function getConfiguredSeries(){const configured=EVENT_SERIES.split(',').map(x=>x.trim()).filter(Boolean);return [...new Set([...configured,...ASSETS.flatMap(c=>[`${c}-UPDOWN-5MIN`,`${c}-UPDOWN-15MIN`])])];}");
    code=code.replace(/function generatedSeries\(\)\{return ASSETS\.map\(c=>`\$\{c\}-UPDOWN-15MIN`\);\}/,"function generatedSeries(){return ASSETS.flatMap(c=>[`${c}-UPDOWN-5MIN`,`${c}-UPDOWN-15MIN`]);}");

    code=code.replace("async function getCandles(instId,bar,limit=100){return confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit}));}","const __TF4H={}; async function getCandles(instId,bar,limit=100){const rows=confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit}));if(bar==='4H')__TF4H[instId]=rows;if(bar==='15m'){try{__TF4H[instId]=confirmed(await publicGet('/api/v5/market/candles',{instId,bar:'4H',limit:100}));}catch(e){console.error('[4H context]',e.message);}}return rows;}");

    const start=code.indexOf('function modelProbability('),end=code.indexOf('\nasync function getEquity(',start);
    if(start>=0&&end>start){
      const replacement=`function modelProbability(price,strike,c5,c15){
  const cl5=closes(c5),cl15=closes(c15),key=Object.keys(__TF4H).find(k=>__TF4H[k]===c15),c4=key?__TF4H[key]:null,cl4=c4?closes(c4):[];
  const e20_4=ema(cl4,20),e50_4=ema(cl4,50),e20_15=ema(cl15,20),e50_15=ema(cl15,50),e9_5=ema(cl5,9),e20_5=ema(cl5,20),r=rsi(cl5),a=atr(c5);
  const main4h=e20_4&&e50_4?(e20_4>e50_4?'UP':'DOWN'):null,trend15=e20_15&&e50_15?(e20_15>e50_15?'UP':'DOWN'):null,entry5=e9_5&&e20_5?(e9_5>e20_5?'UP':'DOWN'):null;
  if(main4h&&trend15&&main4h!==trend15)return{score:0,upProbability:.5,downProbability:.5,reasons:[],signals:['4H/15m direction conflict'],direction:null,atr:a,volumeRatio:1,confirmation:{score:0,bestWeight:0,confidenceGap:0,optionalMissing:['4H/15m conflict']}};
  let up=0,down=0;const ur=[],dr=[],signals=[];
  if(main4h==='UP'){up+=35;ur.push('4H main direction');signals.push('4H UP');}if(main4h==='DOWN'){down+=35;dr.push('4H main direction');signals.push('4H DOWN');}
  if(trend15==='UP'){up+=25;ur.push('15m trend confirmation');signals.push('15m UP');}if(trend15==='DOWN'){down+=25;dr.push('15m trend confirmation');signals.push('15m DOWN');}
  if(entry5==='UP'){up+=20;ur.push('5m entry signal');signals.push('5m ENTRY UP');}if(entry5==='DOWN'){down+=20;dr.push('5m entry signal');signals.push('5m ENTRY DOWN');}
  if(r!==null){if(r>=52&&r<=72){up+=8;ur.push('5m RSI');signals.push('5m RSI bullish');}else if(r<=48&&r>=28){down+=8;dr.push('5m RSI');signals.push('5m RSI bearish');}}
  const direction=up>=down?'UP':'DOWN',best=direction==='UP'?up:down,opp=direction==='UP'?down:up,gap=Math.max(0,best-opp),score=Math.round(Math.min(100,45+best*.95+Math.min(10,gap*.1))),probUp=Math.min(.94,Math.max(.06,.5+(up-down)*.008));
  return{score,upProbability:probUp,downProbability:1-probUp,reasons:direction==='UP'?ur:dr,signals,direction,atr:a,volumeRatio:1,confirmation:{score,bestWeight:best,confidenceGap:gap,optionalMissing:c4?[]:['4H data']}};
}
`;
      code=code.slice(0,start)+replacement+code.slice(end);
    }

    code=code.replace("function validPrice(p){return Number.isFinite(p)&&p>=MIN_ENTRY_PRICE&&p<=MAX_ENTRY_PRICE;}","const PREFERRED_ENTRY_MIN=.25,PREFERRED_ENTRY_MAX=.35,MAX_ENTRY_FOR_SELECTION=.40,MIN_EXPIRY_RR=2;function expiryRewardRisk(p){return Number.isFinite(p)&&p>0&&p<1?(1-p)/p:0;}function validPrice(p){return Number.isFinite(p)&&p>=PREFERRED_ENTRY_MIN&&p<=MAX_ENTRY_FOR_SELECTION&&expiryRewardRisk(p)>=MIN_EXPIRY_RR;}");
    code=code.replace("return candidates.sort((a,b)=>b.edge-a.edge||b.score-a.score);","return candidates.sort((a,b)=>Number(b.entryPx>=PREFERRED_ENTRY_MIN&&b.entryPx<=PREFERRED_ENTRY_MAX)-Number(a.entryPx>=PREFERRED_ENTRY_MIN&&a.entryPx<=PREFERRED_ENTRY_MAX)||expiryRewardRisk(b.entryPx)-expiryRewardRisk(a.entryPx)||b.edge-a.edge||b.score-a.score);");

    const cooldownPatch=`const COOLDOWN_MS=30*60*1000;
function riskBlocked(){
  resetDaily();
  if(state.cooldownUntil&&Date.now()>=Number(state.cooldownUntil)){state.cooldownUntil=0;state.halted=false;state.consecutiveLosses=0;saveState();console.log('[RISK] 30-minute cooldown complete; trading resumed');}
  if(state.cooldownUntil&&Date.now()<Number(state.cooldownUntil))return true;
  /* A stale halted flag from the old 2-loss/previous daily lock must not override the new 3-loss rule. */
  if(state.halted&&Number(state.consecutiveLosses)<MAX_CONSECUTIVE_LOSSES){state.halted=false;saveState();console.log('[RISK] cleared stale halt; consecutive losses below threshold');}
  if(Number(state.consecutiveLosses)>=MAX_CONSECUTIVE_LOSSES){state.halted=true;state.cooldownUntil=Date.now()+COOLDOWN_MS;saveState();console.log('[RISK] 3 consecutive losses; cooldown 30 minutes');return true;}
  return false;
}`;
    code=code.replace(/function riskBlocked\(\)\{resetDaily\(\);return state\.halted\|\|state\.consecutiveLosses>=MAX_CONSECUTIVE_LOSSES;\}/,cooldownPatch);
    return code;
  }
  return result;
};

require('./event-bot-runner.js');
