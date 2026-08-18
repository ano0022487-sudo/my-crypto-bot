'use strict';

/*
===========================================================
 OKX EVENTS SNR ROLLING BOT
 ----------------------------------------------------------
 Product:
   OKX Event Contracts (EVENTS)

 Supports:
   BTC / ETH / SOL
   UPDOWN / ABOVE / BELOW
   5m + 15m confirmation
   EMA20 / EMA50
   RSI
   ATR
   SNR
   Volume
   Model probability
   Market probability
   Edge
   Rolling stake
   One position at a time
   FOK full-fill protection
   Actual-fill verification
   Early TP / SL
   Daily loss protection
   Consecutive-loss protection
   Telegram
   Render health endpoints

 IMPORTANT:
   LIVE_TRADING=false by default.

 Required:
   OK_ACCESS_KEY
   OK_ACCESS_SECRET
   OKX_PASSPHRASE

 Optional:
   LIVE_TRADING
   START_CAPITAL
   RISK_PCT
   MAX_STAKE_PCT
   MIN_STAKE
   MIN_EDGE
   MIN_SCORE
   MIN_ENTRY_PRICE
   MAX_ENTRY_PRICE
   EARLY_TP_PCT
   EARLY_SL_PCT
   MIN_MINUTES_TO_EXPIRY
   MAX_MINUTES_TO_EXPIRY
   DAILY_LOSS_PCT
   MAX_CONSECUTIVE_LOSSES
   CHECK_INTERVAL
   POSITION_CHECK_INTERVAL
   TELEGRAM_BOT_TOKEN
   TELEGRAM_CHAT_ID
   EVENT_SERIES

 NOTE:
   This version intentionally does NOT use:
     /api/v5/public/event-series
     /api/v5/public/series

   Instead it queries known OKX EVENTS series IDs directly
   through:
     GET /api/v5/public/instruments
     instType=EVENTS
     seriesId=<series>

===========================================================
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

const PORT = Number(
  process.env.PORT || 3000
);

const LIVE_TRADING =
  String(
    process.env.LIVE_TRADING || 'false'
  ).toLowerCase() === 'true';

const API_KEY =
  String(
    process.env.OK_ACCESS_KEY || ''
  ).trim();

const SECRET_KEY =
  String(
    process.env.OK_ACCESS_SECRET || ''
  ).trim();

const PASSPHRASE =
  String(
    process.env.OKX_PASSPHRASE || ''
  ).trim();

const BASE_URL =
  String(
    process.env.OKX_BASE_URL ||
    'https://openapi.okx.com'
  ).replace(/\/$/, '');

const TELEGRAM_BOT_TOKEN =
  String(
    process.env.TELEGRAM_BOT_TOKEN || ''
  )
    .trim()
    .replace(/["']/g, '');

const TELEGRAM_CHAT_ID =
  String(
    process.env.TELEGRAM_CHAT_ID || ''
  ).trim();

const CHECK_INTERVAL =
  Number(
    process.env.CHECK_INTERVAL || 15000
  );

const POSITION_CHECK_INTERVAL =
  Number(
    process.env.POSITION_CHECK_INTERVAL || 5000
  );

const START_CAPITAL =
  Number(
    process.env.START_CAPITAL || 20
  );

const RISK_PCT =
  Number(
    process.env.RISK_PCT || 0.10
  );

const MAX_STAKE_PCT =
  Number(
    process.env.MAX_STAKE_PCT || 0.20
  );

const MIN_STAKE =
  Number(
    process.env.MIN_STAKE || 1
  );

const MIN_EDGE =
  Number(
    process.env.MIN_EDGE || 0.075
  );

const MIN_SCORE =
  Number(
    process.env.MIN_SCORE || 78
  );

const MIN_ENTRY_PRICE =
  Number(
    process.env.MIN_ENTRY_PRICE || 0.22
  );

const MAX_ENTRY_PRICE =
  Number(
    process.env.MAX_ENTRY_PRICE || 0.78
  );

const EARLY_TP_PCT =
  Number(
    process.env.EARLY_TP_PCT || 0.30
  );

const EARLY_SL_PCT =
  Number(
    process.env.EARLY_SL_PCT || 0.25
  );

const MIN_MINUTES_TO_EXPIRY =
  Number(
    process.env.MIN_MINUTES_TO_EXPIRY || 2
  );

const MAX_MINUTES_TO_EXPIRY =
  Number(
    process.env.MAX_MINUTES_TO_EXPIRY || 30
  );

const DAILY_LOSS_PCT =
  Number(
    process.env.DAILY_LOSS_PCT || 0.20
  );

const MAX_CONSECUTIVE_LOSSES =
  Number(
    process.env.MAX_CONSECUTIVE_LOSSES || 3
  );

const EVENT_SERIES =
  String(
    process.env.EVENT_SERIES || ''
  ).trim();

const BOT_STATE_FILE =
  process.env.BOT_STATE_FILE ||
  path.join(
    __dirname,
    'event-bot-state.json'
  );

/*
  Known Event Contract series.

  Your actual IDs have looked like:

    SOL-UPDOWN-15MIN-260818-2230-2245

  Therefore the series family is:

    SOL-UPDOWN-15MIN

  We query the current instruments for these families.
*/

const DEFAULT_EVENT_SERIES = [
  'BTC-UPDOWN-5MIN',
  'BTC-UPDOWN-15MIN',

  'ETH-UPDOWN-5MIN',
  'ETH-UPDOWN-15MIN',

  'SOL-UPDOWN-5MIN',
  'SOL-UPDOWN-15MIN'
];

/*
  Underlying perpetuals are used ONLY for technical analysis.
*/
const UNDERLYING_MAP = {
  BTC: 'BTC-USDT-SWAP',
  ETH: 'ETH-USDT-SWAP',
  SOL: 'SOL-USDT-SWAP'
};

