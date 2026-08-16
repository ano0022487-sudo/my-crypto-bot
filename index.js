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
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

/* ---------- CONFIG (via env) ---------- */
const PORT = Number(process.env.PORT || 3000);
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() !== 'false'; // live trading by default
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/['"]+/g, '');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_KEY = process.env.OK_ACCESS_KEY || '';
const SECRET_KEY = process.env.OK_ACCESS_SECRET || '';
const PASSPHRASE = process.env.OKX_PASSPHRASE || '';
const BASE_URL = process.env.OKX_BASE_URL || 'https://www.okx.com';

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 15 * 1000); // poll interval
const LEVERAGE = Number(process.env.LEVERAGE || 10);
const MARGIN_PER_TRADE = Number(process.env.MARGIN_PER_TRADE || 4); // 4 U margin per trade
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 0.01); // 1% risk
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 0.03); // 3% reward (1:3 R:R)
const POS_MODE = (process.env.POS_MODE || 'net').toLowerCase(); // net or long_short
const BREAKOUT_BUFFER = Number(process.env.BREAKOUT_BUFFER || 0.001); // 0.1% buffer
const BREAKOUT_BUFFER = Number(process.env.BREAKOUT_BUFFER || 0.001); // 0.1% buffer
const EMA_PERIOD = Number(process.env.EMA_PERIOD || 20);
const VOLUME_LOOKBACK = Number(process.env.VOLUME_LOOKBACK || 20);
const MIN_VOLUME_MULTIPLIER = Number(process.env.MIN_VOLUME_MULTIPLIER || 1.2);
const ATR_PERIOD = Number(process.env.ATR_PERIOD || 14);
const MIN_ATR_PCT = Number(process.env.MIN_ATR_PCT || 0.0015); // 0.15% of price
const MAX_ATR_PCT = Number(process.env.MAX_ATR_PCT || 0.02); // 2.00% of price
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);
const POSITION_SYNC_INTERVAL = Number(process.env.POSITION_SYNC_INTERVAL || 60 * 1000);
const MAX_DAILY_LOSS_U = Number(process.env.MAX_DAILY_LOSS_U || 8);
const MAX_CONSECUTIVE_LOSSES = Number(process.env.MAX_CONSECUTIVE_LOSSES || 3);
const MAX_CONSECUTIVE_API_FAILURES = Number(process.env.MAX_CONSECUTIVE_API_FAILURES || 3);
const HEARTBEAT_TIMEOUT = Number(process.env.HEARTBEAT_TIMEOUT || 120 * 1000);
const PROTECTION_VERIFY_ATTEMPTS = Number(process.env.PROTECTION_VERIFY_ATTEMPTS || 8);
const PROTECTION_VERIFY_DELAY = Number(process.env.PROTECTION_VERIFY_DELAY || 1000);
const BOT_STATE_FILE = process.env.BOT_STATE_FILE || path.join(__dirname, 'okx-swap-bot-state.json');
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
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  bot.onText(/^\/start(?:\s|$)/, (msg) => {
    bot.sendMessage(msg.chat.id, `機器人已連線。\n模式：${DRY_RUN ? '模擬交易' : '實盤交易'}\n策略：15m + 4H、${LEVERAGE}x、每筆 ${MARGIN_PER_TRADE}U、止損 1%／止盈 3%。`)
      .catch((e) => console.error('Telegram /start reply failed:', e && e.message ? e.message : e));
  });
}
async function notifyTelegram(text) {
async function notifyTelegram(text) {
  try {
    if (!TELEGRAM_CHAT_ID) return;
    await bot.sendMessage(TELEGRAM_CHAT_ID, text);
  } catch (e) {
    console.debug('Telegram send failed:', e && e.message ? e.message : e);
  }
}

/* ---------- Helpers ---------- */
  }
}

