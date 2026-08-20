'use strict';

/*
 * OKX Event Contract Bot — pure 1H mathematical strategy
 *
 * Signal source: ONLY confirmed 1H candles of the underlying asset.
 * No RSI / MACD / EMA / Bollinger / SNR / volume / multi-timeframe indicators.
 * Event contracts may be 5m or 15m; their entry direction comes only from the 1H model.
 * Default: PAPER / 1U / BTC ETH SOL.
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.PORT || 10000);
const LIVE = String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';
const BASE_URL = String(process.env.OKX_BASE_URL || 'https://www.okx.com').replace(/\/$/, '');
const API_KEY = String(process.env.OK_ACCESS_KEY || '').trim();
const API_SECRET = String(process.env.OK_ACCESS_SECRET || '').trim();
const PASSPHRASE = String(process.env.OKX_PASSPHRASE || '').trim();
const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/[\"']/g, '');
const TG_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();

const LOOP_MS = Math.max(10000, Number(process.env.CHECK_INTERVAL || 15000));
const POSITION_MS = Math.max(3000, Number(process.env.POSITION_CHECK_INTERVAL || 5000));
const STAKE = 1;
const START_CAPITAL = 20;
const MIN_PROB = 0.75;
const MIN_EV = 0;
const MIN_PRICE = 0.25;
const MAX_PRICE = 0.40;
const MIN_EXPIRY_MIN = 2;
const MAX_EXPIRY_MIN = 20;
const MAX_LOSSES = 3;
const COOLDOWN_MS = 30 * 60 * 1000;
const DAILY_LOSS_LIMIT = 0.10;
const TAKE_PROFIT = Number(process.env.EARLY_TP_PCT || 0.30);
const STOP_LOSS = Number(process.env.EARLY_SL_PCT || 0.25);
const STATE_FILE = process.env.BOT_STATE_FILE || path.join(__dirname, 'bot-state.json');
const ASSETS = ['BTC', 'ETH', 'SOL'];
const UNDERLYING = {
  BTC: 'BTC-USDT-SWAP',
  ETH: 'ETH-USDT-SWAP',
  SOL: 'SOL-USDT-SWAP'
};

const telegram = TG_TOKEN ? new TelegramBot(TG_TOKEN, { polling: false }) : null;

function log(tag, value) {
  if (value === undefined) console.log(tag);
  else console.log(tag, typeof value === 'string' ? value : JSON.stringify(value));
}

async function notify(text) {
  if (!telegram || !TG_CHAT_ID) return;
  try { await telegram.sendMessage(TG_CHAT_ID, text); }
  catch (e) { console.error('[TELEGRAM]', e.message); }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function query(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function http(config, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try { return await axios({ timeout: 15000, ...config }); }
    catch (e) {
      last = e;
      if (i < retries - 1) await sleep(400 * (i + 1));
    }
  }
  throw last;
}

async function publicGet(endpoint, params = {}) {
  const qs = query(params);
  const url = `${BASE_URL}${endpoint}${qs ? `?${qs}` : ''}`;
  const res = await http({ method: 'GET', url });
  if (!res.data || String(res.data.code) !== '0') {
    throw new Error(`OKX public error: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return Array.isArray(res.data.data) ? res.data.data : [];
}

function sign(timestamp, method, requestPath, body) {
  return crypto.createHmac('sha256', API_SECRET)
    .update(timestamp + method.toUpperCase() + requestPath + body)
    .digest('base64');
}

async function privateRequest(method, requestPath, bodyObject = null) {
  if (!API_KEY || !API_SECRET || !PASSPHRASE) throw new Error('OKX private API credentials are missing');
  const timestamp = new Date().toISOString();
  const body = bodyObject ? JSON.stringify(bodyObject) : '';
  const headers = {
    'OK-ACCESS-KEY': API_KEY,
    'OK-ACCESS-SIGN': sign(timestamp, method, requestPath, body),
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': PASSPHRASE,
    'Content-Type': 'application/json'
  };
  const res = await http({ method, url: `${BASE_URL}${requestPath}`, data: body || undefined, headers });
  if (!res.data || String(res.data.code) !== '0') {
    throw new Error(`OKX private error: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return Array.isArray(res.data.data) ? res.data.data : [];
}

function freshState() {
  return {
    day: new Date().toISOString().slice(0, 10),
    paperEquity: START_CAPITAL,
    realizedPnl: 0,
    consecutiveLosses: 0,
    cooldownUntil: 0,
    halted: false,
    position: null,
    usedEvents: [],
    trades: []
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return freshState();
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      ...freshState(),
      ...saved,
      usedEvents: Array.isArray(saved.usedEvents) ? saved.usedEvents : [],
      trades: Array.isArray(saved.trades) ? saved.trades : []
    };
  } catch (e) {
    console.error('[STATE LOAD]', e.message);
    return freshState();
  }
}

const state = loadState();

function saveState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('[STATE SAVE]', e.message); }
}

function recalcStats() {
  let pnl = 0;
  let losses = 0;
  for (const t of state.trades) pnl += Number(t.pnl || 0);
  for (let i = state.trades.length - 1; i >= 0; i--) {
    const p = Number(state.trades[i].pnl || 0);
    if (p < 0) losses++;
    else if (p > 0) break;
  }
  state.realizedPnl = Number(pnl.toFixed(4));
  state.consecutiveLosses = losses;
  if (!LIVE) state.paperEquity = Number(Math.max(0, START_CAPITAL + pnl).toFixed(4));
}

function resetDayIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) {
    state.day = today;
    state.cooldownUntil = 0;
    state.halted = false;
    recalcStats();
    saveState();
  }
}

function riskBlocked() {
  resetDayIfNeeded();
  recalcStats();
  const now = Date.now();
  if (state.cooldownUntil > 0) {
    if (now < state.cooldownUntil) {
      state.halted = true;
      return true;
    }
    state.cooldownUntil = 0;
    state.halted = false;
    state.consecutiveLosses = 0;
    saveState();
    log('[RISK]', '30 minute cooldown complete; trading resumed');
  }
  if (state.consecutiveLosses >= MAX_LOSSES) {
    state.halted = true;
    state.cooldownUntil = now + COOLDOWN_MS;
    saveState();
    log('[RISK]', '3 consecutive losses -> 30 minute cooldown');
    return true;
  }
  if (state.realizedPnl <= -(START_CAPITAL * DAILY_LOSS_LIMIT)) {
    state.halted = true;
    saveState();
    return true;
  }
  state.halted = false;
  return false;
}

function eventUsed(instId) { return state.usedEvents.includes(instId); }
function markEventUsed(instId) {
  if (!eventUsed(instId)) {
    state.usedEvents.push(instId);
    if (state.usedEvents.length > 2000) state.usedEvents = state.usedEvents.slice(-2000);
    saveState();
  }
}

function confirmedCandles(rows) {
  return rows
    .slice()
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .filter(row => String(row[8]) === '1');
}

async function candles(instId, bar, limit = 100) {
  const rows = await publicGet('/api/v5/market/candles', { instId, bar, limit });
  return confirmedCandles(rows);
}

async function ticker(instId) {
  const rows = await publicGet('/api/v5/market/ticker', { instId, instType: 'EVENTS' });
  return rows[0] || null;
}

function closePrices(rows) {
  return rows.map(r => Number(r[4])).filter(Number.isFinite);
}

/*
 * Pure 1H mathematical model:
 * r_t = ln(P_t / P_{t-1})
 * mu_w = sum(w_t * r_t) / sum(w_t)
 * sigma = sample standard deviation of r_t
 * z = mu_w / sigma
 * P(UP) = 0.5 + 0.5 * tanh(1.35 * z)
 * EV = P / Entry - 1
 */