/* =========================================================
   TELEGRAM
========================================================= */

const bot =
  TELEGRAM_BOT_TOKEN
    ? new TelegramBot(
        TELEGRAM_BOT_TOKEN,
        {
          polling: true
        }
      )
    : null;

/*
  Ignore Telegram 409/403 polling problems without
  killing the trading process.
*/
if (bot) {

  bot.on(
    'polling_error',
    err => {

      console.error(
        '[Telegram polling]',
        err.message
      );
    }
  );

  bot.on(
    'error',
    err => {

      console.error(
        '[Telegram]',
        err.message
      );
    }
  );
}

async function notify(text) {

  if (
    !bot ||
    !TELEGRAM_CHAT_ID
  ) {
    return;
  }

  try {

    await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      text
    );

  } catch (err) {

    console.error(
      '[Telegram send]',
      err.message
    );
  }
}

/* =========================================================
   UTIL
========================================================= */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function queryString(params) {

  return Object.entries(
    params
  )
    .filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        value !== ''
    )
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join('&');
}

async function request(
  config,
  retries = 3
) {

  let lastError;

  for (
    let i = 0;
    i < retries;
    i++
  ) {

    try {

      return await axios({
        timeout: 15000,
        ...config
      });

    } catch (err) {

      lastError = err;

      if (
        i <
        retries - 1
      ) {

        await sleep(
          500 *
          (i + 1)
        );
      }
    }
  }

  throw lastError;
}

/* =========================================================
   OKX PUBLIC API
========================================================= */

async function publicGet(
  pathname,
  params = {}
) {

  const qs =
    queryString(
      params
    );

  const requestPath =
    qs
      ? `${pathname}?${qs}`
      : pathname;

  const response =
    await request({
      method: 'GET',
      url:
        `${BASE_URL}${requestPath}`
    });

  if (
    !response.data ||
    String(
      response.data.code
    ) !== '0'
  ) {

    throw new Error(
      `OKX public error ${response.status}: ` +
      JSON.stringify(
        response.data
      )
    );
  }

  return (
    response.data.data || []
  );
}

/* =========================================================
   SIGNATURE
========================================================= */

function sign(
  timestamp,
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
      timestamp +
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
      'OKX API credentials missing'
    );
  }

  const timestamp =
    new Date().toISOString();

  const body =
    bodyObj
      ? JSON.stringify(
          bodyObj
        )
      : '';

  const headers = {

    'OK-ACCESS-KEY':
      API_KEY,

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

  const response =
    await request({
      method,
      url:
        `${BASE_URL}${requestPath}`,
      data:
        body || undefined,
      headers
    });

  if (
    !response.data ||
    String(
      response.data.code
    ) !== '0'
  ) {

    throw new Error(
      `OKX private error ${response.status}: ` +
      JSON.stringify(
        response.data
      )
    );
  }

  return (
    response.data.data || []
  );
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

    position:
      null,

    trades:
      []
  };
}

function loadState() {

  try {

    if (
      !fs.existsSync(
        BOT_STATE_FILE
      )
    ) {

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

  } catch (err) {

    console.error(
      '[STATE LOAD]',
      err.message
    );

    return freshState();
  }
}

const state =
  loadState();

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

  } catch (err) {

    console.error(
      '[STATE SAVE]',
      err.message
    );
  }
}

/* =========================================================
   DAILY RISK
========================================================= */

function resetDaily() {

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  if (
    state.day !== today
  ) {

    state.day =
      today;

    state.startEquity =
      LIVE_TRADING
        ? 0
        : Number(
            state.paperEquity ||
            START_CAPITAL
          );

    state.realizedPnl =
      0;

    state.consecutiveLosses =
      0;

    state.halted =
      false;

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
   CANDLE HELPERS
========================================================= */

function closes(candles) {

  return candles
    .map(
      x =>
        Number(x[4])
    )
    .filter(
      Number.isFinite
    );
}

function highs(candles) {

  return candles
    .map(
      x =>
        Number(x[2])
    )
    .filter(
      Number.isFinite
    );
}

function lows(candles) {

  return candles
    .map(
      x =>
        Number(x[3])
    )
    .filter(
      Number.isFinite
    );
}

function volumes(candles) {

  return candles
    .map(
      x =>
        Number(x[5])
    )
    .filter(
      Number.isFinite
    );
}

/* =========================================================
   EMA
========================================================= */

function ema(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 /
    (period + 1);

  let value =
    values
      .slice(
        0,
        period
      )
      .reduce(
        (a, b) =>
          a + b,
        0
      ) /
    period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    value =
      values[i] *
        multiplier +
      value *
        (1 - multiplier);
  }

  return value;
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

    const change =
      values[i] -
      values[i - 1];

    if (
      change >= 0
    ) {

      gains +=
        change;

    } else {

      losses -=
        change;
    }
  }

  let avgGain =
    gains /
    period;

  let avgLoss =
    losses /
    period;

  for (
    let i =
      period + 1;
    i <
      values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    avgGain =
      (
        avgGain *
          (period - 1) +
        Math.max(
          change,
          0
        )
      ) /
      period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        Math.max(
          -change,
          0
        )
      ) /
      period;
  }

  if (
    avgLoss === 0
  ) {

    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 /
      (1 + rs)
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
    i <
      candles.length;
    i++
  ) {

    const high =
      Number(
        candles[i][2]
      );

    const low =
      Number(
        candles[i][3]
      );

    const prev =
      Number(
        candles[i - 1][4]
      );

    tr.push(
      Math.max(
        high - low,
        Math.abs(
          high - prev
        ),
        Math.abs(
          low - prev
        )
      )
    );
  }

  const recent =
    tr.slice(
      -period
    );

  return (
    recent.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    recent.length
  );
}