/* ---------- Persistent audit and risk state ---------- */
function utcDay() {
  return new Date().toISOString().slice(0, 10);
}
function newBotState() {
  return {
    version: 1,
    risk: { day: utcDay(), startEquity: null, dailyRealizedPnl: 0, consecutiveLosses: 0, halted: false, processedClosures: [] },
    audit: []
  };
}
function loadBotState() {
  try {
    if (!fs.existsSync(BOT_STATE_FILE)) return newBotState();
    const parsed = JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf8'));
    return { ...newBotState(), ...parsed, risk: { ...newBotState().risk, ...(parsed.risk || {}) }, audit: Array.isArray(parsed.audit) ? parsed.audit : [] };
  } catch (error) {
    console.error('Unable to load bot state:', error && error.message ? error.message : error);
    return newBotState();
  }
}
const botState = loadBotState();
function persistBotState() {
  try {
    fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(botState, null, 2), 'utf8');
  } catch (error) {
    console.error('Unable to persist bot state:', error && error.message ? error.message : error);
  }
}
function appendAudit(event, details = {}) {
  botState.audit.push({ at: new Date().toISOString(), event, ...details });
  if (botState.audit.length > 500) botState.audit.splice(0, botState.audit.length - 500);
  persistBotState();
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
function hasTradingCredentials() {
  return Boolean(API_KEY && SECRET_KEY && PASSPHRASE);
}
async function privateGetOKX(requestPath) {
  if (!hasTradingCredentials()) throw new Error('OKX trading credentials are missing');
  const timestamp = new Date().toISOString();
  const signature = generateSignature(timestamp, 'GET', requestPath);
  const response = await axiosWithRetry({
    method: 'GET',
    url: `${BASE_URL}${requestPath}`,
    headers: {
      'OK-ACCESS-KEY': API_KEY,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': PASSPHRASE
    },
    timeout: 15000
  });
  if (!response || !response.data || String(response.data.code) !== '0') {
    throw new Error(`OKX private request failed: ${JSON.stringify(response && response.data)}`);
  }
  return Array.isArray(response.data.data) ? response.data.data : [];
}
async function privatePostOKX(requestPath, bodyObj) {
  if (!hasTradingCredentials()) throw new Error('OKX trading credentials are missing');
  const timestamp = new Date().toISOString();
  const body = JSON.stringify(bodyObj);
  const signature = generateSignature(timestamp, 'POST', requestPath, body);
  const response = await axiosWithRetry({
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
  if (!response || !response.data || String(response.data.code) !== '0') {
    throw new Error(`OKX private request failed: ${JSON.stringify(response && response.data)}`);
  }
  return Array.isArray(response.data.data) ? response.data.data : [];
}
function createClientOrderId(prefix = 'snr') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`.slice(0, 32);
}
function normalizeCandles(candles) {
  return candles.slice().sort((a, b) => new Date(a[0]) - new Date(b[0]));
}
function confirmedCandles(candles) {
  return normalizeCandles(candles).filter(c => String(c[8]) === '1');
}
function closesFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[4])); }
function highsFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[2])); }
function lowsFrom(candles) { return normalizeCandles(candles).map(c => parseFloat(c[3])); }

/* ---------- Indicators ---------- */
function ema(values, period) {
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
  if (DRY_RUN) return;
  if (!hasTradingCredentials()) throw new Error('OKX trading credentials are missing');
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
function quoteVolumeFrom(candle) {
  const quoteVolume = parseFloat(candle[7]);
  if (Number.isFinite(quoteVolume)) return quoteVolume;
  const currencyVolume = parseFloat(candle[6]);
  if (Number.isFinite(currencyVolume)) return currencyVolume;
  return parseFloat(candle[5]) || 0;
}
function atrPercent(candles, period) {
  const sorted = normalizeCandles(candles);
  if (sorted.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < sorted.length; i++) {
    const high = parseFloat(sorted[i][2]);
    const low = parseFloat(sorted[i][3]);
    const previousClose = parseFloat(sorted[i - 1][4]);
    if (![high, low, previousClose].every(Number.isFinite)) return null;
    trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  const recentRanges = trueRanges.slice(-period);
  const latestClose = parseFloat(sorted[sorted.length - 1][4]);
  if (!latestClose || recentRanges.length < period) return null;
  return recentRanges.reduce((sum, value) => sum + value, 0) / recentRanges.length / latestClose;
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

    if (DRY_RUN) {
      return { success: true, id: 'SIM-' + Date.now(), details: { instId, side, sz: szFloat, price: last, takeProfitPrice, stopLossPrice, meta } };
    }
    if (!hasTradingCredentials()) return { success: false, error: 'OKX trading credentials are missing' };

    await setLeverage(instId, posSide);
    const requestPath = '/api/v5/trade/order';
    const timestamp = new Date().toISOString();
    const timestamp = new Date().toISOString();
    const clOrdId = createClientOrderId();
    const attachAlgoClOrdId = createClientOrderId('snra');
    const bodyObj = {
      instId, tdMode: 'cross', side, ordType: 'market', sz: szFloat.toString(),
      attachAlgoOrds: [{ tpTriggerPx: takeProfitPrice.toString(), tpOrdPx: '-1', slTriggerPx: stopLossPrice.toString(), slOrdPx: '-1', tpTriggerPxType: 'last', slTriggerPxType: 'last' }]
      instId, tdMode: 'cross', side, ordType: 'market', sz: szFloat.toString(), clOrdId,
      attachAlgoOrds: [{ attachAlgoClOrdId, tpTriggerPx: takeProfitPrice.toString(), tpOrdPx: '-1', slTriggerPx: stopLossPrice.toString(), slOrdPx: '-1', tpTriggerPxType: 'last', slTriggerPxType: 'last' }]
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
    const ord = Array.isArray(resp.data.data) && resp.data.data[0] ? resp.data.data[0] : null;
    const ordId = ord ? (ord.ordId || ord.clOrdId || null) : null;
    const orderInfo = ordId ? await pollOKXOrderStatus(instId, ordId, 6, 1000) : null;
    let protection = { ok: false, error: 'OKX did not return an order ID' };
    if (ordId) {
      try {
        protection = await verifyAndAlignProtection({ instId, ordId, direction, initialOrderInfo: orderInfo });
      } catch (error) {
        protection = { ok: false, error: error && error.message ? error.message : String(error) };
      }
    }

    return { success: true, id: ordId || ('OKX-SIM-' + Date.now()), details: { resp: resp.data, orderInfo, clOrdId, attachAlgoClOrdId, protection } };

    return { success: true, id: ordId || ('OKX-SIM-' + Date.now()), details: { resp: resp.data, orderInfo } };

  } catch (e) {
    return { success: false, error: e && e.message ? e.message : e };
  }
}
async function pollOKXOrderStatus(instId, ordId, attempts = 6, delay = 1000) {
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
  return null;
}
async function getOrderInfo(instId, ordId) {
  const orders = await privateGetOKX(`/api/v5/trade/order?instId=${encodeURIComponent(instId)}&ordId=${encodeURIComponent(ordId)}`);
  return orders[0] || null;
}
function protectionPrices(direction, averagePrice) {
  return {
    takeProfitPrice: direction === 'UP' ? averagePrice * (1 + TAKE_PROFIT_PCT) : averagePrice * (1 - TAKE_PROFIT_PCT),
    stopLossPrice: direction === 'UP' ? averagePrice * (1 - STOP_LOSS_PCT) : averagePrice * (1 + STOP_LOSS_PCT)
  };
}
function priceMatches(actual, expected) {
  const actualNumber = parseFloat(actual);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expected) || expected <= 0) return false;
  return Math.abs(actualNumber - expected) / expected <= 0.0001;
}
async function amendAttachedProtection(instId, attachAlgoId, averagePrice, direction) {
  const { takeProfitPrice, stopLossPrice } = protectionPrices(direction, averagePrice);
  await privatePostOKX('/api/v5/trade/amend-algos', {
    instId,
    algoId: attachAlgoId,
    reqId: createClientOrderId('snrr'),
    newTpTriggerPx: takeProfitPrice.toString(),
    newTpOrdPx: '-1',
    newTpTriggerPxType: 'last',
    newSlTriggerPx: stopLossPrice.toString(),
    newSlOrdPx: '-1',
    newSlTriggerPxType: 'last'
  });
  return { takeProfitPrice, stopLossPrice };
}
async function verifyAndAlignProtection({ instId, ordId, direction, initialOrderInfo }) {
  if (DRY_RUN) return { ok: true, simulated: true };
  let orderInfo = initialOrderInfo;
  for (let attempt = 0; attempt < PROTECTION_VERIFY_ATTEMPTS; attempt++) {
    if (!orderInfo || attempt > 0) orderInfo = await getOrderInfo(instId, ordId);
    const averagePrice = parseFloat(orderInfo && orderInfo.avgPx);
    const attached = Array.isArray(orderInfo && orderInfo.attachAlgoOrds) ? orderInfo.attachAlgoOrds[0] : null;
    const attachedAlgoId = attached && attached.attachAlgoId;
    if (Number.isFinite(averagePrice) && averagePrice > 0 && attached && attachedAlgoId) {
      const { takeProfitPrice, stopLossPrice } = protectionPrices(direction, averagePrice);
      const alreadyAligned = priceMatches(attached.tpTriggerPx, takeProfitPrice) && priceMatches(attached.slTriggerPx, stopLossPrice);
      if (!alreadyAligned) await amendAttachedProtection(instId, attachedAlgoId, averagePrice, direction);
      return { ok: true, averagePrice, takeProfitPrice, stopLossPrice, amended: !alreadyAligned, attachAlgoId: attachedAlgoId };
    }
    await new Promise(resolve => setTimeout(resolve, PROTECTION_VERIFY_DELAY));
  }
  return { ok: false, error: 'Attached TP/SL could not be verified after fill', orderInfo };
}

/* ---------- Strategy state ---------- */
const state = {};
for (const s of SYMBOLS) state[s.base] = { last15CloseTs: null, lastBet: { '15m': null } };
let paused = false;
let globalOpenBets = 0;
const monitoredSwapIds = new Set(SYMBOLS.map(s => s.swap));
const activeTradesByInstrument = new Map();
let accountSyncReady = DRY_RUN;
let lastAccountSyncError = '';

function hasNonZeroPosition(position) {
  return Number.isFinite(Number(position.pos)) && Math.abs(Number(position.pos)) > 0;
}

async function syncTradingState(announce = false) {
  if (DRY_RUN) return true;
  try {
    const [positions, pendingOrders] = await Promise.all([
      privateGetOKX('/api/v5/account/positions?instType=SWAP'),
      privateGetOKX('/api/v5/trade/orders-pending?instType=SWAP')
    ]);

    const nextActiveTrades = new Map();
    for (const position of positions) {
      if (monitoredSwapIds.has(position.instId) && hasNonZeroPosition(position)) {
        nextActiveTrades.set(position.instId, { kind: 'position', position });
      }
    }
    for (const order of pendingOrders) {
      if (monitoredSwapIds.has(order.instId)) {
        nextActiveTrades.set(order.instId, { kind: 'pending-order', order });
      }
    }

    activeTradesByInstrument.clear();
    for (const [instId, trade] of nextActiveTrades) activeTradesByInstrument.set(instId, trade);
    globalOpenBets = activeTradesByInstrument.size;
    accountSyncReady = true;
    lastAccountSyncError = '';

    if (announce && globalOpenBets > 0) {
      await notifyTelegram(`已同步 ${globalOpenBets} 個既有持倉／未成交委託；這些標的不會再由機器人開新倉。`);
    }
    return true;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const shouldNotify = announce || accountSyncReady || message !== lastAccountSyncError;
    accountSyncReady = false;
    lastAccountSyncError = message;
    console.error('Trading state sync failed:', message);
    if (shouldNotify) await notifyTelegram(`無法同步 OKX 持倉，為避免錯單已停止開新倉：${message}`);
    return false;
  }
}

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
    const atrPct = atrPercent(candles15, ATR_PERIOD);
    if (!Number.isFinite(atrPct) || atrPct < MIN_ATR_PCT || atrPct > MAX_ATR_PCT) return;

    if (candles15.length < VOLUME_LOOKBACK + 1) return;
    const latestVolume = quoteVolumeFrom(candles15[candles15.length - 1]);
    const averageVolume = candles15
      .slice(-(VOLUME_LOOKBACK + 1), -1)
      .map(quoteVolumeFrom)
      .reduce((sum, value) => sum + value, 0) / VOLUME_LOOKBACK;
    if (!latestVolume || !averageVolume || latestVolume < averageVolume * MIN_VOLUME_MULTIPLIER) return;

    let direction = null;
    if (latest15Close > resistance * (1 + BREAKOUT_BUFFER) && latest15Close > ema4h && latest15Close > ema15) direction = 'UP';
    else if (latest15Close < support * (1 - BREAKOUT_BUFFER) && latest15Close < ema4h && latest15Close < ema15) direction = 'DOWN';
    if (!direction) return;

    const nowTs = Date.now();
    if (state[sym.base].lastBet['15m'] && nowTs - state[sym.base].lastBet['15m'] < 15 * 60 * 1000) return;
    if (!DRY_RUN && !(await syncTradingState())) return;
    if (activeTradesByInstrument.has(sym.swap)) return;
    if (globalOpenBets >= MAX_CONCURRENT) return;

    const resp = await submitSwapOrderOKX({ instId: sym.swap, direction, amountU: MARGIN_PER_TRADE });
    if (!resp || !resp.success) {
      await notifyTelegram(`Order failed ${sym.label} ${direction}\nerror: ${JSON.stringify(resp)}`);
      return;
    }

    state[sym.base].lastBet['15m'] = nowTs;
    activeTradesByInstrument.set(sym.swap, { kind: 'submitted-order', orderId: resp.id });
    globalOpenBets = activeTradesByInstrument.size;
    await notifyTelegram(`Order ${DRY_RUN ? '(SIM)' : '(LIVE)'}\nSymbol: ${sym.label}\nTimeframe: 15m + 4H\nDirection: ${direction}\nMargin: ${MARGIN_PER_TRADE}U\nLeverage: ${LEVERAGE}x\nTP/SL: 3% / 1%\ninstId: ${sym.swap}\norderId: ${resp.id}`);
    if (DRY_RUN) {
      setTimeout(() => {
        activeTradesByInstrument.delete(sym.swap);
        globalOpenBets = activeTradesByInstrument.size;
      }, 4 * 60 * 60 * 1000);
    }
  } catch (e) {
    console.error('evaluateForTimeframe error', e && e.message ? e.message : e);
  }
}

async function processSymbol(sym) {
  try {
    const [c4h, c15] = await Promise.all([fetchOKXCandles(sym.base, '4H', 80), fetchOKXCandles(sym.base, '15m', 80)]);
    if (!c4h || !c15) return;
    const sorted4h = confirmedCandles(c4h);
    const sorted15 = confirmedCandles(c15);
    const min15Candles = Math.max(EMA_PERIOD + 1, VOLUME_LOOKBACK + 1, ATR_PERIOD + 1);
    if (sorted4h.length < EMA_PERIOD + 7 || sorted15.length < EMA_PERIOD + 1) return;
    if (sorted4h.length < EMA_PERIOD + 7 || sorted15.length < min15Candles) return;
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
if (!DRY_RUN) setInterval(() => { void syncTradingState(); }, POSITION_SYNC_INTERVAL);
async function bootstrap() {
  if (!DRY_RUN) await syncTradingState(true);
  await runLoop();
}
void bootstrap();

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
