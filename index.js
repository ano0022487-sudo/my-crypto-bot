'use strict';

/* OKX Event Contract launcher / safety patch.
   4H + 15m define the main trend; 5m is an entry confirmation.
   PAPER risk: 1U stake, 3 consecutive losses -> 30m cooldown.
   CORE STRATEGY: EV = P / Entry - 1. */

require('./runtime-diagnostics.js');
const fs=require('fs');
const path=require('path');
const source=path.join(__dirname,'event-bot.js');
const originalReadFileSync=fs.readFileSync;

fs.readFileSync=function(file,encoding,...rest){
  const result=originalReadFileSync.call(fs,file,encoding,...rest);
  if(typeof file==='string'&&/event-bot-runner\\.js$/.test(file)&&typeof result==='string'){
    return result.replace("code = code.replace(/polling\\s*:\\s*(true|false)/g, 'polling: true');","code = code.replace(/polling\\s*:\\s*(true|false)/g, 'polling: false');");
  }
  if(typeof file==='string'&&/event-bot\\.js$/.test(file)&&typeof result==='string'){
    let code=result;
    code=code.replace("function getConfiguredSeries(){return EVENT_SERIES.split(',').map(x=>x.trim()).filter(Boolean);}","function getConfiguredSeries(){const configured=EVENT_SERIES.split(',').map(x=>x.trim()).filter(Boolean);return [...new Set([...configured,...ASSETS.flatMap(c=>[`${c}-UPDOWN-5MIN`,`${c}-UPDOWN-15MIN`])])];}");
    code=code.replace(/function generatedSeries\\(\\)\\{return ASSETS\\.map\\(c=>`\\$\\{c\\}-UPDOWN-15MIN`\\);\\}/,"function generatedSeries(){return ASSETS.flatMap(c=>[`${c}-UPDOWN-5MIN`,`${c}-UPDOWN-15MIN`]);}");
    code=code.replace("async function getCandles(instId,bar,limit=100){return confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit}));}","let __LAST4H=[]; async function getCandles(instId,bar,limit=100){const rows=confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit}));if(bar==='15m'){try{__LAST4H=confirmed(await publicGet('/api/v5/market/candles',{instId,bar:'4H',limit:100}));}catch(e){__LAST4H=[];console.error('[4H context]',e.message);}}return rows;}");
    const start=code.indexOf('function modelProbability(');
    const end=code.indexOf('\\nasync function getEquity(',start);
    if(start<0||end<=start)throw new Error('[SAFETY PATCH] modelProbability boundary not found');
    const replacement=`function modelProbability(price,strike,c5,c15){
  const cl5=closes(c5),cl15=closes(c15),cl4=closes(__LAST4H),vol=volumes(c5);
  const e20_4=ema(cl4,20),e50_4=ema(cl4,50),e20_15=ema(cl15,20),e50_15=ema(cl15,50),e9_5=ema(cl5,9),e20_5=ema(cl5,20),r=rsi(cl5),a=atr(c5);
  const main4h=e20_4&&e50_4?(e20_4>e50_4?'UP':'DOWN'):null;
  const trend15=e20_15&&e50_15?(e20_15>e50_15?'UP':'DOWN'):null;
  const entry5=e9_5&&e20_5?(e9_5>e20_5?'UP':'DOWN'):null;
  if(!main4h||!trend15||!entry5)return{score:0,upProbability:.5,downProbability:.5,reasons:[],signals:['insufficient multi-timeframe data'],direction:null,atr:a,volumeRatio:1,confirmation:{score:0,bestWeight:0,confidenceGap:0,optionalMissing:['4H/15m/5m data']}};
  if(main4h!==trend15)return{score:0,upProbability:.5,downProbability:.5,reasons:[],signals:['4H/15m conflict: 4H='+main4h+',15m='+trend15+',5m='+entry5],direction:null,atr:a,volumeRatio:1,confirmation:{score:0,bestWeight:0,confidenceGap:0,optionalMissing:['4H/15m direction conflict']}};
  const direction=main4h;
  let score=60;
  const reasons=['4H '+main4h,'15m '+trend15];
  const signals=['4H='+main4h,'15m='+trend15,'5m='+entry5];
  if(entry5===direction){score+=15;reasons.push('5m entry confirmation');}else{score-=5;reasons.push('5m counter-trend caution');}
  if(r!==null){if((direction==='UP'&&r>=55&&r<=72)||(direction==='DOWN'&&r<=45&&r>=28)){score+=8;reasons.push('RSI confirmation');signals.push('RSI '+r.toFixed(1));}else if((direction==='UP'&&r<45)||(direction==='DOWN'&&r>55)){score-=6;reasons.push('RSI conflict');}}
  const avgVol=vol.length?vol.slice(-20).reduce((x,y)=>x+y,0)/Math.min(20,vol.length):0;
  const vr=avgVol>0?(vol.at(-1)||0)/avgVol:1;
  if(vr>=1.15){score+=7;reasons.push('volume confirmation');signals.push('volume '+vr.toFixed(2)+'x');}
  if(strike&&a&&a>0){const dist=(price-strike)/a;if((direction==='UP'&&dist>=0.75)||(direction==='DOWN'&&dist<=-0.75)){score+=10;reasons.push('strike distance confirmation');signals.push('strike '+dist.toFixed(2)+' ATR');}}
  score=Math.round(Math.max(0,Math.min(100,score)));
  const probability=Math.min(.84,Math.max(.60,.60+(score-60)*.006));
  return{score,upProbability:direction==='UP'?probability:1-probability,downProbability:direction==='DOWN'?probability:1-probability,reasons,signals,direction,atr:a,volumeRatio:vr,confirmation:{score,bestWeight:score,confidenceGap:Math.max(0,score-60),optionalMissing:entry5===direction?[]:['5m counter-trend caution']}};
}
`;
    code=code.slice(0,start)+replacement+code.slice(end);
    code=code.replace("const MIN_EDGE=0.15;","const MIN_EDGE=0;");
    code=code.replace("function validPrice(p){return Number.isFinite(p)&&p>=MIN_ENTRY_PRICE&&p<=MAX_ENTRY_PRICE;}","const PREFERRED_ENTRY_MIN=.25,PREFERRED_ENTRY_MAX=.35,MAX_ENTRY_FOR_SELECTION=.40,MIN_EXPIRY_RR=2;function expiryRewardRisk(p){return Number.isFinite(p)&&p>0&&p<1?(1-p)/p:0;}function validPrice(p){return Number.isFinite(p)&&p>=PREFERRED_ENTRY_MIN&&p<=MAX_ENTRY_FOR_SELECTION&&expiryRewardRisk(p)>=MIN_EXPIRY_RR;}");
    code=code.replace("const yesValid=validPrice(yesEntry),noValid=validPrice(noEntry),yesEdge=yesValid?model.upProbability-yesEntry:-Infinity,noEdge=noValid?model.downProbability-noEntry:-Infinity;","const yesValid=validPrice(yesEntry),noValid=validPrice(noEntry),yesEdge=yesValid&&yesEntry>0?model.upProbability/yesEntry-1:-Infinity,noEdge=noValid&&noEntry>0?model.downProbability/noEntry-1:-Infinity;");
    code=code.replace("return candidates.sort((a,b)=>b.edge-a.edge||b.score-a.score);","return candidates.sort((a,b)=>b.edge-a.edge||b.score-a.score);");
    return code;
  }
  return result;
};

if(!fs.existsSync(source))throw new Error('找不到 event-bot.js: '+source);
console.log('[SAFETY] PAPER launcher loaded');
console.log('[STRATEGY] CORE = EV = P / Entry - 1');
console.log('[STRATEGY] Score is diagnostic only; NO Score>=90 entry gate');
console.log('[STRATEGY] EV > 0 required; candidates ranked by EV');
console.log('[SAFETY] Trend context: 4H + 15m; 5m confirmation only');
console.log('[SAFETY] 1U / Model>=75% / EV>0 / Entry 0.25-0.40 / expiry RR>=2');
console.log('[SAFETY] 3 consecutive losses -> 30 minute cooldown');

require('./event-bot-runner.js');