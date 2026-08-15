'use strict';
/*
  Event Contract SNR Bot — OKX (BTC & ETH)
  - Timeframes: 5m & 15m (act on candle close)
  - Strategy: SNR pivot breakout + EMA20 trend filter
  - Each bet: fixed amount in USDT (MARGIN_PER_TRADE, default 2)
  - Uses OKX event instruments (instId) you provide via env
  - DRY_RUN=false to send live orders (must set env). Default: DRY_RUN=true for safety.
  - Emergency HTTP control: /pause, /resume (protected by CONTROL_TOKEN)
*/

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

/* ---------- CONFIG (via env) ---------- */
const PORT = Number(process.env.PORT || 3000);
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() !== 'false'; // set false to go live
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/['"]+/g, '');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_KEY = process.env.OK_ACCESS_KEY || '';
const SECRET_KEY = process.env.OK_ACCESS_SECRET || '';
const PASSPHRASE = process.env.OKX_PASSPHRASE || '';
const BASE_URL = process.env.OKX_BASE_URL || 'https://www.okx.com';

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 15 * 1000); // poll interval
const LEVERAGE = Number(process.env.LEVERAGE || 3);
const MARGIN_PER_TRADE = Number(process.env.MARGIN_PER_TRADE || 8); // 8 U margin per trade
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 0.01); // 1% risk
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 0.03); // 3% reward (1:3 R:R)
const POS_MODE = (process.env.POS_MODE || 'net').toLowerCase(); // net or long_short
const BREAKOUT_BUFFER = Number(process.env.BREAKOUT_BUFFER || 0.001); // 0.1% buffer
const EMA_PERIOD = Number(process.env.EMA_PERIOD || 20);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || ''; // required to protect /pause /resume

/* ---------- Symbols (monitor spot candles for S/R) ---------- */
const SYMBOLS = [
  { base: 'ETH-USDT', label: 'ETH', swap: 'ETH-USDT-SWAP' },
  { base: 'SOL-USDT', label: 'SOL', swap: 'SOL-USDT-SWAP' },
  { base: 'XRP-USDT', label: 'XRP', swap: 'XRP-USDT-SWAP' },
  { base: 'DOGE-USDT', label: 'DOGE', swap: 'DOGE-USDT-SWAP' },
  { base: 'ADA-USDT', label: 'ADA', swap: 'ADA-USDT-SWAP' },
  { base: 'AVAX-USDT', label: 'AVAX', swap: 'AVAX-USDT-SWAP' },
  { base: 'LINK-USDT', label: 'LINK', swap: 'LINK-USDT-SWAP' },
  { base: 'DOT-USDT', label: 'DOT', swap: 'DOT-USDT-SWAP' },
  { base: 'LTC-USDT', label: 'LTC', swap: 'LTC-USDT-SWAP' },
  { base: 'BCH-USDT', label: 'BCH', swap: 'BCH-USDT-SWAP' },
  { base: 'SUI-USDT', label: 'SUI', swap: 'SUI-USDT-SWAP' },
  { base: 'APT-USDT', label: 'APT', swap: 'APT-USDT-SWAP' },
  { base: 'NEAR-USDT', label: 'NEAR', swap: 'NEAR-USDT-SWAP' },
  { base: 'UNI-USDT', label: 'UNI', swap: 'UNI-USDT-SWAP' },
  { base: 'ATOM-USDT', label: 'ATOM', swap: 'ATOM-USDT-SWAP' },
  { base: 'FIL-USDT', label: 'FIL', swap: 'FIL-USDT-SWAP' },
  { base: 'ETC-USDT', label: 'ETC', swap: 'ETC-USDT-SWAP' },
  { base: 'ARB-USDT', label: 'ARB', swap: 'ARB-USDT-SWAP' },
  { base: 'OP-USDT', label: 'OP', swap: 'OP-USDT-SWAP' },
  { base: 'TRX-USDT', label: 'TRX', swap: 'TRX-USDT-SWAP' }
];