/* =========================================================
   CONFIRMED CANDLES
========================================================= */

function confirmed(
  candles
) {

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
   SNR
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

    const highest =
      Math.max(
        ...h.slice(
          i - lookback,
          i +
            lookback +
            1
        )
      );

    const lowest =
      Math.min(
        ...l.slice(
          i - lookback,
          i +
            lookback +
            1
        )
      );

    if (
      h[i] ===
      highest
    ) {

      resistance.push(
        h[i]
      );
    }

    if (
      l[i] ===
      lowest
    ) {

      support.push(
        l[i]
      );
    }
  }

  return {

    resistance:
      resistance.slice(
        -10
      ),

    support:
      support.slice(
        -10
      )
  };
}

function nearestAbove(
  levels,
  price
) {

  return levels
    .filter(
      x =>
        x > price
    )
    .sort(
      (a, b) =>
        a - b
    )[0] || null;
}

function nearestBelow(
  levels,
  price
) {

  return levels
    .filter(
      x =>
        x < price
    )
    .sort(
      (a, b) =>
        b - a
    )[0] || null;
}

/* =========================================================
   MARKET DATA
========================================================= */

async function getCandles(
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

  return confirmed(
    rows
  );
}

async function getTicker(
  instId,
  instType
) {

  const rows =
    await publicGet(
      '/api/v5/market/ticker',
      {
        instType,
        instId
      }
    );

  return (
    rows?.[0] ||
    null
  );
}

/* =========================================================
   EVENT SERIES
========================================================= */

function getSeriesList() {

  if (
    EVENT_SERIES
  ) {

    return EVENT_SERIES
      .split(',')
      .map(
        x =>
          x.trim()
      )
      .filter(
        Boolean
      );
  }

  return [
    ...DEFAULT_EVENT_SERIES
  ];
}

/*
  This replaces the broken discovery endpoints.

  OKX official V5:
    GET /api/v5/public/instruments
    instType=EVENTS
    seriesId=<series>
*/
async function getEventInstruments(
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
   EVENT HELPERS
========================================================= */

function getBaseAsset(
  inst
) {

  const text =
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
      text.includes(
        coin
      )
    ) {

      return coin;
    }
  }

  return null;
}

function getExpiry(
  inst
) {

  const values = [
    Number(
      inst.expTime
    ),
    Number(
      inst.expiryTime
    ),
    Number(
      inst.endTime
    )
  ].filter(
    Number.isFinite
  );

  if (
    !values.length
  ) {

    return null;
  }

  return Math.max(
    ...values
  );
}

function minutesToExpiry(
  inst
) {

  const expiry =
    getExpiry(inst);

  if (
    !Number.isFinite(
      expiry
    )
  ) {

    return null;
  }

  return (
    expiry -
    Date.now()
  ) /
  60000;
}

function allowedExpiry(
  inst
) {

  const mins =
    minutesToExpiry(
      inst
    );

  if (
    !Number.isFinite(
      mins
    )
  ) {

    return false;
  }

  return (
    mins >=
      MIN_MINUTES_TO_EXPIRY &&
    mins <=
      MAX_MINUTES_TO_EXPIRY
  );
}

function getDirection(
  inst
) {

  const text =
    `${inst.seriesId || ''} ` +
    `${inst.instId || ''} ` +
    `${inst.ruleType || ''}`
      .toUpperCase();

  if (
    text.includes(
      'UPDOWN'
    )
  ) {

    return 'UPDOWN';
  }

  if (
    text.includes(
      'ABOVE'
    ) ||
    text.includes(
      'UP'
    )
  ) {

    return 'ABOVE';
  }

  if (
    text.includes(
      'BELOW'
    ) ||
    text.includes(
      'DOWN'
    )
  ) {

    return 'BELOW';
  }

  return 'UNKNOWN';
}

function getStrike(
  inst
) {

  const fields = [
    'stk',
    'strike',
    'strikePx',
    'targetPx',
    'triggerPx',
    'floorStrike',
    'capStrike'
  ];

  for (
    const key of
      fields
  ) {

    const n =
      Number(
        inst[key]
      );

    if (
      Number.isFinite(
        n
      ) &&
      n > 0
    ) {

      return n;
    }
  }

  return null;
}

/* =========================================================
   PRICE UTILITIES
========================================================= */

function decimalPlaces(
  value
) {

  const text =
    String(value);

  if (
    !text.includes('.')
  ) {

    return 0;
  }

  return (
    text.split('.')[1] ||
    ''
  ).length;
}

function roundDown(
  value,
  step
) {

  if (
    !(step > 0)
  ) {

    return value;
  }

  const decimals =
    Math.max(
      0,
      decimalPlaces(
        step
      )
    );

  return Number(
    (
      Math.floor(
        value /
        step
      ) *
      step
    ).toFixed(
      decimals
    )
  );
}

function roundToTick(
  value,
  tick
) {

  if (
    !(tick > 0)
  ) {

    return value;
  }

  const decimals =
    Math.max(
      0,
      decimalPlaces(
        tick
      )
    );

  return Number(
    (
      Math.round(
        value /
        tick
      ) *
      tick
    ).toFixed(
      decimals
    )
  );
}

