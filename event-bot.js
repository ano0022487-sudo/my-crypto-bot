'use strict';

/*
  OKX Event Contract SNR + Rolling Bot
  2026 API version

  IMPORTANT:
  - LIVE_TRADING defaults to false.
  - Event Contract public discovery uses:
      /api/v5/public/event-contract/series
      /api/v5/public/event-contract/events
      /api/v5/public/event-contract/markets
  - Event instruments use:
      /api/v5/public/instruments?instType=EVENTS&seriesId=...
  - EVENTS market data returns YES-side data.
  - NO price is derived from YES price.
  - Event orders use tdMode=isolated.
  - Non-post-only EVENTS orders require speedBump=1.
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

const TELEGRAM_BOT_TOKEN = String(
  process.env.TELEGRAM_BOT_TOKEN || ''
).trim().replace(/["']+/g, '');

const TELEGRAM_CHAT_ID = String(
  process.env.TELEGRAM_CHAT_ID || ''
).trim();

const CHECK_INTERVAL =
  Number(process.env.CHECK_INTERVAL || 30000);

const POSITION_CHECK_INTERVAL =
  Number(process.env.POSITION_CHECK_INTERVAL || 10000);

const START_CAPITAL =
  Number(process.env.START_CAPITAL || 20);

const RISK_PCT =
  Number(process.env.RISK_PCT || 0.10);

const MAX_STAKE_PCT =
  Number(process.env.MAX_STAKE_PCT || 0.20);

const MIN_STAKE =
  Number(process.env.MIN_STAKE || 1);

const MIN_EDGE =
  Number(process.env.MIN_EDGE || 0.075);

const MIN_SCORE =
  Number(process.env.MIN_SCORE || 78);

const MAX_ENTRY_PRICE =
  Number(process.env.MAX_ENTRY_PRICE || 0.78);

const MIN_ENTRY_PRICE =
  Number(process.env.MIN_ENTRY_PRICE || 0.22);

const EARLY_TP_PCT =
  Number(process.env.EARLY_TP_PCT || 0.30);

const EARLY_SL_PCT =
  Number(process.env.EARLY_SL_PCT || 0.25);

const MIN_MINUTES_TO_EXPIRY =
  Number(process.env.MIN_MINUTES_TO_EXPIRY || 2);

const MAX_MINUTES_TO_EXPIRY =
  Number(process.env.MAX_MINUTES_TO_EXPIRY || 180);

const DAILY_LOSS_PCT =
  Number(process.env.DAILY_LOSS_PCT || 0.20);

const MAX_CONSECUTIVE_LOSSES =
  Number(process.env.MAX_CONSECUTIVE_LOSSES || 3);

const EVENT_SERIES =
  String(process.env.EVENT_SERIES || '').trim();

const AUTO_DISCOVER_SERIES =
  String(process.env.AUTO_DISCOVER_SERIES || 'true')
    .toLowerCase() === 'true';

const EVENT_COINS =
  String(process.env.EVENT_COINS || 'BTC,ETH,SOL')
    .split(',')
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);

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
  ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true })
  : {
      sendMessage: async () => {}
    };

async function notify(text) {
  if (!TELEGRAM_CHAT_ID) return;

  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, text);
  } catch (e) {
    console.error('Telegram:', e.message);
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
  let last;

  for (let i = 0; i < retries; i++) {
    try {
      return await axios({
        timeout: 12000,
        ...config
      });
    } catch (e) {
      last = e;

      if (i < retries - 1) {
        await new Promise(resolve =>
          setTimeout(resolve, 500 * (i + 1))
        );
      }
    }
  }

  throw last;
}

async function publicGet(pathname, params = {}) {
  const query = q(params);

  const requestPath =
    query ? `${pathname}?${query}` : pathname;

  const response = await request({
    method: 'GET',
    url: `${BASE_URL}${requestPath}`
  });

  if (!response.data ||
      String(response.data.code) !== '0') {

    throw new Error(
      `OKX public error ${response.status}: ` +
      JSON.stringify(response.data)
    );
  }

  return Array.isArray(response.data.data)
    ? response.data.data
    : [];
}

/* =========================================================
   PRIVATE API
========================================================= */