/* ---------- Telegram ---------- */
let bot = { sendMessage: async () => {} };
if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
}
async function notifyTelegram(text) {
  try {
    if (!TELEGRAM_CHAT_ID) return;
    await bot.sendMessage(TELEGRAM_CHAT_ID, text);
  } catch (e) {
    console.debug('Telegram send failed:', e && e.message ? e.message : e);
  }
}

/* ---------- Helpers ---------- */
async function axiosWithRetry(config, retries = 3, delay = 1200) {
  for (let i = 0; i < retries; i++) {
    try { return await axios(config); }
    catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
function generateSignature(timestamp, method, requestPath, body = '') {
  if (!SECRET_KEY) throw new Error('API Secret 未設定');
  const message = timestamp + method.toUpperCase() + requestPath + body;
  return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
}
function normalizeCandles(candles) {
  return candles.slice().sort((a, b) => new Date(a[0]) - new Date(b[0]));
}
function closesFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[4])); }
function highsFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[2])); }
function lowsFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[3])); }

/* ---------- Indicators ---------- */
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let emaPrev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) emaPrev = values[i] * k + emaPrev * (1 - k);
  return emaPrev;
}

/* ---------- S/R pivot detection ---------- */
function findPivots(candles, lookback = 3) {
  const s = normalizeCandles(candles);
  const highs = highsFrom(s), lows = lowsFrom(s);
  const pivotHighs = [], pivotLows = [];
  for (let i = lookback; i < s.length - lookback; i++) {
    if (highs[i] === Math.max(...highs.slice(i - lookback, i + lookback + 1))) pivotHighs.push({ idx: i, price: highs[i] });
    if (lows[i] === Math.min(...lows.slice(i - lookback, i + lookback + 1))) pivotLows.push({ idx: i, price: lows[i] });
  }
  return { pivotHighs, pivotLows };
}
function pickLevelFromPivots(pivots, proximity = 0.006) {
  if (!pivots || pivots.length === 0) return null;
  const clusters = [];
  for (const p of pivots) {
    const found = clusters.find(c => Math.abs(c.price - p.price) / p.price <= proximity);
    if (found) { found.members.push(p); found.price = (found.price * (found.count || 1) + p.price) / ((found.count || 1) + 1); found.count = (found.count || 1) + 1; }
    else clusters.push({ price: p.price, members: [p], count: 1 });
  }
  clusters.sort((a, b) => (b.members[b.members.length - 1].idx) - (a.members[a.members.length - 1].idx));
  return clusters[0] ? clusters[0].price : null;
}