function mathModel(rows) {
  const prices = closePrices(rows);
  if (prices.length < 20) return null;

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > 0 && prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  if (returns.length < 19) return null;

  const sample = returns.slice(-48);
  let weightSum = 0;
  let weightedReturn = 0;
  for (let i = 0; i < sample.length; i++) {
    const w = i + 1;
    weightSum += w;
    weightedReturn += sample[i] * w;
  }

  const mu = weightedReturn / weightSum;
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const variance = sample.reduce((sum, x) => sum + (x - mean) ** 2, 0) / Math.max(1, sample.length - 1);
  const sigma = Math.sqrt(variance);
  if (!(sigma > 0)) return null;

  const z = mu / sigma;
  const pUp = 0.5 + 0.5 * Math.tanh(1.35 * z);
  const direction = pUp >= 0.5 ? 'UP' : 'DOWN';
  const probability = direction === 'UP' ? pUp : 1 - pUp;

  return { direction, probability, z, sigma, mu };
}

function assetFrom(inst) {
  const s = `${inst.instId || ''} ${inst.seriesId || ''} ${inst.baseCcy || ''}`.toUpperCase();
  return ASSETS.find(a => s.includes(a)) || null;
}

function isUpDown(inst) {
  return `${inst.instId || ''} ${inst.seriesId || ''}`.toUpperCase().includes('UPDOWN');
}