function sign(timestamp, method, requestPath, body) {
  return crypto
    .createHmac('sha256', SECRET_KEY)
    .update(
      timestamp +
      method.toUpperCase() +
      requestPath +
      body
    )
    .digest('base64');
}

async function privateRequest(
  method,
  requestPath,
  bodyObj = null
) {
  if (!API_KEY || !SECRET_KEY || !PASSPHRASE) {
    throw new Error(
      'OKX API credentials are missing'
    );
  }

  const timestamp =
    new Date().toISOString();

  const body =
    bodyObj ? JSON.stringify(bodyObj) : '';

  const headers = {
    'OK-ACCESS-KEY': API_KEY,
    'OK-ACCESS-SIGN':
      sign(
        timestamp,
        method,
        requestPath,
        body
      ),
    'OK-ACCESS-TIMESTAMP':
      timestamp,
    'OK-ACCESS-PASSPHRASE':
      PASSPHRASE,
    'Content-Type':
      'application/json'
  };

  const response = await request({
    method,
    url: `${BASE_URL}${requestPath}`,
    data: body || undefined,
    headers
  });

  if (!response.data ||
      String(response.data.code) !== '0') {

    throw new Error(
      `OKX private error ${response.status}: ` +
      JSON.stringify(response.data)
    );
  }

  return Array.isArray(response.data.data)
    ? response.data.data
    : [];
}

/* =========================================================
   STATE
========================================================= */

function freshState() {
  return {
    day: new Date().toISOString().slice(0, 10),

    startEquity: START_CAPITAL,

    paperEquity: START_CAPITAL,

    realizedPnl: 0,

    consecutiveLosses: 0,

    halted: false,

    lastTradeAt: 0,

    trades: [],

    position: null
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

function resetDaily() {
  const day =
    new Date().toISOString().slice(0, 10);

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
   INDICATORS
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

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  const k = 2 / (period + 1);

  let value =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    value =
      values[i] * k +
      value * (1 - k);
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) {
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
        avgGain * (period - 1) +
        Math.max(d, 0)
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        Math.max(-d, 0)
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  return (
    100 -
    100 /
      (
        1 +
        avgGain / avgLoss
      )
  );
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) {
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
    ) / recent.length
  );
}

function confirmed(candles) {
  return candles
    .slice()
    .sort(
      (a, b) =>
        Number(a[0]) -
        Number(b[0])
    )
    .filter(
      x => String(x[8]) === '1'
    );
}

function pivots(candles, lookback = 3) {
  const h = highs(candles);
  const l = lows(candles);

  const resistance = [];
  const support = [];

  for (
    let i = lookback;
    i < candles.length - lookback;
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

function nearestAbove(levels, price) {
  return levels
    .filter(x => x > price)
    .sort((a, b) => a - b)[0] ||
    null;
}

function nearestBelow(levels, price) {
  return levels
    .filter(x => x < price)
    .sort((a, b) => b - a)[0] ||
    null;
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
  instId
) {
  const rows =
    await publicGet(
      '/api/v5/market/ticker',
      {
        instType: 'EVENTS',
        instId
      }
    );

  return rows[0] || null;
}

async function underlyingTicker(
  instId
) {
  const rows =
    await publicGet(
      '/api/v5/market/ticker',
      {
        instId
      }
    );

  return rows[0] || null;
}

/* =========================================================
   EVENT CONTRACT DISCOVERY
========================================================= */

/*
  Correct OKX 2026 endpoints:

  /api/v5/public/event-contract/series
  /api/v5/public/event-contract/events
  /api/v5/public/event-contract/markets
*/

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
        '/api/v5/public/event-contract/series'
      );

    const now =
      Date.now();

    const result = [];

    for (const row of rows) {
      const seriesId =
        row.seriesId ||
        row.id;

      if (!seriesId) {
        continue;
      }

      const text =
        JSON.stringify(row)
          .toUpperCase();

      const matchedCoin =
        EVENT_COINS.some(
          coin =>
            text.includes(coin)
        );

      if (!matchedCoin) {
        continue;
      }

      /*
        Keep the common live crypto series.
        If OKX returns freq / state fields,
        use them when available.
      */

      const stateValue =
        String(
          row.state ||
          row.status ||
          ''
        ).toLowerCase();

      if (
        stateValue &&
        ![
          'live',
          'active',
          'open'
        ].includes(stateValue)
      ) {
        continue;
      }

      const exp =
        Number(
          row.expTime ||
          row.expiryTime ||
          row.endTime ||
          0
        );

      if (
        exp > 0 &&
        exp < now
      ) {
        continue;
      }

      result.push(
        seriesId
      );
    }

    /*
      Fallback to well-known series IDs
      if discovery returns no usable series.
    */

    if (!result.length) {
      return EVENT_COINS.flatMap(
        coin => [
          `${coin}-ABOVE-DAILY`,
          `${coin}-UPDOWN-15MIN`,
          `${coin}-UPDOWN-HOURLY`
        ]
      );
    }

    return [
      ...new Set(result)
    ];
  } catch (e) {
    console.error(
      'Series discovery failed:',
      e.message
    );

    /*
      Discovery failure should not crash
      the whole Render service.

      Use known series as fallback.
    */

    return EVENT_COINS.flatMap(
      coin => [
        `${coin}-ABOVE-DAILY`,
        `${coin}-UPDOWN-15MIN`,
        `${coin}-UPDOWN-HOURLY`
      ]
    );
  }
}

