'use strict';

/*
  OKX EVENT CONTRACT SNR + ROLLING BOT
  =====================================

  IMPORTANT:
  - This file is ONLY for OKX EVENT Contracts.
  - It does NOT trade SWAP / perpetual contracts.
  - Event Contracts use isolated tdMode according to current OKX API docs.
  - Entry orders use FOK to prevent partial fills.
  - If the requested size cannot be fully filled immediately,
    the entire entry order is cancelled.
  - Exit orders use IOC because exits should prioritize getting out.
  - Partial exits are handled correctly.

  Strategy:
  - Underlying: BTC / ETH / SOL
  - Underlying timeframe: 5m + 15m
  - EMA20 / EMA50
  - RSI
  - ATR
  - Volume
  - SNR pivots
  - Model score
  - Model probability
  - Market probability
  - Minimum edge
  - Rolling position size
  - One position at a time
  - Daily loss lock
  - Consecutive loss lock
  - Early TP / SL

  LIVE_TRADING:
  false = paper
  true  = real trading
*/

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const LIVE_TRADING =
  String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';

const API_KEY = String(process.env.OK_ACCESS_KEY || '').trim();
const SECRET_KEY = String(process.env.OK_ACCESS_SECRET || '').trim();
const PASSPHRASE = String(process.env.OKX_PASSPHRASE || '').trim();

const BASE_URL = String(
  process.env.OKX_BASE_URL || 'https://openapi.okx.com'
).replace(/\/$/, '');

