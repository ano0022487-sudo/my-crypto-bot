'use strict';

/* OKX EVENT CONTRACT SNR BOT - FIXED 5U / ONE ENTRY PER EVENT */
const express=require('express');
const axios=require('axios');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const TelegramBot=require('node-telegram-bot-api');
const app=express(); app.use(express.json());

const PORT=Number(process.env.PORT||3000);
const LIVE_TRADING=String(process.env.LIVE_TRADING||'false').toLowerCase()==='true';
const API_KEY=String(process.env.OK_ACCESS_KEY||'').trim();
const SECRET_KEY=String(process.env.OK_ACCESS_SECRET||'').trim();
const PASSPHRASE=String(process.env.OKX_PASSPHRASE||'').trim();
const BASE_URL=String(process.env.OKX_BASE_URL||'https://www.okx.com').replace(/\/$/,'');
const TG_TOKEN=String(process.env.TELEGRAM_BOT_TOKEN||'').trim().replace(/["']/g,'');
const TG_CHAT=String(process.env.TELEGRAM_CHAT_ID||'').trim();
const CHECK_INTERVAL=Number(process.env.CHECK_INTERVAL||15000);
const POSITION_CHECK_INTERVAL=Number(process.env.POSITION_CHECK_INTERVAL||5000);
const START_CAPITAL=Number(process.env.START_CAPITAL||20);
const TARGET_STAKE=5;
const MIN_EDGE=Number(process.env.MIN_EDGE||0.10);
const MIN_SCORE=Number(process.env.MIN_SCORE||85);
const MIN_MODEL_PROB=Number(process.env.MIN_MODEL_PROB||0.70);
const MIN_ENTRY_PRICE=Number(process.env.MIN_ENTRY_PRICE||0.15);
const MAX_ENTRY_PRICE=Number(process.env.MAX_ENTRY_PRICE||0.90);
const EARLY_TP_PCT=Number(process.env.EARLY_TP_PCT||0.30);
const EARLY_SL_PCT=Number(process.env.EARLY_SL_PCT||0.25);
const MIN_MINUTES_TO_EXPIRY=Number(process.env.MIN_MINUTES_TO_EXPIRY||2);
const MAX_MINUTES_TO_EXPIRY=Number(process.env.MAX_MINUTES_TO_EXPIRY||20);
const DAILY_LOSS_PCT=Number(process.env.DAILY_LOSS_PCT||0.20);
const MAX_CONSECUTIVE_LOSSES=Number(process.env.MAX_CONSECUTIVE_LOSSES||3);
const EVENT_SERIES=String(process.env.EVENT_SERIES||'').trim();
const AUTO_DISCOVER_SERIES=String(process.env.AUTO_DISCOVER_SERIES||'true').toLowerCase()==='true';
const BOT_STATE_FILE=process.env.BOT_STATE_FILE||path.join(__dirname,'event-bot-state.json');
const ASSETS=['BTC','ETH','SOL'];
const UNDERLYING_MAP={BTC:'BTC-USDT-SWAP',ETH:'ETH-USDT-SWAP',SOL:'SOL-USDT-SWAP'};
const bot=TG_TOKEN?new TelegramBot(TG_TOKEN,{polling:true}):null;
async function notify(text){if(!bot||!TG_CHAT)return;try{await bot.sendMessage(TG_CHAT,text);}catch(e){console.error('[Telegram]',e.message);}}
if(bot)bot.on('polling_error',e=>console.error('[Telegram polling_error]',e.message));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function q(p){return Object.entries(p).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');}
async function request(config,retries=3){let last;for(let i=0;i<retries;i++){try{return await axios({timeout:15000,...config});}catch(e){last=e;if(i<retries-1)await sleep(500*(i+1));}}throw last;}
async function publicGet(pathname,params={}){const query=q(params);const rp=query?`${pathname}?${query}`:pathname;const r=await request({method:'GET',url:`${BASE_URL}${rp}`});if(!r.data||String(r.data.code)!=='0')throw new Error(`OKX public ${r.status}: ${JSON.stringify(r.data)}`);return r.data.data;}
function sign(ts,method,rp,body){return crypto.createHmac('sha256',SECRET_KEY).update(ts+method.toUpperCase()+rp+body).digest('base64');}
async function privateRequest(method,rp,bodyObj=null){if(!API_KEY||!SECRET_KEY||!PASSPHRASE)throw new Error('OKX API credentials missing');const ts=new Date().toISOString();const body=bodyObj?JSON.stringify(bodyObj):'';const headers={'OK-ACCESS-KEY':API_KEY,'OK-ACCESS-SIGN':sign(ts,method,rp,body),'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':PASSPHRASE,'Content-Type':'application/json'};const r=await request({method,url:`${BASE_URL}${rp}`,data:body||undefined,headers});if(!r.data||String(r.data.code)!=='0')throw new Error(`OKX private ${r.status}: ${JSON.stringify(r.data)}`);return Array.isArray(r.data.data)?r.data.data:[];}

function freshState(){return{day:new Date().toISOString().slice(0,10),startEquity:START_CAPITAL,paperEquity:START_CAPITAL,realizedPnl:0,consecutiveLosses:0,halted:false,lastTradeAt:0,position:null,trades:[],usedEvents:[]};}
function loadState(){try{if(!fs.existsSync(BOT_STATE_FILE))return freshState();const d=JSON.parse(fs.readFileSync(BOT_STATE_FILE,'utf8'));return{...freshState(),...d,usedEvents:Array.isArray(d.usedEvents)?d.usedEvents:[]};}catch(e){console.error('[State load]',e.message);return freshState();}}
const state=loadState();
function saveState(){try{fs.writeFileSync(BOT_STATE_FILE,JSON.stringify(state,null,2),'utf8');}catch(e){console.error('[State save]',e.message);}}
function resetDaily(){const today=new Date().toISOString().slice(0,10);if(state.day!==today){state.day=today;state.startEquity=LIVE_TRADING?0:Number(state.paperEquity||START_CAPITAL);state.realizedPnl=0;state.consecutiveLosses=0;state.halted=false;saveState();}}
function riskBlocked(){resetDaily();return state.halted||state.consecutiveLosses>=MAX_CONSECUTIVE_LOSSES;}
function eventUsed(instId){return state.usedEvents.includes(instId);}
function markEventUsed(instId){if(!eventUsed(instId)){state.usedEvents.push(instId);if(state.usedEvents.length>2000)state.usedEvents=state.usedEvents.slice(-2000);saveState();}}

function closes(c){return c.map(x=>Number(x[4])).filter(Number.isFinite);}
function highs(c){return c.map(x=>Number(x[2])).filter(Number.isFinite);}
function lows(c){return c.map(x=>Number(x[3])).filter(Number.isFinite);}
function volumes(c){return c.map(x=>Number(x[5])).filter(Number.isFinite);}
function ema(v,p){if(v.length<p)return null;const m=2/(p+1);let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<v.length;i++)x=v[i]*m+x*(1-m);return x;}
function rsi(v,p=14){if(v.length<p+1)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];if(d>=0)g+=d;else l-=d;}let ag=g/p,al=l/p;for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}return al===0?100:100-100/(1+ag/al);}
function atr(c,p=14){if(c.length<p+1)return null;let trs=[];for(let i=1;i<c.length;i++){const h=Number(c[i][2]),l=Number(c[i][3]),pc=Number(c[i-1][4]);trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}return trs.slice(-p).reduce((a,b)=>a+b,0)/Math.min(p,trs.length);}
function confirmed(c){return c.slice().sort((a,b)=>Number(a[0])-Number(b[0])).filter(x=>String(x[8])==='1');}
function pivots(c,lb=3){const h=highs(c),l=lows(c),r=[],s=[];for(let i=lb;i<c.length-lb;i++){const hi=Math.max(...h.slice(i-lb,i+lb+1)),lo=Math.min(...l.slice(i-lb,i+lb+1));if(h[i]===hi)r.push(h[i]);if(l[i]===lo)s.push(l[i]);}return{resistance:r.slice(-10),support:s.slice(-10)};}
function nearestAbove(levels,p){return levels.filter(x=>x>p).sort((a,b)=>a-b)[0]||null;}
async function getCandles(instId,bar,limit=100){return confirmed(await publicGet('/api/v5/market/candles',{instId,bar,limit}));}
async function getTicker(instId,instType='EVENTS'){const p={instId};if(instType)p.instType=instType;const r=await publicGet('/api/v5/market/ticker',p);return r?.[0]||null;}