/* ---------- OKX Public helpers ---------- */
async function fetchOKXCandles(instId, bar, limit = 80) {
  const url = `${BASE_URL}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;
  const resp = await axiosWithRetry({ method: 'GET', url, timeout: 10000 });
  return resp && resp.data && resp.data.data ? resp.data.data : null;
}
async function fetchEventInstruments() {
  const url = `${BASE_URL}/api/v5/public/instruments?instType=SWAP`;
  const resp = await axiosWithRetry({ method: 'GET', url, timeout: 12000 });
  return resp && resp.data && Array.isArray(resp.data.data) ? resp.data.data : [];
}
async function fetchTicker(instId) {
  const url = `${BASE_URL}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`;
  const resp = await axiosWithRetry({ method: 'GET', url, timeout: 8000 });
  return resp && resp.data && Array.isArray(resp.data.data) && resp.data.data[0] ? resp.data.data[0] : null;
}
async function fetchInstrumentMetadata(instId) {
  const url = `${BASE_URL}/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`;
  try {
    const resp = await axiosWithRetry({ method: 'GET', url, timeout: 8000 });
    if (resp && resp.data && Array.isArray(resp.data.data) && resp.data.data[0]) return resp.data.data[0];
  } catch (e) { /* ignore */ }
  return null;
}
function roundDownToStep(value, step) {
  if (!step || step <= 0) return value;
  const precision = Math.max(0, (step.toString().split('.')[1] || '').length);
  const floored = Math.floor(value / step) * step;
  return parseFloat(floored.toFixed(precision));
}

/* ---------- Order submit & poll ---------- */
async function setLeverage(instId, posSide) {
  if (DRY_RUN || !API_KEY || !SECRET_KEY || !PASSPHRASE) return;
  const requestPath = '/api/v5/account/set-leverage';
  const timestamp = new Date().toISOString();
  const bodyObj = { instId, lever: LEVERAGE.toString(), mgnMode: 'cross' };
  if (POS_MODE === 'long_short') bodyObj.posSide = posSide;
  const body = JSON.stringify(bodyObj);
  const signature = generateSignature(timestamp, 'POST', requestPath, body);
  const resp = await axiosWithRetry({
    method: 'POST', url: `${BASE_URL}${requestPath}`, data: body,
    headers: { 'OK-ACCESS-KEY': API_KEY, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': PASSPHRASE, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  if (!resp || !resp.data || String(resp.data.code) !== '0') throw new Error(`Leverage setup failed: ${JSON.stringify(resp && resp.data)}`);
}

async function submitSwapOrderOKX({ instId, direction, amountU }) {
  try {
    const ticker = await fetchTicker(instId);
    const last = ticker && (ticker.last || ticker.px) ? parseFloat(ticker.last || ticker.px) : null;
    const meta = await fetchInstrumentMetadata(instId);
    let step = null;
    if (meta) {
      step = meta.lotSz || meta.minSz || meta.minSize || meta.sizeIncrement || meta.lot || null;
      if (typeof step === 'string') step = parseFloat(step);
    }
    const ctVal = meta && meta.ctVal ? parseFloat(meta.ctVal) : null;
    if (!last || last <= 0 || !ctVal || ctVal <= 0) return { success: false, error: 'Missing valid ticker or contract value' };
    let szFloat = (amountU * LEVERAGE) / (last * ctVal);
    if (step) szFloat = roundDownToStep(szFloat, step);
    const minSz = meta && meta.minSz ? parseFloat(meta.minSz) : 0;
    if (!szFloat || szFloat <= 0 || (minSz && szFloat < minSz)) return { success: false, error: `Order size below minimum: ${szFloat} contracts (min ${minSz || 'unknown'})` };

    const side = direction === 'UP' ? 'buy' : 'sell';
    const posSide = direction === 'UP' ? 'long' : 'short';
    const takeProfitPrice = direction === 'UP' ? last * (1 + TAKE_PROFIT_PCT) : last * (1 - TAKE_PROFIT_PCT);
    const stopLossPrice = direction === 'UP' ? last * (1 - STOP_LOSS_PCT) : last * (1 + STOP_LOSS_PCT);

    if (DRY_RUN || !API_KEY || !SECRET_KEY || !PASSPHRASE) {
      return { success: true, id: 'SIM-' + Date.now(), details: { instId, side, sz: szFloat, price: last, takeProfitPrice, stopLossPrice, meta } };
    }

    await setLeverage(instId, posSide);
    const requestPath = '/api/v5/trade/order';
    const timestamp = new Date().toISOString();
    const bodyObj = {
      instId, tdMode: 'cross', side, ordType: 'market', sz: szFloat.toString(),
      attachAlgoOrds: [{ tpTriggerPx: takeProfitPrice.toString(), tpOrdPx: '-1', slTriggerPx: stopLossPrice.toString(), slOrdPx: '-1', tpTriggerPxType: 'last', slTriggerPxType: 'last' }]
    };
    if (POS_MODE === 'long_short') bodyObj.posSide = posSide;
    const body = JSON.stringify(bodyObj);
    const signature = generateSignature(timestamp, 'POST', requestPath, body);

    const resp = await axiosWithRetry({
      method: 'POST',
      url: `${BASE_URL}${requestPath}`,
      data: body,
      headers: {
        'OK-ACCESS-KEY': API_KEY,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': PASSPHRASE,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    if (!resp || !resp.data) return { success: false, error: 'Empty OKX response' };
    if (String(resp.data.code) !== '0') return { success: false, error: resp.data };

    const ord = Array.isArray(resp.data.data) && resp.data.data[0] ? resp.data.data[0] : null;
    const ordId = ord ? (ord.ordId || ord.clOrdId || null) : null;
    const orderInfo = ordId ? await pollOKXOrderStatus(instId, ordId, 6, 1000) : null;

    return { success: true, id: ordId || ('OKX-SIM-' + Date.now()), details: { resp: resp.data, orderInfo } };

  } catch (e) {
    return { success: false, error: e && e.message ? e.message : e };
  }
}
async function pollOKXOrderStatus(instId, ordId, attempts = 6, delay = 1000) {
  if (!API_KEY || !SECRET_KEY || !PASSPHRASE) return null;
  const requestPath = '/api/v5/trade/order';
  const qs = `?instId=${encodeURIComponent(instId)}&ordId=${encodeURIComponent(ordId)}`;
  for (let i = 0; i < attempts; i++) {
    const timestamp = new Date().toISOString();
    try {
      const sig = generateSignature(timestamp, 'GET', requestPath + qs, '');
      const resp = await axiosWithRetry({
        method: 'GET',
        url: `${BASE_URL}${requestPath}${qs}`,
        headers: {
          'OK-ACCESS-KEY': API_KEY,
          'OK-ACCESS-SIGN': sig,
          'OK-ACCESS-TIMESTAMP': timestamp,
          'OK-ACCESS-PASSPHRASE': PASSPHRASE
        },
        timeout: 8000
      });
      if (resp && resp.data && String(resp.data.code) === '0' && Array.isArray(resp.data.data) && resp.data.data[0]) {
        const info = resp.data.data[0];
        if (info.state && (info.state === 'filled' || info.state === 'canceled' || info.state === 'live')) return info;
      }
    } catch (e) { /* ignore */ }
    await new Promise(r => setTimeout(r, delay));
  }
  return null;
}

/* ---------- Strategy state ---------- */
const state = {};
for (const s of SYMBOLS) state[s.base] = { last15CloseTs: null, lastBet: { '15m': null } };
let paused = false;
let globalOpenBets = 0;

/* ---------- Core: evaluate and act ---------- */
async function legacyEvaluateForTimeframe(sym, timeframe, candles15, candles5) {
  try {
    if (paused) return;
    const instId = (timeframe === '5m') ? sym.inst5 : sym.inst15;
    if (!instId) {
      await notifyTelegram(`[${sym.label}] ${timeframe} - 沒有對應 event instId，請在 env 設定 ${sym.label}_${timeframe.toUpperCase()}_INST`);
      return;
    }

    const { pivotHighs, pivotLows } = findPivots(candles15, 3);
    const resistance = pickLevelFromPivots(pivotHighs, 0.006);
    const support = pickLevelFromPivots(pivotLows, 0.006);
    if (!resistance || !support) return;

    const closes15 = closesFrom(candles15);
    const closes5 = closesFrom(candles5);
    const ema15 = ema(closes15, EMA_PERIOD);
    const ema5 = ema(closes5, EMA_PERIOD);
    if (!ema15 || !ema5) return;

    const latest5Close = closes5[closes5.length - 1];
    const buffer = BREAKOUT_BUFFER;

    let direction = null;
    if (latest5Close > resistance * (1 + buffer) && latest5Close > ema15 && latest5Close > ema5) direction = 'UP';
    else if (latest5Close < support * (1 - buffer) && latest5Close < ema15 && latest5Close < ema5) direction = 'DOWN';
    if (!direction) return;

    const key = timeframe;
    const lastBetTs = state[sym.base].lastBet[key];
    const nowTs = Date.now();
    const timeframeMs = (timeframe === '5m') ? 5 * 60 * 1000 : 15 * 60 * 1000;
    if (lastBetTs && (nowTs - lastBetTs) < timeframeMs) return;

    if (globalOpenBets >= MAX_CONCURRENT) {
      await notifyTelegram(`⚠️ 超過最大同時押注 (${MAX_CONCURRENT})，${sym.label} ${timeframe} 信號跳過`);
      return;
    }

    const bet = { instId, direction, amountU: MARGIN_PER_TRADE };
    const resp = await submitSwapOrderOKX(bet);

    if (resp && resp.success) {
      state[sym.base].lastBet[key] = nowTs;
      globalOpenBets++;
      await notifyTelegram(`✅ 下單 ${DRY_RUN ? '(SIM)' : '(LIVE)'}\n標的: ${sym.label}\n時框: ${timeframe}\n方向: ${direction}\n金額(U): ${MARGIN_PER_TRADE}\ninstId: ${instId}\norderId: ${resp.id}\ndetails: ${JSON.stringify(resp.details)}`);
      // optional: you may poll later and decrement globalOpenBets when order resolves
      setTimeout(async () => { globalOpenBets = Math.max(0, globalOpenBets - 1); }, 5 * 60 * 1000); // safe decrement fallback
    } else {
      await notifyTelegram(`❌ 下單失敗 ${sym.label} ${timeframe} ${direction}\nerror: ${JSON.stringify(resp)}`);
    }

  } catch (e) {
    console.error('evaluateForTimeframe error', e && e.message ? e.message : e);
  }
}

async function legacyProcessSymbol(sym) {
  try {
    const c15 = await fetchOKXCandles(sym.base, '15m', 80);
    const c5 = await fetchOKXCandles(sym.base, '5m', 80);
    if (!c15 || !c5) return;
    const sorted15 = normalizeCandles(c15);
    const sorted5 = normalizeCandles(c5);
    const latest15 = sorted15[sorted15.length - 1];
    const latest5 = sorted5[sorted5.length - 1];
    const ts15 = latest15[0], ts5 = latest5[0];
    const st = state[sym.base];
    if (st.last5CloseTs !== ts5) {
      st.last5CloseTs = ts5;
      await evaluateForTimeframe(sym, '5m', sorted15, sorted5);
    }
    if (st.last15CloseTs !== ts15) {
      st.last15CloseTs = ts15;
      await evaluateForTimeframe(sym, '15m', sorted15, sorted5);
    }
  } catch (e) {
    console.error('processSymbol error', sym.base, e && e.message ? e.message : e);
  }
}

/* ---------- Perpetual-swap strategy: 4H context, 15m entry ---------- */
async function evaluateForTimeframe(sym, candles4h, candles15) {
  try {
    if (paused) return;
    const { pivotHighs, pivotLows } = findPivots(candles4h, 3);
    const resistance = pickLevelFromPivots(pivotHighs, 0.006);
    const support = pickLevelFromPivots(pivotLows, 0.006);
    if (!resistance || !support) return;

    const closes4h = closesFrom(candles4h);
    const closes15 = closesFrom(candles15);
    const ema4h = ema(closes4h, EMA_PERIOD);
    const ema15 = ema(closes15, EMA_PERIOD);
    if (!ema4h || !ema15) return;

    const latest15Close = closes15[closes15.length - 1];
    let direction = null;
    if (latest15Close > resistance * (1 + BREAKOUT_BUFFER) && latest15Close > ema4h && latest15Close > ema15) direction = 'UP';
    else if (latest15Close < support * (1 - BREAKOUT_BUFFER) && latest15Close < ema4h && latest15Close < ema15) direction = 'DOWN';
    if (!direction) return;

    const nowTs = Date.now();
    if (state[sym.base].lastBet['15m'] && nowTs - state[sym.base].lastBet['15m'] < 15 * 60 * 1000) return;
    if (globalOpenBets >= MAX_CONCURRENT) return;

    const resp = await submitSwapOrderOKX({ instId: sym.swap, direction, amountU: MARGIN_PER_TRADE });
    if (!resp || !resp.success) {
      await notifyTelegram(`Order failed ${sym.label} ${direction}\nerror: ${JSON.stringify(resp)}`);
      return;
    }

    state[sym.base].lastBet['15m'] = nowTs;
    globalOpenBets++;
    await notifyTelegram(`Order ${DRY_RUN ? '(SIM)' : '(LIVE)'}\nSymbol: ${sym.label}\nTimeframe: 15m + 4H\nDirection: ${direction}\nMargin: ${MARGIN_PER_TRADE}U\nLeverage: ${LEVERAGE}x\nTP/SL: 3% / 1%\ninstId: ${sym.swap}\norderId: ${resp.id}`);
    setTimeout(() => { globalOpenBets = Math.max(0, globalOpenBets - 1); }, 4 * 60 * 60 * 1000);
  } catch (e) {
    console.error('evaluateForTimeframe error', e && e.message ? e.message : e);
  }
}

async function processSymbol(sym) {
  try {
    const [c4h, c15] = await Promise.all([fetchOKXCandles(sym.base, '4H', 80), fetchOKXCandles(sym.base, '15m', 80)]);
    if (!c4h || !c15) return;
    const sorted4h = normalizeCandles(c4h);
    const sorted15 = normalizeCandles(c15);
    const ts15 = sorted15[sorted15.length - 1][0];
    if (state[sym.base].last15CloseTs === ts15) return;
    state[sym.base].last15CloseTs = ts15;
    await evaluateForTimeframe(sym, sorted4h, sorted15);
  } catch (e) {
    console.error('processSymbol error', sym.base, e && e.message ? e.message : e);
  }
}

/* ---------- Runner ---------- */
let running = false;
async function runLoop() {
  if (running) return;
  running = true;
  try {
    for (const s of SYMBOLS) {
      await processSymbol(s);
      await new Promise(r => setTimeout(r, 700));
    }
  } finally {
    running = false;
  }
}
setInterval(runLoop, CHECK_INTERVAL);
runLoop();

/* ---------- HTTP control endpoints ---------- */
app.post('/pause', (req, res) => {
  const token = req.header('x-control-token') || req.query.token;
  if (!CONTROL_TOKEN || token !== CONTROL_TOKEN) return res.status(401).json({ ok: false, msg: 'unauthorized' });
  paused = true;
  notifyTelegram('🤚 Bot 已暫停 (pause)'); 
  return res.json({ ok: true, paused });
});
app.post('/resume', (req, res) => {
  const token = req.header('x-control-token') || req.query.token;
  if (!CONTROL_TOKEN || token !== CONTROL_TOKEN) return res.status(401).json({ ok: false, msg: 'unauthorized' });
  paused = false;
  notifyTelegram('▶️ Bot 已恢復 (resume)');
  return res.json({ ok: true, paused });
});
app.get('/health', (req, res) => res.json({ ok: true, DRY_RUN, paused, now: new Date().toISOString(), globalOpenBets }));

/* ---------- Start ---------- */
app.get('/', (req, res) => res.send(`Event SNR OKX Bot running. DRY_RUN=${DRY_RUN}`));
const server = app.listen(PORT, () => {
  console.log(`Bot listening on ${PORT} — DRY_RUN=${DRY_RUN}`);
  notifyTelegram(`Bot started. DRY_RUN=${DRY_RUN}`);
});
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('unhandledRejection', r => console.error('Unhandled Rejection', r));
