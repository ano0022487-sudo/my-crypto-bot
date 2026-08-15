'use strict';
/*
  Event-contract SNR Bot — LIVE (実盤)
  - DRY_RUN is forced to false (LIVE trading).
  - Single trade amount: 2 USDT (MARGIN_PER_TRADE).
  - Only BTC and ETH supported (use EVENT_INST_BTC_USDT / EVENT_INST_ETH_USDT env).
  - Keep original structure: polling Telegram, /test-telegram, /health.
  IMPORTANT: This will place real orders when API keys and EVENT instIds are present.
*/

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// FORCE LIVE
const DRY_RUN = false;

// Telegram config
const TELEGRAM_BOT_TOKEN_RAW = (process.env.TELEGRAM_BOT_TOKEN || '');
const TELEGRAM_BOT_TOKEN = TELEGRAM_BOT_TOKEN_RAW.trim().replace(/['"]+/g, '');
const TELEGRAM_CHAT_ID_RAW = (process.env.TELEGRAM_CHAT_ID || '');
const TELEGRAM_CHAT_ID = (() => {
  const v = TELEGRAM_CHAT_ID_RAW.toString().trim();
  if (!v) return '';
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
})();

// OKX API
const API_KEY = process.env.OK_ACCESS_KEY || '';
const SECRET_KEY = process.env.OK_ACCESS_SECRET || '';
const PASSPHRASE = process.env.OKX_PASSPHRASE || '';
const BASE_URL = process.env.OKX_BASE_URL || 'https://www.okx.com';

// Strategy / risk params
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 15 * 1000);
const MARGIN_PER_TRADE = 2; // fixed 2 USDT per request (LIVE)
const EMA_PERIOD = Number(process.env.EMA_PERIOD || 20);
const BREAKOUT_BUFFER = Number(process.env.BREAKOUT_BUFFER || 0.001);
const LOOKBACK_PIVOT = Number(process.env.LOOKBACK_PIVOT || 3);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 0.01);
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 0.03);

// Only BTC and ETH (preserve your position structure)
const SYMBOLS = [
  { targetSpot: 'BTC-USDT', swapSymbol: 'BTC-USDT-SWAP', label: 'BTC', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } },
  { targetSpot: 'ETH-USDT', swapSymbol: 'ETH-USDT-SWAP', label: 'ETH', position: { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 } }
];

// read event inst ids from env
const EVENT_INST_BTC_USDT = (process.env.EVENT_INST_BTC_USDT || '').trim();
const EVENT_INST_ETH_USDT = (process.env.EVENT_INST_ETH_USDT || '').trim();
for (const s of SYMBOLS) {
  if (s.targetSpot === 'BTC-USDT') s.eventInst = EVENT_INST_BTC_USDT || null;
  if (s.targetSpot === 'ETH-USDT') s.eventInst = EVENT_INST_ETH_USDT || null;
}

/* ---------- Helpers ---------- */
function generateSignature(timestamp, method, requestPath, body = '') {
  if (!SECRET_KEY) throw new Error('API Secret 未設定');
  const message = timestamp + method.toUpperCase() + requestPath + body;
  return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
}

async function axiosWithRetry(config, retries = 3, delay = 1200) {
  for (let i = 0; i < retries; i++) {
    try { return await axios(config); }
    catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/* ---------- Telegram ---------- */
let bot = { sendMessage: async () => {}, getMe: async () => {}, getChat: async () => {} };
let telegramEnabled = false;
if (TELEGRAM_BOT_TOKEN) {
  try {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    telegramEnabled = true;
  } catch (e) {
    console.error('Telegram init failed:', e && e.message ? e.message : e);
    telegramEnabled = false;
  }
}
async function safeSendTelegram(text) {
  if (!telegramEnabled) {
    console.warn('Telegram disabled, skip notify:', text);
    return;
  }
  if (!TELEGRAM_CHAT_ID) {
    console.warn('TELEGRAM_CHAT_ID not set, skip notify:', text);
    return;
  }
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, text);
  } catch (e) {
    const body = e && e.response && (e.response.body || e.response) ? (e.response.body || e.response) : (e && e.message ? e.message : e);
    console.error('Telegram send failed:', body);
  }
}

/* ---------- Candles / indicators / S/R ---------- */
function normalizeCandles(candles) { return candles.slice().sort((a,b)=> new Date(a[0]) - new Date(b[0])); }
function closesFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[4])); }
function highsFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[2])); }
function lowsFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[3])); }