function getConfiguredSeries(){return EVENT_SERIES.split(',').map(x=>x.trim()).filter(Boolean);}
function generatedSeries(){return ASSETS.map(c=>`${c}-UPDOWN-15MIN`);}
function parseExpiryFromInstId(instId){const m=String(instId||'').toUpperCase().match(/-(\d{6})-(\d{4})-(\d{4})$/);if(!m)return null;const d=m[1],e=m[3];return Date.UTC(2000+Number(d.slice(0,2)),Number(d.slice(2,4))-1,Number(d.slice(4,6)),Number(e.slice(0,2)),Number(e.slice(2,4)),0,0);}
function getExpiry(inst){const v=[Number(inst.expTime),Number(inst.expiryTime),Number(inst.endTime)].filter(Number.isFinite);return v.length?Math.max(...v):parseExpiryFromInstId(inst.instId);}
function minutesToExpiry(inst){const e=getExpiry(inst);return Number.isFinite(e)?(e-Date.now())/60000:null;}
function allowedExpiry(inst){const m=minutesToExpiry(inst);return Number.isFinite(m)&&m>=MIN_MINUTES_TO_EXPIRY&&m<=MAX_MINUTES_TO_EXPIRY;}
async function getEventInstruments(seriesId){return publicGet('/api/v5/public/instruments',{instType:'EVENTS',seriesId});}
async function discoverEventInstruments(){let series=getConfiguredSeries();if(!series.length&&AUTO_DISCOVER_SERIES)series=generatedSeries();if(!series.length)throw new Error('No EVENT series configured');const all=[];for(const s of series){try{const rows=await getEventInstruments(s);if(Array.isArray(rows))for(const inst of rows)all.push({...inst,seriesId:inst.seriesId||s});}catch(e){console.error(`[EVENT] ${s}:`,e.message);}}return all;}
function getBaseAsset(inst){const text=`${inst.baseCcy||''} ${inst.instId||''} ${inst.seriesId||''}`.toUpperCase();return ASSETS.find(c=>text.includes(c))||null;}
function isUpDown(inst){return `${inst.instId||''} ${inst.seriesId||''}`.toUpperCase().includes('UPDOWN');}
function getStrike(inst){for(const k of ['stk','strike','strikePx','targetPx','triggerPx']){const n=Number(inst[k]);if(Number.isFinite(n)&&n>0)return n;}return null;}
function roundToTick(price,tick){if(!(tick>0))return price;const d=Math.max(0,(String(tick).split('.')[1]||'').length);return Number((Math.round(price/tick)*tick).toFixed(d));}
function validPrice(p){return Number.isFinite(p)&&p>=MIN_ENTRY_PRICE&&p<=MAX_ENTRY_PRICE;}

