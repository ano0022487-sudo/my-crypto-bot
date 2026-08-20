'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const LIVE = String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';
const BASE_URL = String(process.env.OKX_BASE_URL || 'https://www.okx.com').replace(/\/$/, '');
const KEY = String(process.env.OK_ACCESS_KEY || '').trim();
const SECRET = String(process.env.OK_ACCESS_SECRET || '').trim();
const PASS = String(process.env.OKX_PASSPHRASE || '').trim();
const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/["']/g, '');
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '').trim();

// Strategy: 4H trend -> 1H Bayesian -> 15M confirmation -> 5M entry.
const SYMBOLS = String(process.env.PERP_SYMBOLS || 'BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP')
  .split(',').map(x => x.trim()).filter(Boolean);
const CHECK_INTERVAL = Math.max(15000, Number(process.env.CHECK_INTERVAL || 30000));
const RISK_PCT = Math.min(0.02, Math.max(0.01, Number(process.env.RISK_PCT || 0.01)));
const LEVERAGE = Math.min(5, Math.max(3, Number(process.env.LEVERAGE || 3)));
const RR = Math.min(3, Math.max(2, Number(process.env.RR || 2));
const MIN_BAYES = Math.max(0.75, Number(process.env.MIN_BAYES || 0.75));
const MAX_DAILY_LOSS = Math.max(0.01, Number(process.env.MAX_DAILY_LOSS || 0.10));
const MAX_LOSSES = 3;
const COOLDOWN_MS = 30 * 60 * 1000;
const PAPER_EQUITY = Number(process.env.PAPER_EQUITY || 20);
const STATE = process.env.PERP_STATE_FILE || path.join(__dirname, 'perp-1h-state.json');
const BAR1H = '1H';

function log(msg, obj) { console.log(obj === undefined ? msg : `${msg} ${JSON.stringify(obj)}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const query = o => Object.entries(o).filter(([,v]) => v !== undefined && v !== null && v !== '')
  .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

async function http(config) {
  let err;
  for (let i = 0; i < 3; i++) {
    try { return await axios({ timeout: 15000, ...config }); }
    catch (e) { err = e; if (i < 2) await sleep(400 * (i + 1)); }
  }
  throw err;
}

async function pub(endpoint, params = {}) {
  const qs = query(params);
  const r = await http({ method: 'GET', url: BASE_URL + endpoint + (qs ? `?${qs}` : '') });
  if (!r.data || String(r.data.code) !== '0') throw Error(`OKX public ${r.status}: ${JSON.stringify(r.data)}`);
  return Array.isArray(r.data.data) ? r.data.data : [];
}

function sign(ts, method, requestPath, body) {
  return crypto.createHmac('sha256', SECRET).update(ts + method.toUpperCase() + requestPath + body).digest('base64');
}

async function priv(method, requestPath, obj, params) {
  if (!KEY || !SECRET || !PASS) throw Error('OKX credentials missing');
  const qs = params ? query(params) : '';
  const pathWithQuery = requestPath + (qs ? `?${qs}` : '');
  const body = obj ? JSON.stringify(obj) : '';
  const ts = new Date().toISOString();
  const headers = {
    'OK-ACCESS-KEY': KEY,
    'OK-ACCESS-SIGN': sign(ts, method, pathWithQuery, body),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': PASS,
    'Content-Type': 'application/json'
  };
  const r = await http({ method, url: BASE_URL + pathWithQuery, data: body || undefined, headers });
  if (!r.data || String(r.data.code) !== '0') throw Error(`OKX private ${r.status}: ${JSON.stringify(r.data)}`);
  return Array.isArray(r.data.data) ? r.data.data : [];
}

function fresh() {
  return { day: new Date().toISOString().slice(0,10), paperEquity: PAPER_EQUITY, realizedPnl: 0,
    consecutiveLosses: 0, cooldownUntil: 0, halted: false, position: null, trades: [] };
}
function load() {
  try {
    if (!fs.existsSync(STATE)) return fresh();
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return { ...fresh(), ...s, trades: Array.isArray(s.trades) ? s.trades : [] };
  } catch { return fresh(); }
}
const state = load();
function save() { try { fs.writeFileSync(STATE + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(STATE + '.tmp', STATE); } catch(e) { console.error('[STATE]', e.message); } }
function recalc() {
  let pnl = 0, losses = 0;
  for (const t of state.trades) pnl += Number(t.pnl || 0);
  for (let i = state.trades.length - 1; i >= 0; i--) { const p = Number(state.trades[i].pnl || 0); if (p < 0) losses++; else if (p > 0) break; }
  state.realizedPnl = Number(pnl.toFixed(4));
  state.consecutiveLosses = losses;
  if (!LIVE) state.paperEquity = Number(Math.max(0, PAPER_EQUITY + state.realizedPnl).toFixed(4));
}
function riskBlocked() {
  recalc();
  const now = Date.now();
  if (state.cooldownUntil && now < state.cooldownUntil) { state.halted = true; return true; }
  if (state.cooldownUntil && now >= state.cooldownUntil) { state.cooldownUntil = 0; state.consecutiveLosses = 0; }
  if (state.consecutiveLosses >= MAX_LOSSES) { state.cooldownUntil = now + COOLDOWN_MS; state.halted = true; save(); return true; }
  if (state.realizedPnl <= -(PAPER_EQUITY * MAX_DAILY_LOSS)) { state.halted = true; save(); return true; }
  state.halted = false; return false;
}

async function candles(instId, bar, limit = 120) {
  const rows = await pub('/api/v5/market/candles', { instId, bar, limit });
  return rows.slice().sort((a,b) => Number(a[0]) - Number(b[0])).filter(x => String(x[8]) === '1');
}
async function ticker(instId) { return (await pub('/api/v5/market/ticker', { instId }))[0] || null; }
async function instrument(instId) { return (await pub('/api/v5/public/instruments', { instType: 'SWAP', instId }))[0] || null; }

function closes(rows) { return rows.map(x => Number(x[4])).filter(Number.isFinite); }
function mean(a) { return a.length ? a.reduce((s,x) => s+x, 0) / a.length : 0; }
function sd(a,m) { return a.length < 2 ? 1e-8 : Math.max(Math.sqrt(a.reduce((s,x) => s+(x-m)**2,0)/a.length), 1e-8); }
function ema(values, n) {
  if (values.length < n) return null;
  const k = 2/(n+1); let e = mean(values.slice(0,n));
  for (let i=n; i<values.length; i++) e = values[i]*k + e*(1-k);
  return e;
}
function pdf(x,m,s) { const d = Math.max(s,1e-8), z=(x-m)/d; return Math.exp(-0.5*z*z)/(d*Math.sqrt(2*Math.PI)); }
function bayesian(rows, min = 30) {
  const p = closes(rows); if (p.length < min) return null;
  const r=[]; for(let i=1;i<p.length;i++) if(p[i]>0&&p[i-1]>0) r.push(Math.log(p[i]/p[i-1]));
  if(r.length<20) return null;
  const up=r.filter(x=>x>0), dn=r.filter(x=>x<=0); if(!up.length||!dn.length) return null;
  const prior=(up.length+1)/(r.length+2), x=r[r.length-1], muU=mean(up), muD=mean(dn), sU=sd(up,muU), sD=sd(dn,muD);
  const lu=pdf(x,muU,sU), ld=pdf(x,muD,sD), den=lu*prior+ld*(1-prior);
  const pUp=den>0?lu*prior/den:prior;
  return { direction:pUp>=0.5?'LONG':'SHORT', probability:pUp>=0.5?pUp:1-pUp, pUp, evidence:x };
}
function trend4H(rows) {
  const c=closes(rows); if(c.length<60)return null;
  const e20=ema(c,20), e50=ema(c,50), last=c[c.length-1];
  return { direction:last>e20&&e20>e50?'LONG':last<e20&&e20<e50?'SHORT':'NONE', ema20:e20, ema50:e50, last };
}
function confirm15(rows, direction) {
  const c=closes(rows); if(c.length<30)return false;
  const e20=ema(c,20), last=c[c.length-1];
  return direction==='LONG'?last>e20:last<e20;
}
function entry5(rows, direction) {
  const c=closes(rows); if(c.length<25)return false;
  const e9=ema(c,9), e20=ema(c,20), last=c[c.length-1], prev=c[c.length-2];
  return direction==='LONG' ? last>e9&&e9>e20&&last>=prev : last<e9&&e9<e20&&last<=prev;
}
function roundDown(x, step) { return Number((Math.floor(x/step)*step).toFixed(8)); }
function decimals(step) { const s=String(step); return s.includes('.') ? s.split('.')[1].length : 0; }

async function equity() {
  if(!LIVE) return state.paperEquity;
  const d=await priv('GET','/api/v5/account/balance',null,{ccy:'USDT'});
  const x=d[0]; return Number(x?.availEq || x?.adjEq || x?.totalEq || 0);
}
async function setLeverage(instId, posSide) {
  if(!LIVE)return;
  try { await priv('POST','/api/v5/account/set-leverage',{instId,lever:String(LEVERAGE),mgnMode:'isolated',posSide}); }
  catch(e) { if(!/same leverage|leverage/i.test(e.message)) throw e; }
}
async function positions() { return LIVE ? await priv('GET','/api/v5/account/positions',null,{instType:'SWAP'}) : []; }
async function notify(text) {
  if(!TG_TOKEN||!TG_CHAT)return;
  try { await http({method:'POST',url:`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,data:{chat_id:TG_CHAT,text}}); } catch(e) { console.error('[TELEGRAM]',e.message); }
}

