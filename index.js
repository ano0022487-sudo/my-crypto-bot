'use strict';

/*
  OKX Perpetual SNR Bot
  Strategy: 4H trend + 4H SNR breakout + 15m EMA20/ATR/Volume filters
  Risk: 4 USDT margin, 10x leverage, max 8 concurrent positions,
        one position per symbol, TP 3%, SL 1%, daily loss lock, loss-streak lock.
*/

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const DRY_RUN = String(process.env.DRY_RUN ?? 'false').toLowerCase() !== 'false';
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/['\"]+/g, '');
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const API_KEY = String(process.env.OK_ACCESS_KEY || '').trim();
const SECRET_KEY = String(process.env.OK_ACCESS_SECRET || '').trim();
const PASSPHRASE = String(process.env.OKX_PASSPHRASE || '').trim();
const BASE_URL = String(process.env.OKX_BASE_URL || 'https://www.okx.com').replace(/\/$/, '');

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 15000);
const POSITION_SYNC_INTERVAL = Number(process.env.POSITION_SYNC_INTERVAL || 60000);
const DEFAULT_LEVERAGE = Number(process.env.DEFAULT_LEVERAGE || 10);
const DEFAULT_MARGIN_PER_TRADE = Number(process.env.DEFAULT_MARGIN_PER_TRADE || 4);
const DEFAULT_MAX_CONCURRENT = Number(process.env.DEFAULT_MAX_CONCURRENT || 8);
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 0.01);
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 0.03);
const POS_MODE = String(process.env.POS_MODE || 'net').toLowerCase();
const BREAKOUT_BUFFER = Number(process.env.BREAKOUT_BUFFER || 0.001);
const EMA_PERIOD = Number(process.env.EMA_PERIOD || 20);
const VOLUME_LOOKBACK = Number(process.env.VOLUME_LOOKBACK || 20);
const MIN_VOLUME_MULTIPLIER = Number(process.env.MIN_VOLUME_MULTIPLIER || 1.2);
const ATR_PERIOD = Number(process.env.ATR_PERIOD || 14);
const MIN_ATR_PCT = Number(process.env.MIN_ATR_PCT || 0.0015);
const MAX_ATR_PCT = Number(process.env.MAX_ATR_PCT || 0.02);
const SNR_PROXIMITY = Number(process.env.SNR_PROXIMITY || 0.006);
const PIVOT_LOOKBACK = Number(process.env.PIVOT_LOOKBACK || 3);
const MAX_DAILY_LOSS_U = Number(process.env.MAX_DAILY_LOSS_U || 8);
const MAX_CONSECUTIVE_LOSSES = Number(process.env.MAX_CONSECUTIVE_LOSSES || 3);
const MAX_CONSECUTIVE_API_FAILURES = Number(process.env.MAX_CONSECUTIVE_API_FAILURES || 3);
const PROTECTION_VERIFY_ATTEMPTS = Number(process.env.PROTECTION_VERIFY_ATTEMPTS || 8);
const PROTECTION_VERIFY_DELAY = Number(process.env.PROTECTION_VERIFY_DELAY || 1000);
const BOT_STATE_FILE = process.env.BOT_STATE_FILE || path.join(__dirname, 'okx-swap-bot-state.json');
const CONTROL_TOKEN = String(process.env.CONTROL_TOKEN || '').trim();
const WHITELIST_SYMBOLS = (process.env.WHITELIST_SYMBOLS || '').split(',').map(s => s.trim()).filter(Boolean);
const STARTUP_SAFE_MODE = String(process.env.STARTUP_SAFE_MODE || 'true').toLowerCase() === 'true';

// Single axios instance with baseURL
const http = axios.create({ baseURL: BASE_URL, timeout: 15000 });
http.interceptors.response.use(resp => resp, err => Promise.reject(err));