/* Weighted confirmation: trend is core; RSI/volume/SNR/strike are confirmations, not hard gates. */
function modelProbability(price,strike,c5,c15){
  const cl5=closes(c5),cl15=closes(c15),vol=volumes(c5),p5=pivots(c5),p15=pivots(c15);
  const e20_5=ema(cl5,20),e50_5=ema(cl5,50),e20_15=ema(cl15,20),e50_15=ema(cl15,50);
  const r=rsi(cl5),a=atr(c5);
  const avgVol=vol.slice(-20).reduce((x,y)=>x+y,0)/(Math.min(20,vol.length)||1);
  const vr=avgVol>0?(vol.at(-1)||0)/avgVol:1;
  let up=0,down=0;
  const upReasons=[],downReasons=[],signals=[];
  if(e20_5&&e50_5){
    if(e20_5>e50_5){up+=15;upReasons.push('5m trend');signals.push('5m trend UP');}
    else{down+=15;downReasons.push('5m trend');signals.push('5m trend DOWN');}
  }
  if(e20_15&&e50_15){
    if(e20_15>e50_15){up+=20;upReasons.push('15m trend');signals.push('15m trend UP');}
    else{down+=20;downReasons.push('15m trend');signals.push('15m trend DOWN');}
  }
  if(r!==null){
    if(r>=55&&r<=72){up+=12;upReasons.push('RSI');signals.push(`RSI ${r.toFixed(1)} bullish`);}
    else if(r<=45&&r>=28){down+=12;downReasons.push('RSI');signals.push(`RSI ${r.toFixed(1)} bearish`);}
  }
  if(vr>=1.15){
    if(up>=down){up+=8;upReasons.push('volume');signals.push(`volume ${vr.toFixed(2)}x`);}
    else{down+=8;downReasons.push('volume');signals.push(`volume ${vr.toFixed(2)}x`);}
  }
  const resistance=nearestAbove([...p5.resistance,...p15.resistance],price);
  if(resistance&&price>=resistance*0.999){
    if(up>=down){up+=8;upReasons.push('SNR resistance test');}
    else{down+=8;downReasons.push('SNR resistance test');}
  }
  if(strike&&a&&a>0){
    const dist=(price-strike)/a;
    if(dist>=0.75){up+=17;upReasons.push('strike distance');signals.push(`strike +${dist.toFixed(2)} ATR`);}
    else if(dist<=-0.75){down+=17;downReasons.push('strike distance');signals.push(`strike ${dist.toFixed(2)} ATR`);}
  }
  const direction=up>=down?'UP':'DOWN';
  const best=direction==='UP'?up:down;
  const opposing=direction==='UP'?down:up;
  const confidenceGap=Math.max(0,best-opposing);
  const score=Math.round(Math.min(100,50+best*0.95+Math.min(10,confidenceGap*0.10)));
  const probUp=Math.min(0.94,Math.max(0.06,0.50+(up-down)*0.0065));
  const reasons=direction==='UP'?upReasons:downReasons;
  const optionalMissing=[];
  if(r===null)optionalMissing.push('RSI');
  if(vr<1.15)optionalMissing.push('volume');
  if(!resistance)optionalMissing.push('SNR');
  return{score,upProbability:probUp,downProbability:1-probUp,reasons,signals,direction,atr:a,volumeRatio:vr,confirmation:{score,bestWeight:best,confidenceGap,optionalMissing}};
}

