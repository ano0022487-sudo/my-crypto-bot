'use strict';

const { TTLCache } = require('./cache');
const okx = require('./okx');
const config = require('./config');
const { normalizeCandle, normalizeTicker, normalizeTrade, normalizeOrderBook, numberOrNull } = require('./normalize');

const cache = new TTLCache();
const history = new Map();

function isUsdtSwap(i) { return i.instType === 'SWAP' && i.state === 'live' && (i.quoteCcy === 'USDT' || i.settleCcy === 'USDT'); }
function remember(key, value, ts = Date.now(), max = 720) { const arr = history.get(key) || []; arr.push({ ts, value }); while (arr.length > max) arr.shift(); history.set(key, arr); }
function nearestPast(arr, ageMs, now = Date.now()) { const target = now - ageMs; return [...arr].reverse().find(x => x.ts <= target) || null; }
function delta(key, current, ageMs, now = Date.now()) { const base = nearestPast(history.get(key) || [], ageMs, now); if (!base) return { value: null, pct: null, sampledAt: null }; const value = current - base.value; return { value, pct: base.value !== 0 ? (value / base.value) * 100 : null, sampledAt: base.ts }; }

async function instruments() { const hit = cache.get('instruments'); if (hit) return hit; return cache.set('instruments', (await okx.getInstruments()).filter(isUsdtSwap), config.CACHE_TTL_MS.instruments); }
async function tickers() { const hit = cache.get('tickers'); if (hit) return hit; const allowed = new Set((await instruments()).map(x => x.instId)); const data = (await okx.getTickers()).filter(x => allowed.has(x.instId)).map(normalizeTicker); return cache.set('tickers', data, config.CACHE_TTL_MS.tickers); }
async function openInterest() { const hit = cache.get('openInterest'); if (hit) return hit; const allowed = new Set((await instruments()).map(x => x.instId)); const data = (await okx.getOpenInterest()).filter(x => allowed.has(x.instId)).map(x => { const oiUsd = numberOrNull(x.oiUsd); const key = `oi:${x.instId}`; const timestamp = numberOrNull(x.ts); const result = { symbol:x.instId, oi:numberOrNull(x.oi), oiCcy:numberOrNull(x.oiCcy), oiUsd, timestamp, changes:{'5m':delta(key,oiUsd,300000),'15m':delta(key,oiUsd,900000),'1h':delta(key,oiUsd,3600000)} }; if (oiUsd !== null) remember(key,oiUsd,timestamp); return result; }); return cache.set('openInterest', data, config.CACHE_TTL_MS.openInterest); }
async function funding(instId) { const key=`funding:${instId}`; const hit=cache.get(key); if(hit)return hit; const d=(await okx.getFundingRate(instId))[0]||null; if(!d)return null; const result={symbol:instId,fundingRate:numberOrNull(d.fundingRate),fundingTime:numberOrNull(d.fundingTime),nextFundingTime:numberOrNull(d.nextFundingTime),timestamp:numberOrNull(d.ts)}; return cache.set(key,result,config.CACHE_TTL_MS.funding); }
async function fundingHistory(instId,limit=100) { return (await okx.getFundingHistory(instId,limit)).map(x=>({symbol:instId,fundingRate:numberOrNull(x.fundingRate),fundingTime:numberOrNull(x.fundingTime),realizedRate:numberOrNull(x.realizedRate),timestamp:numberOrNull(x.ts)})); }
async function candles(instId,bar) { if(!config.BARS.includes(bar))throw new Error('Unsupported bar'); const key=`candles:${instId}:${bar}`; const hit=cache.get(key); if(hit)return hit; return cache.set(key,(await okx.getCandles(instId,bar)).map(normalizeCandle),config.CACHE_TTL_MS.candles); }
async function trades(instId,limit=100) { return (await okx.getTrades(instId,limit)).map(normalizeTrade); }
async function orderBook(instId,sz=config.MAX_ORDER_BOOK_LEVELS) { const key=`orderbook:${instId}:${sz}`; const hit=cache.get(key); if(hit)return hit; const raw=(await okx.getOrderBook(instId,sz))[0]; if(!raw)return null; const bids=raw.bids.map(normalizeOrderBook),asks=raw.asks.map(normalizeOrderBook); const bidVolume=bids.reduce((a,x)=>a+x.volume,0),askVolume=asks.reduce((a,x)=>a+x.volume,0); return cache.set(key,{bids,asks,bidVolume,askVolume,bidAskRatio:askVolume?bidVolume/askVolume:null,spread:bids[0]&&asks[0]?asks[0].price-bids[0].price:null,timestamp:numberOrNull(raw.ts),seqId:raw.seqId},config.CACHE_TTL_MS.orderBook); }
module.exports={instruments,tickers,openInterest,funding,fundingHistory,candles,trades,orderBook,isUsdtSwap,delta};