/* =========================================================
   EVENTS / MARKETS
========================================================= */

async function eventDetails(
  seriesId
) {
  try {
    return await publicGet(
      '/api/v5/public/event-contract/events',
      {
        seriesId
      }
    );
  } catch (e) {
    console.error(
      `Events ${seriesId}:`,
      e.message
    );

    return [];
  }
}

async function eventMarkets(
  seriesId
) {
  return publicGet(
    '/api/v5/public/event-contract/markets',
    {
      seriesId
    }
  );
}

async function eventInstruments(
  seriesId
) {
  return publicGet(
    '/api/v5/public/instruments',
    {
      instType: 'EVENTS',
      seriesId
    }
  );
}

/* =========================================================
   EVENT FIELD HELPERS
========================================================= */

function textOf(obj) {
  return JSON.stringify(obj || {})
    .toUpperCase();
}

function baseAsset(inst) {
  const text =
    `${inst.baseCcy || ''} ` +
    `${inst.instId || ''} ` +
    `${inst.seriesId || ''} ` +
    `${inst.uly || ''}`;

  const upper =
    text.toUpperCase();

  for (
    const coin of EVENT_COINS
  ) {
    if (
      upper.includes(coin)
    ) {
      return coin;
    }
  }

  return null;
}

function eventDirection(inst) {
  const text =
    textOf(inst);

  if (
    text.includes('UPDOWN') ||
    text.includes('UP_DOWN') ||
    text.includes('PRICE_UP_DOWN')
  ) {
    return 'UPDOWN';
  }

  if (
    text.includes('ABOVE') ||
    text.includes('PRICE_ABOVE')
  ) {
    return 'ABOVE';
  }

  if (
    text.includes('BELOW')
  ) {
    return 'BELOW';
  }

  return 'UNKNOWN';
}

function numberField(
  obj,
  keys
) {
  for (const key of keys) {
    const value =
      Number(obj?.[key]);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }

  return null;
}

function strike(inst) {
  return numberField(
    inst,
    [
      'stk',
      'strike',
      'strikePx',
      'targetPx',
      'triggerPx',
      'floorStrike'
    ]
  );
}

function expiry(inst) {
  return numberField(
    inst,
    [
      'expTime',
      'expiryTime',
      'endTime'
    ]
  );
}

function seriesExpiry(
  series
) {
  return numberField(
    series,
    [
      'expTime',
      'expiryTime',
      'endTime'
    ]
  );
}

/* =========================================================
   PRICE / TICK SIZE
========================================================= */

async function getTickBands() {
  try {
    return await publicGet(
      '/api/v5/public/instrument-tick-bands',
      {
        instType: 'EVENTS'
      }
    );
  } catch (e) {
    console.error(
      'Tick bands:',
      e.message
    );

    return [];
  }
}