async function getEquity(){if(!LIVE_TRADING)return Math.max(0,Number(state.paperEquity||START_CAPITAL));const rows=await privateRequest('GET','/api/v5/account/balance?ccy=USDT');const d=rows?.[0]?.details?.find(x=>x.ccy==='USDT');const eq=Number(d?.eq),av=Number(d?.availBal);if(Number.isFinite(eq)&&eq>0)return eq;if(Number.isFinite(av)&&av>0)return av;throw new Error('Unable to read USDT equity');}

async function scanCandidates(){
  const instruments=await discoverEventInstruments();
  const filtered=instruments.filter(inst=>{const coin=getBaseAsset(inst);return coin&&isUpDown(inst)&&(!inst.state||String(inst.state).toLowerCase()==='live')&&allowedExpiry(inst)&&!eventUsed(inst.instId);});
  console.log(`[SCAN DISCOVERY] instruments=${instruments.length}`);
  console.log(`[SCAN FILTER] live-updown=${filtered.length}`);
  const candidates=[],cache={};
  for(const inst of filtered){
    try{
      const coin=getBaseAsset(inst),underlying=UNDERLYING_MAP[coin];
      if(!cache[coin]){const [c5,c15]=await Promise.all([getCandles(underlying,'5m',100),getCandles(underlying,'15m',100)]);cache[coin]={c5,c15};}
      const {c5,c15}=cache[coin];
      if(!c5.length||!c15.length)continue;
      const t=await getTicker(inst.instId,'EVENTS');
      const yesAsk=Number(t?.askPx||t?.last),yesBid=Number(t?.bidPx||t?.last);
      if(!(yesAsk>0&&yesBid>0&&yesAsk<1&&yesBid>0))continue;
      const price=Number(c5.at(-1)?.[4]);
      if(!Number.isFinite(price))continue;
      const strike=getStrike(inst),model=modelProbability(price,strike,c5,c15);
      const yesEntry=yesAsk,noEntry=1-yesBid;

      /* Evaluate YES and NO independently. A bad YES price must not hide a valid NO setup. */
      const yesValid=validPrice(yesEntry),noValid=validPrice(noEntry);
      const yesEdge=yesValid?model.upProbability-yesEntry:-Infinity;
      const noEdge=noValid?model.downProbability-noEntry:-Infinity;
      if(!Number.isFinite(yesEdge)&&!Number.isFinite(noEdge)){
        console.log('[EVENT REJECT]',JSON.stringify({instId:inst.instId,reason:'invalid_both_prices',yesEntry,noEntry}));
        continue;
      }
      const side=yesEdge>=noEdge?'yes':'no';
      const entryPx=side==='yes'?yesEntry:noEntry;
      const modelProb=side==='yes'?model.upProbability:model.downProbability;
      const edge=side==='yes'?yesEdge:noEdge;
      const mins=minutesToExpiry(inst);
      let reject=null;
      if(model.score<MIN_SCORE)reject=`score ${model.score}<${MIN_SCORE}`;
      else if(modelProb<MIN_MODEL_PROB)reject=`model ${(modelProb*100).toFixed(1)}%<${MIN_MODEL_PROB*100}%`;
      else if(edge<MIN_EDGE)reject=`edge ${(edge*100).toFixed(1)}%<${MIN_EDGE*100}%`;
      if(reject){
        console.log('[EVENT REJECT]',JSON.stringify({instId:inst.instId,reason:reject,side,score:model.score,model:Number((modelProb*100).toFixed(1)),market:Number((entryPx*100).toFixed(1)),edge:Number((edge*100).toFixed(1)),mins:Number(mins?.toFixed(1)),confirmation:model.confirmation,signals:model.signals}));
        continue;
      }
      candidates.push({inst,seriesId:inst.seriesId,coin,underlying,side,entryPx,modelProb,marketProb:entryPx,edge,score:model.score,reasons:model.reasons,signals:model.signals,confirmation:model.confirmation,strikePx:strike,underlyingPrice:price,expiry:getExpiry(inst),minutesToExpiry:mins,atr:model.atr});
      console.log('[EVENT PASS]',JSON.stringify({instId:inst.instId,side,entryPx,score:model.score,model:Number((modelProb*100).toFixed(1)),edge:Number((edge*100).toFixed(1)),reasons:model.reasons,signals:model.signals}));
    }catch(e){console.error(`[EVENT CANDIDATE ERROR] ${inst.instId}:`,e.message);}
  }
  console.log(`[SCAN DIAGNOSTICS] filtered=${filtered.length} passed=${candidates.length}`);
  return candidates.sort((a,b)=>b.edge-a.edge||b.score-a.score);
}

