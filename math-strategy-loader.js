'use strict';
const fs=require('fs');
const path=require('path');
const Module=require('module');

function buildSource(sourcePath){
  const source=fs.readFileSync(sourcePath,'utf8');
  const start=source.indexOf('async function scanCandidates()');
  const end=source.indexOf('\nfunction calcOrderSize',start);
  if(start<0||end<0) throw new Error('Cannot locate scanCandidates boundaries');
  const replacement=`async function scanCandidates(){
  const instruments=await discoverEventInstruments();
  const filtered=instruments.filter(inst=>{
    const coin=getBaseAsset(inst);
    return coin&&isUpDown(inst)&&(!inst.state||String(inst.state).toLowerCase()==='live')&&allowedExpiry(inst)&&!eventUsed(inst.instId);
  });
  const candidates=[]; const cache={};
  for(const inst of filtered){
    try{
      const coin=getBaseAsset(inst), underlying=UNDERLYING_MAP[coin];
      if(!cache[coin]) cache[coin]=await getCandles(underlying,'1H',100);
      const c1h=cache[coin]; if(!c1h.length) continue;
      const model=mathTrendModel(c1h); if(!model) continue;
      const t=await getTicker(inst.instId,'EVENTS');
      const yesAsk=Number(t?.askPx||t?.last), yesBid=Number(t?.bidPx||t?.last);
      if(!(yesAsk>0&&yesBid>0&&yesAsk<1&&yesBid<1)) continue;
      const side=model.direction==='UP'?'yes':'no';
      const entryPx=side==='yes'?yesAsk:1-yesBid;
      if(!validPrice(entryPx)) continue;

      const rr=(1-entryPx)/entryPx;
      const modelProb=model.probability;
      const ev=modelProb*(1-entryPx)-(1-modelProb)*entryPx;
      const breakEven=entryPx;
      const edge=modelProb-entryPx;
      const mins=minutesToExpiry(inst);
      if(!Number.isFinite(mins)) continue;

      const reject=[];
      if(model.score<MIN_SCORE) reject.push('score');
      if(modelProb<MIN_MODEL_PROB) reject.push('model');
      if(edge<MIN_EDGE) reject.push('edge');
      if(rr<1.5) reject.push('rr');
      if(ev<0.15) reject.push('ev');
      if(reject.length){
        console.log('[EVENT REJECT]',JSON.stringify({instId:inst.instId,reason:reject.join(','),direction:model.direction,side,entryPx,model:Number((modelProb*100).toFixed(1)),edge:Number((edge*100).toFixed(1)),rr:Number(rr.toFixed(3)),ev:Number(ev.toFixed(4)),breakEven:Number((breakEven*100).toFixed(1)),mins:Number(mins.toFixed(1))}));
        continue;
      }
      candidates.push({
        inst,seriesId:inst.seriesId,coin,underlying,side,entryPx,modelProb,
        marketProb:entryPx,edge,score:model.score,rr,ev,breakEven,
        signals:['1H MATH '+model.direction,'P '+(modelProb*100).toFixed(1)+'%','Z '+model.z.toFixed(3),'Edge '+(edge*100).toFixed(1)+'%','RR 1:'+rr.toFixed(2),'EV +'+ev.toFixed(3)+'U'],
        minutesToExpiry:mins,math:model
      });
      console.log('[EVENT PASS]',JSON.stringify({instId:inst.instId,direction:model.direction,side,entryPx,model:Number((modelProb*100).toFixed(1)),edge:Number((edge*100).toFixed(1)),rr:Number(rr.toFixed(3)),ev:Number(ev.toFixed(4)),breakEven:Number((breakEven*100).toFixed(1)),mins:Number(mins.toFixed(1))}));
    }catch(e){console.error('[EVENT CANDIDATE ERROR] '+inst.instId+':',e.message);}
  }
  return candidates.sort((a,b)=>b.ev-a.ev||b.edge-a.edge||b.score-a.score);
}`;
  return source.slice(0,start)+replacement+source.slice(end);
}

function load(){
  const target=path.join(__dirname,'event-bot.js');
  const patched=buildSource(target);
  const m=new Module(target,module);
  m.filename=target;
  m.paths=Module._nodeModulePaths(path.dirname(target));
  m._compile(patched,target);
  return m.exports;
}
module.exports={buildSource,load};