function tickSizeForPrice(
  price,
  bands
) {
  for (const band of bands) {
    const minPx =
      Number(band.minPx);

    const maxPx =
      Number(band.maxPx);

    const tickSz =
      Number(band.tickSz);

    if (
      Number.isFinite(minPx) &&
      Number.isFinite(maxPx) &&
      Number.isFinite(tickSz) &&
      price >= minPx &&
      price <= maxPx
    ) {
      return tickSz;
    }
  }

  return 0.01;
}

function decimalsForStep(step) {
  const s =
    String(step);

  if (!s.includes('.')) {
    return 0;
  }

  return s.split('.')[1]
    .replace(/0+$/, '')
    .length;
}

function roundToTick(
  value,
  tick
) {
  if (!(tick > 0)) {
    return value;
  }

  const decimals =
    Math.max(
      0,
      decimalsForStep(tick)
    );

  const rounded =
    Math.round(
      value / tick
    ) * tick;

  return Number(
    rounded.toFixed(decimals)
  );
}

function roundDown(
  value,
  step
) {
  if (!(step > 0)) {
    return value;
  }

  const decimals =
    Math.max(
      0,
      decimalsForStep(step)
    );

  return Number(
    (
      Math.floor(
        value / step
      ) * step
    ).toFixed(decimals)
  );
}

/* =========================================================
   EXPIRY
========================================================= */

function allowedExpiry(
  inst
) {
  const exp =
    expiry(inst);

  if (!exp) {
    return false;
  }

  const minutes =
    (exp - Date.now()) /
    60000;

  return (
    minutes >=
      MIN_MINUTES_TO_EXPIRY &&
    minutes <=
      MAX_MINUTES_TO_EXPIRY
  );
}