let SYMBOLS = [
  ['ETH','ETH-USDT-SWAP'], ['SOL','SOL-USDT-SWAP'], ['XRP','XRP-USDT-SWAP'],
  ['DOGE','DOGE-USDT-SWAP'], ['ADA','ADA-USDT-SWAP'], ['AVAX','AVAX-USDT-SWAP'],
  ['LINK','LINK-USDT-SWAP'], ['DOT','DOT-USDT-SWAP'], ['LTC','LTC-USDT-SWAP'],
  ['BCH','BCH-USDT-SWAP'], ['SUI','SUI-USDT-SWAP'], ['APT','APT-USDT-SWAP'],
  ['NEAR','NEAR-USDT-SWAP'], ['UNI','UNI-USDT-SWAP'], ['ATOM','ATOM-USDT-SWAP'],
  ['FIL','FIL-USDT-SWAP'], ['ETC','ETC-USDT-SWAP'], ['ARB','ARB-USDT-SWAP'],
  ['OP','OP-USDT-SWAP'], ['TRX','TRX-USDT-SWAP']
].map(([label, swap]) => ({ label, swap, base: swap.replace(/-SWAP$/, '') }));

// If whitelist provided, filter symbols to only those
if (WHITELIST_SYMBOLS.length) {
  const wl = new Set(WHITELIST_SYMBOLS.map(s => s.toUpperCase()));
  SYMBOLS = SYMBOLS.filter(s => wl.has(s.label.toUpperCase()) || wl.has(s.swap.toUpperCase()));
}

let bot = { sendMessage: async () => {} };
if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  bot.onText(/^\/start(?:\s|$)/, msg => {
    bot.sendMessage(msg.chat.id,
      `OKX 永續機器人\n模式：${DRY_RUN ? '模擬' : '實盤'}\n策略：4H SNR + 15m Breakout\n保證金：${DEFAULT_MARGIN_PER_TRADE}U\n槓桿：${DEFAULT_LEVERAGE}x\n最多：${DEFAULT_MAX_CONCURRENT} 倉\nTP/SL：[...]`
    ).catch(() => {});
  });
}
async function notifyTelegram(text) {
  if (!TELEGRAM_CHAT_ID) return;
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, text); } catch (e) { console.error('Telegram:', e.message || e); }
}

function utcDay() { return new Date().toISOString().slice(0, 10); }
function newState() {
  return {
    version: 3,
    risk: {
      day: utcDay(),
      dailyRealizedPnl: 0,
      consecutiveLosses: 0,
      halted: false,
      processedTradeIds: [],
      processedClosingOrders: []
    },
    audit: []
  };
}
function loadState() {
  try {
    if (!fs.existsSync(BOT_STATE_FILE)) return newState();
    const parsed = JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf8'));
    const fresh = newState();
    return {
      ...fresh,
      ...parsed,
      risk: { ...fresh.risk, ...(parsed.risk || {}) },
      audit: Array.isArray(parsed.audit) ? parsed.audit : []
    };
  } catch (e) { console.error('State load failed:', e.message || e); return newState(); }
}
const botState = loadState();
function persistState() {
  try {
    const data = JSON.stringify(botState, null, 2);
    const tmp = BOT_STATE_FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data, null, 'utf8');
    fs.fdatasyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, BOT_STATE_FILE);
    // try to fsync directory to ensure rename persisted (best-effort)
    try {
      const dirFd = fs.openSync(path.dirname(BOT_STATE_FILE), 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch (_) {}
  }
  catch (e) { console.error('State save failed:', e.message || e); }
}
function audit(event, details = {}) {
  botState.audit.push({ at: new Date().toISOString(), event, ...details });
  if (botState.audit.length > 500) botState.audit.splice(0, botState.audit.length - 500);
  persistState();
}
function resetDailyRiskIfNeeded() {
  const day = utcDay();
  if (botState.risk.day !== day) {
    botState.risk.day = day;
    botState.risk.dailyRealizedPnl = 0;
    botState.risk.consecutiveLosses = 0;
    botState.risk.halted = false;
    botState.risk.processedTradeIds = [];
    botState.risk.processedClosingOrders = [];
    audit('daily_reset', { day });
  }
}
function riskBlocked() {
  resetDailyRiskIfNeeded();
  return botState.risk.halted || botState.risk.dailyRealizedPnl <= -Math.abs(MAX_DAILY_LOSS_U) || botState.risk.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES;
}

