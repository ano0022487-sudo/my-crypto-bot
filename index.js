'use strict';
/*
  Event Contract SNR Bot — OKX (BTC & ETH)
  - Timeframes: 5m & 15m (act on candle close)
  - Strategy: SNR pivot breakout + EMA20 trend filter
  - Each bet: fixed amount in USDT (MARGIN_PER_TRADE, default 2)
  - Uses OKX event instruments (instId) you provide via env
  - DRY_RUN default = false (live). Set DRY_RUN=true to force simulate.
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

// DEFAULT: live trading (set DRY_RUN=true to simulate)
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/['"]+/g, '');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_KEY = process.env.OK_ACCESS_KEY || '';
const SECRET_KEY = process.env.OK_ACCESS_SECRET || '';
const PASSPHRASE = process.env.OKX_PASSPHRASE || '';
const BASE_URL = process.env.OKX_BASE_URL || 'https://www.okx.com';

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 15 * 1000); // poll interval
const MARGIN_PER_TRADE = Number(process.env.MARGIN_PER_TRADE || 2); // default 2 U per bet
const BREAKOUT_BUFFER = Number(process.env.BREAKOUT_BUFFER || 0.001); // 0.1% buffer
const EMA_PERIOD = Number(process.env.EMA_PERIOD || 20);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || ''; // required to protect /pause /resume

// REQUIRED: event instrument instIds (strongly recommended to set these)
const BTC_5M_INST = process.env.BTC_5M_INST || '';
const BTC_15M_INST = process.env.BTC_15M_INST || '';
const ETH_5M_INST = process.env.ETH_5M_INST || '';
const ETH_15M_INST = process.env.ETH_15M_INST || '';

/* ---------- Symbols (monitor spot candles for S/R) ---------- */
const SYMBOLS = [
  { base: 'BTC-USDT', label: 'BTC', inst5: BTC_5M_INST, inst15: BTC_15M_INST },
  { base: 'ETH-USDT', label: 'ETH', inst5: ETH_5M_INST, inst15: ETH_15M_INST }
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
  const url = `${BASE_URL}/api/v5/public/instruments?instType=EVENT`;
  const resp = await axiosWithRetry({ method: 'GET', url, timeout: 12000 });
  return resp && resp.data && Array.isArray(resp.data.data) ? resp.data.data : [];
}
async function fetchTicker(instId) {
  const url = `${BASE_URL}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`;
  const resp = await axiosWithRetry({ method: 'GET', url, timeout: 8000 });
  return resp && resp.data && Array.isArray(resp.data.data) && resp.data.data[0] ? resp.data.data[0] : null;
}
async function fetchInstrumentMetadata(instId) {
  const url = `${BASE_URL}/api/v5/public/instruments?instType=EVENT&instId=${encodeURIComponent(instId)}`;
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
async function submitEventOrderOKX({ instId, direction, amountU }) {
  try {
    const ticker = await fetchTicker(instId);
    const last = ticker && (ticker.last || ticker.px) ? parseFloat(ticker.last || ticker.px) : null;
    const meta = await fetchInstrumentMetadata(instId);
    let step = null;
    if (meta) {
      step = meta.minSz || meta.minSize || meta.sizeIncrement || meta.lot || meta.tickSz || null;
      if (typeof step === 'string') step = parseFloat(step);
    }
    let szFloat = 1;
    if (last && last > 0) szFloat = amountU / last;
    if (step) szFloat = roundDownToStep(szFloat, step);
    if (!szFloat || szFloat <= 0) szFloat = 1;

    const side = direction === 'UP' ? 'buy' : 'sell';

    // simulation only when DRY_RUN is true
    if (DRY_RUN) {
      const sim = { success: true, id: 'SIM-' + Date.now(), details: { instId, side, sz: szFloat, price: last, meta } };
      await notifyTelegram(`(SIM) 下單模擬: inst=${instId} side=${side} sz=${szFloat} price=${last}`);
      return sim;
    }

    // Live: require API credentials
    if (!API_KEY || !SECRET_KEY || !PASSPHRASE) {
      return { success: false, error: 'Missing API credentials for live trading' };
    }

    const requestPath = '/api/v5/trade/order';
    const timestamp = new Date().toISOString();
    const bodyObj = { instId, tdMode: 'cash', side, ordType: 'market', sz: szFloat.toString() };
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
    const orderInfo = ordId ? await pollOKXOrderStatus(instId, ordId, 12, 2000) : null;

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
for (const s of SYMBOLS) {
  state[s.base] = { last5CloseTs: null, last15CloseTs: null, lastBet: { '5m': null, '15m': null } };
}
let paused = false;
let globalOpenBets = 0;

/* ---------- Core: evaluate and act ---------- */
async function evaluateForTimeframe(sym, timeframe, candles15, candles5) {
  try {
    if (paused) return;
    const instId = (timeframe === '5m') ? sym.inst5 : sym.inst15;
    if (!instId) {
      await notifyTelegram(`[${sym.label}] ${timeframe} - 沒有對應 event instId，請在 env 設定 ${sym.label}_${timeframe.toUpperCase()}_INST`);
      return;
    }

    // block live attempt if credentials missing
    if (!DRY_RUN && (!API_KEY || !SECRET_KEY || !PASSPHRASE)) {
      await notifyTelegram(`⚠️ 實盤模式但缺少 API credentials，已停止該次下單。`);
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

    // reserve slot
    globalOpenBets++;
    try {
      const resp = await submitEventOrderOKX(bet);
      if (resp && resp.success) {
        state[sym.base].lastBet[key] = nowTs;
        await notifyTelegram(`✅ 下單 ${DRY_RUN ? '(SIM)' : '(LIVE)'}\n標的: ${sym.label}\n時框: ${timeframe}\n方向: ${direction}\n金額(U): ${MARGIN_PER_TRADE}\ninstId: ${instId}\norderId: ${resp.id || 'N/A'}`);
        // if orderInfo already present use it, otherwise poll
        let final = (resp.details && resp.details.orderInfo) ? resp.details.orderInfo : null;
        if (!final && resp.id && !DRY_RUN) {
          final = await pollOKXOrderStatus(instId, resp.id, 12, 2000);
        }
        if (final) {
          await notifyTelegram(`訂單狀態: ordId=${resp.id} state=${final.state} filled=${final.fillSz || final.accFillSz || 0}`);
        } else {
          await notifyTelegram(`訂單查詢未在時限內回來: ordId=${resp.id}`);
        }
      } else {
        await notifyTelegram(`❌ 下單失敗 ${sym.label} ${timeframe} ${direction}\nerror: ${JSON.stringify(resp)}`);
      }
    } catch (e) {
      await notifyTelegram(`❌ 下單過程發生例外: ${e && e.message ? e.message : e}`);
    } finally {
      globalOpenBets = Math.max(0, globalOpenBets - 1);
    }

  } catch (e) {
    console.error('evaluateForTimeframe error', e && e.message ? e.message : e);
  }
}

async function processSymbol(sym) {
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