function calcOrderSize(price,inst){const lot=Math.max(Number(inst.lotSz||0.1),0.1),min=Math.max(Number(inst.minSz||lot),lot);let sz=Math.ceil((TARGET_STAKE/price)/lot)*lot;if(sz<min)sz=min;return Number(sz.toFixed(8));}
async function placeEventOrder(candidate){const inst=candidate.inst,tick=Number(inst.tickSz||0.001),px=roundToTick(candidate.entryPx,tick),sz=calcOrderSize(px,inst),actualStake=px*sz;console.log('[ORDER SIZE]',JSON.stringify({targetStake:TARGET_STAKE,entryPx:px,lotSz:Number(inst.lotSz||0.1),minSz:Number(inst.minSz||0.1),contracts:sz,actualStake}));const body={instId:inst.instId,tdMode:'isolated',ccy:'USDT',side:'buy',ordType:'ioc',px:px.toFixed(6),sz:String(sz),outcome:candidate.side,clOrdId:`snr${Date.now().toString(36)}`.slice(0,32)};if(!LIVE_TRADING)return{ordId:`SIM-${Date.now()}`,state:'filled',avgPx:px,accFillSz:sz,simulated:true,body};const rows=await privateRequest('POST','/api/v5/trade/order',body),result=rows?.[0];console.log('[ENTRY ORDER RESPONSE]',JSON.stringify(result));if(!result||String(result.sCode)!=='0')throw new Error(`Order rejected: ${JSON.stringify(result)}`);if(!result.ordId)return result;await sleep(700);const filled=await getOrder(inst.instId,result.ordId);console.log('[ENTRY ORDER STATE]',JSON.stringify(filled));return{...result,...filled};}
async function getOrder(instId,ordId){const rows=await privateRequest('GET',`/api/v5/trade/order?${q({instId,ordId})}`);return rows?.[0]||null;}
async function closePosition(position,currentPx){const inst=position.inst,tick=Number(inst.tickSz||0.001),px=roundToTick(currentPx,tick),sz=Number(position.sz);if(!(sz>0))throw new Error(`Invalid close size: ${sz}`);const body={instId:inst.instId,tdMode:'isolated',ccy:'USDT',side:'sell',ordType:'ioc',px:px.toFixed(6),sz:String(sz),outcome:position.side,clOrdId:`exit${Date.now().toString(36)}`.slice(0,32)};if(!LIVE_TRADING)return{state:'filled',avgPx:px,accFillSz:sz,pnl:(px-position.entryPx)*sz,simulated:true};const rows=await privateRequest('POST','/api/v5/trade/order',body),r=rows?.[0];if(!r||String(r.sCode)!=='0')throw new Error(`Exit rejected: ${JSON.stringify(r)}`);if(r.ordId){await sleep(700);const filled=await getOrder(inst.instId,r.ordId);return{...r,...filled};}return r;}