function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let emaPrev = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < values.length; i++) emaPrev = values[i] * k + emaPrev * (1 - k);
  return emaPrev;
}

function findPivots(candles, lookback = LOOKBACK_PIVOT) {
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
  clusters.sort((a,b) => (b.members[b.members.length-1].idx) - (a.members[a.members.length-1].idx));
  return clusters[0] ? clusters[0].price : null;
}

/* ---------- OKX helpers ---------- */
async function fetchOKXCandles(instId, bar, limit = 80) {
  const url = `${BASE_URL}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;
  const resp = await axiosWithRetry({ method: 'GET', url, timeout: 10000 });
  return resp && resp.data && resp.data.data ? resp.data.data : null;
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

/* ---------- Order submit & poll (EVENT) ---------- */
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

    // Live only (DRY_RUN=false)
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

    return { success: true, id: ordId || ('OKX-' + Date.now()), details: { resp: resp.data, orderInfo } };
  } catch (e) {
    return { success: false, error: e && e.response && e.response.data ? e.response.data : (e && e.message ? e.message : e) };
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
for (const s of SYMBOLS) state[s.targetSpot] = { last5Ts: null, last15Ts: null, lastBetTs: null };
let globalOpenBets = 0;

/* ---------- setLeverage (kept, may be ignored by EVENT) ---------- */
async function setLeverage(symbol) {
  try {
    const requestPath = '/api/v5/account/set-leverage';
    const timestamp = new Date().toISOString();
    const bodyData = JSON.stringify({ instId: symbol, lever: '1', mgnMode: 'cross' }); // set 1 (no leverage) for safety
    const signature = generateSignature(timestamp, 'POST', requestPath, bodyData);
    await axiosWithRetry({
      method: 'POST',
      url: `${BASE_URL}${requestPath}`,
      data: bodyData,
      headers: {
        'OK-ACCESS-KEY': API_KEY,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': PASSPHRASE,
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    // ignore
  }
}

/* ---------- openOrder / closeOrder (use eventInst pref) ---------- */
async function openOrder(item, side, reason, entryPrice) {
  try {
    const instToTrade = item.eventInst || item.swapSymbol;
    await setLeverage(instToTrade);
    const requestPath = '/api/v5/trade/order';
    const timestamp = new Date().toISOString();

    const positionValue = MARGIN_PER_TRADE;
    const sz = (positionValue / entryPrice).toFixed(6);

    const bodyData = JSON.stringify({
      instId: instToTrade,
      tdMode: 'cash',
      side: side,
      ordType: 'market',
      sz: sz > 0 ? sz.toString() : '1'
    });

    const signature = generateSignature(timestamp, 'POST', requestPath, bodyData);
    const response = await axiosWithRetry({
      method: 'POST',
      url: `${BASE_URL}${requestPath}`,
      data: bodyData,
      headers: {
        'OK-ACCESS-KEY': API_KEY,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': PASSPHRASE,
        'Content-Type': 'application/json'
      }
    });

    const resData = response.data;
    if (String(resData.code) === '0') {
      const sl = side === 'buy' ? entryPrice * (1 - STOP_LOSS_PCT) : entryPrice * (1 + STOP_LOSS_PCT);
      const tp = side === 'buy' ? entryPrice * (1 + TAKE_PROFIT_PCT) : entryPrice * (1 - TAKE_PROFIT_PCT);
      item.position = { active: true, side: side, entryPrice: entryPrice, stopLossPrice: sl, takeProfitPrice: tp };

      if (TELEGRAM_CHAT_ID) {
        await safeSendTelegram(
          `🚀 【事件合約開倉通知】\n標的：${item.targetSpot}\nINST：${instToTrade}\n方向：${side.toUpperCase()}\n原因：${reason}\n進場價：${entryPrice}\n止損價：${sl.toFixed(6)} | 止盈價：${tp.toFixed(6)}`
        );
      }
    } else {
      console.error('openOrder failed:', resData);
      await safeSendTelegram(`❌ 下單失敗：${JSON.stringify(resData)}`);
    }
  } catch (error) {
    console.error('下單失敗:', error && error.message ? error.message : error);
    await safeSendTelegram(`❌ 下單例外: ${error && error.message ? error.message : error}`);
  }
}

async function closeOrder(item, reason, currentPrice) {
  try {
    const instToTrade = item.eventInst || item.swapSymbol;
    const requestPath = '/api/v5/trade/order';
    const timestamp = new Date().toISOString();
    const closeSide = item.position.side === 'buy' ? 'sell' : 'buy';

    const bodyData = JSON.stringify({
      instId: instToTrade,
      tdMode: 'cash',
      side: closeSide,
      ordType: 'market',
      sz: '1'
    });

    const signature = generateSignature(timestamp, 'POST', requestPath, bodyData);
    await axiosWithRetry({
      method: 'POST',
      url: `${BASE_URL}${requestPath}`,
      data: bodyData,
      headers: {
        'OK-ACCESS-KEY': API_KEY,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': PASSPHRASE,
        'Content-Type': 'application/json'
      }
    });

    if (TELEGRAM_CHAT_ID) {
      await safeSendTelegram(
        `🛡 【事件合約平倉通知】\n標的：${item.targetSpot}\nINST：${instToTrade}\n方向：${item.position.side.toUpperCase()}\n原因：${reason}\n現價：${currentPrice}`
      );
    }
    item.position = { active: false, side: null, entryPrice: 0, stopLossPrice: 0, takeProfitPrice: 0 };
  } catch (error) {
    console.error('平倉失敗:', error && error.message ? error.message : error);
    await safeSendTelegram(`❌ 平倉例外: ${error && error.message ? error.message : error}`);
  }
}

/* ---------- Strategy: SNR breakout ---------- */
async function processItem(item) {
  try {
    const [res15m, res5m] = await Promise.all([
      axiosWithRetry({ method: 'GET', url: `${BASE_URL}/api/v5/market/candles?instId=${item.targetSpot}&bar=15m&limit=80` }),
      axiosWithRetry({ method: 'GET', url: `${BASE_URL}/api/v5/market/candles?instId=${item.targetSpot}&bar=5m&limit=80` })
    ]);
    const candles15m = res15m && res15m.data && res15m.data.data ? res15m.data.data : null;
    const candles5m = res5m && res5m.data && res5m.data.data ? res5m.data.data : null;
    if (!candles15m || !candles5m) return;
    if (candles15m.length < 20 || candles5m.length < 20) return;

    const sorted15 = normalizeCandles(candles15m);
    const sorted5 = normalizeCandles(candles5m);
    const latest15 = sorted15[sorted15.length - 1];
    const latest5 = sorted5[sorted5.length - 1];
    const ts15 = latest15[0], ts5 = latest5[0];
    const st = state[item.targetSpot];

    if (st.last5Ts === ts5 && st.last15Ts === ts15) return;
    st.last5Ts = ts5; st.last15Ts = ts15;

    const { pivotHighs, pivotLows } = findPivots(sorted15, LOOKBACK_PIVOT);
    const resistance = pickLevelFromPivots(pivotHighs, 0.006);
    const support = pickLevelFromPivots(pivotLows, 0.006);
    if (!resistance || !support) return;

    const closes15 = closesFrom(sorted15);
    const closes5 = closesFrom(sorted5);
    const ema15 = ema(closes15, EMA_PERIOD);
    const ema5 = ema(closes5, EMA_PERIOD);
    if (!ema15 || !ema5) return;

    const latest5Close = closes5[closes5.length - 1];
    const buffer = BREAKOUT_BUFFER;

    let direction = null;
    if (latest5Close > resistance * (1 + buffer) && latest5Close > ema15 && latest5Close > ema5) direction = 'buy';
    else if (latest5Close < support * (1 - buffer) && latest5Close < ema15 && latest5Close < ema5) direction = 'sell';
    if (!direction) return;

    const nowTs = Date.now();
    if (st.lastBetTs && (nowTs - st.lastBetTs) < 5 * 60 * 1000) return;

    if (globalOpenBets >= MAX_CONCURRENT) {
      await safeSendTelegram(`⚠️ 超過最大同時押注 (${MAX_CONCURRENT})，${item.targetSpot} 信號跳過`);
      return;
    }

    const instToTrade = item.eventInst || item.swapSymbol;
    if (!instToTrade) {
      await safeSendTelegram(`⚠️ ${item.targetSpot} 未設定可下單的 instId`);
      return;
    }

    globalOpenBets++;
    try {
      await safeSendTelegram(`⏳ 偵測到訊號: ${item.label} ${direction.toUpperCase()}，嘗試下單 inst=${instToTrade} amount=${MARGIN_PER_TRADE}U`);
      const resp = await submitEventOrderOKX({ instId: instToTrade, direction: direction === 'buy' ? 'UP' : 'DOWN', amountU: MARGIN_PER_TRADE });
      if (resp && resp.success) {
        st.lastBetTs = nowTs;
        await safeSendTelegram(`✅ 下單成功 (LIVE)\n標的: ${item.targetSpot}\nINST: ${instToTrade}\n方向: ${direction.toUpperCase()}\n金額(U): ${MARGIN_PER_TRADE}\norderId: ${resp.id || 'N/A'}`);
        let final = (resp.details && resp.details.orderInfo) ? resp.details.orderInfo : null;
        if (!final && resp.id) final = await pollOKXOrderStatus(instToTrade, resp.id, 12, 2000);
        if (final) await safeSendTelegram(`訂單狀態: ordId=${resp.id} state=${final.state} filled=${final.fillSz || final.accFillSz || 0}`);
        else await safeSendTelegram(`訂單查詢未在時限內回來: ordId=${resp.id}`);
      } else {
        await safeSendTelegram(`❌ 下單失敗 ${item.targetSpot} ${direction}\nerror: ${JSON.stringify(resp)}`);
      }
    } catch (e) {
      await safeSendTelegram(`❌ 下單發生例外 ${item.targetSpot}: ${e && e.message ? e.message : e}`);
    } finally {
      globalOpenBets = Math.max(0, globalOpenBets - 1);
    }
  } catch (err) {
    console.error(`策略運算錯誤 (${item.targetSpot}):`, err && err.message ? err.message : err);
  }
}

/* ---------- Runner ---------- */
let running = false;
async function runLoop() {
  if (running) return;
  running = true;
  try {
    for (const item of SYMBOLS) {
      await processItem(item);
      await new Promise(r => setTimeout(r, 1500));
    }
  } finally {
    running = false;
  }
}
setInterval(runLoop, CHECK_INTERVAL);
runLoop();

/* ---------- Telegram handlers ---------- */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🚀 事件合約 SNR 機器人（LIVE）已啟動！');
});

/* ---------- HTTP endpoints ---------- */
app.get('/', (req, res) => res.status(200).send('Event SNR Bot (BTC & ETH) — LIVE'));
app.get('/health', (req, res) => res.json({ ok: true, DRY_RUN, now: new Date().toISOString(), globalOpenBets }));
app.get('/test-telegram', async (req, res) => {
  if (!telegramEnabled) return res.status(400).json({ ok: false, msg: 'telegram not enabled' });
  const msg = req.query.msg || `test @ ${new Date().toISOString()}`;
  try {
    const info = await bot.getMe();
    const chat = TELEGRAM_CHAT_ID ? await bot.getChat(TELEGRAM_CHAT_ID) : null;
    let send = null;
    if (TELEGRAM_CHAT_ID) {
      try { send = await bot.sendMessage(TELEGRAM_CHAT_ID, msg); } catch (e) { send = { error: e && e.response && (e.response.body || e.response) ? (e.response.body || e.response) : e && e.message ? e.message : e }; }
    }
    return res.json({ ok: true, getMe: info, chat, send });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : e });
  }
});

/* ---------- Start server & startup checks ---------- */
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT} — LIVE mode (DRY_RUN=${DRY_RUN})`);
  if (telegramEnabled) {
    try {
      const info = await bot.getMe();
      console.log('Telegram getMe ok:', info && (info.username || info.id) ? (info.username || info.id) : info);
    } catch (e) {
      console.error('Telegram getMe failed:', e && e.response && (e.response.body || e.response) ? (e.response.body || e.response) : (e && e.message ? e.message : e));
    }
    if (TELEGRAM_CHAT_ID) {
      try {
        const chat = await bot.getChat(TELEGRAM_CHAT_ID);
        console.log('Telegram getChat ok:', { id: chat.id, type: chat.type, title: chat.title || chat.username || '' });
      } catch (e) {
        console.error('Telegram getChat failed (chat may be unreachable):', e && e.response && (e.response.body || e.response) ? (e.response.body || e.response) : (e && e.message ? e.message : e));
      }
    } else {
      console.warn('TELEGRAM_CHAT_ID not set — notifications disabled');
    }
    await safeSendTelegram(`Bot started (LIVE). Single trade amount: ${MARGIN_PER_TRADE} U`);
  } else {
    console.warn('Telegram disabled (no token). Notifications will be skipped.');
  }

  // log inst ids
  for (const s of SYMBOLS) {
    console.log(`Symbol ${s.label} (${s.targetSpot}) -> eventInst used: ${s.eventInst || s.swapSymbol}`);
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('unhandledRejection', r => console.error('Unhandled Rejection', r));