function expiryMs(inst) {
  for (const key of ['expTime', 'expiryTime', 'endTime']) {
    const n = Number(inst[key]);
    if (Number.isFinite(n) && n > Date.now() - 86400000) return n;
  }
  const m = String(inst.instId || '').match(/-(\d{6})-(\d{4})-(\d{4})$/);
  if (!m) return NaN;
  const d = m[1];
  const end = m[3];
  return Date.UTC(2000 + Number(d.slice(0, 2)), Number(d.slice(2, 4)) - 1, Number(d.slice(4, 6)), Number(end.slice(0, 2)), Number(end.slice(2, 4)));
}

function minutesToExpiry(inst) {
  const ms = expiryMs(inst);
  return Number.isFinite(ms) ? (ms - Date.now()) / 60000 : NaN;
}

function validExpiry(inst) {
  const m = minutesToExpiry(inst);
  return Number.isFinite(m) && m >= MIN_EXPIRY_MIN && m <= MAX_EXPIRY_MIN;
}

function priceValid(p) { return Number.isFinite(p) && p >= MIN_PRICE && p <= MAX_PRICE; }

function roundPrice(value, tick) {
  const t = Number(tick);
  if (!(t > 0)) return Number(value.toFixed(6));
  const decimals = Math.max(0, (String(t).split('.')[1] || '').length);
  return Number((Math.round(value / t) * t).toFixed(decimals));
}

function orderSize(price, inst) {
  const lot = Math.max(Number(inst.lotSz || 0.1), 0.1);
  const min = Math.max(Number(inst.minSz || lot), lot);
  let size = Math.floor((STAKE / price) / lot) * lot;
  if (size < min) size = min;
  return Number(size.toFixed(8));
}

