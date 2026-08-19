'use strict';

/*
  OKX Event Contract launcher.
  Runtime patch adds multi-timeframe signal architecture:
  4H = main direction, 15m = trend confirmation, 5m = entry signal.
  Both 5m and 15m event series are eligible.
*/

require('./runtime-diagnostics.js');

const fs = require('fs');
const originalReadFileSync = fs.readFileSync;

fs.readFileSync = function(file, encoding, ...rest) {
  const result = originalReadFileSync.call(fs, file, encoding, ...rest);
  if (typeof file === 'string' && /event-bot\.js$/.test(file) && typeof result === 'string') {
    let code = result;

    // Allow both 5m and 15m UPDOWN event series when auto-discovering.
    code = code.replace(
      /function generatedSeries\(\)\{return ASSETS\.map\(c=>`\$\{c\}-UPDOWN-15MIN`\);\}/,
      "function generatedSeries(){return ASSETS.flatMap(c=>[`${c}-UPDOWN-5MIN`,`${c}-UPDOWN-15MIN`]);}"
    );

    // Store the latest confirmed 4H candles for each underlying.
    code = code.replace(
      "async function getCandles(instId,bar,limit=100){return confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit}));}",
      "const __TF4H={}; async function getCandles(instId,bar,limit=100){const rows=confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit})); if(bar==='4H') __TF4H[instId]=rows; return rows;}"
    );

    // Make the existing 15m candle request also load 4H context.
    code = code.replace(
      "async function getCandles(instId,bar,limit=100){const rows=confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit})); if(bar==='4H') __TF4H[instId]=rows; return rows;}",
      "async function getCandles(instId,bar,limit=100){const rows=confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit})); if(bar==='4H') __TF4H[instId]=rows; if(bar==='15m'){try{__TF4H[instId]=confirmed(await publicGet('/api/v5/market/candles',{instId,bar:'4H',limit:100}));}catch(e){console.error('[4H context]',e.message);}} return rows;}"
    );

    // Replace the scoring function with strict hierarchy:
    // 4H direction -> 15m confirmation -> 5m entry trigger.
    const start = code.indexOf('function modelProbability(');
    const end = code.indexOf('\nasync function getEquity(', start);
    if (start >= 0 && end > start) {
      const replacement = `function modelProbability(price,strike,c5,c15){
  const cl5=closes(c5),cl15=closes(c15);
  const instKey=Object.keys(__TF4H).find(k=>__TF4H[k]===c15)||Object.keys(__TF4H).find(k=>__TF4H[k]&&__TF4H[k].length===c15.length);
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
  return {score,upProbability:probUp,downProbability:1-probUp,reasons:direction==='UP'?upReasons:downReasons,signals,direction,atr:a,volumeRatio:1,confirmation:{score,bestWeight:best,confidenceGap,optionalMissing:c4?'[]':['4H data']}};
}
`;
      code = code.slice(0,start)+replacement+code.slice(end);
    }

    return code;
  }
  return result;
};

require('./event-bot-runner.js');