function validPrice(
  price
) {

  return (
    Number.isFinite(
      price
    ) &&
    price >
      MIN_ENTRY_PRICE &&
    price <
      MAX_ENTRY_PRICE
  );
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
    ema(
      cl5,
      20
    );

  const ema50_5 =
    ema(
      cl5,
      50
    );

  const ema20_15 =
    ema(
      cl15,
      20
    );

  const ema50_15 =
    ema(
      cl15,
      50
    );

  const rsi5 =
    rsi(
      cl5,
      14
    );

  const atr5 =
    atr(
      c5,
      14
    );

  const recentVolume =
    vol5.slice(
      -20
    );

  const avgVolume =
    recentVolume.length
      ? recentVolume.reduce(
          (a, b) =>
            a + b,
          0
        ) /
        recentVolume.length
      : 0;

  const currentVolume =
    vol5[
      vol5.length - 1
    ] || 0;

  const volumeRatio =
    avgVolume > 0
      ? currentVolume /
        avgVolume
      : 1;

  let score = 50;

  const reasons = [];

  const bullish =
    direction ===
      'ABOVE' ||
    direction ===
      'UPDOWN_UP';

  const bearish =
    direction ===
      'BELOW' ||
    direction ===
      'UPDOWN_DOWN';

  if (
    bullish
  ) {

    if (
      ema20_5 &&
      ema50_5 &&
      ema20_5 >
        ema50_5
    ) {

      score += 10;

      reasons.push(
        '5m trend'
      );
    }

    if (
      ema20_15 &&
      ema50_15 &&
      ema20_15 >
        ema50_15
    ) {

      score += 15;

      reasons.push(
        '15m trend'
      );
    }

    if (
      rsi5 !== null &&
      rsi5 >= 55 &&
      rsi5 <= 72
    ) {

      score += 10;

      reasons.push(
        'RSI'
      );
    }
  }

  if (
    bearish
  ) {

    if (
      ema20_5 &&
      ema50_5 &&
      ema20_5 <
        ema50_5
    ) {

      score += 10;

      reasons.push(
        '5m trend'
      );
    }

    if (
      ema20_15 &&
      ema50_15 &&
      ema20_15 <
        ema50_15
    ) {

      score += 15;

      reasons.push(
        '15m trend'
      );
    }

    if (
      rsi5 !== null &&
      rsi5 >= 28 &&
      rsi5 <= 45
    ) {

      score += 10;

      reasons.push(
        'RSI'
      );
    }
  }

  if (
    volumeRatio >=
    1.15
  ) {

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
      resistance *
      0.999
  ) {

    score += 8;

    reasons.push(
      'SNR resistance test'
    );
  }

  if (
    bearish &&
    support &&
    price <=
      support *
      1.001
  ) {

    score += 8;

    reasons.push(
      'SNR support test'
    );
  }

  if (
    strikePx &&
    strikePx > 0
  ) {

    const distance =
      Math.abs(
        price -
        strikePx
      ) /
      price;

    if (
      bullish &&
      price >
        strikePx
    ) {

      score += 8;

      reasons.push(
        'above strike'
      );
    }

    if (
      bearish &&
      price <
        strikePx
    ) {

      score += 8;

      reasons.push(
        'below strike'
      );
    }

    if (
      distance <
      0.0025
    ) {

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
      atr5 /
      price;

    if (
      atrPct <
      0.001
    ) {

      score -= 5;
    }

    if (
      atrPct >
      0.03
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

  const probability =
    Math.max(
      0.50,
      Math.min(
        0.80,
        0.50 +
          (
            score -
            50
          ) *
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

  if (
    !LIVE_TRADING
  ) {

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

  const account =
    rows?.[0];

  const detail =
    account?.details?.find(
      x =>
        x.ccy ===
        'USDT'
    );

  const equity =
    Number(
      detail?.eq
    );

  const available =
    Number(
      detail?.availBal
    );

  if (
    Number.isFinite(
      available
    ) &&
    available > 0
  ) {

    return available;
  }

  if (
    Number.isFinite(
      equity
    ) &&
    equity > 0
  ) {

    return equity;
  }

  throw new Error(
    'Unable to read USDT balance'
  );
}

/* =========================================================
   STAKE
========================================================= */

function stakeForEquity(
  equity
) {

  const calculated =
    equity *
    RISK_PCT;

  const maximum =
    equity *
    MAX_STAKE_PCT;

  return Math.max(
    MIN_STAKE,
    Math.min(
      calculated,
      maximum
    )
  );
}

/* =========================================================
   EVENT PRICE
========================================================= */

function getYesAsk(
  ticker
) {

  const value =
    Number(
      ticker?.askPx
    );

  if (
    Number.isFinite(
      value
    ) &&
    value > 0
  ) {

    return value;
  }

  const last =
    Number(
      ticker?.last
    );

  return Number.isFinite(
    last
  )
    ? last
    : null;
}

function getYesBid(
  ticker
) {

  const value =
    Number(
      ticker?.bidPx
    );

  if (
    Number.isFinite(
      value
    ) &&
    value > 0
  ) {

    return value;
  }

  const last =
    Number(
      ticker?.last
    );

  return Number.isFinite(
    last
  )
    ? last
    : null;
}

/* =========================================================
   SCAN
========================================================= */

async function scanCandidates() {

  const seriesList =
    getSeriesList();

  const candidates = [];

  console.log(
    `[EVENT] Checking ${seriesList.length} series`
  );

  for (
    const seriesId of
      seriesList
  ) {

    let instruments;

    try {

      instruments =
        await getEventInstruments(
          seriesId
        );

    } catch (err) {

      console.error(
        `[EVENT] ${seriesId}:`,
        err.message
      );

      continue;
    }

    if (
      !Array.isArray(
        instruments
      )
    ) {

      continue;
    }

    for (
      const inst of
        instruments
    ) {

      try {

        if (
          String(
            inst.state ||
            ''
          ).toLowerCase() !==
          'live'
        ) {

          continue;
        }

        if (
          !allowedExpiry(
            inst
          )
        ) {

          continue;
        }

        const coin =
          getBaseAsset(
            inst
          );

        if (
          !coin
        ) {

          continue;
        }

        const underlying =
          UNDERLYING_MAP[
            coin
          ];

        if (
          !underlying
        ) {

          continue;
        }

        const direction =
          getDirection(
            inst
          );

        if (
          direction ===
          'UNKNOWN'
        ) {

          continue;
        }

        /*
          Don't trade an instrument
          twice during its lifetime.
        */
        if (
          state.trades.some(
            t =>
              t.instId ===
              inst.instId
          )
        ) {

          continue;
        }

        const [
          eventTicker,
          c5,
          c15
        ] =
          await Promise.all([
            getTicker(
              inst.instId,
              'EVENTS'
            ),

            getCandles(
              underlying,
              '5m',
              100
            ),

            getCandles(
              underlying,
              '15m',
              100
            )
          ]);

        if (
          !c5.length ||
          !c15.length
        ) {

          continue;
        }

        const yesAsk =
          getYesAsk(
            eventTicker
          );

        const yesBid =
          getYesBid(
            eventTicker
          );

        if (
          !validPrice(
            yesAsk
          ) ||
          !validPrice(
            yesBid
          )
        ) {

          continue;
        }

        const underlyingPrice =
          Number(
            c5[
              c5.length - 1
            ][4]
          );

        if (
          !Number.isFinite(
            underlyingPrice
          )
        ) {

          continue;
        }

        const strikePx =
          getStrike(
            inst
          );

        /*
          UPDOWN:
            YES = UP
            NO  = DOWN

          ABOVE:
            YES = ABOVE

          BELOW:
            YES = BELOW
        */

        let modelDirection;

        if (
          direction ===
          'UPDOWN'
        ) {

          modelDirection =
            'UPDOWN_UP';

        } else {

          modelDirection =
            direction;
        }

        const model =
          modelProbability(
            modelDirection,
            underlyingPrice,
            strikePx,
            c5,
            c15
          );

        let yesModelProb =
          model.probability;

        let noModelProb =
          1 -
          yesModelProb;

        const yesMarketProb =
          yesAsk;

        const noEntry =
          1 -
          yesBid;

        const noMarketProb =
          noEntry;

        const yesEdge =
          yesModelProb -
          yesMarketProb;

        const noEdge =
          noModelProb -
          noMarketProb;

        let side;
        let entryPx;
        let modelProb;
        let marketProb;
        let edge;

        if (
          yesEdge >=
          noEdge
        ) {

          side =
            'yes';

          entryPx =
            yesAsk;

          modelProb =
            yesModelProb;

          marketProb =
            yesMarketProb;

          edge =
            yesEdge;

        } else {

          side =
            'no';

          entryPx =
            noEntry;

          modelProb =
            noModelProb;

          marketProb =
            noMarketProb;

          edge =
            noEdge;
        }

        if (
          !validPrice(
            entryPx
          )
        ) {

          continue;
        }

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

        candidates.push({

          inst,

          seriesId,

          coin,

          underlying,

          direction,

          side,

          entryPx,

          modelProb,

          marketProb,

          edge,

          score:
            model.score,

          reasons:
            model.reasons,

          strikePx,

          underlyingPrice,

          expiry:
            getExpiry(
              inst
            ),

          minutesToExpiry:
            minutesToExpiry(
              inst
            )
        });

      } catch (err) {

        console.error(
          `[EVENT candidate ${inst.instId}]`,
          err.message
        );
      }
    }
  }

  return candidates.sort(
    (a, b) =>
      b.edge -
      a.edge ||
      b.score -
      a.score
  );
}

/* =========================================================
   ORDER QUANTITY
========================================================= */

function calculateOrderSize(
  stake,
  price,
  inst
) {

  const lotSz =
    Number(
      inst.lotSz
    ) || 0.1;

  const minSz =
    Number(
      inst.minSz
    ) || lotSz;

  /*
    Event contract:
      1 winning contract pays 1 USDT.

    Quantity:
      stake / price
  */
  const raw =
    stake /
    price;

  const rounded =
    roundDown(
      raw,
      lotSz
    );

  /*
    We DO NOT silently force minSz
    if doing so would exceed requested
    stake substantially.
  */
  if (
    rounded <
    minSz
  ) {

    return {
      ok:
        false,

      reason:
        `calculated size ${rounded} < minSz ${minSz}`,

      sz:
        rounded,

      lotSz,

      minSz
    };
  }

  const actualNotional =
    rounded *
    price;

  /*
    Maximum allowed overshoot:
      2%.
  */
  if (
    actualNotional >
    stake *
    1.02
  ) {

    return {
      ok:
        false,

      reason:
        `notional ${actualNotional.toFixed(6)} exceeds stake ${stake.toFixed(6)}`,

      sz:
        rounded,

      lotSz,

      minSz
    };
  }

  return {

    ok:
      true,

    sz:
      rounded,

    lotSz,

    minSz,

    requestedStake:
      stake,

    expectedNotional:
      actualNotional
  };
}

/* =========================================================
   PLACE EVENT ORDER
========================================================= */

async function placeEventOrder(
  candidate,
  stake
) {

  const inst =
    candidate.inst;

  const size =
    calculateOrderSize(
      stake,
      candidate.entryPx,
      inst
    );

  if (
    !size.ok
  ) {

    throw new Error(
      `SIZE REJECTED: ${size.reason}`
    );
  }

  const tickSz =
    Number(
      inst.tickSz
    ) || 0.001;

  const px =
    roundToTick(
      candidate.entryPx,
      tickSz
    );

  const finalNotional =
    px *
    size.sz;

  if (
    finalNotional >
    stake *
    1.02
  ) {

    throw new Error(
      `FINAL NOTIONAL TOO HIGH: ` +
      `requested=${stake.toFixed(6)} ` +
      `actual=${finalNotional.toFixed(6)}`
    );
  }

  /*
    IMPORTANT:
      Current OKX EVENTS order fields:

      instType = EVENTS through instrument
      tdMode   = isolated
      outcome  = yes/no
      ordType  = fok
      side     = buy

    speedBump is intentionally NOT sent.
    OKX removed the parameter in July 2026.
  */

  const body = {

    instId:
      inst.instId,

    tdMode:
      'isolated',

    side:
      'buy',

    ordType:
      'fok',

    px:
      px.toFixed(6),

    sz:
      String(
        size.sz
      ),

    outcome:
      candidate.side,

    clOrdId:
      `snr${Date.now().toString(36)}`
        .slice(
          0,
          32
        )
  };

  console.log(
    '[EVENT ORDER]',
    JSON.stringify(
      body
    )
  );

  /*
    PAPER
  */
  if (
    !LIVE_TRADING
  ) {

    return {

      ordId:
        `SIM-${Date.now()}`,

      state:
        'filled',

      avgPx:
        px,

      accFillSz:
        size.sz,

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
    rows?.[0];

  if (
    !result
  ) {

    throw new Error(
      'OKX returned empty order result'
    );
  }

  if (
    String(
      result.sCode
    ) !== '0'
  ) {

    throw new Error(
      `Order rejected: ${
        JSON.stringify(
          result
        )
      }`
    );
  }

  return result;
}

/* =========================================================
   ORDER DETAILS
========================================================= */

async function getOrder(
  instId,
  ordId
) {

  const requestPath =
    `/api/v5/trade/order?` +
    queryString({
      instId,
      ordId
    });

  const rows =
    await privateRequest(
      'GET',
      requestPath
    );

  return (
    rows?.[0] ||
    null
  );
}

/* =========================================================
   CANCEL ORDER
========================================================= */

async function cancelOrder(
  instId,
  ordId
) {

  const body = {

    instId,

    ordId
  };

  return privateRequest(
    'POST',
    '/api/v5/trade/cancel-order',
    body
  );
}

/* =========================================================
   CLOSE POSITION
========================================================= */

async function closePosition(
  position,
  currentPx
) {

  const inst =
    position.inst;

  const tickSz =
    Number(
      inst.tickSz
    ) || 0.001;

  const px =
    roundToTick(
      currentPx,
      tickSz
    );

  const body = {

    instId:
      inst.instId,

    tdMode:
      'isolated',

    side:
      'sell',

    ordType:
      'fok',

    px:
      px.toFixed(6),

    sz:
      String(
        position.sz
      ),

    outcome:
      position.side,

    clOrdId:
      `exit${Date.now().toString(36)}`
        .slice(
          0,
          32
        )
  };

  console.log(
    '[EVENT EXIT]',
    JSON.stringify(
      body
    )
  );

  if (
    !LIVE_TRADING
  ) {

    const pnl =
      (
        Number(
          currentPx
        ) -
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
    rows?.[0];

  if (
    !result
  ) {

    throw new Error(
      'Empty EXIT response'
    );
  }

  if (
    String(
      result.sCode
    ) !== '0'
  ) {

    throw new Error(
      `Exit rejected: ${
        JSON.stringify(
          result
        )
      }`
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

  const position =
    state.position;

  try {

    /*
      Check expiry first.
    */
    const mins =
      position.expiry
        ? (
            position.expiry -
            Date.now()
          ) /
          60000
        : null;

    if (
      Number.isFinite(
        mins
      ) &&
      mins <= 0
    ) {

      console.log(
        '[EVENT] Position reached expiry'
      );

      return;
    }

    const ticker =
      await getTicker(
        position.inst.instId,
        'EVENTS'
      );

    const yesBid =
      getYesBid(
        ticker
      );

    if (
      !Number.isFinite(
        yesBid
      )
    ) {

      return;
    }

    /*
      YES:
        current = YES bid

      NO:
        current = 1 - YES ask approximation.

      For safety, use the same YES reference
      used by OKX's public EVENTS market data.
    */
    let currentPx;

    if (
      position.side ===
      'yes'
    ) {

      currentPx =
        yesBid;

    } else {

      currentPx =
        1 -
        yesBid;
    }

    if (
      !(
        currentPx > 0 &&
        currentPx < 1
      )
    ) {

      return;
    }

    const change =
      (
        currentPx -
        position.entryPx
      ) /
      position.entryPx;

    console.log(
      `[EVENT POSITION] ` +
      `${position.inst.instId} ` +
      `${position.side} ` +
      `entry=${position.entryPx.toFixed(4)} ` +
      `current=${currentPx.toFixed(4)} ` +
      `change=${(change * 100).toFixed(2)}%`
    );

    if (
      change >=
      EARLY_TP_PCT
    ) {

      await exitPosition(
        position,
        currentPx,
        'TP'
      );

      return;
    }

    if (
      change <=
      -EARLY_SL_PCT
    ) {

      await exitPosition(
        position,
        currentPx,
        'SL'
      );
    }

  } catch (err) {

    console.error(
      '[POSITION MANAGER]',
      err.message
    );
  }
}

/* =========================================================
   EXIT
========================================================= */

async function exitPosition(
  position,
  currentPx,
  reason
) {

  const result =
    await closePosition(
      position,
      currentPx
    );

  const exitPx =
    Number(
      result?.avgPx ||
      currentPx
    );

  const exitSz =
    Number(
      result?.accFillSz ||
      result?.fillSz ||
      position.sz
    );

  const pnl =
    (
      exitPx -
      position.entryPx
    ) *
    exitSz;

  state.realizedPnl +=
    pnl;

  if (
    !LIVE_TRADING
  ) {

    state.paperEquity =
      Math.max(
        0,
        Number(
          state.paperEquity ||
          START_CAPITAL
        ) +
        pnl
      );
  }

  if (
    pnl < 0
  ) {

    state.consecutiveLosses++;

  } else {

    state.consecutiveLosses =
      0;
  }

  state.trades.push({

    at:
      new Date()
        .toISOString(),

    instId:
      position.inst.instId,

    side:
      position.side,

    entryPx:
      position.entryPx,

    exitPx,

    sz:
      exitSz,

    requestedStake:
      position.requestedStake,

    actualStake:
      position.actualStake,

    pnl,

    reason
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

  saveState();

  await notify(
    `${pnl >= 0 ? '🟢' : '🔴'} EVENT EXIT\n` +
    `${position.inst.instId}\n` +
    `${position.side.toUpperCase()}\n` +
    `Reason ${reason}\n` +
    `Entry ${position.entryPx.toFixed(4)}\n` +
    `Exit ${exitPx.toFixed(4)}\n` +
    `Contracts ${exitSz}\n` +
    `PnL ${
      pnl >= 0
        ? '+'
        : ''
    }${pnl.toFixed(4)}U\n` +
    `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
  );
}

/* =========================================================
   TRADE
========================================================= */

async function maybeTrade() {

  if (
    riskBlocked()
  ) {

    return;
  }

  if (
    state.position
  ) {

    return;
  }

  let equity;

  try {

    equity =
      await getEquity();

  } catch (err) {

    console.error(
      '[EQUITY]',
      err.message
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

  const dailyLossLimit =
    Math.max(
      START_CAPITAL,
      equity
    ) *
    DAILY_LOSS_PCT;

  if (
    state.realizedPnl <=
    -dailyLossLimit
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

  let candidates;

  try {

    candidates =
      await scanCandidates();

  } catch (err) {

    console.error(
      '[SCAN]',
      err.message
    );

    return;
  }

  if (
    !candidates.length
  ) {

    return;
  }

  const candidate =
    candidates[0];

  const calculatedStake =
    stakeForEquity(
      equity
    );

  const stake =
    Math.min(
      calculatedStake,
      equity
    );

  if (
    stake <= 0
  ) {

    return;
  }

  try {

    console.log(
      '----------------------------------------'
    );

    console.log(
      '[EVENT CANDIDATE]',
      candidate.inst.instId
    );

    console.log(
      '[EVENT SIDE]',
      candidate.side
    );

    console.log(
      '[EVENT ENTRY]',
      candidate.entryPx
    );

    console.log(
      '[EVENT SCORE]',
      candidate.score
    );

    console.log(
      '[EVENT MODEL]',
      candidate.modelProb
    );

    console.log(
      '[EVENT MARKET]',
      candidate.marketProb
    );

    console.log(
      '[EVENT EDGE]',
      candidate.edge
    );

    console.log(
      '[EVENT REQUESTED STAKE]',
      stake
    );

    const order =
      await placeEventOrder(
        candidate,
        stake
      );

    let filled =
      order;

    /*
      FOK should either fill fully
      or not fill.

      Still query actual exchange result
      before creating position.
    */
    if (
      LIVE_TRADING &&
      order.ordId
    ) {

      await sleep(
        700
      );

      filled =
        await getOrder(
          candidate.inst.instId,
          order.ordId
        );
    }

    const requestedSize =
      calculateOrderSize(
        stake,
        candidate.entryPx,
        candidate.inst
      );

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
        candidate.entryPx
      );

    /*
      CRITICAL:
      Never create a position from
      an abnormal tiny fill.
    */
    if (
      !(
        fillSz > 0
      )
    ) {

      console.log(
        '[EVENT] NO FILL'
      );

      return;
    }

    if (
      !requestedSize.ok
    ) {

      console.log(
        '[EVENT] SIZE INVALID AFTER ORDER'
      );

      return;
    }

    const minimumAcceptedFill =
      requestedSize.sz *
      0.99;

    if (
      fillSz <
      minimumAcceptedFill
    ) {

      console.error(
        `[EVENT] PARTIAL FILL REJECTED ` +
        `requested=${requestedSize.sz} ` +
        `filled=${fillSz}`
      );

      /*
        If an unexpected partial fill somehow
        occurs, do not pretend it is a full
        position.
      */
      if (
        LIVE_TRADING &&
        order.ordId
      ) {

        try {

          await cancelOrder(
            candidate.inst.instId,
            order.ordId
          );

        } catch (
          cancelErr
        ) {

          console.error(
            '[EVENT CANCEL]',
            cancelErr.message
          );
        }
      }

      await notify(
        `⚠️ EVENT PARTIAL FILL REJECTED\n` +
        `${candidate.inst.instId}\n` +
        `Side ${candidate.side.toUpperCase()}\n` +
        `Requested ${requestedSize.sz}\n` +
        `Filled ${fillSz}\n` +
        `Requested ${stake.toFixed(4)}U`
      );

      return;
    }

    const actualStake =
      avgPx *
      fillSz;

    /*
      Extra protection:
      actual fill cannot be wildly different
      from requested stake.
    */
    if (
      actualStake >
      stake *
      1.03
    ) {

      console.error(
        `[EVENT] ACTUAL STAKE TOO HIGH ` +
        `requested=${stake} ` +
        `actual=${actualStake}`
      );

      return;
    }

    /*
      Create actual position only after
      actual exchange fill verification.
    */
    state.position = {

      inst:
        candidate.inst,

      seriesId:
        candidate.seriesId,

      coin:
        candidate.coin,

      side:
        candidate.side,

      sz:
        fillSz,

      entryPx:
        avgPx,

      requestedStake:
        stake,

      actualStake,

      score:
        candidate.score,

      edge:
        candidate.edge,

      modelProb:
        candidate.modelProb,

      marketProb:
        candidate.marketProb,

      underlyingPrice:
        candidate.underlyingPrice,

      expiry:
        candidate.expiry,

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
      `Contracts ${fillSz}\n` +
      `Requested ${stake.toFixed(4)}U\n` +
      `Actual ${actualStake.toFixed(4)}U\n` +
      `Score ${candidate.score}\n` +
      `Model ${
        (
          candidate.modelProb *
          100
        ).toFixed(1)
      }%\n` +
      `Market ${
        (
          candidate.marketProb *
          100
        ).toFixed(1)
      }%\n` +
      `Edge ${
        (
          candidate.edge *
          100
        ).toFixed(1)
      }%\n` +
      `Reason ${
        candidate.reasons.join(
          ', '
        )
      }\n` +
      `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
    );

  } catch (err) {

    console.error(
      '[EVENT ORDER ERROR]',
      err.message
    );

    await notify(
      `🔴 EVENT ORDER ERROR\n` +
      `${candidate?.inst?.instId || 'UNKNOWN'}\n` +
      `${err.message}`
    );
  }
}

/* =========================================================
   HTTP
========================================================= */

app.get(
  '/',
  (req, res) => {

    res.json({

      ok:
        true,

      bot:
        'OKX EVENT CONTRACT SNR ROLLING BOT',

      product:
        'EVENTS',

      live:
        LIVE_TRADING,

      baseUrl:
        BASE_URL,

      eventSeries:
        getSeriesList(),

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

              contracts:
                state.position
                  .sz,

              requestedStake:
                state.position
                  .requestedStake,

              actualStake:
                state.position
                  .actualStake
            }

          : null,

      halted:
        state.halted,

      consecutiveLosses:
        state.consecutiveLosses,

      realizedPnl:
        state.realizedPnl
    });
  }
);

app.get(
  '/health',
  (req, res) => {

    res.json({

      ok:
        true,

      live:
        LIVE_TRADING,

      product:
        'EVENTS',

      time:
        new Date()
          .toISOString()
    });
  }
);

app.get(
  '/status',
  (req, res) => {

    res.json({

      ok:
        true,

      live:
        LIVE_TRADING,

      product:
        'EVENTS',

      baseUrl:
        BASE_URL,

      series:
        getSeriesList(),

      riskPct:
        RISK_PCT,

      maxStakePct:
        MAX_STAKE_PCT,

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
      },

      trades:
        state.trades.length
    });
  }
);

/* =========================================================
   EVENT DEBUG
========================================================= */

app.get(
  '/event-discovery',
  async (req, res) => {

    const result = [];

    for (
      const seriesId of
        getSeriesList()
    ) {

      try {

        const instruments =
          await getEventInstruments(
            seriesId
          );

        result.push({

          seriesId,

          ok:
            true,

          count:
            instruments.length,

          instruments:
            instruments
              .slice(
                0,
                50
              )
              .map(
                x => ({

                  instId:
                    x.instId,

                  seriesId:
                    x.seriesId,

                  state:
                    x.state,

                  expTime:
                    x.expTime,

                  lotSz:
                    x.lotSz,

                  minSz:
                    x.minSz,

                  tickSz:
                    x.tickSz
                })
              )
        });

      } catch (err) {

        result.push({

          seriesId,

          ok:
            false,

          error:
            err.message
        });
      }
    }

    res.json({

      ok:
        true,

      results:
        result
    });
  }
);

/* =========================================================
   SERVER
========================================================= */

app.listen(
  PORT,
  async () => {

    console.log(
      '=========================================='
    );

    console.log(
      'OKX EVENT CONTRACT BOT'
    );

    console.log(
      '=========================================='
    );

    console.log(
      `Port=${PORT}`
    );

    console.log(
      `LIVE_TRADING=${LIVE_TRADING}`
    );

    console.log(
      `BASE_URL=${BASE_URL}`
    );

    console.log(
      `SERIES=${getSeriesList().join(', ')}`
    );

    console.log(
      `MIN_EDGE=${MIN_EDGE}`
    );

    console.log(
      `MIN_SCORE=${MIN_SCORE}`
    );

    console.log(
      `RISK_PCT=${RISK_PCT}`
    );

    console.log(
      `MAX_STAKE_PCT=${MAX_STAKE_PCT}`
    );

    console.log(
      `MIN_STAKE=${MIN_STAKE}`
    );

    console.log(
      '=========================================='
    );

    /*
      Server time test.
    */
    try {

      const rows =
        await publicGet(
          '/api/v5/public/time'
        );

      const ts =
        Number(
          rows?.[0]?.ts
        );

      if (
        Number.isFinite(
          ts
        )
      ) {

        console.log(
          '[OKX] Server time:',
          new Date(
            ts
          ).toISOString()
        );
      }

    } catch (err) {

      console.error(
        '[OKX TIME]',
        err.message
      );
    }

    /*
      Test EVENTS series access.
    */
    try {

      const series =
        getSeriesList();

      const first =
        series[0];

      const instruments =
        await getEventInstruments(
          first
        );

      console.log(
        `[EVENT] ${first}: ${instruments.length} instruments`
      );

    } catch (err) {

      console.error(
        '[EVENT STARTUP CHECK]',
        err.message
      );
    }

    console.log(
      '=========================================='
    );
  }
);

/* =========================================================
   LOOPS
========================================================= */

setInterval(
  async () => {

    try {

      await managePosition();

    } catch (err) {

      console.error(
        '[POSITION LOOP]',
        err.message
      );
    }

  },
  POSITION_CHECK_INTERVAL
);

setInterval(
  async () => {

    try {

      if (
        !state.position
      ) {

        await maybeTrade();
      }

    } catch (err) {

      console.error(
        '[MAIN LOOP]',
        err.message
      );
    }

  },
  CHECK_INTERVAL
);

/*
  Initial scan.
*/
(async () => {

  try {

    await managePosition();

    if (
      !state.position
    ) {

      await maybeTrade();
    }

  } catch (err) {

    console.error(
      '[INITIAL LOOP]',
      err.message
    );
  }

})();