function configuredSeries() {
  const explicit = String(process.env.EVENT_SERIES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  return ASSETS.flatMap(a => [`${a}-UPDOWN-5MIN`, `${a}-UPDOWN-15MIN`]);
}

async function discover() {
  const all = [];
  for (const seriesId of configuredSeries()) {
    try {
      const rows = await publicGet('/api/v5/public/instruments', { instType: 'EVENTS', seriesId });
      for (const row of rows) all.push({ ...row, seriesId: row.seriesId || seriesId });
    } catch (e) { console.error(`[DISCOVERY] ${seriesId}:`, e.message); }
  }
  return all;
}

async function scan() {
  const instruments = await discover();
  const filtered = instruments.filter(inst => {
    const asset = assetFrom(inst);
    return asset && isUpDown(inst) && (!inst.state || String(inst.state).toLowerCase() === 'live') && validExpiry(inst) && !eventUsed(inst.instId);
  });
  log('[SCAN]', { instruments: instruments.length, filtered: filtered.length, timeframe: '1H' });

  const cache = {};
  const candidates = [];
  for (const inst of filtered) {
    try {
      const asset = assetFrom(inst);
      if (!cache[asset]) cache[asset] = await candles(UNDERLYING[asset], '1H', 100);
      const model = mathModel(cache[asset]);
      if (!model) continue;

      const t = await ticker(inst.instId);
      const ask = Number(t?.askPx || t?.last);
      const bid = Number(t?.bidPx || t?.last);
      if (!(ask > 0 && ask < 1 && bid > 0 && bid < 1)) continue;

      const side = model.direction === 'UP' ? 'yes' : 'no';
      const entry = side === 'yes' ? ask : 1 - bid;
      if (!priceValid(entry)) continue;

      const ev = model.probability / entry - 1;
      if (model.probability < MIN_PROB || ev <= MIN_EV) continue;

      const mins = minutesToExpiry(inst);
      candidates.push({ inst, asset, side, entry, ev, model, mins });
      log('[MATH PASS]', {
        instId: inst.instId,
        side,
        entryPx: Number(entry.toFixed(4)),
        probability: Number((model.probability * 100).toFixed(1)),
        z: Number(model.z.toFixed(4)),
        sigma: Number(model.sigma.toFixed(6)),
        ev: Number((ev * 100).toFixed(1)),
        timeframe: '1H',
        minutesToExpiry: Number(mins.toFixed(1))
      });
    } catch (e) {
      console.error(`[CANDIDATE] ${inst.instId}:`, e.message);
    }
  }

  return candidates.sort((a, b) => b.ev - a.ev);
}

async function getOrder(instId, ordId) {
  const rows = await privateRequest('GET', `/api/v5/trade/order?${query({ instId, ordId })}`);
  return rows[0] || null;
}

function orderSizeForEntry(price, inst) {
  return orderSize(price, inst);
}

async function place(candidate) {
  const inst = candidate.inst;
  const px = roundPrice(candidate.entry, Number(inst.tickSz || 0.001));
  const sz = orderSizeForEntry(px, inst);
  const actualStake = Number((px * sz).toFixed(6));
  log('[ORDER SIZE]', { targetStake: STAKE, entryPx: px, contracts: sz, actualStake });

  if (!LIVE) {
    return { simulated: true, state: 'filled', avgPx: px, accFillSz: sz, ordId: `PAPER-${Date.now()}` };
  }
  if (!API_KEY || !API_SECRET || !PASSPHRASE) throw new Error('LIVE_TRADING=true but OKX credentials are missing');

  const body = {
    instId: inst.instId,
    tdMode: 'isolated',
    side: 'buy',
    ordType: 'ioc',
    px: px.toFixed(6),
    sz: String(sz),
    outcome: candidate.side,
    ccy: 'USDT',
    clOrdId: `evt${Date.now().toString(36)}`.slice(0, 32)
  };
  const rows = await privateRequest('POST', '/api/v5/trade/order', body);
  const result = rows[0];
  if (!result || String(result.sCode) !== '0' || !result.ordId) throw new Error(`Order rejected: ${JSON.stringify(result)}`);
  await sleep(500);
  return { ...result, ...(await getOrder(inst.instId, result.ordId)) };
}

function pnl(side, entry, exit, size) {
  const delta = side === 'yes' ? exit - entry : entry - exit;
  return Number((delta * size).toFixed(4));
}

async function closePosition(position, exitPx, reason) {
  const inst = position.inst;
  const px = roundPrice(exitPx, Number(inst.tickSz || 0.001));
  let result;
  if (!LIVE) {
    result = { simulated: true, state: 'filled', avgPx: px, accFillSz: position.size };
  } else {
    const body = {
      instId: inst.instId,
      tdMode: 'isolated',
      side: 'sell',
      ordType: 'ioc',
      px: px.toFixed(6),
      sz: String(position.size),
      outcome: position.side,
      ccy: 'USDT',
      clOrdId: `exit${Date.now().toString(36)}`.slice(0, 32)
    };
    const rows = await privateRequest('POST', '/api/v5/trade/order', body);
    result = rows[0];
    if (!result || String(result.sCode) !== '0') throw new Error(`Exit rejected: ${JSON.stringify(result)}`);
    if (result.ordId) {
      await sleep(500);
      result = { ...result, ...(await getOrder(inst.instId, result.ordId)) };
    }
  }

  const actualExit = Number(result.avgPx || result.fillPx || px);
  const profit = pnl(position.side, position.entryPx, actualExit, position.size);
  state.trades.push({
    at: new Date().toISOString(),
    instId: inst.instId,
    side: position.side,
    entryPx: position.entryPx,
    exitPx: actualExit,
    size: position.size,
    pnl: profit,
    reason
  });
  state.position = null;
  recalcStats();
  if (state.consecutiveLosses >= MAX_LOSSES) state.cooldownUntil = Date.now() + COOLDOWN_MS;
  saveState();
  await notify(`${profit >= 0 ? '🟢' : '🔴'} EVENT EXIT\n${inst.instId}\n${position.side.toUpperCase()}\nEntry ${position.entryPx.toFixed(4)}\nExit ${actualExit.toFixed(4)}\nContracts ${position.size}\nPnL ${profit >= 0 ? '+' : ''}${profit.toFixed(4)}U\n${reason}\n${LIVE ? 'LIVE' : 'PAPER'}`);
}

async function managePosition() {
  const position = state.position;
  if (!position) return;
  try {
    const t = await ticker(position.inst.instId);
    const bid = Number(t?.bidPx || t?.last);
    const ask = Number(t?.askPx || t?.last);
    if (!(bid > 0 && bid < 1)) return;
    const current = position.side === 'yes' ? bid : 1 - (ask > 0 ? ask : bid);
    if (!(current > 0 && current < 1)) return;
    const change = (current - position.entryPx) / position.entryPx;
    if (change >= TAKE_PROFIT) return closePosition(position, current, 'TP');
    if (change <= -STOP_LOSS) return closePosition(position, current, 'SL');
  } catch (e) { console.error('[POSITION]', e.message); }
}

function entryMessage(c, fillPx, size) {
  return [
    '🟡 EVENT ENTRY',
    c.inst.instId,
    c.side.toUpperCase(),
    `Entry ${fillPx.toFixed(4)}`,
    `Contracts ${size}`,
    `Stake ${STAKE}U`,
    'Timeframe 1H',
    `Direction ${c.model.direction}`,
    `Probability ${(c.model.probability * 100).toFixed(1)}%`,
    `Z ${c.model.z.toFixed(4)}`,
    `EV ${(c.ev * 100).toFixed(1)}%`,
    `Expiry ${c.mins.toFixed(1)}m`,
    LIVE ? 'LIVE' : 'PAPER'
  ].join('\n');
}

async function tradeTopCandidate(candidate) {
  if (riskBlocked() || state.position) return;
  markEventUsed(candidate.inst.instId);
  const result = await place(candidate);
  const fillPx = Number(result.avgPx || result.fillPx || candidate.entry);
  const size = Number(result.accFillSz || result.fillSz || orderSizeForEntry(fillPx, candidate.inst));
  if (!(size > 0)) throw new Error('Order returned zero filled size');
  state.position = {
    inst: candidate.inst,
    side: candidate.side,
    entryPx: fillPx,
    size,
    openedAt: Date.now(),
    probability: candidate.model.probability,
    z: candidate.model.z,
    ev: candidate.ev
  };
  saveState();
  await notify(entryMessage(candidate, fillPx, size));
}

let loopBusy = false;
let started = false;
let loopTimer = null;
let positionTimer = null;

async function mainLoop() {
  if (loopBusy) {
    log('[LOOP]', 'duplicate invocation blocked');
    return;
  }
  loopBusy = true;
  try {
    log('[HEARTBEAT]', new Date().toISOString());
    if (riskBlocked() || state.position) return;
    const candidates = await scan();
    log('[SCAN RESULT]', `candidates=${candidates.length}`);
    if (candidates.length) await tradeTopCandidate(candidates[0]);
  } catch (e) {
    console.error('[MAIN LOOP]', e.stack || e.message || e);
  } finally {
    loopBusy = false;
  }
}

function start() {
  if (started) {
    log('[START]', 'duplicate start blocked');
    return;
  }
  started = true;
  log('[START]', `mode=${LIVE ? 'LIVE' : 'PAPER'} stake=${STAKE}U strategy=PURE-1H-MATH`);
  log('[FORMULA]', 'r=ln(Pt/Pt-1), mu_w=sum(w*r)/sum(w), sigma=std(r), z=mu_w/sigma, P=0.5+0.5*tanh(1.35*z), EV=P/Entry-1');
  log('[SAFETY]', `P>=${MIN_PROB * 100}% EV>0 Entry=${MIN_PRICE}-${MAX_PRICE} 3-loss-cooldown=30m`);

  app.get('/', (_req, res) => res.status(200).send('OKX EVENT CONTRACT BOT RUNNING'));
  app.get('/health', (_req, res) => res.json({
    ok: true,
    mode: LIVE ? 'LIVE' : 'PAPER',
    strategy: 'PURE-1H-MATH',
    timeframe: '1H',
    loopBusy,
    position: Boolean(state.position),
    cooldownUntil: state.cooldownUntil || 0,
    consecutiveLosses: state.consecutiveLosses
  }));

  app.listen(PORT, () => log('[HTTP]', `listening on ${PORT}`));

  if (telegram) {
    telegram.onText(/^\/(stats|stat|統計)$/i, async msg => {
      if (String(msg.chat.id) !== TG_CHAT_ID) return;
      recalcStats();
      const wins = state.trades.filter(t => Number(t.pnl) > 0).length;
      const losses = state.trades.filter(t => Number(t.pnl) < 0).length;
      const wr = state.trades.length ? wins / state.trades.length * 100 : 0;
      await notify(`📊 PAPER 統計\n\n交易筆數：${state.trades.length}\n勝場：${wins}\n敗場：${losses}\n勝率：${wr.toFixed(1)}%\n累計 PnL：${state.realizedPnl >= 0 ? '+' : ''}${state.realizedPnl.toFixed(4)}U\n目前資金：${state.paperEquity.toFixed(4)}U\n連敗：${state.consecutiveLosses}\n冷卻：${state.cooldownUntil > Date.now() ? '是' : '否'}`);
    });
  }

  void mainLoop();
  loopTimer = setInterval(() => void mainLoop(), LOOP_MS);
  positionTimer = setInterval(() => void managePosition(), POSITION_MS);
}

process.on('SIGTERM', () => {
  if (loopTimer) clearInterval(loopTimer);
  if (positionTimer) clearInterval(positionTimer);
  log('[SHUTDOWN]', 'SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  if (loopTimer) clearInterval(loopTimer);
  if (positionTimer) clearInterval(positionTimer);
  log('[SHUTDOWN]', 'SIGINT');
  process.exit(0);
});

start();