const TELEGRAM_BOT_TOKEN =
  String(process.env.TELEGRAM_BOT_TOKEN || '')
    .trim()
    .replace(/["']+/g, '');

const TELEGRAM_CHAT_ID =
  String(process.env.TELEGRAM_CHAT_ID || '').trim();

const CHECK_INTERVAL =
  Number(process.env.CHECK_INTERVAL || 15000);

const POSITION_CHECK_INTERVAL =
  Number(process.env.POSITION_CHECK_INTERVAL || 10000);

/* =========================================================
   RISK
========================================================= */

const START_CAPITAL =
  Number(process.env.START_CAPITAL || 20);

const RISK_PCT =
  Number(process.env.RISK_PCT || 0.10);

const MAX_STAKE_PCT =
  Number(process.env.MAX_STAKE_PCT || 0.20);

const MIN_STAKE =
  Number(process.env.MIN_STAKE || 1.0);

const MAX_OPEN_POSITIONS =
  Number(process.env.MAX_OPEN_POSITIONS || 1);

/* =========================================================
   STRATEGY
========================================================= */

const MIN_EDGE =
  Number(process.env.MIN_EDGE || 0.075);

const MIN_SCORE =
  Number(process.env.MIN_SCORE || 78);

const MAX_ENTRY_PRICE =
  Number(process.env.MAX_ENTRY_PRICE || 0.78);

const MIN_ENTRY_PRICE =
  Number(process.env.MIN_ENTRY_PRICE || 0.22);

/* =========================================================
   EXIT
========================================================= */

const EARLY_TP_PCT =
  Number(process.env.EARLY_TP_PCT || 0.30);

const EARLY_SL_PCT =
  Number(process.env.EARLY_SL_PCT || 0.25);

const MIN_MINUTES_TO_EXPIRY =
  Number(process.env.MIN_MINUTES_TO_EXPIRY || 2);

const MAX_MINUTES_TO_EXPIRY =
  Number(process.env.MAX_MINUTES_TO_EXPIRY || 180);

/* =========================================================
   RISK LOCK
========================================================= */

const DAILY_LOSS_PCT =
  Number(process.env.DAILY_LOSS_PCT || 0.20);

const MAX_CONSECUTIVE_LOSSES =
  Number(process.env.MAX_CONSECUTIVE_LOSSES || 3);

/* =========================================================
   EVENT SERIES
========================================================= */

const EVENT_SERIES =
  String(process.env.EVENT_SERIES || '').trim();

const AUTO_DISCOVER_SERIES =
  String(process.env.AUTO_DISCOVER_SERIES || 'true')
    .toLowerCase() === 'true';

/* =========================================================
   STATE
========================================================= */

const BOT_STATE_FILE =
  process.env.BOT_STATE_FILE ||
  path.join(__dirname, 'event-bot-state.json');

/* =========================================================
   UNDERLYING
========================================================= */

const UNDERLYING_MAP = {
  BTC: 'BTC-USDT-SWAP',
  ETH: 'ETH-USDT-SWAP',
  SOL: 'SOL-USDT-SWAP'
};

/* =========================================================
   TELEGRAM
========================================================= */

const bot = TELEGRAM_BOT_TOKEN
  ? new TelegramBot(
      TELEGRAM_BOT_TOKEN,
      { polling: true }
    )
  : {
      sendMessage: async () => {}
    };

async function notify(text) {
  if (!TELEGRAM_CHAT_ID) return;

  try {
    await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      text
    );
  } catch (e) {
    console.error(
      'Telegram:',
      e.message
    );
  }
}

/* =========================================================
   HTTP HELPERS
========================================================= */

function q(params) {
  return Object.entries(params)
    .filter(([, v]) =>
      v !== undefined &&
      v !== null &&
      v !== ''
    )
    .map(([k, v]) =>
      `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    )
    .join('&');
}

async function request(config, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await axios({
        timeout: 12000,
        ...config
      });
    } catch (e) {
      lastError = e;

      if (i < retries - 1) {
        await new Promise(resolve =>
          setTimeout(resolve, 500 * (i + 1))
        );
      }
    }
  }

  throw lastError;
}

/* =========================================================
   PUBLIC API
========================================================= */

async function publicGet(pathname, params = {}) {
  const pathWithQuery =
    Object.keys(params).length
      ? `${pathname}?${q(params)}`
      : pathname;

  const r = await request({
    method: 'GET',
    url: `${BASE_URL}${pathWithQuery}`
  });

  if (!r.data || String(r.data.code) !== '0') {
    throw new Error(
      `OKX public error: ${JSON.stringify(r.data)}`
    );
  }

  return r.data.data;
}

/* =========================================================
   SIGNATURE
========================================================= */

function sign(
  ts,
  method,
  requestPath,
  body
) {
  return crypto
    .createHmac(
      'sha256',
      SECRET_KEY
    )
    .update(
      ts +
      method.toUpperCase() +
      requestPath +
      body
    )
    .digest('base64');
}

/* =========================================================
   PRIVATE API
========================================================= */

async function privateRequest(
  method,
  requestPath,
  bodyObj = null
) {
  if (
    !API_KEY ||
    !SECRET_KEY ||
    !PASSPHRASE
  ) {
    throw new Error(
      'OKX API credentials are missing'
    );
  }

  const ts =
    new Date().toISOString();

  const body =
    bodyObj
      ? JSON.stringify(bodyObj)
      : '';

  const headers = {
    'OK-ACCESS-KEY': API_KEY,

    'OK-ACCESS-SIGN':
      sign(
        ts,
        method,
        requestPath,
        body
      ),

    'OK-ACCESS-TIMESTAMP':
      ts,

    'OK-ACCESS-PASSPHRASE':
      PASSPHRASE,

    'Content-Type':
      'application/json'
  };

  const r = await request({
    method,
    url: `${BASE_URL}${requestPath}`,
    data: body || undefined,
    headers
  });

  if (
    !r.data ||
    String(r.data.code) !== '0'
  ) {
    throw new Error(
      `OKX private error: ${JSON.stringify(r.data)}`
    );
  }

  return Array.isArray(r.data.data)
    ? r.data.data
    : [];
}

/* =========================================================
   STATE
========================================================= */

function freshState() {
  return {
    day:
      new Date()
        .toISOString()
        .slice(0, 10),

    startEquity:
      START_CAPITAL,

    paperEquity:
      START_CAPITAL,

    realizedPnl:
      0,

    consecutiveLosses:
      0,

    halted:
      false,

    lastTradeAt:
      0,

    trades:
      [],

    position:
      null
  };
}

function loadState() {
  try {
    if (!fs.existsSync(BOT_STATE_FILE)) {
      return freshState();
    }

    const data =
      JSON.parse(
        fs.readFileSync(
          BOT_STATE_FILE,
          'utf8'
        )
      );

    return {
      ...freshState(),
      ...data
    };

  } catch (e) {
    console.error(
      'State load:',
      e.message
    );

    return freshState();
  }
}

const state = loadState();

function saveState() {
  try {
    fs.writeFileSync(
      BOT_STATE_FILE,
      JSON.stringify(
        state,
        null,
        2
      ),
      'utf8'
    );
  } catch (e) {
    console.error(
      'State save:',
      e.message
    );
  }
}

/* =========================================================
   DAILY RESET
========================================================= */

function resetDaily() {
  const day =
    new Date()
      .toISOString()
      .slice(0, 10);

  if (state.day !== day) {

    state.day = day;

    state.startEquity = 0;

    state.realizedPnl = 0;

    state.consecutiveLosses = 0;

    state.halted = false;

    saveState();
  }
}

function riskBlocked() {
  resetDaily();

  return (
    state.halted ||
    state.consecutiveLosses >=
      MAX_CONSECUTIVE_LOSSES
  );
}

/* =========================================================
   CANDLE FUNCTIONS
========================================================= */

function closes(candles) {
  return candles
    .map(x => Number(x[4]))
    .filter(Number.isFinite);
}

function highs(candles) {
  return candles
    .map(x => Number(x[2]))
    .filter(Number.isFinite);
}

function lows(candles) {
  return candles
    .map(x => Number(x[3]))
    .filter(Number.isFinite);
}

function volumes(candles) {
  return candles
    .map(x => Number(x[5]))
    .filter(Number.isFinite);
}

/* =========================================================
   EMA
========================================================= */

function ema(
  values,
  period
) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  const k =
    2 /
    (period + 1);

  let v =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    v =
      values[i] * k +
      v * (1 - k);
  }

  return v;
}

/* =========================================================
   RSI
========================================================= */

function rsi(
  values,
  period = 14
) {
  if (
    values.length <
    period + 1
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const d =
      values[i] -
      values[i - 1];

    if (d >= 0) {
      gains += d;
    } else {
      losses -= d;
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const d =
      values[i] -
      values[i - 1];

    avgGain =
      (
        avgGain *
          (period - 1) +
        Math.max(d, 0)
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        Math.max(-d, 0)
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  return (
    100 -
    (
      100 /
      (
        1 +
        avgGain /
          avgLoss
      )
    )
  );
}

/* =========================================================
   ATR
========================================================= */

function atr(
  candles,
  period = 14
) {
  if (
    candles.length <
    period + 1
  ) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const h =
      Number(candles[i][2]);

    const l =
      Number(candles[i][3]);

    const pc =
      Number(candles[i - 1][4]);

    tr.push(
      Math.max(
        h - l,
        Math.abs(h - pc),
        Math.abs(l - pc)
      )
    );
  }

  const recent =
    tr.slice(-period);

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) /
    recent.length
  );
}

/* =========================================================
   CONFIRMED CANDLES
========================================================= */

function confirmed(candles) {
  return candles
    .slice()
    .sort(
      (a, b) =>
        Number(a[0]) -
        Number(b[0])
    )
    .filter(
      x =>
        String(x[8]) === '1'
    );
}

/* =========================================================
   PIVOTS
========================================================= */

function pivots(
  candles,
  lookback = 3
) {
  const h =
    highs(candles);

  const l =
    lows(candles);

  const resistance = [];

  const support = [];

  for (
    let i = lookback;
    i <
      candles.length -
        lookback;
    i++
  ) {

    const hi =
      Math.max(
        ...h.slice(
          i - lookback,
          i + lookback + 1
        )
      );

    const lo =
      Math.min(
        ...l.slice(
          i - lookback,
          i + lookback + 1
        )
      );

    if (h[i] === hi) {
      resistance.push(h[i]);
    }

    if (l[i] === lo) {
      support.push(l[i]);
    }
  }

  return {
    resistance:
      resistance.slice(-8),

    support:
      support.slice(-8)
  };
}

function nearestAbove(
  levels,
  price
) {
  return levels
    .filter(
      x => x > price
    )
    .sort(
      (a, b) => a - b
    )[0] || null;
}

function nearestBelow(
  levels,
  price
) {
  return levels
    .filter(
      x => x < price
    )
    .sort(
      (a, b) => b - a
    )[0] || null;
}

/* =========================================================
   MARKET DATA
========================================================= */

async function candles(
  instId,
  bar,
  limit = 100
) {
  const rows =
    await publicGet(
      '/api/v5/market/candles',
      {
        instId,
        bar,
        limit
      }
    );

  return confirmed(rows);
}

async function ticker(
  instId,
  instType = null
) {
  const rows =
    await publicGet(
      '/api/v5/market/ticker',
      {
        ...(instType
          ? { instType }
          : {}),
        instId
      }
    );

  return rows[0] || null;
}

/* =========================================================
   EVENT SERIES
========================================================= */

async function eventSeries() {

  if (EVENT_SERIES) {
    return EVENT_SERIES
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);
  }

  if (!AUTO_DISCOVER_SERIES) {
    return [];
  }

  try {

    const rows =
      await publicGet(
        '/api/v5/public/series',
        {
          instType:
            'EVENTS'
        }
      );

    return rows
      .map(
        x =>
          x.seriesId ||
          x.id
      )
      .filter(Boolean);

  } catch (e) {

    console.error(
      'Series discovery failed:',
      e.message
    );

    return [];
  }
}

/* =========================================================
   EVENT INSTRUMENTS
========================================================= */

async function eventInstruments(
  seriesId
) {
  return publicGet(
    '/api/v5/public/instruments',
    {
      instType:
        'EVENTS',

      seriesId
    }
  );
}

/* =========================================================
   BASE ASSET
========================================================= */

function baseAsset(inst) {

  const s =
    `${inst.baseCcy || ''} ` +
    `${inst.instId || ''} ` +
    `${inst.seriesId || ''}`
      .toUpperCase();

  for (
    const coin of
      Object.keys(
        UNDERLYING_MAP
      )
  ) {

    if (
      s.includes(coin)
    ) {
      return coin;
    }
  }

  return null;
}

/* =========================================================
   STRIKE
========================================================= */

function strike(inst) {

  for (
    const key of [
      'stk',
      'strike',
      'strikePx',
      'targetPx',
      'triggerPx'
    ]
  ) {

    const n =
      Number(inst[key]);

    if (
      Number.isFinite(n) &&
      n > 0
    ) {
      return n;
    }
  }

  const text =
    `${inst.instId || ''} ` +
    `${inst.seriesId || ''}`;

  const m =
    text.match(
      /(?:^|[-_])(\d+(?:\.\d+)?)(?:[-_]|$)/
    );

  return m
    ? Number(m[1])
    : null;
}

/* =========================================================
   EVENT TYPE
========================================================= */

function eventType(inst) {

  const s =
    `${inst.seriesId || ''} ` +
    `${inst.instId || ''} ` +
    `${inst.ruleType || ''}`
      .toUpperCase();

  if (
    s.includes('ABOVE') ||
    s.includes('UP')
  ) {
    return 'ABOVE';
  }

  if (
    s.includes('BELOW') ||
    s.includes('DOWN')
  ) {
    return 'BELOW';
  }

  return 'UNKNOWN';
}

/* =========================================================
   EXPIRY
========================================================= */

function expiry(inst) {

  const candidates = [
    Number(inst.expTime),
    Number(inst.expiryTime),
    Number(inst.endTime)
  ]
    .filter(Number.isFinite);

  return candidates.length
    ? Math.max(...candidates)
    : null;
}

/* =========================================================
   NUMBER HELPERS
========================================================= */

function decimalsForStep(step) {

  const s =
    String(step);

  if (
    !s.includes('.')
  ) {
    return 0;
  }

  return s.split('.')[1]
    .replace(/0+$/, '')
    .length;
}

function roundDown(
  value,
  step
) {

  if (!(step > 0)) {
    return value;
  }

  const decimals =
    decimalsForStep(step);

  const n =
    Math.floor(
      (
        value + 1e-12
      ) / step
    ) * step;

  return Number(
    n.toFixed(decimals)
  );
}

function roundToStep(
  value,
  step
) {

  if (!(step > 0)) {
    return value;
  }

  const decimals =
    decimalsForStep(step);

  const n =
    Math.round(
      value / step
    ) * step;

  return Number(
    n.toFixed(decimals)
  );
}

/* =========================================================
   MARKET PROBABILITY
========================================================= */

function marketProbability(
  price,
  outcome
) {

  if (
    !(price > 0 && price < 1)
  ) {
    return null;
  }

  return outcome === 'yes'
    ? price
    : 1 - price;
}

/* =========================================================
   MODEL
========================================================= */

function modelProbability(
  direction,
  price,
  strikePx,
  c5,
  c15
) {

  const p5 =
    pivots(c5);

  const p15 =
    pivots(c15);

  const cl5 =
    closes(c5);

  const cl15 =
    closes(c15);

  const vol5 =
    volumes(c5);

  const ema20_5 =
    ema(cl5, 20);

  const ema50_5 =
    ema(cl5, 50);

  const ema20_15 =
    ema(cl15, 20);

  const ema50_15 =
    ema(cl15, 50);

  const rsi5 =
    rsi(cl5, 14);

  const atr5 =
    atr(c5, 14);

  const avgVol =
    vol5
      .slice(-20)
      .reduce(
        (a, b) => a + b,
        0
      ) /
    Math.max(
      1,
      Math.min(
        20,
        vol5.length
      )
    );

  const volRatio =
    avgVol > 0
      ? vol5[
          vol5.length - 1
        ] / avgVol
      : 1;

  let score = 50;

  const reasons = [];

  const bullish =
    direction === 'ABOVE';

  const trend5 =
    bullish
      ? ema20_5 > ema50_5
      : ema20_5 < ema50_5;

  const trend15 =
    bullish
      ? ema20_15 > ema50_15
      : ema20_15 < ema50_15;

  if (trend5) {
    score += 10;
    reasons.push(
      '5m trend'
    );
  }

  if (trend15) {
    score += 15;
    reasons.push(
      '15m trend'
    );
  }

  const momentum =
    bullish
      ? rsi5 >= 55 &&
        rsi5 <= 72
      : rsi5 <= 45 &&
        rsi5 >= 28;

  if (momentum) {
    score += 10;
    reasons.push('RSI');
  }

  if (volRatio >= 1.15) {
    score += 8;
    reasons.push('volume');
  }

  const resistance =
    nearestAbove(
      [
        ...p5.resistance,
        ...p15.resistance
      ],
      price
    );

  const support =
    nearestBelow(
      [
        ...p5.support,
        ...p15.support
      ],
      price
    );

  if (
    bullish &&
    resistance &&
    price >=
      resistance * 0.999
  ) {

    score += 8;

    reasons.push(
      'SNR resistance test'
    );
  }

  if (
    !bullish &&
    support &&
    price <=
      support * 1.001
  ) {

    score += 8;

    reasons.push(
      'SNR support test'
    );
  }

  const strikeDistance =
    strikePx > 0
      ? Math.abs(
          price - strikePx
        ) / price
      : 1;

  if (
    bullish &&
    price > strikePx
  ) {

    score += 8;

    reasons.push(
      'above strike'
    );
  }

  if (
    !bullish &&
    price < strikePx
  ) {

    score += 8;

    reasons.push(
      'below strike'
    );
  }

  if (
    strikeDistance <
    0.0025
  ) {

    score -= 10;

    reasons.push(
      'strike too close'
    );
  }

  if (
    atr5 &&
    price > 0
  ) {

    const atrPct =
      atr5 / price;

    if (
      atrPct < 0.001
    ) {
      score -= 5;
    }

    if (
      atrPct > 0.03
    ) {
      score -= 8;
    }
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  /*
    This is still a MODEL estimate.
    It is NOT a backtested win rate.
  */

  const probability =
    Math.max(
      0.50,
      Math.min(
        0.90,
        0.50 +
          (score - 50) *
            0.006
      )
    );

  return {
    score,
    probability,
    reasons
  };
}

/* =========================================================
   EQUITY
========================================================= */

async function getEquity() {

  if (!LIVE_TRADING) {

    return Math.max(
      START_CAPITAL,
      Number(
        state.paperEquity ||
        START_CAPITAL
      )
    );
  }

  const rows =
    await privateRequest(
      'GET',
      '/api/v5/account/balance?ccy=USDT'
    );

  const detail =
    rows[0]?.details?.find(
      x =>
        x.ccy === 'USDT'
    );

  const available =
    Number(
      detail?.availBal
    );

  const equity =
    Number(
      detail?.eq
    );

  if (
    Number.isFinite(equity) &&
    equity > 0
  ) {
    return equity;
  }

  if (
    Number.isFinite(available) &&
    available > 0
  ) {
    return available;
  }

  throw new Error(
    'Unable to read USDT equity'
  );
}

/* =========================================================
   STAKE
========================================================= */

function stakeForEquity(
  equity
) {

  const calculated =
    equity * RISK_PCT;

  return Math.max(
    MIN_STAKE,
    Math.min(
      equity *
        MAX_STAKE_PCT,
      calculated
    )
  );
}

/* =========================================================
   EXPIRY FILTER
========================================================= */

function allowedExpiry(inst) {

  const exp =
    expiry(inst);

  if (!exp) {
    return false;
  }

  const mins =
    (
      exp -
      Date.now()
    ) / 60000;

  return (
    mins >=
      MIN_MINUTES_TO_EXPIRY &&
    mins <=
      MAX_MINUTES_TO_EXPIRY
  );
}

/* =========================================================
   PRICE VALIDATION
========================================================= */

function validPrice(p) {

  return (
    Number.isFinite(p) &&
    p >
      MIN_ENTRY_PRICE &&
    p <
      MAX_ENTRY_PRICE
  );
}

/* =========================================================
   EVENT CANDIDATE SCAN
========================================================= */

async function scanCandidates() {

  const series =
    await eventSeries();

  const candidates = [];

  for (
    const seriesId of series
  ) {

    let instruments;

    try {

      instruments =
        await eventInstruments(
          seriesId
        );

    } catch (e) {

      console.error(
        `Series ${seriesId}:`,
        e.message
      );

      continue;
    }

    for (
      const inst of instruments
    ) {

      if (
        inst.state &&
        ![
          'live'
        ].includes(
          inst.state
        )
      ) {
        continue;
      }

      if (
        !allowedExpiry(inst)
      ) {
        continue;
      }

      const coin =
        baseAsset(inst);

      const strikePx =
        strike(inst);

      const type =
        eventType(inst);

      if (
        !coin ||
        !strikePx ||
        type === 'UNKNOWN'
      ) {
        continue;
      }

      const underlying =
        UNDERLYING_MAP[coin];

      try {

        const [
          eventTicker,
          c5,
          c15
        ] =
          await Promise.all([
            ticker(
              inst.instId,
              'EVENTS'
            ),

            candles(
              underlying,
              '5m',
              100
            ),

            candles(
              underlying,
              '15m',
              100
            )
          ]);

        /*
          OKX EVENTS market data returns YES.
          NO is derived as 1 - YES.
        */

        const yesAsk =
          Number(
            eventTicker?.askPx ||
            eventTicker?.last
          );

        const yesBid =
          Number(
            eventTicker?.bidPx ||
            eventTicker?.last
          );

        if (
          !(
            yesAsk > 0 &&
            yesBid > 0
          )
        ) {
          continue;
        }

        const side =
          type === 'ABOVE'
            ? 'yes'
            : 'no';

        const entryPx =
          side === 'yes'
            ? yesAsk
            : 1 - yesBid;

        if (
          !validPrice(entryPx)
        ) {
          continue;
        }

        const underlyingPrice =
          Number(
            c5[
              c5.length - 1
            ][4]
          );

        const model =
          modelProbability(
            type,
            underlyingPrice,
            strikePx,
            c5,
            c15
          );

        const mktProb =
          marketProbability(
            entryPx,
            side
          );

        if (
          mktProb === null
        ) {
          continue;
        }

        const edge =
          model.probability -
          mktProb;

        if (
          model.score <
            MIN_SCORE ||
          edge <
            MIN_EDGE
        ) {
          continue;
        }

        candidates.push({
          inst,
          coin,
          underlying,
          strikePx,
          type,
          side,
          entryPx,
          modelProb:
            model.probability,
          marketProb:
            mktProb,
          edge,
          score:
            model.score,
          reasons:
            model.reasons,
          underlyingPrice,

          /*
            Store current YES prices
            for diagnostics.
          */

          yesAsk,
          yesBid
        });

      } catch (e) {

        console.error(
          `Candidate scan ${inst.instId}:`,
          e.message
        );
      }
    }
  }

  return candidates.sort(
    (a, b) =>
      b.edge - a.edge ||
      b.score - a.score
  );
}

/* =========================================================
   GET EVENT INSTRUMENT RULES
========================================================= */

function getEventRules(
  inst
) {

  const lotSz =
    Number(
      inst.lotSz
    );

  const minSz =
    Number(
      inst.minSz
    );

  const tickSz =
    Number(
      inst.tickSz ||
      0.01
    );

  if (
    !(lotSz > 0)
  ) {
    throw new Error(
      `Invalid EVENTS lotSz: ${JSON.stringify(inst)}`
    );
  }

  if (
    !(minSz > 0)
  ) {
    throw new Error(
      `Invalid EVENTS minSz: ${JSON.stringify(inst)}`
    );
  }

  return {
    lotSz,
    minSz,
    tickSz
  };
}

/* =========================================================
   CALCULATE EVENT CONTRACT SIZE
========================================================= */

function calculateEventSize(
  stake,
  price,
  inst
) {

  const {
    lotSz,
    minSz
  } =
    getEventRules(inst);

  /*
    Event Contract:
    margin / cost ≈ price × number of shares

    Example:
    5.05 / 0.51
    = 9.9019 shares

    Then round DOWN to OKX lotSz.
  */

  const rawSz =
    stake / price;

  const sz =
    roundDown(
      rawSz,
      lotSz
    );

  if (
    !(sz > 0)
  ) {
    throw new Error(
      `Calculated EVENTS size is zero. ` +
      `stake=${stake}, price=${price}, ` +
      `lotSz=${lotSz}, minSz=${minSz}`
    );
  }

  if (
    sz < minSz
  ) {
    throw new Error(
      `EVENTS size below minimum. ` +
      `sz=${sz}, minSz=${minSz}`
    );
  }

  return {
    rawSz,
    sz,
    lotSz,
    minSz,

    estimatedCost:
      sz * price
  };
}

/* =========================================================
   PLACE EVENT ENTRY
========================================================= */

async function placeEventOrder(
  candidate,
  stake
) {

  const inst =
    candidate.inst;

  const sizeInfo =
    calculateEventSize(
      stake,
      candidate.entryPx,
      inst
    );

  const {
    sz,
    estimatedCost,
    lotSz,
    minSz
  } =
    sizeInfo;

  /*
    IMPORTANT:
    Use FOK instead of IOC.

    IOC can partially fill.
    FOK must fully fill or cancel.

    This prevents:
      planned 5.05U
      actual 0.05U
    caused by thin liquidity.
  */

  const body = {
    instId:
      inst.instId,

    /*
      Current OKX EVENTS documentation:
      Event Contracts support isolated.
    */
    tdMode:
      'isolated',

    side:
      'buy',

    /*
      FOK = full fill or cancel.
    */
    ordType:
      'fok',

    px:
      Number(
        candidate.entryPx
      ).toFixed(2),

    sz:
      String(sz),

    /*
      Required for EVENTS.
    */
    outcome:
      candidate.side,

    clOrdId:
      `snr${Date.now().toString(36)}`
        .slice(0, 32)
  };

  console.log(
    '[EVENT ORDER]',
    JSON.stringify({
      instId:
        inst.instId,

      side:
        candidate.side,

      price:
        candidate.entryPx,

      stake,

      rawSz:
        sizeInfo.rawSz,

      sz,

      lotSz,

      minSz,

      estimatedCost,

      ordType:
        'fok',

      live:
        LIVE_TRADING
    })
  );

  if (!LIVE_TRADING) {

    return {
      ordId:
        `SIM-${Date.now()}`,

      state:
        'filled',

      avgPx:
        candidate.entryPx,

      accFillSz:
        sz,

      simulated:
        true,

      body
    };
  }

  const rows =
    await privateRequest(
      'POST',
      '/api/v5/trade/order',
      body
    );

  const result =
    rows[0];

  if (
    !result ||
    String(
      result.sCode
    ) !== '0'
  ) {

    throw new Error(
      `Order rejected: ${JSON.stringify(result)}`
    );
  }

  return {
    ...result,

    requestedSz:
      sz,

    requestedStake:
      stake,

    estimatedCost
  };
}

/* =========================================================
   GET ORDER
========================================================= */

async function getOrder(
  instId,
  ordId
) {

  const rows =
    await privateRequest(
      'GET',
      `/api/v5/trade/order?${q({
        instId,
        ordId
      })}`
    );

  return rows[0] || null;
}

/* =========================================================
   CLOSE POSITION
========================================================= */

async function closePosition(
  position,
  currentPx
) {

  const body = {
    instId:
      position.inst.instId,

    tdMode:
      'isolated',

    side:
      'sell',

    /*
      IOC is intentional on exits.
      We prefer exiting immediately.
    */
    ordType:
      'ioc',

    px:
      Number(
        currentPx
      ).toFixed(2),

    sz:
      String(
        position.sz
      ),

    outcome:
      position.side,

    clOrdId:
      `exit${Date.now().toString(36)}`
        .slice(0, 32)
  };

  console.log(
    '[EVENT EXIT ORDER]',
    JSON.stringify(body)
  );

  if (!LIVE_TRADING) {

    const pnl =
      (
        Number(currentPx) -
        position.entryPx
      ) *
      position.sz;

    return {
      state:
        'filled',

      avgPx:
        currentPx,

      accFillSz:
        position.sz,

      pnl,

      simulated:
        true
    };
  }

  const rows =
    await privateRequest(
      'POST',
      '/api/v5/trade/order',
      body
    );

  const result =
    rows[0];

  if (
    !result ||
    String(
      result.sCode
    ) !== '0'
  ) {

    throw new Error(
      `Exit rejected: ${JSON.stringify(result)}`
    );
  }

  return result;
}

/* =========================================================
   POSITION MANAGER
========================================================= */

async function managePosition() {

  if (
    !state.position
  ) {
    return;
  }

  const p =
    state.position;

  try {

    const t =
      await ticker(
        p.inst.instId,
        'EVENTS'
      );

    const yesBid =
      Number(
        t?.bidPx ||
        t?.last
      );

    if (
      !(yesBid > 0)
    ) {
      return;
    }

    /*
      Current YES market price.
      NO price = 1 - YES.
    */

    const currentBid =
      p.side === 'yes'
        ? yesBid
        : 1 - yesBid;

    const change =
      (
        currentBid -
        p.entryPx
      ) /
      p.entryPx;

    /*
      Early TP / SL
    */

    if (
      change >=
        EARLY_TP_PCT ||
      change <=
        -EARLY_SL_PCT
    ) {

      const result =
        await closePosition(
          p,
          currentBid
        );

      /*
        In LIVE mode:
        accFillSz is the cumulative
        filled exit quantity.
      */

      let exitSz =
        Number(
          result?.accFillSz ||
          result?.fillSz ||
          0
        );

      let exitPx =
        Number(
          result?.avgPx ||
          result?.fillPx ||
          currentBid
        );

      /*
        Paper mode always exits all.
      */

      if (
        !LIVE_TRADING
      ) {
        exitSz =
          p.sz;
      }

      if (
        !(exitSz > 0)
      ) {

        console.log(
          'Exit had no fill:',
          JSON.stringify(result)
        );

        return;
      }

      /*
        Never close more than current position.
      */

      exitSz =
        Math.min(
          exitSz,
          p.sz
        );

      const pnl =
        (
          exitPx -
          p.entryPx
        ) *
        exitSz;

      const remainingSz =
        Math.max(
          0,
          p.sz -
            exitSz
        );

      state.realizedPnl +=
        pnl;

      state.paperEquity =
        Math.max(
          0,
          Number(
            state.paperEquity ||
            START_CAPITAL
          ) + pnl
        );

      /*
        If fully closed:
      */

      if (
        remainingSz <= 1e-12
      ) {

        state.consecutiveLosses =
          pnl < 0
            ? state.consecutiveLosses + 1
            : 0;

        state.trades.push({
          at:
            new Date().toISOString(),

          instId:
            p.inst.instId,

          side:
            p.side,

          entryPx:
            p.entryPx,

          exitPx,

          sz:
            exitSz,

          pnl
        });

        if (
          state.trades.length >
          200
        ) {
          state.trades.shift();
        }

        state.position =
          null;

        if (
          state.consecutiveLosses >=
          MAX_CONSECUTIVE_LOSSES
        ) {
          state.halted =
            true;
        }

      } else {

        /*
          Partial exit:
          Keep the remaining position.
        */

        state.position = {
          ...p,
          sz:
            remainingSz
        };
      }

      saveState();

      await notify(
        `${pnl >= 0 ? '🟢' : '🔴'} EVENT EXIT\n` +
        `${p.inst.instId}\n` +
        `${p.side.toUpperCase()}\n` +
        `Exit ${exitPx.toFixed(4)}\n` +
        `Closed ${exitSz}\n` +
        `Remaining ${remainingSz}\n` +
        `PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}U\n` +
        `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
      );
    }

  } catch (e) {

    console.error(
      'Position manager:',
      e.message
    );
  }
}