async function scanSymbol(instId) {
  const [i, r4, r1, r15, r5, t] = await Promise.all([
    instrument(instId), candles(instId,'4H'), candles(instId,'1H'), candles(instId,'15m'), candles(instId,'5m'), ticker(instId)
  ]);
  if(!i||!t)return null;
  const trend=trend4H(r4), b1=bayesian(r1), price=Number(t.last);
  if(!trend||trend.direction==='NONE'||!b1||b1.direction!==trend.direction||b1.probability<MIN_BAYES)return null;
  if(!confirm15(r15,b1.direction)||!entry5(r5,b1.direction))return null;
  const atrRows=r1.slice(-15), c=closes(atrRows); let tr=[];
  for(let n=1;n<c.length;n++)tr.push(Math.abs(c[n]-c[n-1]));
  const atr=mean(tr); if(!(atr>0))return null;
  const stopDist=Math.max(atr*1.2, price*0.003);
  const tpDist=stopDist*RR;
  const eq=await equity();
  const riskUsd=eq*RISK_PCT;
  const ctVal=Number(i.ctVal||1), lotSz=Number(i.lotSz||1), minSz=Number(i.minSz||lotSz);
  let sz=roundDown(riskUsd/(stopDist*ctVal),lotSz);
  if(sz<minSz)sz=minSz;
  const notional=sz*ctVal*price;
  const margin=notional/LEVERAGE;
  if(!Number.isFinite(sz)||sz<=0)return null;
  return { instId, instrument:i, price, direction:b1.direction, probability:b1.probability, trend, atr, stopDist, tpDist, size:sz, notional, margin, riskUsd, equity:eq };
}