// Runtime effective trading parameters (can be overridden via env)
let EFFECTIVE_LEVERAGE = Number(process.env.LEVERAGE || DEFAULT_LEVERAGE);
let EFFECTIVE_MARGIN_PER_TRADE = Number(process.env.MARGIN_PER_TRADE || DEFAULT_MARGIN_PER_TRADE);
let EFFECTIVE_MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || DEFAULT_MAX_CONCURRENT);
if (STARTUP_SAFE_MODE) {
  // Enforce conservative limits on startup to avoid large unexpected exposure
  EFFECTIVE_MARGIN_PER_TRADE = Math.min(EFFECTIVE_MARGIN_PER_TRADE, 1);
  EFFECTIVE_MAX_CONCURRENT = Math.min(EFFECTIVE_MAX_CONCURRENT, 1);
  EFFECTIVE_LEVERAGE = Math.min(EFFECTIVE_LEVERAGE, 2);
}

async function axiosWithRetry(config, retries = 4, baseDelay = 800) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await http.request(config);
      return response;
    } catch (e) {
      last = e;
      const status = e.response?.status;
      if (status === 429 || status === 503) {
        const ra = e.response?.headers?.['retry-after'];
        const raMs = ra ? Number(ra) * 1000 : null;
        const wait = raMs || Math.min(60000, baseDelay * Math.pow(2, i));
        const jitter = Math.floor(Math.random() * 300);
        await new Promise(r => setTimeout(r, wait + jitter));
      } else if (i < retries - 1) {
        const wait = Math.min(60000, baseDelay * Math.pow(2, i));
        const jitter = Math.floor(Math.random() * 200);
        await new Promise(r => setTimeout(r, wait + jitter));
      }
    }
  }
  throw last;
}
function sign(ts, method, requestPath, body = '') {
  if (!SECRET_KEY) throw new Error('OKX API secret missing');
  return crypto.createHmac('sha256', SECRET_KEY).update(ts + method.toUpperCase() + requestPath + body).digest('base64');
}
function hasCredentials() { return Boolean(API_KEY && SECRET_KEY && PASSPHRASE); }
async function privateRequest(method, requestPath, bodyObj = null) {
  if (!hasCredentials()) throw new Error('OKX credentials missing');
  const ts = new Date().toISOString();
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const headers = {
    'OK-ACCESS-KEY': API_KEY,
    'OK-ACCESS-SIGN': sign(ts, method, requestPath, body),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': PASSPHRASE
  };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await axiosWithRetry({ method, url: requestPath, data: body || undefined, headers, timeout: 15000 });
  if (!response.data || String(response.data.code) !== '0') throw new Error(`OKX ${method} failed: ${JSON.stringify(response.data)}`);
  return Array.isArray(response.data.data) ? response.data.data : response.data.data;
}
async function publicGet(requestPath) {
  const response = await axiosWithRetry({ method: 'GET', url: requestPath, timeout: 12000 });
  if (!response.data || String(response.data.code) !== '0') throw new Error(`OKX public request failed: ${JSON.stringify(response.data)}`);
  return Array.isArray(response.data.data) ? response.data.data : response.data.data;
}
function qs(params) { return Object.entries(params).filter(([,v]) => v !== undefined && v !== null && v !== '').map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }

function normalizeCandles(candles) { return candles.slice().sort((a,b) => Number(a[0]) - Number(b[0])); }
function confirmedCandles(candles) { return normalizeCandles(candles).filter(c => String(c[8]) === '1'); }
function closes(c) { return c.map(x => Number(x[4])); }
function highs(c) { return c.map(x => Number(x[2])); }
function lows(c) { return c.map(x => Number(x[3])); }
function quoteVolume(c) { const v = Number(c[7]); return Number.isFinite(v) ? v : Number(c[5]) || 0; }
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a,b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1-k);
  return prev;
}
function atrPct(candles, period) {
  if (candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = Number(candles[i][2]), l = Number(candles[i][3]), pc = Number(candles[i-1][4]);
    if (![h,l,pc].every(Number.isFinite)) return null;
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  const latest = Number(candles[candles.length-1][4]);
  const recent = tr.slice(-period);
  return latest > 0 ? recent.reduce((a,b) => a+b, 0) / recent.length / latest : null;
}
function findPivots(candles, lookback = 3) {
  const h = highs(candles), l = lows(candles), ph = [], pl = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    if (h[i] === Math.max(...h.slice(i-lookback, i+lookback+1))) ph.push({ idx:i, price:h[i] });
    if (l[i] === Math.min(...l.slice(i-lookback, i+lookback+1))) pl.push({ idx:i, price:l[i] });
  }
  return { pivotHighs: ph, pivotLows: pl };
}
function pickLevel(pivots, proximity = SNR_PROXIMITY) {
  if (!pivots.length) return null;
  const clusters = [];
  for (const p of pivots) {
    const c = clusters.find(x => Math.abs(x.price-p.price)/p.price <= proximity);
    if (c) { c.members.push(p); c.price = (c.price*(c.members.length-1)+p.price)/c.members.length; }
    else clusters.push({ price:p.price, members:[p] });
  }
  clusters.sort((a,b) => b.members[b.members.length-1].idx - a.members[a.members.length-1].idx);
  return clusters[0]?.price || null;
}