/* =========================================================
   MAYBE TRADE
========================================================= */

async function maybeTrade() {

  if (
    riskBlocked() ||
    state.position
  ) {
    return;
  }

  let equity;

  try {

    equity =
      await getEquity();

  } catch (e) {

    console.error(
      'Equity:',
      e.message
    );

    return;
  }

  if (
    !state.startEquity
  ) {

    state.startEquity =
      equity;

    saveState();
  }

  /*
    Daily loss lock.
  */

  if (
    state.realizedPnl <=
    -(
      equity *
      DAILY_LOSS_PCT
    )
  ) {

    state.halted =
      true;

    saveState();

    await notify(
      `⛔ EVENT BOT DAILY LOSS LOCK\n` +
      `PnL ${state.realizedPnl.toFixed(4)}U`
    );

    return;
  }

  const candidates =
    await scanCandidates();

  if (
    !candidates.length
  ) {
    return;
  }

  const c =
    candidates[0];

  /*
    Position budget.
  */

  const stake =
    Math.min(
      stakeForEquity(
        equity
      ),
      equity
    );

  /*
    Calculate expected size BEFORE order.
  */

  let sizeInfo;

  try {

    sizeInfo =
      calculateEventSize(
        stake,
        c.entryPx,
        c.inst
      );

  } catch (e) {

    console.error(
      'Size calculation:',
      e.message
    );

    await notify(
      `⚠️ EVENT SIZE ERROR\n` +
      `${c.inst.instId}\n` +
      `${e.message}`
    );

    return;
  }

  /*
    Safety:
    if estimated cost is materially below
    requested stake because of lot-size rounding,
    do not falsely report stake as actual.
  */

  const estimatedCost =
    sizeInfo.estimatedCost;

  try {

    const order =
      await placeEventOrder(
        c,
        stake
      );

    let filled =
      order;

    /*
      FOK should be either fully filled
      or cancelled.

      Still query the order to get
      the actual fill.
    */

    if (
      LIVE_TRADING &&
      order.ordId
    ) {

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            500
          )
      );

      filled =
        await getOrder(
          c.inst.instId,
          order.ordId
        );
    }

    const fillSz =
      Number(
        filled?.accFillSz ||
        filled?.fillSz ||
        0
      );

    const avgPx =
      Number(
        filled?.avgPx ||
        filled?.fillPx ||
        c.entryPx
      );

    /*
      No fill:
      FOK cancelled.
    */

    if (
      !(fillSz > 0)
    ) {

      console.log(
        '[EVENT FOK NOT FILLED]',
        JSON.stringify(
          filled
        )
      );

      await notify(
        `⚪ EVENT NOT FILLED\n` +
        `${c.inst.instId}\n` +
        `${c.side.toUpperCase()}\n` +
        `Wanted ${sizeInfo.sz} shares\n` +
        `Budget ${stake.toFixed(2)}U\n` +
        `FOK cancelled`
      );

      return;
    }

    /*
      Actual cost.
    */

    const actualCost =
      fillSz *
      avgPx;

    /*
      Safety check.
      If actual fill is significantly below
      planned size, do not silently accept it.
      With FOK this should not happen.
    */

    const sizeRatio =
      fillSz /
      sizeInfo.sz;

    if (
      sizeRatio <
      0.999
    ) {

      console.error(
        '[EVENT PARTIAL FILL DETECTED]',
        {
          requested:
            sizeInfo.sz,

          filled:
            fillSz,

          ratio:
            sizeRatio,

          order:
            filled
        }
      );

      /*
        We do NOT automatically create a
        position from an unexpected partial fill.
        However, the exchange may already have
        filled it. Therefore record it and manage it
        safely rather than placing another order.
      */
    }

    /*
      REAL position uses ACTUAL fill size.
    */

    state.position = {

      inst:
        c.inst,

      side:
        c.side,

      sz:
        fillSz,

      entryPx:
        avgPx,

      /*
        Budget originally requested.
      */

      stake,

      /*
        Actual capital used.
      */

      actualCost,

      requestedSz:
        sizeInfo.sz,

      score:
        c.score,

      edge:
        c.edge,

      modelProb:
        c.modelProb,

      marketProb:
        c.marketProb,

      openedAt:
        Date.now()
    };

    state.lastTradeAt =
      Date.now();

    saveState();

    await notify(
      `🟡 EVENT ENTRY\n` +
      `${c.inst.instId}\n` +
      `${c.side.toUpperCase()}\n` +
      `Entry ${avgPx.toFixed(4)}\n` +
      `Score ${c.score}\n` +
      `Model ${(c.modelProb * 100).toFixed(1)}%\n` +
      `Market ${(c.marketProb * 100).toFixed(1)}%\n` +
      `Edge ${(c.edge * 100).toFixed(1)}%\n` +
      `Budget ${stake.toFixed(2)}U\n` +
      `Requested ${sizeInfo.sz} shares\n` +
      `Actual ${fillSz} shares\n` +
      `Actual Cost ${actualCost.toFixed(4)}U\n` +
      `Reason ${c.reasons.join(', ')}\n` +
      `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
    );

  } catch (e) {

    console.error(
      'Trade:',
      e.message
    );

    await notify(
      `⚠️ EVENT ORDER ERROR\n` +
      `${c.inst.instId}\n` +
      `${e.message}`
    );
  }
}

/* =========================================================
   WEB
========================================================= */

app.get(
  '/',
  (req, res) =>
    res.json({
      ok: true,

      bot:
        'OKX Event Contract SNR Rolling Bot',

      type:
        'EVENTS',

      live:
        LIVE_TRADING,

      position:
        state.position
          ? {
              instId:
                state.position
                  .inst
                  .instId,

              side:
                state.position
                  .side,

              entryPx:
                state.position
                  .entryPx,

              sz:
                state.position
                  .sz,

              actualCost:
                state.position
                  .actualCost
            }
          : null,

      halted:
        state.halted,

      consecutiveLosses:
        state.consecutiveLosses,

      realizedPnl:
        state.realizedPnl
    })
);

app.get(
  '/health',
  (req, res) =>
    res.json({
      ok: true,

      type:
        'EVENTS',

      live:
        LIVE_TRADING,

      time:
        new Date()
          .toISOString()
    })
);

app.get(
  '/status',
  (req, res) =>
    res.json({

      live:
        LIVE_TRADING,

      riskPct:
        RISK_PCT,

      minEdge:
        MIN_EDGE,

      minScore:
        MIN_SCORE,

      position:
        state.position,

      risk: {
        halted:
          state.halted,

        consecutiveLosses:
          state.consecutiveLosses,

        realizedPnl:
          state.realizedPnl
      }
    })
);

/* =========================================================
   MAIN LOOP
========================================================= */

async function mainLoop() {

  resetDaily();

  try {

    await managePosition();

    if (
      !state.position
    ) {
      await maybeTrade();
    }

  } catch (e) {

    console.error(
      'MAIN LOOP:',
      e.message || e
    );
  }
}

/* =========================================================
   SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Event bot listening on ${PORT}`
    );

    console.log(
      `LIVE_TRADING=${LIVE_TRADING}`
    );

    console.log(
      `BASE_URL=${BASE_URL}`
    );

    console.log(
      `EVENT_SERIES=${EVENT_SERIES || 'AUTO'}`
    );

    console.log(
      `RISK_PCT=${RISK_PCT}`
    );

    console.log(
      `MIN_EDGE=${MIN_EDGE}`
    );

    console.log(
      `MIN_SCORE=${MIN_SCORE}`
    );

    console.log(
      `ENTRY_ORDER=FOK`
    );

    console.log(
      `EVENT_TD_MODE=isolated`
    );
  }
);

/* =========================================================
   TIMERS
========================================================= */

setInterval(
  mainLoop,
  CHECK_INTERVAL
);

setInterval(
  managePosition,
  POSITION_CHECK_INTERVAL
);

mainLoop()
  .catch(
    e =>
      console.error(
        e
      )
  );