/* =========================================================
   PROBABILITY
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

  const lastVol =
    vol5[vol5.length - 1];

  const volRatio =
    avgVol > 0
      ? lastVol / avgVol
      : 1;

  let score = 50;

  const reasons = [];

  /*
    UPDOWN:
    Estimate direction from EMA/RSI.
  */

  let bullish;

  if (direction === 'BELOW') {
    bullish = false;
  } else {
    bullish = true;
  }

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
    reasons.push(
      'RSI'
    );
  }

  if (volRatio >= 1.15) {
    score += 8;
    reasons.push(
      'volume'
    );
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

  if (
    strikePx &&
    direction === 'ABOVE'
  ) {
    if (price > strikePx) {
      score += 8;
      reasons.push(
        'above strike'
      );
    }
  }

  if (
    strikePx &&
    direction === 'BELOW'
  ) {
    if (price < strikePx) {
      score += 8;
      reasons.push(
        'below strike'
      );
    }
  }

  if (
    strikePx &&
    price > 0
  ) {
    const distance =
      Math.abs(
        price - strikePx
      ) / price;

    if (distance < 0.0025) {
      score -= 10;
      reasons.push(
        'strike too close'
      );
    }
  }

  if (
    atr5 &&
    price > 0
  ) {
    const atrPct =
      atr5 / price;

    if (atrPct < 0.001) {
      score -= 5;
    }

    if (atrPct > 0.03) {
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
   ACCOUNT
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
      x => x.ccy === 'USDT'
    );

  const equity =
    Number(detail?.eq);

  const available =
    Number(detail?.availBal);

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

function stakeForEquity(
  equity
) {
  const risk =
    equity * RISK_PCT;

  return Math.max(
    MIN_STAKE,
    Math.min(
      equity * MAX_STAKE_PCT,
      risk
    )
  );
}

/* =========================================================
   CANDIDATE SCAN
========================================================= */

function validPrice(price) {
  return (
    Number.isFinite(price) &&
    price > MIN_ENTRY_PRICE &&
    price < MAX_ENTRY_PRICE
  );
}

async function scanCandidates() {
  const series =
    await eventSeries();

  const candidates = [];

  const tickBands =
    await getTickBands();

  for (const seriesId of series) {
    let instruments = [];

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

    if (!instruments.length) {
      continue;
    }

    /*
      Fetch event / market metadata.
      These are used for identification and
      future compatibility with OKX Event APIs.
    */

    let events = [];

    try {
      events =
        await eventDetails(
          seriesId
        );
    } catch (_) {}

    let markets = [];

    try {
      markets =
        await eventMarkets(
          seriesId
        );
    } catch (_) {}

    console.log(
      `[Discovery] ${seriesId}: ` +
      `${instruments.length} instruments, ` +
      `${events.length} events, ` +
      `${markets.length} markets`
    );

    for (const inst of instruments) {
      if (
        inst.state &&
        ![
          'live',
          'preopen'
        ].includes(
          String(
            inst.state
          ).toLowerCase()
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

      if (
        !coin ||
        !UNDERLYING_MAP[coin]
      ) {
        continue;
      }

      const direction =
        eventDirection(inst);

      if (
        direction === 'UNKNOWN'
      ) {
        continue;
      }

      /*
        Do not invent strike for contracts
        that don't have one.
      */

      const strikePx =
        strike(inst);

      const underlying =
        UNDERLYING_MAP[coin];

      try {
        const [
          eventTicker,
          c5,
          c15
        ] =
          await Promise.all([
            ticker(inst.instId),

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

        if (
          !eventTicker
        ) {
          continue;
        }

        /*
          OKX EVENTS market data returns
          YES-side data.

          NO is derived:
          NO price = 1 - YES price
        */

        const yesAsk =
          Number(
            eventTicker.askPx ||
            eventTicker.last
          );

        const yesBid =
          Number(
            eventTicker.bidPx ||
            eventTicker.last
          );

        if (
          !(yesAsk > 0) ||
          !(yesBid > 0)
        ) {
          continue;
        }

        /*
          For ABOVE / general binary events:
          model YES when event direction is favorable.

          For DOWN / BELOW:
          trade NO.
        */

        let side;

        if (
          direction === 'BELOW'
        ) {
          side = 'no';
        } else {
          side = 'yes';
        }

        const entryPx =
          side === 'yes'
            ? yesAsk
            : 1 - yesBid;

        if (
          !validPrice(entryPx)
        ) {
          continue;
        }

        const lastCandle =
          c5[c5.length - 1];

        if (!lastCandle) {
          continue;
        }

        const underlyingPrice =
          Number(
            lastCandle[4]
          );

        if (
          !(
            underlyingPrice >
            0
          )
        ) {
          continue;
        }

        const model =
          modelProbability(
            direction,
            underlyingPrice,
            strikePx,
            c5,
            c15
          );

        const marketProb =
          marketProbability(
            entryPx,
            side
          );

        if (
          marketProb === null
        ) {
          continue;
        }

        const edge =
          model.probability -
          marketProb;

        if (
          model.score <
          MIN_SCORE
        ) {
          continue;
        }

        if (
          edge <
          MIN_EDGE
        ) {
          continue;
        }

        const tick =
          tickSizeForPrice(
            entryPx,
            tickBands
          );

        const adjustedEntry =
          roundToTick(
            entryPx,
            tick
          );

        candidates.push({
          inst,

          seriesId,

          coin,

          underlying,

          strikePx,

          direction,

          side,

          entryPx:
            adjustedEntry,

          yesAsk,

          yesBid,

          modelProb:
            model.probability,

          marketProb,

          edge,

          score:
            model.score,

          reasons:
            model.reasons,

          underlyingPrice
        });
      } catch (e) {
        console.error(
          `Candidate ${inst.instId}:`,
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
   ORDER SIZE
========================================================= */

function getLotSize(inst) {
  const lot =
    Number(inst.lotSz);

  const min =
    Number(inst.minSz);

  return {
    lot:
      Number.isFinite(lot) &&
      lot > 0
        ? lot
        : 1,

    min:
      Number.isFinite(min) &&
      min > 0
        ? min
        : 1
  };
}

/* =========================================================
   EVENT ORDER
========================================================= */

async function placeEventOrder(
  candidate,
  stake
) {
  const inst =
    candidate.inst;

  const {
    lot,
    min
  } =
    getLotSize(inst);

  /*
    Event limit order:
    sz = number of contracts.

    Approximate cost:
    contracts × event price
  */

  let sz =
    stake /
    candidate.entryPx;

  sz =
    roundDown(
      sz,
      lot
    );

  if (
    sz < min
  ) {
    throw new Error(
      `Order size below minimum: ` +
      `sz=${sz}, min=${min}`
    );
  }

  const notional =
    sz *
    candidate.entryPx;

  if (
    notional >
    stake * 1.03
  ) {
    throw new Error(
      `Order exceeds stake budget: ` +
      `${notional.toFixed(4)}`
    );
  }

  const body = {
    instId:
      inst.instId,

    tdMode:
      'isolated',

    side:
      'buy',

    ordType:
      'ioc',

    px:
      candidate.entryPx.toString(),

    sz:
      String(sz),

    outcome:
      candidate.side,

    speedBump:
      '1',

    clOrdId:
      `snr${Date.now().toString(36)}`
        .slice(0, 32)
  };

  /*
    PAPER MODE
  */

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

  /*
    LIVE
  */

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
    String(result.sCode) !== '0'
  ) {
    throw new Error(
      `Order rejected: ` +
      JSON.stringify(result)
    );
  }

  return result;
}

/* =========================================================
   ORDER QUERY
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
   CLOSE EVENT POSITION
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

    ordType:
      'ioc',

    px:
      Number(currentPx)
        .toString(),

    sz:
      String(position.sz),

    outcome:
      position.side,

    speedBump:
      '1',

    clOrdId:
      `exit${Date.now().toString(36)}`
        .slice(0, 32)
  };

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
    String(result.sCode) !== '0'
  ) {
    throw new Error(
      `Exit rejected: ` +
      JSON.stringify(result)
    );
  }

  return result;
}

/* =========================================================
   POSITION MANAGER
========================================================= */

async function managePosition() {
  if (!state.position) {
    return;
  }

  const position =
    state.position;

  try {
    const t =
      await ticker(
        position.inst.instId
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
      YES:
        current = YES bid

      NO:
        current = 1 - YES ask

      Using YES bid for NO would overstate
      the executable NO exit price.

      If OKX provides ask, use it.
    */

    const yesAsk =
      Number(
        t?.askPx ||
        t?.last
      );

    let currentBid;

    if (
      position.side === 'yes'
    ) {
      currentBid =
        yesBid;
    } else {
      currentBid =
        1 - yesAsk;
    }

    if (
      !(
        currentBid > 0 &&
        currentBid < 1
      )
    ) {
      return;
    }

    const change =
      (
        currentBid -
        position.entryPx
      ) /
      position.entryPx;

    if (
      change >= EARLY_TP_PCT ||
      change <= -EARLY_SL_PCT
    ) {
      const result =
        await closePosition(
          position,
          currentBid
        );

      const exitPx =
        Number(
          result?.avgPx ||
          currentBid
        );

      const pnl =
        (
          exitPx -
          position.entryPx
        ) *
        position.sz;

      state.realizedPnl += pnl;

      state.paperEquity =
        Math.max(
          0,
          Number(
            state.paperEquity ||
              START_CAPITAL
          ) + pnl
        );

      state.consecutiveLosses =
        pnl < 0
          ? state.consecutiveLosses + 1
          : 0;

      state.trades.push({
        at:
          new Date().toISOString(),

        instId:
          position.inst.instId,

        side:
          position.side,

        entryPx:
          position.entryPx,

        exitPx,

        sz:
          position.sz,

        pnl
      });

      if (
        state.trades.length >
        200
      ) {
        state.trades.shift();
      }

      state.position = null;

      if (
        state.consecutiveLosses >=
        MAX_CONSECUTIVE_LOSSES
      ) {
        state.halted = true;
      }

      saveState();

      await notify(
        `${pnl >= 0 ? '🟢' : '🔴'} EVENT EXIT\n` +
        `${position.inst.instId}\n` +
        `${position.side.toUpperCase()}\n` +
        `Entry ${position.entryPx}\n` +
        `Exit ${exitPx}\n` +
        `PnL ${pnl >= 0 ? '+' : ''}` +
        `${pnl.toFixed(3)}U\n` +
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
   TRADE
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

  if (
    state.realizedPnl <=
    -(equity * DAILY_LOSS_PCT)
  ) {
    state.halted = true;

    saveState();

    await notify(
      `⛔ EVENT BOT DAILY LOSS LOCK\n` +
      `PnL ${state.realizedPnl.toFixed(3)}U`
    );

    return;
  }

  const candidates =
    await scanCandidates();

  if (!candidates.length) {
    return;
  }

  const candidate =
    candidates[0];

  const stake =
    Math.min(
      stakeForEquity(equity),
      equity
    );

  try {
    const order =
      await placeEventOrder(
        candidate,
        stake
      );

    let filled =
      order;

    if (
      LIVE_TRADING &&
      order.ordId
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1000
          )
      );

      filled =
        await getOrder(
          candidate.inst.instId,
          order.ordId
        );
    }

    const fillSz =
      Number(
        filled?.accFillSz ||
        filled?.fillSz ||
        filled?.sz ||
        0
      );

    const avgPx =
      Number(
        filled?.avgPx ||
        filled?.fillPx ||
        candidate.entryPx
      );

    if (
      !(fillSz > 0)
    ) {
      console.log(
        'Order not filled:',
        JSON.stringify(
          filled
        )
      );

      return;
    }

    state.position = {
      inst:
        candidate.inst,

      seriesId:
        candidate.seriesId,

      coin:
        candidate.coin,

      direction:
        candidate.direction,

      side:
        candidate.side,

      sz:
        fillSz,

      entryPx:
        avgPx,

      stake,

      score:
        candidate.score,

      edge:
        candidate.edge,

      modelProb:
        candidate.modelProb,

      marketProb:
        candidate.marketProb,

      openedAt:
        Date.now()
    };

    state.lastTradeAt =
      Date.now();

    saveState();

    await notify(
      `🟡 EVENT ENTRY\n` +
      `${candidate.inst.instId}\n` +
      `${candidate.side.toUpperCase()}\n` +
      `Entry ${avgPx.toFixed(4)}\n` +
      `Score ${candidate.score}\n` +
      `Model ${(candidate.modelProb * 100).toFixed(1)}%\n` +
      `Market ${(candidate.marketProb * 100).toFixed(1)}%\n` +
      `Edge ${(candidate.edge * 100).toFixed(1)}%\n` +
      `Stake ${stake.toFixed(2)}U\n` +
      `Reason ${candidate.reasons.join(', ')}\n` +
      `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
    );
  } catch (e) {
    console.error(
      'Trade:',
      e.message
    );
  }
}

/* =========================================================
   HTTP
========================================================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,

    bot:
      'OKX Event Contract SNR Rolling Bot',

    api:
      'OKX 2026 Event Contracts',

    live:
      LIVE_TRADING,

    baseUrl:
      BASE_URL,

    position:
      state.position
        ? {
            instId:
              state.position.inst.instId,

            side:
              state.position.side,

            entryPx:
              state.position.entryPx,

            sz:
              state.position.sz
          }
        : null,

    halted:
      state.halted,

    consecutiveLosses:
      state.consecutiveLosses,

    realizedPnl:
      state.realizedPnl
  });
});

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,

      live:
        LIVE_TRADING,

      time:
        new Date().toISOString()
    });
  }
);

app.get(
  '/status',
  (req, res) => {
    res.json({
      live:
        LIVE_TRADING,

      baseUrl:
        BASE_URL,

      eventCoins:
        EVENT_COINS,

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
    });
  }
);

/* =========================================================
   START
========================================================= */

async function startupCheck() {
  try {
    const time =
      await publicGet(
        '/api/v5/public/time'
      );

    console.log(
      '[OKX] API reachable.',
      time[0]?.ts || ''
    );
  } catch (e) {
    console.error(
      '[OKX] API startup check failed:',
      e.message
    );
  }

  try {
    const series =
      await eventSeries();

    console.log(
      '[OKX] Event series:',
      series.slice(0, 20)
    );
  } catch (e) {
    console.error(
      '[OKX] Event discovery:',
      e.message
    );
  }
}

async function mainLoop() {
  resetDaily();

  try {
    await managePosition();

    if (!state.position) {
      await maybeTrade();
    }
  } catch (e) {
    console.error(
      'MAIN LOOP:',
      e.message || e
    );
  }
}

app.listen(
  PORT,
  async () => {
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
      `EVENT_COINS=${EVENT_COINS.join(',')}`
    );

    await startupCheck();

    await mainLoop();
  }
);

setInterval(
  mainLoop,
  CHECK_INTERVAL
);

setInterval(
  managePosition,
  POSITION_CHECK_INTERVAL
);
