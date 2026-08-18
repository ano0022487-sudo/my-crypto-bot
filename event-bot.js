'use strict';

/*
  ============================================================
  OKX EVENT CONTRACT SNR ROLLING BOT
  ============================================================

  Product:
    OKX EVENT CONTRACTS

  Current OKX EVENTS architecture:
    /api/v5/public/instruments
      ?instType=EVENTS
      &seriesId=<seriesId>

  Default series:
    BTC-UPDOWN-15MIN
    ETH-UPDOWN-15MIN
    SOL-UPDOWN-15MIN

  IMPORTANT:
    LIVE_TRADING=false by default.

  Required ENV:
    OK_ACCESS_KEY
    OK_ACCESS_SECRET
    OKX_PASSPHRASE

  Optional ENV:
    LIVE_TRADING
    EVENT_SERIES
    AUTO_DISCOVER_SERIES

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

const PORT =
  Number(process.env.PORT || 3000);

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

/*
  Taiwan production OKX API.
*/
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
  Math.max(
    5000,
    Number(
      process.env.CHECK_INTERVAL || 15000
    )
  );

const POSITION_CHECK_INTERVAL =
  Math.max(
    3000,
    Number(
      process.env.POSITION_CHECK_INTERVAL || 5000
    )
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

/*
  Keep this variable for compatibility,
  but discovery no longer depends on the broken
  event-series endpoints.
*/
const AUTO_DISCOVER_SERIES =
  String(
    process.env.AUTO_DISCOVER_SERIES || 'true'
  ).toLowerCase() === 'true';

const BOT_STATE_FILE =
  process.env.BOT_STATE_FILE ||
  path.join(
    __dirname,
    'event-bot-state.json'
  );

/* =========================================================
   DEFAULT EVENT SERIES
========================================================= */

/*
  These correspond to the Event Contract family
  used by the bot.

  The actual tradable instruments are discovered
  from:

    GET /api/v5/public/instruments
      ?instType=EVENTS
      &seriesId=<seriesId>
*/

const DEFAULT_SERIES = [
  'BTC-UPDOWN-15MIN',
  'ETH-UPDOWN-15MIN',
  'SOL-UPDOWN-15MIN'
];

/*
  Optional 5-minute series.

  Disabled by default.
  Add through EVENT_SERIES if needed.
*/
const OPTIONAL_SERIES = [
  'BTC-UPDOWN-5MIN',
  'ETH-UPDOWN-5MIN',
  'SOL-UPDOWN-5MIN'
];

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
  Telegram polling errors should not kill
  the trading process.
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
      '[Telegram]',
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

function q(params) {

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

function safeNumber(
  value,
  fallback = null
) {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
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

  const query =
    q(params);

  const requestPath =
    query
      ? `${pathname}?${query}`
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

  return response.data.data;
}

/* =========================================================
   OKX SIGNATURE
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
   OKX PRIVATE API
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

  return Array.isArray(
    response.data.data
  )
    ? response.data.data
    : [];
}

/* =========================================================
   SERVER TIME
========================================================= */

async function getServerTime() {

  try {

    const rows =
      await publicGet(
        '/api/v5/public/time'
      );

    return Number(
      rows?.[0]?.ts ||
        Date.now()
    );

  } catch (_) {

    return Date.now();
  }
}

/* =========================================================
   STATE
========================================================= */

function freshState() {

  return {

    day:
      new Date()
        .toISOString()
        .slice(
          0,
          10
        ),

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
      '[State load]',
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
      '[State save]',
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
      .slice(
        0,
        10
      );

  if (
    state.day !==
    today
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
        String(x[8]) ===
        '1'
    );
}

function closes(
  candles
) {

  return candles
    .map(
      x =>
        Number(x[4])
    )
    .filter(
      Number.isFinite
    );
}

function highs(
  candles
) {

  return candles
    .map(
      x =>
        Number(x[2])
    )
    .filter(
      Number.isFinite
    );
}

function lows(
  candles
) {

  return candles
    .map(
      x =>
        Number(x[3])
    )
    .filter(
      Number.isFinite
    );
}

function volumes(
  candles
) {

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
    values.length <
      period
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
    i < values.length;
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

  const ranges = [];

  for (
    let i = 1;
    i < candles.length;
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

    const previousClose =
      Number(
        candles[i - 1][4]
      );

    ranges.push(
      Math.max(
        high - low,
        Math.abs(
          high -
            previousClose
        ),
        Math.abs(
          low -
            previousClose
        )
      )
    );
  }

  const recent =
    ranges.slice(
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

  const resistance =
    [];

  const support =
    [];

  for (
    let i =
      lookback;
    i <
      candles.length -
        lookback;
    i++
  ) {

    const highest =
      Math.max(
        ...h.slice(
          i -
            lookback,
          i +
            lookback +
            1
        )
      );

    const lowest =
      Math.min(
        ...l.slice(
          i -
            lookback,
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
    )[0] ||
    null;
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
    )[0] ||
    null;
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
  instType = null
) {

  const params = {
    instId
  };

  if (
    instType
  ) {
    params.instType =
      instType;
  }

  const rows =
    await publicGet(
      '/api/v5/market/ticker',
      params
    );

  return (
    rows?.[0] ||
    null
  );
}

/* =========================================================
   EVENT SERIES
========================================================= */

/*
  IMPORTANT:

  We intentionally DO NOT call:

    /api/v5/public/event-series
    /api/v5/public/series

  Your previous version was failing with 404.

  Instead, this bot uses the official EVENTS
  instruments endpoint directly with seriesId.
*/

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
      .filter(Boolean);
  }

  /*
    Default:
    the exact families used by your
    BTC / ETH / SOL UPDOWN 15MIN bot.
  */

  return [
    ...DEFAULT_SERIES
  ];
}

/* =========================================================
   EVENT INSTRUMENT DISCOVERY
========================================================= */

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

async function discoverEventSeries() {

  const series =
    getSeriesList();

  console.log(
    '[EVENT] Series candidates:',
    series
  );

  const valid =
    [];

  for (
    const seriesId of series
  ) {

    try {

      const instruments =
        await getEventInstruments(
          seriesId
        );

      if (
        Array.isArray(
          instruments
        ) &&
        instruments.length
      ) {

        console.log(
          `[EVENT] ${seriesId}: ${instruments.length} instruments`
        );

        valid.push(
          seriesId
        );

      } else {

        console.log(
          `[EVENT] ${seriesId}: 0 instruments`
        );
      }

    } catch (err) {

      console.error(
        `[EVENT] ${seriesId}:`,
        err.message
      );
    }

    await sleep(
      120
    );
  }

  if (
    !valid.length
  ) {

    throw new Error(
      'No valid EVENT series found. ' +
      'Check EVENT_SERIES and OKX region/API access.'
    );
  }

  return valid;
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
    const coin of Object.keys(
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
    const key of fields
  ) {

    const value =
      Number(
        inst[key]
      );

    if (
      Number.isFinite(
        value
      ) &&
      value > 0
    ) {
      return value;
    }
  }

  /*
    Example:
      SOL-UPDOWN-15MIN-260818-2115-2130

    UPDOWN contracts may not encode
    a strike directly.
  */
  return null;
}

/* =========================================================
   UP / DOWN
========================================================= */

function isUpDown(
  inst
) {

  return String(
    inst.instId || ''
  )
    .toUpperCase()
    .includes(
      'UPDOWN'
    );
}

/*
  For UPDOWN:

    YES = UP
    NO  = DOWN

  This matches the structure of your
  SOL-UPDOWN-15MIN contracts.
*/

function modelDirectionFor(
  inst,
  side
) {

  if (
    isUpDown(inst)
  ) {

    return side === 'yes'
      ? 'UPDOWN_UP'
      : 'UPDOWN_DOWN';
  }

  return 'UNKNOWN';
}

/* =========================================================
   ROUNDING
========================================================= */

function decimalsFor(
  step
) {

  const text =
    String(step);

  if (
    !text.includes('.')
  ) {
    return 0;
  }

  return Math.max(
    0,
    text.split('.')[1]
      .length
  );
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
    decimalsFor(
      step
    );

  return Number(
    (
      Math.floor(
        value / step
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
    decimalsFor(
      tick
    );

  return Number(
    (
      Math.round(
        value / tick
      ) *
      tick
    ).toFixed(
      decimals
    )
  );
}

/* =========================================================
   PRICE
========================================================= */

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

  let score =
    50;

  const reasons =
    [];

  /* -------------------------------------------------------
     BULLISH
  ------------------------------------------------------- */

  if (
    direction ===
      'UPDOWN_UP' ||
    direction ===
      'ABOVE'
  ) {

    if (
      ema20_5 &&
      ema50_5 &&
      ema20_5 >
        ema50_5
    ) {

      score +=
        10;

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

      score +=
        15;

      reasons.push(
        '15m trend'
      );
    }

    if (
      rsi5 !== null &&
      rsi5 >= 55 &&
      rsi5 <= 72
    ) {

      score +=
        10;

      reasons.push(
        'RSI'
      );
    }
  }

  /* -------------------------------------------------------
     BEARISH
  ------------------------------------------------------- */

  if (
    direction ===
      'UPDOWN_DOWN' ||
    direction ===
      'BELOW'
  ) {

    if (
      ema20_5 &&
      ema50_5 &&
      ema20_5 <
        ema50_5
    ) {

      score +=
        10;

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

      score +=
        15;

      reasons.push(
        '15m trend'
      );
    }

    if (
      rsi5 !== null &&
      rsi5 <= 45 &&
      rsi5 >= 28
    ) {

      score +=
        10;

      reasons.push(
        'RSI'
      );
    }
  }

  /* -------------------------------------------------------
     VOLUME
  ------------------------------------------------------- */

  if (
    volumeRatio >=
    1.15
  ) {

    score +=
      8;

    reasons.push(
      'volume'
    );
  }

  /* -------------------------------------------------------
     SNR
  ------------------------------------------------------- */

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
    (
      direction ===
        'UPDOWN_UP' ||
      direction ===
        'ABOVE'
    ) &&
    resistance &&
    price >=
      resistance *
        0.999
  ) {

    score +=
      8;

    reasons.push(
      'SNR resistance test'
    );
  }

  if (
    (
      direction ===
        'UPDOWN_DOWN' ||
      direction ===
        'BELOW'
    ) &&
    support &&
    price <=
      support *
        1.001
  ) {

    score +=
      8;

    reasons.push(
      'SNR support test'
    );
  }

  /* -------------------------------------------------------
     STRIKE
  ------------------------------------------------------- */

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
      direction ===
        'ABOVE' &&
      price >
        strikePx
    ) {

      score +=
        8;

      reasons.push(
        'above strike'
      );
    }

    if (
      direction ===
        'BELOW' &&
      price <
        strikePx
    ) {

      score +=
        8;

      reasons.push(
        'below strike'
      );
    }

    if (
      distance <
      0.0025
    ) {

      score -=
        10;

      reasons.push(
        'strike too close'
      );
    }
  }

  /* -------------------------------------------------------
     ATR
  ------------------------------------------------------- */

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
      score -=
        5;
    }

    if (
      atrPct >
      0.03
    ) {
      score -=
        8;
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
    Score mapping:

      50 = 50%
      78 = 66.8%
      80 = 68%
      90 = 74%
      100 = 80%

    This is a scoring model, NOT a guarantee.
  */

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

    reasons:
      reasons.length
        ? reasons
        : ['base model']
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

  const details =
    account?.details ||
    [];

  const usdt =
    details.find(
      x =>
        String(
          x.ccy
        ).toUpperCase() ===
        'USDT'
    );

  const equity =
    safeNumber(
      usdt?.eq
    );

  const available =
    safeNumber(
      usdt?.availBal
    );

  if (
    equity !== null &&
    equity > 0
  ) {
    return equity;
  }

  if (
    available !== null &&
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
    equity *
    RISK_PCT;

  const maximum =
    equity *
    MAX_STAKE_PCT;

  return Math.max(
    MIN_STAKE,
    Math.min(
      maximum,
      calculated
    )
  );
}

/* =========================================================
   EVENT TICKER
========================================================= */

async function getEventTicker(
  instId
) {

  /*
    EVENTS ticker.
    OKX returns YES-side market data.
  */

  return getTicker(
    instId,
    'EVENTS'
  );
}

/* =========================================================
   CANDIDATE
========================================================= */

function buildSideCandidate(
  inst,
  seriesId,
  coin,
  underlying,
  ticker,
  c5,
  c15,
  side,
  underlyingPrice
) {

  const yesAsk =
    safeNumber(
      ticker?.askPx
    );

  const yesBid =
    safeNumber(
      ticker?.bidPx
    );

  const yesLast =
    safeNumber(
      ticker?.last
    );

  /*
    Use ask for YES entry.
    If ask is unavailable, use last.
  */

  const yesEntry =
    yesAsk !== null &&
    yesAsk > 0
      ? yesAsk
      : yesLast;

  /*
    For NO:
      OKX public EVENTS market data
      returns YES side.
      NO = 1 - YES.
  */

  const noEntry =
    yesBid !== null &&
    yesBid > 0
      ? 1 -
        yesBid
      : (
          yesEntry !== null
            ? 1 -
              yesEntry
            : null
        );

  if (
    !validPrice(
      yesEntry
    ) &&
    !validPrice(
      noEntry
    )
  ) {
    return null;
  }

  const direction =
    modelDirectionFor(
      inst,
      side
    );

  if (
    direction ===
    'UNKNOWN'
  ) {
    return null;
  }

  const strikePx =
    getStrike(
      inst
    );

  const model =
    modelProbability(
      direction,
      underlyingPrice,
      strikePx,
      c5,
      c15
    );

  const modelProb =
    model.probability;

  let entryPx;

  if (
    side ===
    'yes'
  ) {
    entryPx =
      yesEntry;
  } else {
    entryPx =
      noEntry;
  }

  if (
    !validPrice(
      entryPx
    )
  ) {
    return null;
  }

  const marketProb =
    entryPx;

  const edge =
    modelProb -
    marketProb;

  return {

    inst,

    seriesId,

    coin,

    underlying,

    side,

    direction,

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
      getExpiry(inst),

    minutesToExpiry:
      minutesToExpiry(inst)
  };
}

/* =========================================================
   SCAN ONE SERIES
========================================================= */

async function scanSeries(
  seriesId
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

    return [];
  }

  if (
    !Array.isArray(
      instruments
    )
  ) {
    return [];
  }

  const candidates =
    [];

  for (
    const inst of instruments
  ) {

    try {

      const stateValue =
        String(
          inst.state ||
            ''
        ).toLowerCase();

      /*
        Only trade live instruments.
      */

      if (
        stateValue &&
        stateValue !==
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

      /*
        Underlying technical data.
      */

      const [
        ticker,
        c5,
        c15
      ] =
        await Promise.all([
          getEventTicker(
            inst.instId
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

      /*
        Evaluate YES and NO separately.

        For UPDOWN:
          YES -> UP
          NO  -> DOWN
      */

      const yesCandidate =
        buildSideCandidate(
          inst,
          seriesId,
          coin,
          underlying,
          ticker,
          c5,
          c15,
          'yes',
          underlyingPrice
        );

      const noCandidate =
        buildSideCandidate(
          inst,
          seriesId,
          coin,
          underlying,
          ticker,
          c5,
          c15,
          'no',
          underlyingPrice
        );

      if (
        yesCandidate &&
        yesCandidate.score >=
          MIN_SCORE &&
        yesCandidate.edge >=
          MIN_EDGE
      ) {

        candidates.push(
          yesCandidate
        );
      }

      if (
        noCandidate &&
        noCandidate.score >=
          MIN_SCORE &&
        noCandidate.edge >=
          MIN_EDGE
      ) {

        candidates.push(
          noCandidate
        );
      }

    } catch (err) {

      console.error(
        `[EVENT] Candidate ${inst.instId}:`,
        err.message
      );
    }
  }

  return candidates;
}

/* =========================================================
   SCAN ALL
========================================================= */

async function scanCandidates() {

  const series =
    await discoverEventSeries();

  let all =
    [];

  for (
    const seriesId of series
  ) {

    const candidates =
      await scanSeries(
        seriesId
      );

    all =
      all.concat(
        candidates
      );
  }

  return all.sort(
    (a, b) =>
      b.edge -
        a.edge ||
      b.score -
        a.score ||
      a.minutesToExpiry -
        b.minutesToExpiry
  );
}

/* =========================================================
   TICK BAND
========================================================= */

async function getEventTickBands() {

  try {

    const rows =
      await publicGet(
        '/api/v5/public/instrument-tick-bands',
        {
          instType:
            'EVENTS'
        }
      );

    return rows || [];

  } catch (err) {

    console.error(
      '[EVENT] Tick bands:',
      err.message
    );

    return [];
  }
}

function findTickSize(
  price,
  inst,
  bands
) {

  /*
    First prefer instrument tickSz.
  */

  const instTick =
    Number(
      inst.tickSz
    );

  /*
    Official docs say EVENTS tickSz
    should be interpreted together with
    tick bands for the accurate price range.
  */

  let best =
    null;

  for (
    const row of bands
  ) {

    const tickBands =
      row.tickBand ||
      row.tickBands ||
      [];

    for (
      const band of tickBands
    ) {

      const minPx =
        Number(
          band.minPx
        );

      const maxPx =
        Number(
          band.maxPx
        );

      const tickSz =
        Number(
          band.tickSz
        );

      if (
        Number.isFinite(
          tickSz
        ) &&
        (
          !Number.isFinite(
            minPx
          ) ||
          price >=
            minPx
        ) &&
        (
          !Number.isFinite(
            maxPx
          ) ||
          price <=
            maxPx
        )
      ) {

        best =
          tickSz;
      }
    }
  }

  if (
    best &&
    best > 0
  ) {
    return best;
  }

  if (
    instTick &&
    instTick > 0
  ) {
    return instTick;
  }

  return 0.001;
}

/* =========================================================
   ORDER SIZE
========================================================= */

function calculateOrderSize(
  stake,
  entryPx,
  inst
) {

  const lotSz =
    Number(
      inst.lotSz
    ) || 1;

  const minSz =
    Number(
      inst.minSz
    ) || lotSz;

  if (
    !(stake > 0) ||
    !(entryPx > 0)
  ) {
    throw new Error(
      'Invalid stake or entry price'
    );
  }

  /*
    EVENT quantity is contract count.

    Requested contracts =
      stake / price
  */

  const rawSize =
    stake /
    entryPx;

  let size =
    roundDown(
      rawSize,
      lotSz
    );

  /*
    Minimum exchange size.
  */

  if (
    size <
    minSz
  ) {
    size =
      minSz;
  }

  const actualNotional =
    size *
    entryPx;

  /*
    Do NOT silently increase an order
    far beyond requested stake.

    This prevents the old situation where
    the bot says 5U but exchange quantity
    behaves unexpectedly.
  */

  if (
    actualNotional >
    stake *
      1.05
  ) {

    throw new Error(
      `Minimum/order lot would exceed stake: ` +
      `requested=${stake.toFixed(4)} ` +
      `price=${entryPx.toFixed(4)} ` +
      `lotSz=${lotSz} ` +
      `minSz=${minSz} ` +
      `contracts=${size} ` +
      `notional=${actualNotional.toFixed(4)}`
    );
  }

  return {

    size,

    lotSz,

    minSz,

    requestedStake:
      stake,

    estimatedNotional:
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

  const tickBands =
    await getEventTickBands();

  const tickSz =
    findTickSize(
      candidate.entryPx,
      inst,
      tickBands
    );

  const px =
    roundToTick(
      candidate.entryPx,
      tickSz
    );

  const sizing =
    calculateOrderSize(
      stake,
      px,
      inst
    );

  const body = {

    instId:
      inst.instId,

    tdMode:
      'cash',

    side:
      'buy',

    ordType:
      'ioc',

    px:
      px.toFixed(
        6
      ),

    sz:
      String(
        sizing.size
      ),

    outcome:
      candidate.side,

    clOrdId:
      `snr${Date.now()
        .toString(36)}`
        .slice(
          0,
          32
        )

    /*
      IMPORTANT:

      Do NOT add speedBump.

      OKX removed it on 2026-07-24.
    */
  };

  console.log(
    '[EVENT ORDER]',
    JSON.stringify(
      body
    )
  );

  console.log(
    '[EVENT ORDER SIZING]',
    JSON.stringify(
      sizing
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
        sizing.size,

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
   ORDER QUERY
========================================================= */

async function getOrder(
  instId,
  ordId
) {

  const requestPath =
    `/api/v5/trade/order?` +
    q({
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
   CLOSE POSITION
========================================================= */

async function closePosition(
  position,
  currentPx
) {

  const inst =
    position.inst;

  const tickBands =
    await getEventTickBands();

  const tickSz =
    findTickSize(
      currentPx,
      inst,
      tickBands
    );

  const px =
    roundToTick(
      currentPx,
      tickSz
    );

  const body = {

    instId:
      inst.instId,

    tdMode:
      'cash',

    side:
      'sell',

    ordType:
      'ioc',

    px:
      px.toFixed(
        6
      ),

    sz:
      String(
        position.sz
      ),

    outcome:
      position.side,

    clOrdId:
      `exit${Date.now()
        .toString(36)}`
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

  /*
    PAPER
  */

  if (
    !LIVE_TRADING
  ) {

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
    !result ||
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

    const ticker =
      await getEventTicker(
        position.inst.instId
      );

    const yesBid =
      safeNumber(
        ticker?.bidPx
      );

    const yesLast =
      safeNumber(
        ticker?.last
      );

    const yesPrice =
      yesBid !== null &&
      yesBid > 0
        ? yesBid
        : yesLast;

    if (
      !(
        yesPrice > 0 &&
        yesPrice < 1
      )
    ) {
      return;
    }

    /*
      YES:
        current = YES bid

      NO:
        current = 1 - YES ask/bid reference

      Public EVENTS API provides YES side.
    */

    const currentPx =
      position.side ===
        'yes'
        ? yesPrice
        : 1 -
          yesPrice;

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
      `[POSITION] ${position.inst.instId} ` +
      `${position.side} ` +
      `entry=${position.entryPx.toFixed(4)} ` +
      `current=${currentPx.toFixed(4)} ` +
      `change=${(change * 100).toFixed(2)}%`
    );

    /*
      TAKE PROFIT
    */

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

    /*
      STOP LOSS
    */

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
      '[Position manager]',
      err.message
    );
  }
}

/* =========================================================
   EXIT POSITION
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
        result?.fillPx ||
        currentPx
    );

  const pnl =
    (
      exitPx -
      position.entryPx
    ) *
    position.sz;

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
      position.sz,

    stake:
      position.stake,

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

    `Contracts ${position.sz}\n` +

    `Stake ${position.stake.toFixed(4)}U\n` +

    `PnL ${
      pnl >= 0
        ? '+'
        : ''
    }${pnl.toFixed(4)}U\n` +

    `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
  );
}

/* =========================================================
   MAY TRADE
========================================================= */

async function maybeTrade() {

  if (
    riskBlocked()
  ) {
    return;
  }

  /*
    One position at a time.
  */

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
      '[Equity]',
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

  /*
    Daily loss.
  */

  const dailyLossLimit =
    Math.max(
      0.01,
      equity *
        DAILY_LOSS_PCT
    );

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
      '[Scan]',
      err.message
    );

    return;
  }

  if (
    !candidates.length
  ) {

    console.log(
      '[EVENT] No qualified candidate'
    );

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
    !(stake > 0)
  ) {
    return;
  }

  console.log(
    '======================================'
  );

  console.log(
    '[EVENT] BEST CANDIDATE'
  );

  console.log(
    'instId:',
    candidate.inst.instId
  );

  console.log(
    'series:',
    candidate.seriesId
  );

  console.log(
    'side:',
    candidate.side
  );

  console.log(
    'entry:',
    candidate.entryPx
  );

  console.log(
    'score:',
    candidate.score
  );

  console.log(
    'model:',
    candidate.modelProb
  );

  console.log(
    'market:',
    candidate.marketProb
  );

  console.log(
    'edge:',
    candidate.edge
  );

  console.log(
    'stake:',
    stake
  );

  console.log(
    '======================================'
  );

  try {

    /*
      Send order.
    */

    const order =
      await placeEventOrder(
        candidate,
        stake
      );

    let filled =
      order;

    /*
      LIVE:
      Wait and query actual order.
    */

    if (
      LIVE_TRADING &&
      order.ordId
    ) {

      await sleep(
        1000
      );

      filled =
        await getOrder(
          candidate.inst.instId,
          order.ordId
        );
    }

    /*
      IMPORTANT:
      Always use actual exchange fill.
    */

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
      For PAPER we know our simulated size.
    */

    const finalSize =
      fillSz > 0
        ? fillSz
        : (
            !LIVE_TRADING
              ? Number(
                  filled?.accFillSz ||
                    0
                )
              : 0
          );

    if (
      !(finalSize > 0)
    ) {

      console.log(
        '[EVENT] Order did not fill.'
      );

      await notify(
        `⚪ EVENT NO FILL\n` +
        `${candidate.inst.instId}\n` +
        `${candidate.side.toUpperCase()}\n` +
        `Requested ${stake.toFixed(4)}U\n` +
        `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
      );

      return;
    }

    /*
      Actual capital used.

      For EVENTS:
        contracts × price
    */

    const actualStake =
      avgPx *
      finalSize;

    /*
      This is the critical fix for your
      previous "5U requested but 0.1U actual"
      confusion.

      The bot records exactly what OKX
      actually filled.
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
        finalSize,

      entryPx:
        avgPx,

      stake:
        actualStake,

      requestedStake:
        stake,

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
        Date.now(),

      ordId:
        order.ordId ||
        null
    };

    state.lastTradeAt =
      Date.now();

    saveState();

    await notify(

      `🟡 EVENT ENTRY\n` +

      `${candidate.inst.instId}\n` +

      `${candidate.side.toUpperCase()}\n` +

      `Entry ${avgPx.toFixed(4)}\n` +

      `Contracts ${finalSize}\n` +

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
      '[Trade]',
      err.message
    );

    await notify(
      `🔴 EVENT ORDER ERROR\n` +
      `${candidate.inst.instId}\n` +
      `${err.message}`
    );
  }
}

/* =========================================================
   HTTP ROOT
========================================================= */

app.get(
  '/',
  (req, res) => {

    res.json({

      ok:
        true,

      bot:
        'OKX Event Contract SNR Rolling Bot',

      product:
        'EVENTS',

      live:
        LIVE_TRADING,

      baseUrl:
        BASE_URL,

      series:
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

              stake:
                state.position
                  .stake,

              requestedStake:
                state.position
                  .requestedStake
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

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',
  async (
    req,
    res
  ) => {

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

/* =========================================================
   STATUS
========================================================= */

app.get(
  '/status',
  (
    req,
    res
  ) => {

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

      minStake:
        MIN_STAKE,

      minEdge:
        MIN_EDGE,

      minScore:
        MIN_SCORE,

      minEntryPrice:
        MIN_ENTRY_PRICE,

      maxEntryPrice:
        MAX_ENTRY_PRICE,

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
   EVENT DISCOVERY DEBUG
========================================================= */

app.get(
  '/event-discovery',
  async (
    req,
    res
  ) => {

    try {

      const series =
        await discoverEventSeries();

      const result =
        [];

      for (
        const seriesId of series
      ) {

        try {

          const instruments =
            await getEventInstruments(
              seriesId
            );

          result.push({

            seriesId,

            count:
              Array.isArray(
                instruments
              )
                ? instruments.length
                : 0,

            instruments:
              (
                Array.isArray(
                  instruments
                )
                  ? instruments
                  : []
              )
                .slice(
                  0,
                  20
                )
                .map(
                  inst => ({

                    instId:
                      inst.instId,

                    seriesId:
                      inst.seriesId,

                    state:
                      inst.state,

                    expTime:
                      inst.expTime,

                    lotSz:
                      inst.lotSz,

                    minSz:
                      inst.minSz,

                    tickSz:
                      inst.tickSz,

                    stk:
                      inst.stk,

                    ruleType:
                      inst.ruleType
                  })
                )
          });

        } catch (err) {

          result.push({

            seriesId,

            error:
              err.message
          });
        }
      }

      res.json({

        ok:
          true,

        baseUrl:
          BASE_URL,

        result
      });

    } catch (err) {

      res.status(
        500
      ).json({

        ok:
          false,

        error:
          err.message,

        series:
          getSeriesList()
      });
    }
  }
);

/* =========================================================
   EVENT SCAN DEBUG
========================================================= */

app.get(
  '/event-scan',
  async (
    req,
    res
  ) => {

    try {

      const candidates =
        await scanCandidates();

      res.json({

        ok:
          true,

        count:
          candidates.length,

        candidates:
          candidates
            .slice(
              0,
              20
            )
            .map(
              c => ({

                instId:
                  c.inst.instId,

                seriesId:
                  c.seriesId,

                coin:
                  c.coin,

                side:
                  c.side,

                entry:
                  c.entryPx,

                score:
                  c.score,

                model:
                  c.modelProb,

                market:
                  c.marketProb,

                edge:
                  c.edge,

                expiry:
                  c.minutesToExpiry,

                reason:
                  c.reasons
              })
            )
      });

    } catch (err) {

      res.status(
        500
      ).json({

        ok:
          false,

        error:
          err.message
      });
    }
  }
);

/* =========================================================
   MANUAL RESET RISK
========================================================= */

app.post(
  '/reset-risk',
  (
    req,
    res
  ) => {

    state.halted =
      false;

    state.consecutiveLosses =
      0;

    state.realizedPnl =
      0;

    saveState();

    res.json({

      ok:
        true,

      halted:
        state.halted,

      consecutiveLosses:
        state.consecutiveLosses,

      realizedPnl:
        state.realizedPnl
    });
  }
);

/* =========================================================
   MAIN LOOP
========================================================= */

let loopRunning =
  false;

async function mainLoop() {

  if (
    loopRunning
  ) {
    return;
  }

  loopRunning =
    true;

  try {

    resetDaily();

    await managePosition();

    if (
      !state.position
    ) {

      await maybeTrade();
    }

  } catch (err) {

    console.error(
      '[MAIN LOOP]',
      err.message ||
        err
    );

  } finally {

    loopRunning =
      false;
  }
}

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  async () => {

    console.log(
      '======================================'
    );

    console.log(
      'OKX EVENT CONTRACT BOT'
    );

    console.log(
      '======================================'
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
      `AUTO_DISCOVER_SERIES=${AUTO_DISCOVER_SERIES}`
    );

    console.log(
      `EVENT_SERIES=${
        EVENT_SERIES ||
        '(default BTC/ETH/SOL UPDOWN 15MIN)'
      }`
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
      '======================================'
    );

    /*
      OKX server time.
    */

    try {

      const serverTime =
        await getServerTime();

      console.log(
        '[OKX] Server time:',
        new Date(
          serverTime
        ).toISOString()
      );

    } catch (err) {

      console.error(
        '[OKX] Time:',
        err.message
      );
    }

    /*
      Do an initial discovery check.

      This DOES NOT place an order.
    */

    try {

      const series =
        await discoverEventSeries();

      console.log(
        '[EVENT] Initial discovery OK:',
        series
      );

    } catch (err) {

      console.error(
        '[EVENT] Initial discovery:',
        err.message
      );
    }
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

/* =========================================================
   INITIAL RUN
========================================================= */

mainLoop().catch(
  err =>
    console.error(
      '[Initial loop]',
      err
    )
);