async function managePosition(){if(!state.position)return;const p=state.position;try{const t=await getTicker(p.inst.instId,'EVENTS'),bid=Number(t?.bidPx||t?.last),ask=Number(t?.askPx||t?.last);if(!(bid>0))return;const current=p.side==='yes'?bid:1-(ask>0?ask:bid);if(!(current>0&&current<1))return;const change=(current-p.entryPx)/p.entryPx;if(change>=EARLY_TP_PCT)return exitPosition(p,current,'TP');if(change<=-EARLY_SL_PCT)return exitPosition(p,current,'SL');}catch(e){console.error('[EVENT POSITION MANAGER]',e.message);}}
async function exitPosition(position,currentPx,reason){const result=await closePosition(position,currentPx);const exitPx=Number(result?.avgPx||result?.fillPx||currentPx),pnl=result?.forcedClear?0:(exitPx-position.entryPx)*position.sz;state.realizedPnl+=pnl;if(!LIVE_TRADING)state.paperEquity=Math.max(0,Number(state.paperEquity||START_CAPITAL)+pnl);state.consecutiveLosses=pnl<0?state.consecutiveLosses+1:0;state.trades.push({at:new Date().toISOString(),instId:position.inst.instId,side:position.side,entryPx:position.entryPx,exitPx,sz:position.sz,pnl,reason});if(state.trades.length>200)state.trades.shift();state.position=null;if(state.consecutiveLosses>=MAX_CONSECUTIVE_LOSSES)state.halted=true;saveState();await notify(`${pnl>=0?'🟢':'🔴'} EVENT EXIT\
${position.inst.instId}\
${position.side.toUpperCase()}\
Reason ${reason}\
Entry ${position.entryPx.toFixed(4)}\
Exit ${exitPx.toFixed(4)}\
Contracts ${position.sz}\
PnL ${pnl>=0?'+':''}${pnl.toFixed(4)}U\
${LIVE_TRADING?'LIVE':'PAPER'}`);}

