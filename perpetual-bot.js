'use strict';
const express=require('express');
const axios=require('axios');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');

const app=express();
const PORT=Number(process.env.PORT||10000);
const LIVE=String(process.env.LIVE_TRADING||'false').toLowerCase()==='true';
const BASE_URL=String(process.env.OKX_BASE_URL||'https://www.okx.com').replace(/\/$/,'');
const KEY=String(process.env.OK_ACCESS_KEY||'').trim();
const SECRET=String(process.env.OK_ACCESS_SECRET||'').trim();
const PASS=String(process.env.OKX_PASSPHRASE||'').trim();
const TG_TOKEN=String(process.env.TELEGRAM_BOT_TOKEN||'').trim().replace(/[\"']/g,'');
const TG_CHAT=String(process.env.TELEGRAM_CHAT_ID||'').trim();

// Perpetual contract risk configuration.
const MARGIN=5;
const LEVERAGE=3;
const NOTIONAL=MARGIN*LEVERAGE;
const MIN_PROB=Number(process.env.MIN_MODEL_PROB||0.75);
const TP_PCT=Number(process.env.PERP_TP_PCT||0.024); // 2.4% price move
const SL_PCT=Number(process.env.PERP_SL_PCT||0.008); // 0.8% price move; 1:3 RR
const LOOP=Math.max(10000,Number(process.env.CHECK_INTERVAL||15000));
const POS_LOOP=Math.max(3000,Number(process.env.POSITION_CHECK_INTERVAL||5000));
const MAXLOSS=3;
const COOLDOWN=30*60*1000;
const DAILY_LOSS_LIMIT=Number(process.env.DAILY_LOSS_LIMIT||0.10);
const STATE=process.env.BOT_STATE_FILE||path.join(__dirname,'bot-state.json');
const ASSETS=['BTC','ETH','SOL'];
const UNDER={BTC:'BTC-USDT-SWAP',ETH:'ETH-USDT-SWAP',SOL:'SOL-USDT-SWAP'};

const log=(x,v)=>console.log(v===undefined?x:x+' '+(typeof v==='string'?v:JSON.stringify(v)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const query=o=>Object.entries(o).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');

async function http(c){let e;for(let n=0;n<3;n++){try{return await axios({timeout:15000,...c});}catch(x){e=x;if(n<2)await sleep(400*(n+1));}}throw e;}
async function pub(ep,p={}){const s=query(p),r=await http({method:'GET',url:BASE_URL+ep+(s?'?'+s:'')});if(!r.data||String(r.data.code)!=='0')throw Error('OKX public '+r.status+': '+JSON.stringify(r.data));return Array.isArray(r.data.data)?r.data.data:[];}
function sig(ts,m,r,b){return crypto.createHmac('sha256',SECRET).update(ts+m.toUpperCase()+r+b).digest('base64');}
async function priv(m,r,obj){if(!KEY||!SECRET||!PASS)throw Error('OKX credentials missing');const ts=new Date().toISOString(),b=obj?JSON.stringify(obj):'',h={'OK-ACCESS-KEY':KEY,'OK-ACCESS-SIGN':sig(ts,m,r,b),'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':PASS,'Content-Type':'application/json'},x=await http({method:m,url:BASE_URL+r,data:b||undefined,headers:h});if(!x.data||String(x.data.code)!=='0')throw Error('OKX private '+x.status+': '+JSON.stringify(x.data));return Array.isArray(x.data.data)?x.data.data:[];}

function fresh(){return{day:new Date().toISOString().slice(0,10),paperEquity:20,realizedPnl:0,consecutiveLosses:0,cooldownUntil:0,halted:false,position:null,trades:[]};}
function load(){try{if(!fs.existsSync(STATE))return fresh();const s=JSON.parse(fs.readFileSync(STATE,'utf8'));return{...fresh(),...s,trades:Array.isArray(s.trades)?s.trades:[]};}catch(e){return fresh();}}
const state=load();
function save(){try{const t=STATE+'.tmp';fs.writeFileSync(t,JSON.stringify(state,null,2));fs.renameSync(t,STATE);}catch(e){console.error('[STATE]',e.message);}}
function recalc(){let p=0,l=0;for(const t of state.trades)p+=Number(t.pnl||0);for(let i=state.trades.length-1;i>=0;i--){const x=Number(state.trades[i].pnl||0);if(x<0)l++;else if(x>0)break;}state.realizedPnl=Number(p.toFixed(4));state.consecutiveLosses=l;if(!LIVE)state.paperEquity=Number(Math.max(0,20+state.realizedPnl).toFixed(4));}
function blocked(){recalc();const n=Date.now();if(state.cooldownUntil){if(n<state.cooldownUntil){state.halted=true;return true;}state.cooldownUntil=0;state.consecutiveLosses=0;}if(state.consecutiveLosses>=MAXLOSS){state.cooldownUntil=n+COOLDOWN;state.halted=true;save();return true;}if(state.realizedPnl<=-(20*DAILY_LOSS_LIMIT)){state.halted=true;save();return true;}state.halted=false;return false;}

function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0;}
function sd(a,m){return a.length<2?1e-8:Math.max(Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length),1e-8);}
function pdf(x,m,s){const d=Math.max(s,1e-8),z=(x-m)/d;return Math.exp(-.5*z*z)/(d*Math.sqrt(2*Math.PI));}
function confirmed(a){return a.slice().sort((x,y)=>Number(x[0])-Number(y[0])).filter(x=>String(x[8])==='1');}
async function candles(id,bar,limit=100){return confirmed(await pub('/api/v5/market/candles',{instId:id,bar,limit}));}
async function ticker(id){return(await pub('/api/v5/market/ticker',{instId:id}))[0]||null;}

// Same mathematical Bayesian core as the previous bot, now applied to perpetual prices.
function bayes(rows,min=25){
  const p=rows.map(x=>Number(x[4])).filter(Number.isFinite);if(p.length<min)return null;
  const r=[];for(let i=1;i<p.length;i++)if(p[i]>0&&p[i-1]>0)r.push(Math.log(p[i]/p[i-1]));
  if(r.length<20)return null;const up=r.filter(x=>x>0),dn=r.filter(x=>x<=0);if(!up.length||!dn.length)return null;
  const prior=(up.length+1)/(r.length+2),x=r[r.length-1],muU=mean(up),muD=mean(dn),sU=sd(up,muU),sD=sd(dn,muD),lu=pdf(x,muU,sU),ld=pdf(x,muD,sD),den=lu*prior+ld*(1-prior),pU=den>0?lu*prior/den:prior;
  return{direction:pU>=.5?'LONG':'SHORT',pLong:pU,probability:pU>=.5?pU:1-pU,evidence:x};
}
function logit(p){p=Math.min(.999999,Math.max(.000001,p));return Math.log(p/(1-p));}
function sigmoid(x){return 1/(1+Math.exp(-x));}
function fuse(h1,h15,h5){if(!h1||!h15||!h5)return null;const p=sigmoid(.50*logit(h1.pLong)+.25*logit(h15.pLong)+.25*logit(h5.pLong));return{direction:h1.direction,pLong:p,probability:h1.direction==='LONG'?p:1-p,oneH:h1,fifteenM:h15,fiveM:h5};}

async function instrument(id){const a=await pub('/api/v5/public/instruments',{instType:'SWAP',instId:id});return a[0]||null;}
function decimals(step){const s=String(step);if(s.includes('e-'))return Number(s.split('e-')[1]);return Math.max(0,(s.split('.')[1]||'').length);}
function roundStep(x,step){step=Number(step);if(!(step>0))return Number(x.toFixed(8));return Number((Math.floor(x/step)*step).toFixed(decimals(step)));}
function roundPrice(x,tick){tick=Number(tick);if(!(tick>0))return Number(x.toFixed(8));return Number((Math.round(x/tick)*tick).toFixed(decimals(tick)));}
function qtyForNotional(price,i){const ctVal=Number(i.ctVal||1),lot=Number(i.lotSz||1),min=Number(i.minSz||lot);let q=NOTIONAL/(price*ctVal);q=roundStep(q,lot);if(q<min)q=min;return Number(q.toFixed(8));}

async function setLeverage(id,posSide){
  if(!LIVE)return;
  const body={instId:id,lever:String(LEVERAGE),mgnMode:'isolated'};
  if(posSide)body.posSide=posSide;
  await priv('POST','/api/v5/account/set-leverage',body);
}
async function placeMarket(id,side,sz,posSide){
  const body={instId:id,tdMode:'isolated',side,ordType:'market',sz:String(sz),ccy:'USDT'};
  if(posSide)body.posSide=posSide;
  if(!LIVE)return{ordId:'PAPER-'+Date.now(),avgPx:null,fillSz:String(sz)};
  const r=(await priv('POST','/api/v5/trade/order',body))[0];
  if(!r||String(r.sCode)!=='0'||!r.ordId)throw Error('Order rejected: '+JSON.stringify(r));
  return r;
}

async function notify(text){
  if(!TG_TOKEN||!TG_CHAT)return;
  try{await http({method:'POST',url:`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,data:{chat_id:TG_CHAT,text}});}catch(e){console.error('[TELEGRAM]',e.message);}
}

async function scan(){
  if(blocked()||state.position)return null;
  const candidates=[];
  for(const a of ASSETS){
    try{
      const id=UNDER[a], [h1,m15,m5,t,i]=await Promise.all([candles(id,'1H'),candles(id,'15m'),candles(id,'5m'),ticker(id),instrument(id)]);
      const h=bayes(h1,25),m=bayes(m15,30),f=bayes(m5,30);if(!h||!m||!f)continue;
      if(h.direction!==m.direction||h.direction!==f.direction)continue;
      const model=fuse(h,m,f);if(!model||model.probability<MIN_PROB)continue;
      const price=Number(t?.last);if(!(price>0))continue;
      candidates.push({asset:a,instId:id,price,instrument:i,model});
    }catch(e){console.error('[SCAN]',a,e.message);}
  }
  candidates.sort((a,b)=>b.model.probability-a.model.probability);
  return candidates[0]||null;
}

async function openPosition(c){
  const i=c.instrument,price=c.price,side=c.model.direction==='LONG'?'buy':'sell',posSide=c.model.direction==='LONG'?'long':'short';
  const sz=qtyForNotional(price,i);if(!(sz>0))throw Error('Invalid contract size');
  await setLeverage(c.instId,posSide);
  const order=await placeMarket(c.instId,side,sz,posSide);
  const entry=Number(order.avgPx||price);
  const tp=c.model.direction==='LONG'?entry*(1+TP_PCT):entry*(1-TP_PCT);
  const sl=c.model.direction==='LONG'?entry*(1-SL_PCT):entry*(1+SL_PCT);
  state.position={asset:c.asset,instId:c.instId,direction:c.model.direction,posSide,size:sz,entryPx:entry,tp,sl,probability:c.model.probability,openedAt:new Date().toISOString(),margin:MARGIN,leverage:LEVERAGE,notional:NOTIONAL};
  save();
  await notify(`🟡 PERPETUAL ENTRY\n${c.instId}\n${c.model.direction}\nEntry ${entry}\nMargin ${MARGIN.toFixed(2)}U\nLeverage ${LEVERAGE}x\nNotional ${NOTIONAL.toFixed(2)}U\nSize ${sz}\nModel ${(c.model.probability*100).toFixed(1)}%\nTP ${tp}\nSL ${sl}\n${LIVE?'LIVE':'PAPER'}`);
  log('[ENTRY]',state.position);
}

async function closePosition(reason,marketPrice){
  const p=state.position;if(!p)return;
  const side=p.direction==='LONG'?'sell':'buy';
  const order=await placeMarket(p.instId,side,p.size,p.posSide);
  const exit=Number(order.avgPx||marketPrice);
  const raw=p.direction==='LONG'?(exit-p.entryPx)*p.size*Number(p.instrumentCtVal||1):(p.entryPx-exit)*p.size*Number(p.instrumentCtVal||1);
  const pnl=Number(raw.toFixed(4));
  state.trades.push({at:new Date().toISOString(),instId:p.instId,direction:p.direction,entryPx:p.entryPx,exitPx:exit,size:p.size,margin:MARGIN,leverage:LEVERAGE,pnl,reason,probability:p.probability});
  state.position=null;recalc();if(state.consecutiveLosses>=MAXLOSS)state.cooldownUntil=Date.now()+COOLDOWN;save();
  await notify(`${pnl>=0?'🟢':'🔴'} PERPETUAL EXIT\n${p.instId}\n${p.direction}\nEntry ${p.entryPx}\nExit ${exit}\nMargin ${MARGIN.toFixed(2)}U\n3x\nPnL ${pnl>=0?'+':''}${pnl.toFixed(4)}U\n${reason}\n${LIVE?'LIVE':'PAPER'}`);
}

async function manage(){
  const p=state.position;if(!p)return;
  try{
    const t=await ticker(p.instId),price=Number(t?.last);if(!(price>0))return;
    if((p.direction==='LONG'&&price>=p.tp)||(p.direction==='SHORT'&&price<=p.tp))return closePosition('TAKE PROFIT',price);
    if((p.direction==='LONG'&&price<=p.sl)||(p.direction==='SHORT'&&price>=p.sl))return closePosition('STOP LOSS',price);
  }catch(e){console.error('[MANAGE]',e.message);}
}

async function mainLoop(){try{const c=await scan();if(c){log('[SIGNAL]',{asset:c.asset,direction:c.model.direction,probability:Number((c.model.probability*100).toFixed(1)),price:c.price});await openPosition(c);}else log('[SCAN RESULT] no qualifying perpetual signal');}catch(e){console.error('[MAIN]',e.stack||e.message);}}

app.get('/',(req,res)=>res.json({ok:true,bot:'OKX Perpetual Bot',mode:LIVE?'LIVE':'PAPER',margin:MARGIN,leverage:LEVERAGE,notional:NOTIONAL,position:state.position?{instId:state.position.instId,direction:state.position.direction,entryPx:state.position.entryPx}:null}));
app.get('/health',(req,res)=>res.json({ok:true,time:new Date().toISOString()}));
app.listen(PORT,()=>console.log(`OKX PERPETUAL BOT RUNNING ON PORT ${PORT}`));

(async()=>{console.log('[BOOT] OKX Perpetual Contract Bot');console.log(`[BOOT] mode=${LIVE?'LIVE':'PAPER'} margin=${MARGIN}U leverage=${LEVERAGE}x notional=${NOTIONAL}U`);await sleep(1000);await mainLoop();setInterval(mainLoop,LOOP);setInterval(manage,POS_LOOP);})();
