'use strict';

const { TTLCache } = require('./cache');
const okx = require('./okx');
const config = require('./config');

const cache = new TTLCache();
const history = new Map();

function usdtSwap(i) { return i.instType === 'SWAP' && (i.quoteCcy === 'USDT' || i.settleCcy === 'USDT') && i.state === 'live'; }
function remember(key, value, max = 120) { const arr = history.get(key) || []; arr.push({ ts: Date.now(), value }); while (arr.length > max) arr.shift(); history.set(key, arr); }
function nearestPast(arr, ageMs) { const target = Date.now() - ageMs; return [...arr].reverse().find(x => x.ts <= target) || null; }
function delta(key, current, ageMs) { const base = nearestPast(history.get(key) || [], ageMs); if (!base) return { value: null, pct: null, sampledAt: null }; const value = current - base.value; return { value, pct: base.value ? (value / base.value) * 100 : null, sampledAt: base.ts }; }

async function instruments() { const hit = cache.get('instruments'); if (hit) return hit; return cache.set('instruments', (await okx.getInstruments()).filter(usdtSwap), config.CACHE_TTL_MS.instruments); }
async function tickers() {
  const hit = cache.get('tickers'); if (hit) return hit;
  const allowed = new Set((await instruments()).map(x => x.instId));
  const data = (await okx.getTickers()).filter(x => allowed.has(x.instId)).map(x => ({ symbol:x.instId, price:Number(x.last), change24h:x.open24h ? ((Number(x.last)-Number(x.open24h))/Number(x.open24h))*100 : null, volume:Number(x.volCcy24h), volumeContracts:Number(x.vol24h), timestamp:Number(x.ts) }));
  return cache.set('tickers', data, config.CACHE_TTL_MS.tickers);
}
async function openInterest() {
  const allowed = new Set((await instruments()).map(x => x.instId));
  const data = (await okx.getOpenInterest()).filter(x => allowed.has(x.instId)).map(x => { const oi=Number(x.oiUsd); const key=`oi:${x.instId}`; const result={symbol:x.instId,oi,oiCcy:Number(x.oiCcy),oiUsd:oi, timestamp:Number(x.ts), changes:{'5m':delta(key,oi,300000),'15m':delta(key,oi,900000),'1h':delta(key,oi,3600000)}}; remember(key,oi); return result; });
  cache.set('openInterest', data, config.CACHE_TTL_MS.openInterest); return data;
}
async function funding(instId) { const key=`funding:${instId}`; const hit=cache.get(key); if(hit) return hit; const d=(await okx.getFundingRate(instId))[0]||null; if(!d) return null; return cache.set(key,{symbol:instId,fundingRate:Number(d.fundingRate),fundingTime:Number(d.fundingTime),nextFundingTime:d.nextFundingTime?Number(d.nextFundingTime):null,timestamp:Number(d.ts)},config.CACHE_TTL_MS.funding); }
async function fundingHistory(instId,limit=100) { return okx.getFundingHistory(instId,limit); }
async function candles(instId,bar) { if(!config.BARS.includes(bar)) throw new Error('Unsupported bar'); const key=`candles:${instId}:${bar}`; const hit=cache.get(key); if(hit)return hit; const data=(await okx.getCandles(instId,bar)).map(x=>({timestamp:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]),volumeCurrency:Number(x[6]),volumeQuote:Number(x[7]),confirmed:x[8]==='1'})); return cache.set(key,data,config.CACHE_TTL_MS.candles); }
async function trades(instId,limit=100) { return (await okx.getTrades(instId,limit)).map(x=>({timestamp:Number(x.ts),price:Number(x.px),size:Number(x.sz),side:x.side,tradeId:x.tradeId,source:x.source})); }
async function orderBook(instId,sz=config.MAX_ORDER_BOOK_LEVELS) { const raw=(await okx.getOrderBook(instId,sz))[0]; if(!raw)return null; const bids=raw.bids.map(x=>({price:Number(x[0]),volume:Number(x[1]),orders:Number(x[3]||0)})); const asks=raw.asks.map(x=>({price:Number(x[0]),volume:Number(x[1]),orders:Number(x[3]||0)})); const bidVolume=bids.reduce((a,x)=>a+x.volume,0),askVolume=asks.reduce((a,x)=>a+x.volume,0); return {bids,asks,bidVolume,askVolume,bidAskRatio:askVolume?bidVolume/askVolume:null,spread:bids[0]&&asks[0]?asks[0].price-bids[0].price:null,timestamp:Number(raw.ts),seqId:raw.seqId}; }
module.exports={instruments,tickers,openInterest,funding,fundingHistory,candles,trades,orderBook};