async function fetchCandles(instId, bar, limit=100) { return publicGet(`/api/v5/market/candles?${qs({ instId, bar, limit })}`); }
async function fetchTicker(instId) { const rows = await publicGet(`/api/v5/market/ticker?${qs({ instId })}`); return rows[0] || null; }
async function fetchMeta(instId) { const rows = await publicGet(`/api/v5/public/instruments?${qs({ instType:'SWAP', instId })}`); return rows[0] || null; }
function roundDown(value, step) {
  if (!Number.isFinite(step) || step <= 0) return value;
  const decimals = Math.max(0, (String(step).split('.')[1] || '').length);
  return Number((Math.floor(value / step) * step).toFixed(decimals));
}
async function setLeverage(instId) {
  if (DRY_RUN) return;
  await privateRequest('POST', '/api/v5/account/set-leverage', { instId, lever:String(EFFECTIVE_LEVERAGE), mgnMode:'cross' });
}
function clientId(prefix='snr') { return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`.slice(0,32); }

async function pollOrder(instId, ordId, attempts=8) {
  for (let i=0;i<attempts;i++) {
    try {
      const rows = await privateRequest('GET', `/api/v5/trade/order?${qs({ instId, ordId })}`);
      if (rows[0]) return rows[0];
    } catch (_) {}
    await new Promise(r => setTimeout(r, 700));
  }
  return null;
}
async function placeOrder({ sym, direction }) {
  const ticker = await fetchTicker(sym.swap);
  const meta = await fetchMeta(sym.swap);
  const price = Number(ticker?.last);
  const ctVal = Number(meta?.ctVal);
  const lotSz = Number(meta?.lotSz);
  const minSz = Number(meta?.minSz);
  if (!(price > 0) || !(ctVal > 0) || !(lotSz > 0)) throw new Error(`Invalid instrument metadata for ${sym.swap}`);

  const rawContracts = (EFFECTIVE_MARGIN_PER_TRADE * EFFECTIVE_LEVERAGE) / (price * ctVal);
  const sz = roundDown(rawContracts, lotSz);
  if (!(sz > 0) || (minSz > 0 && sz < minSz)) throw new Error(`Order below minimum: ${sz} contracts; min=${minSz}`);

  const side = direction === 'UP' ? 'buy' : 'sell';
  const tp = direction === 'UP' ? price * (1 + TAKE_PROFIT_PCT) : price * (1 - TAKE_PROFIT_PCT);
  const sl = direction === 'UP' ? price * (1 - STOP_LOSS_PCT) : price * (1 + STOP_LOSS_PCT);

  if (DRY_RUN) return { success:true, id:`SIM-${Date.now()}`, avgPx:price, sz, tp, sl, meta };
  if (!hasCredentials()) throw new Error('Live mode requires OKX API credentials');

  await setLeverage(sym.swap);
  const body = {
    instId:sym.swap, tdMode:'cross', side, ordType:'market', sz:String(sz), clOrdId:clientId(),
    attachAlgoOrds:[{
      attachAlgoClOrdId:clientId('alg'),
      tpTriggerPx:String(tp), tpOrdPx:'-1', tpTriggerPxType:'mark',
      slTriggerPx:String(sl), slOrdPx:'-1', slTriggerPxType:'mark'
    }]
  };
  if (POS_MODE==='long_short') body.posSide = direction === 'UP' ? 'long' : 'short';
  const rows = await privateRequest('POST', '/api/v5/trade/order', body);
  const ordId = rows[0]?.ordId;
  if (!ordId) throw new Error(`OKX did not return ordId: ${JSON.stringify(rows)}`);
  const orderInfo = await pollOrder(sym.swap, ordId);
  if (!orderInfo) throw new Error(`Order ${ordId} submitted but fill status could not be verified`);
  if (orderInfo.state === 'canceled') throw new Error(`Order ${ordId} was canceled`);
  if (orderInfo.state === 'filled') {
    const protection = Array.isArray(orderInfo.attachAlgoOrds) ? orderInfo.attachAlgoOrds[0] : null;
    if (!protection) {
      await new Promise(r => setTimeout(r, 1200));
      const refreshed = await pollOrder(sym.swap, ordId, 2);
      const p2 = Array.isArray(refreshed?.attachAlgoOrds) ? refreshed.attachAlgoOrds[0] : null;
      if (!p2) throw new Error(`Order ${ordId} filled but attached TP/SL could not be verified`);
    }
  }
  audit('order_placed', { instId: sym.swap, ordId, side, sz, tp, sl });
  await notifyTelegram(`🟢 LIVE 進場\n${sym.label} ${direction}\nord:${ordId}\nsz:${sz}\navgPx:${orderInfo.avgPx || 'n/a'}\nTP:${(TAKE_PROFIT_PCT*100).toFixed(2)}% SL:${(STOP_LOSS_PCT*100).toFixed(2)}%`);
  return { success:true, id:ordId, avgPx:Number(orderInfo.avgPx || price), sz, tp, sl, orderInfo };
}

const active = new Map();
const last15Bar = new Map();
let paused = false;
let running = false;
let apiFailureStreak = 0;
let lastRiskNotice = '';

async function syncTradingState() {
  if (DRY_RUN) return true;
  try {
    const positions = await privateRequest('GET', '/api/v5/account/positions?instType=SWAP');
    const pending = await privateRequest('GET', '/api/v5/trade/orders-pending?instType=SWAP');
    const monitored = new Set(SYMBOLS.map(s => s.swap));
    const next = new Map();
    for (const p of positions) {
      if (monitored.has(p.instId) && Math.abs(Number(p.pos || 0)) > 0) next.set(p.instId, { kind:'position', data:p });
    }
    for (const o of pending) {
      if (monitored.has(o.instId)) next.set(o.instId, { kind:'pending', data:o });
    }
    // Replace active atomically
    active.clear();
    for (const [k,v] of next) active.set(k,v);
    apiFailureStreak = 0;
    return true;
  } catch (e) {
    apiFailureStreak++;
    console.error('State sync failed:', e.message || e);
    if (apiFailureStreak >= MAX_CONSECUTIVE_API_FAILURES) paused = true;
    return false;
  }
}

async function updateDailyPnL() {
  if (DRY_RUN) return;
  resetDailyRiskIfNeeded();

  const begin = new Date(`${botState.risk.day}T00:00:00.000Z`).getTime();
  const rows = await privateRequest('GET', `/api/v5/trade/fills-history?${qs({ instType:'SWAP', beginTs:String(begin), limit:'100' })}`);
  const fills = rows
    .filter(r => Number(r.fillTime || 0) >= begin)
    .sort((a,b) => Number(a.fillTime || 0) - Number(b.fillTime || 0));

  let total = 0;
  const closingByOrder = new Map();

  for (const f of fills) {
    const fillTime = Number(f.fillTime || 0);
    const tradeId = String(f.tradeId || f.billId || `${f.ordId}-${fillTime}`);
    const pnl = Number(f.fillPnl || 0);
    const fee = Number(f.fee || 0);
    const realized = pnl + fee;
    total += realized;

    if (!botState.risk.processedTradeIds.includes(tradeId)) botState.risk.processedTradeIds.push(tradeId);

    // Only fills with realized PnL are treated as closing events.
    // Each closing order is one completed trade; its timestamp is the latest
    // fill time belonging to that order, so the streak follows actual close order.
    if (pnl !== 0 && f.ordId) {
      const ordId = String(f.ordId);
      const current = closingByOrder.get(ordId) || {
        ordId,
        pnl: 0,
        lastFillTime: 0,
        instId: f.instId || '',
        tradeIds: []
      };
      current.pnl += realized;
      current.lastFillTime = Math.max(current.lastFillTime, fillTime);
      if (tradeId) current.tradeIds.push(tradeId);
      closingByOrder.set(ordId, current);
    }
  }

  // Sort newest completed trade first. Do NOT sort by PnL, order ID, or object insertion order.
  const completedTrades = [...closingByOrder.values()]
    .filter(t => Number.isFinite(t.lastFillTime) && t.lastFillTime > 0)
    .sort((a,b) => b.lastFillTime - a.lastFillTime);

  let streak = 0;
  for (const trade of completedTrades) {
    if (trade.pnl < 0) {
      streak += 1;
      continue;
    }
    if (trade.pnl > 0) break;
    // Exactly zero after fees is ignored rather than breaking the loss streak.
  }

  botState.risk.dailyRealizedPnl = total;
  botState.risk.consecutiveLosses = streak;

  for (const trade of completedTrades) {
    if (!botState.risk.processedClosingOrders.includes(trade.ordId)) {
      botState.risk.processedClosingOrders.push(trade.ordId);
    }
  }
  if (botState.risk.processedTradeIds.length > 1000) botState.risk.processedTradeIds = botState.risk.processedTradeIds.slice(-1000);
  if (botState.risk.processedClosingOrders.length > 500) botState.risk.processedClosingOrders = botState.risk.processedClosingOrders.slice(-500);

  if (botState.risk.dailyRealizedPnl <= -Math.abs(MAX_DAILY_LOSS_U) || botState.risk.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    botState.risk.halted = true;
  }

  persistState();

  const notice = `${botState.risk.dailyRealizedPnl.toFixed(4)}|${botState.risk.consecutiveLosses}|${botState.risk.halted}`;
  if (botState.risk.halted && notice !== lastRiskNotice) {
    lastRiskNotice = notice;
    await notifyTelegram(`⛔ 風控停機\n今日已實現損益：${botState.risk.dailyRealizedPnl.toFixed(2)}U\n連敗：${botState.risk.consecutiveLosses}\n停止開新倉。`);
  }
}

function evaluateSignal(c4h, c15) {
  const h4 = confirmedCandles(c4h);
  const m15 = confirmedCandles(c15);
  if (h4.length < EMA_PERIOD + PIVOT_LOOKBACK * 2 + 2 || m15.length < Math.max(EMA_PERIOD + 1, VOLUME_LOOKBACK + 1, ATR_PERIOD + 1)) return null;
  const { pivotHighs, pivotLows } = findPivots(h4, PIVOT_LOOKBACK);
  const resistance = pickLevel(pivotHighs);
  const support = pickLevel(pivotLows);
  if (!(resistance > 0) || !(support > 0)) return null;

  const ema4 = ema(closes(h4), EMA_PERIOD);
  const ema15 = ema(closes(m15), EMA_PERIOD);
  const close15 = Number(m15[m15.length-1][4]);
  const atr = atrPct(m15, ATR_PERIOD);
  if (!(ema4 > 0) || !(ema15 > 0) || !Number.isFinite(atr) || atr < MIN_ATR_PCT || atr > MAX_ATR_PCT) return null;

  const latestVol = quoteVolume(m15[m15.length-1]);
  const prev = m15.slice(-(VOLUME_LOOKBACK + 1), -1).map(quoteVolume);
  const avgVol = prev.reduce((a,b) => a+b, 0) / prev.length;
  if (!(latestVol > 0) || !(avgVol > 0) || latestVol < avgVol * MIN_VOLUME_MULTIPLIER) return null;

  if (close15 > resistance * (1 + BREAKOUT_BUFFER) && close15 > ema4 && close15 > ema15) return { direction:'UP', resistance, support, ema4, ema15, atr, volumeRatio:latestVol/avgVol };
  if (close15 < support * (1 - BREAKOUT_BUFFER) && close15 < ema4 && close15 < ema15) return { direction:'DOWN', resistance, support, ema4, ema15, atr, volumeRatio:latestVol/avgVol };
  return null;
}

async function processSymbol(sym) {
  try {
    if (paused || riskBlocked()) return;
    const [c4h,c15] = await Promise.all([fetchCandles(sym.base,'4H',100), fetchCandles(sym.base,'15m',100)]);
    const m15 = confirmedCandles(c15);
    if (!m15.length) return;
    const ts = String(m15[m15.length-1][0]);
    if (last15Bar.get(sym.swap) === ts) return;
    last15Bar.set(sym.swap, ts);

    const signal = evaluateSignal(c4h,c15);
    if (!signal) return;
    if (!DRY_RUN && !(await syncTradingState())) return;
    if (active.has(sym.swap)) return;
    if (active.size >= EFFECTIVE_MAX_CONCURRENT) return;
    if (riskBlocked()) return;

    const result = await placeOrder({ sym, direction:signal.direction });
    active.set(sym.swap, { kind:'bot-order', data:result });
    if (DRY_RUN) setTimeout(() => { active.delete(sym.swap); }, 4 * 60 * 60 * 1000);
    audit('entry', { symbol:sym.label, instId:sym.swap, direction:signal.direction, margin:EFFECTIVE_MARGIN_PER_TRADE, leverage:EFFECTIVE_LEVERAGE, orderId:result.id, signal });
    await notifyTelegram(`✅ ${DRY_RUN ? 'SIM' : 'LIVE'} 進場\n${sym.label} ${signal.direction}\n保證金 ${EFFECTIVE_MARGIN_PER_TRADE}U × ${EFFECTIVE_LEVERAGE}x\nTP ${(TAKE_PROFIT_PCT*100).toFixed(2)}% / SL ${(STOP_LOSS_PCT*100).toFixed(2)}%`);
  } catch (e) {
    console.error(`${sym.label}:`, e.message || e);
    audit('process_error', { symbol:sym.label, error:e.message || String(e) });
  }
}

async function runLoop() {
  if (running) return;
  running = true;
  try {
    resetDailyRiskIfNeeded();
    if (!DRY_RUN) await updateDailyPnL();
    if (paused || riskBlocked()) return;
    if (!DRY_RUN) await syncTradingState();
    for (const sym of SYMBOLS) {
      if (paused || riskBlocked()) break;
      await processSymbol(sym);
      await new Promise(r => setTimeout(r, 150));
    }
  } finally { running = false; }
}

function controlToken(req) { return req.header('x-control-token') || req.query.token || ''; }

// Rate limiter for control endpoints to avoid abuse
const controlLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
app.get('/health', (req,res) => res.json({
  ok:true, mode:DRY_RUN?'DRY_RUN':'LIVE', paused, halted:botState.risk.halted,
  dailyRealizedPnl:botState.risk.dailyRealizedPnl, consecutiveLosses:botState.risk.consecutiveLosses,
  openPositions:active.size, maxPositions:EFFECTIVE_MAX_CONCURRENT, marginPerTrade:EFFECTIVE_MARGIN_PER_TRADE, leverage:EFFECTIVE_LEVERAGE,
  tp:TAKE_PROFIT_PCT, sl:STOP_LOSS_PCT, now:new Date().toISOString()
}));
app.post('/pause', controlLimiter, (req,res) => {
  if (!CONTROL_TOKEN || controlToken(req) !== CONTROL_TOKEN) return res.status(401).json({ok:false,msg:'unauthorized'});
  paused = true; void notifyTelegram('⏸️ Bot 已手動暫停'); res.json({ok:true,paused});
});
app.post('/resume', controlLimiter, (req,res) => {
  if (!CONTROL_TOKEN || controlToken(req) !== CONTROL_TOKEN) return res.status(401).json({ok:false,msg:'unauthorized'});
  resetDailyRiskIfNeeded();
  if (botState.risk.halted) return res.status(409).json({ok:false,msg:'risk lock active; wait for next UTC day'});
  paused = false; apiFailureStreak = 0; void notifyTelegram('▶️ Bot 已恢復'); res.json({ok:true,paused});
});
app.get('/', (req,res) => res.send(`OKX Perpetual SNR Bot | ${DRY_RUN?'DRY_RUN':'LIVE'} | ${EFFECTIVE_MARGIN_PER_TRADE}U × ${EFFECTIVE_LEVERAGE}x | max ${EFFECTIVE_MAX_CONCURRENT} positions`));

function validateEnv() {
  if (!DRY_RUN && (!API_KEY || !SECRET_KEY || !PASSPHRASE)) {
    console.error('Missing OKX credentials. Set OK_ACCESS_KEY, OK_ACCESS_SECRET and OKX_PASSPHRASE (or run in DRY_RUN).');
    process.exit(1);
  }
  if (!BOT_STATE_FILE) {
    console.error('BOT_STATE_FILE not set');
    process.exit(1);
  }
  if (!CONTROL_TOKEN) console.warn('CONTROL_TOKEN not set — /pause and /resume endpoints are unauthenticated');
}

validateEnv();

// Ensure we persist state on unexpected errors
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  try { audit('uncaughtException', { message: String(err) }); } catch (_) {}
  try { persistState(); } catch (_) {}
  process.exit(1);
});
process.on('unhandledRejection', e => {
  console.error('Unhandled rejection:', e);
  try { audit('unhandledRejection', { message: String(e) }); } catch (_) {}
});

const server = app.listen(PORT, () => {
  console.log(`Bot listening on ${PORT}; mode=${DRY_RUN?'DRY_RUN':'LIVE'}; margin=${EFFECTIVE_MARGIN_PER_TRADE}U; leverage=${EFFECTIVE_LEVERAGE}x; max=${EFFECTIVE_MAX_CONCURRENT}`);
  void notifyTelegram(`Bot 啟動\n模式：${DRY_RUN?'模擬':'實盤'}\n${EFFECTIVE_MARGIN_PER_TRADE}U × ${EFFECTIVE_LEVERAGE}x\n最多 ${EFFECTIVE_MAX_CONCURRENT} 倉\nTP/SL ${(TAKE_PROFIT_PCT*100).toFixed(2)}%/${(STOP_LOSS_PCT*100).toFixed(2)}%`);
});

setInterval(() => { void runLoop(); }, CHECK_INTERVAL);
if (!DRY_RUN) setInterval(() => { void syncTradingState(); void updateDailyPnL(); }, POSITION_SYNC_INTERVAL);
void runLoop();

process.on('SIGINT', () => { try { persistState(); } catch (_) {} server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { try { persistState(); } catch (_) {} server.close(() => process.exit(0)); });