async function openPosition(c) {
  const i=c.instrument, px=c.price, posSide=c.direction==='LONG'?'long':'short';
  await setLeverage(c.instId,posSide);
  const decimalsSz=decimals(Number(i.lotSz||1));
  const body={instId:c.instId,tdMode:'isolated',side:c.direction==='LONG'?'buy':'sell',posSide,ordType:'market',sz:c.size.toFixed(decimalsSz),clOrdId:`p1h${Date.now().toString(36)}`.slice(0,32)};
  if(!LIVE){
    state.position={instId:c.instId,direction:c.direction,entryPx:px,size:c.size,stopPx:c.direction==='LONG'?px-c.stopDist:px+c.stopDist,tpPx:c.direction==='LONG'?px+c.tpDist:px-c.tpDist,riskUsd:c.riskUsd,probability:c.probability,notional:c.notional,openedAt:new Date().toISOString(),paper:true};
  } else {
    const r=(await priv('POST','/api/v5/trade/order',body))[0];
    if(!r||String(r.sCode)!=='0'||!r.ordId)throw Error(`Order rejected: ${JSON.stringify(r)}`);
    const fill=Number(r.avgPx||px);
    state.position={instId:c.instId,direction:c.direction,entryPx:fill,size:c.size,stopPx:c.direction==='LONG'?fill-c.stopDist:fill+c.stopDist,tpPx:c.direction==='LONG'?fill+c.tpDist:fill-c.tpDist,riskUsd:c.riskUsd,probability:c.probability,notional:c.notional,openedAt:new Date().toISOString(),ordId:r.ordId,paper:false};
  }
  save();
  await notify(`🟡 PERP 1H ENTRY\n${c.instId}\n${c.direction}\nEntry ${state.position.entryPx}\nSize ${c.size}\nLeverage ${LEVERAGE}x\nRisk ${c.riskUsd.toFixed(4)}U (${(RISK_PCT*100).toFixed(1)}%)\nSL ${state.position.stopPx}\nTP ${state.position.tpPx}\nBayesian ${(c.probability*100).toFixed(1)}%\nRR 1:${RR}\n${LIVE?'LIVE':'PAPER'}`);
  log('[ENTRY]',state.position);
}