async function maybeTrade(){if(riskBlocked()||state.position)return;let equity;try{equity=await getEquity();}catch(e){console.error('[EQUITY]',e.message);return;}if(!state.startEquity){state.startEquity=equity;saveState();}if(state.realizedPnl<=-(equity*DAILY_LOSS_PCT)){state.halted=true;saveState();await notify(`⛔ EVENT BOT DAILY LOSS LOCK\
PnL ${state.realizedPnl.toFixed(4)}U`);return;}let candidates;try{candidates=await scanCandidates();}catch(e){console.error('[SCAN ERROR]',e.message);return;}console.log(`[SCAN RESULT] candidates=${candidates.length}`);if(!candidates.length){console.log('[SCAN] no candidates passed all filters');return;}const c=candidates[0];markEventUsed(c.inst.instId);console.log('[EVENT LOCK]',c.inst.instId);try{const order=await placeEventOrder(c,equity);const fillSz=Number(order?.accFillSz||order?.fillSz||0);const avgPx=Number(order?.avgPx||order?.fillPx||0);if(!(fillSz>0&&avgPx>0)){console.log('[EVENT NO FILL]',JSON.stringify({instId:c.inst.instId,state:order?.state||'unknown',accFillSz:fillSz}));return;}const stake=avgPx*fillSz;state.position={inst:c.inst,seriesId:c.seriesId,coin:c.coin,side:c.side,sz:fillSz,entryPx:avgPx,stake,score:c.score,edge:c.edge,modelProb:c.modelProb,marketProb:c.marketProb,underlyingPrice:c.underlyingPrice,openedAt:Date.now()};state.lastTradeAt=Date.now();saveState();await notify(`🟡 EVENT ENTRY\
${c.inst.instId}\
${c.side.toUpperCase()}\
Entry ${avgPx.toFixed(4)}\
Contracts ${fillSz}\
Actual ${stake.toFixed(4)}U\
Score ${c.score}\
Model ${(c.modelProb*100).toFixed(1)}%\
Edge ${(c.edge*100).toFixed(1)}%\
${LIVE_TRADING?'LIVE':'PAPER'}`);}catch(e){console.error('[EVENT ORDER ERROR]',e.message);}}

app.get('/',(req,res)=>res.json({ok:true,bot:'OKX Event Contract Bot (Fixed 5U)',live:LIVE_TRADING,position:state.position,usedEvents:state.usedEvents.length}));
app.get('/health',(req,res)=>res.json({ok:true,live:LIVE_TRADING,time:new Date().toISOString(),position:!!state.position}));
let loopRunning=false;async function mainLoop(){if(loopRunning)return;loopRunning=true;try{resetDaily();await managePosition();if(!state.position)await maybeTrade();}catch(e){console.error('[EVENT MAIN LOOP]',e.message||e);}finally{loopRunning=false;}}
app.listen(PORT,()=>console.log(`OKX EVENT CONTRACT BOT RUNNING ON PORT ${PORT}`));
setInterval(mainLoop,CHECK_INTERVAL);setInterval(managePosition,POSITION_CHECK_INTERVAL);mainLoop().catch(e=>console.error('[EVENT INITIAL LOOP]',e));