async function closePosition(reason, exitPx) {
  const p=state.position;if(!p)return;
  let ex=exitPx;
  if(LIVE){
    const posSide=p.direction==='LONG'?'long':'short';
    const side=p.direction==='LONG'?'sell':'buy';
    const i=await instrument(p.instId);
    const body={instId:p.instId,tdMode:'isolated',side,posSide,ordType:'market',sz:String(p.size),clOrdId:`x1h${Date.now().toString(36)}`.slice(0,32)};
    const r=(await priv('POST','/api/v5/trade/order',body))[0];
    if(!r||String(r.sCode)!=='0')throw Error(`Close rejected: ${JSON.stringify(r)}`);
    ex=Number(r.avgPx||exitPx);
  }
  const pnl=(p.direction==='LONG'?(ex-p.entryPx):(p.entryPx-ex))*p.size*Number((await instrument(p.instId)).ctVal||1);
  state.trades.push({at:new Date().toISOString(),instId:p.instId,direction:p.direction,entryPx:p.entryPx,exitPx:ex,size:p.size,pnl:Number(pnl.toFixed(4)),reason,probability:p.probability,riskUsd:p.riskUsd});
  state.position=null;recalc();
  if(state.consecutiveLosses>=MAX_LOSSES)state.cooldownUntil=Date.now()+COOLDOWN_MS;
  save();
  await notify(`${pnl>=0?'🟢':'🔴'} PERP 1H EXIT\n${p.instId}\n${p.direction}\nEntry ${p.entryPx}\nExit ${ex}\nPnL ${pnl>=0?'+':''}${pnl.toFixed(4)}U\n${reason}\n${LIVE?'LIVE':'PAPER'}`);
  log('[EXIT]',{instId:p.instId,pnl,reason});
}

async function managePosition(){
  const p=state.position;if(!p)return;
  const t=await ticker(p.instId);const px=Number(t?.last);if(!(px>0))return;
  if(p.direction==='LONG'&&(px<=p.stopPx||px>=p.tpPx))await closePosition(px<=p.stopPx?'SL':'TP',px);
  if(p.direction==='SHORT'&&(px>=p.stopPx||px<=p.tpPx))await closePosition(px>=p.stopPx?'SL':'TP',px);
}

async function loop(){
  try{
    recalc();
    if(state.position){await managePosition();return;}
    if(riskBlocked())return;
    for(const s of SYMBOLS){
      try{
        const c=await scanSymbol(s);
        if(c){
          log('[SIGNAL]',{instId:s,direction:c.direction,oneHBayesian:Number((c.probability*100).toFixed(1)),fourH:c.trend.direction,risk:Number(c.riskUsd.toFixed(4)),size:c.size,RR});
          await openPosition(c);break;
        }
      }catch(e){console.error('[SCAN]',s,e.message);}
    }
  }catch(e){console.error('[LOOP]',e.message);}
}

app.get('/',(req,res)=>res.json({status:'ok',strategy:'4H trend -> 1H Bayesian -> 15M confirm -> 5M entry',mode:LIVE?'LIVE':'PAPER',leverage:LEVERAGE,riskPct:RISK_PCT,rr:RR,position:state.position}));
app.get('/health',(req,res)=>res.json({ok:true,mode:LIVE?'LIVE':'PAPER',halted:state.halted,position:state.position,realizedPnl:state.realizedPnl,consecutiveLosses:state.consecutiveLosses}));
app.listen(PORT,()=>log(`[BOOT] OKX 1H PERPETUAL BOT on ${PORT} mode=${LIVE?'LIVE':'PAPER'} leverage=${LEVERAGE} risk=${RISK_PCT} RR=1:${RR}`));

setInterval(loop,CHECK_INTERVAL);
setTimeout(loop,3000);
