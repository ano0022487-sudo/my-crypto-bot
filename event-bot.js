'use strict';

/*
  OKX EVENT CONTRACT SNR BOT
  ===========================

  FIXED FOR CURRENT OKX EVENT CONTRACT API

  IMPORTANT:
  - EVENTS order tdMode = isolated
  - outcome = yes / no
  - speedBump is NOT sent
  - Event discovery:
      /api/v5/public/event-contract/series
      /api/v5/public/event-contract/events
      /api/v5/public/event-contract/markets
  - Instrument discovery:
      /api/v5/public/instruments?instType=EVENTS&seriesId=...
  - Event market data:
      /api/v5/market/ticker?instType=EVENTS&instId=...
  - Order:
      POST /api/v5/trade/order

  LIVE_TRADING=false by default.
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
  Taiwan normal OKX API:
  https://openapi.okx.com

  Can be overridden by ENV.
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
    process.env.MAX_MINUTES_TO_EXPIRY || 180
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

let bot = null;

if (TELEGRAM_BOT_TOKEN) {
  try {
    bot = new TelegramBot(
      TELEGRAM_BOT_TOKEN,
      {
        polling: true
      }
    );

    bot.on(
      'polling_error',
      err => {
        console.error(
          '[Telegram polling]',
          err.message
        );
      }
    );

    /*
      Telegram commands are optional.
      Trading notifications do NOT depend
      on /start.
    */
    bot.onText(
      /\/status/,
      async msg => {

        const chatId =
          String(msg.chat.id);

        try {
          await bot.sendMessage(
            chatId,
            JSON.stringify(
              getStatusObject(),
              null,
              2
            )
          );
        } catch (err) {
          console.error(
            '[Telegram status]',
            err.message
          );
        }
      }
    );

    console.log(
      '[Telegram] polling started'
    );

  } catch (err) {
    console.error(
      '[Telegram init]',
      err.message
    );
  }
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
   UTILS
========================================================= */

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

function q(params) {

  return Object.entries(params)
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
   PUBLIC API
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
      ? JSON.stringify(bodyObj)
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
   CANDLE INDICATORS
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
        (
          1 -
          multiplier
        );
  }

  return value;
}

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

    const prevClose =
      Number(
        candles[i - 1][4]
      );

    ranges.push(
      Math.max(
        high - low,
        Math.abs(
          high -
          prevClose
        ),
        Math.abs(
          low -
          prevClose
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
        String(
          x[8]
        ) === '1'
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
    let i =
      lookback;
    i <
      candles.length -
      lookback;
    i++
  ) {

    const localHigh =
      Math.max(
        ...h.slice(
          i -
            lookback,
          i +
            lookback +
            1
        )
      );

    const localLow =
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
      localHigh
    ) {
      resistance.push(
        h[i]
      );
    }

    if (
      l[i] ===
      localLow
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
   EVENT DISCOVERY
========================================================= */

/*
  IMPORTANT:

  Correct endpoint:
    /api/v5/public/event-contract/series

  NOT:
    /api/v5/public/event-series
    /api/v5/public/series
*/

async function discoverEventSeries() {

  if (
    EVENT_SERIES
  ) {

    const configured =
      EVENT_SERIES
        .split(',')
        .map(
          x =>
            x.trim()
        )
        .filter(Boolean);

    console.log(
      '[EVENT] Configured series:',
      configured
    );

    return configured;
  }

  if (
    !AUTO_DISCOVER_SERIES
  ) {

    return [];
  }

  const rows =
    await publicGet(
      '/api/v5/public/event-contract/series',
      {}
    );

  let list = [];

  if (
    Array.isArray(rows)
  ) {
    list = rows;
  } else if (
    rows &&
    Array.isArray(
      rows.data
    )
  ) {
    list =
      rows.data;
  } else if (
    rows &&
    Array.isArray(
      rows.series
    )
  ) {
    list =
      rows.series;
  }

  const result =
    list
      .map(
        row =>
          row.seriesId ||
          row.seriesID ||
          row.id ||
          row.series ||
          null
      )
      .filter(Boolean);

  console.log(
    '[EVENT] Series discovered:',
    result.length
  );

  return result;
}

/* =========================================================
   EVENT INSTRUMENTS
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

/* =========================================================
   EVENT HELPERS
========================================================= */

function getBaseAsset(
  inst
) {

  const text =
    (
      `${inst.baseCcy || ''} ` +
      `${inst.instId || ''} ` +
      `${inst.seriesId || ''} ` +
      `${inst.uly || ''}`
    ).toUpperCase();

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

  const candidates = [
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
    !candidates.length
  ) {
    return null;
  }

  return Math.max(
    ...candidates
  );
}

function minutesToExpiry(
  inst
) {

  const expiry =
    getExpiry(inst);

  if (
    !expiry
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
    (
      `${inst.seriesId || ''} ` +
      `${inst.instId || ''} ` +
      `${inst.ruleType || ''}`
    ).toUpperCase();

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
    )
  ) {
    return 'ABOVE';
  }

  if (
    text.includes(
      'BELOW'
    )
  ) {
    return 'BELOW';
  }

  if (
    text.includes(
      'UP'
    )
  ) {
    return 'ABOVE';
  }

  if (
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
    const field of
    fields
  ) {

    const value =
      Number(
        inst[field]
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

  return null;
}

/* =========================================================
   PRICE ROUNDING
========================================================= */

function decimalsForStep(
  step
) {

  const str =
    String(step);

  if (
    !str.includes('.')
  ) {
    return 0;
  }

  return (
    str.split('.')[1] ||
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
    decimalsForStep(
      step
    );

  return Number(
    (
      Math.floor(
        value / step
      ) * step
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
    decimalsForStep(
      tick
    );

  return Number(
    (
      Math.round(
        value / tick
      ) * tick
    ).toFixed(
      decimals
    )
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
    direction === 'ABOVE' ||
    direction === 'UPDOWN_UP';

  const bearish =
    direction === 'BELOW' ||
    direction === 'UPDOWN_DOWN';

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
      rsi5 <= 45 &&
      rsi5 >= 28
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

  const p5 =
    pivots(c5);

  const p15 =
    pivots(c15);

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

  const details =
    account?.details ||
    [];

  const usdt =
    details.find(
      x =>
        x.ccy ===
        'USDT'
    );

  const equity =
    Number(
      usdt?.eq
    );

  const available =
    Number(
      usdt?.availBal
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
      maximum,
      calculated
    )
  );
}

/* =========================================================
   EVENT CANDIDATE
========================================================= */

function priceValid(
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
   SCAN
========================================================= */

async function scanCandidates() {

  const series =
    await discoverEventSeries();

  const candidates = [];

  console.log(
    `[EVENT] scanning ${series.length} series`
  );

  for (
    const seriesId of
    series
  ) {

    let instruments;

    try {

      instruments =
        await getEventInstruments(
          seriesId
        );

    } catch (err) {

      console.error(
        `[EVENT] instruments ${seriesId}:`,
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

        const stateName =
          String(
            inst.state ||
            ''
          ).toLowerCase();

        if (
          stateName &&
          ![
            'live',
            'preopen'
          ].includes(
            stateName
          )
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
          Number(
            eventTicker?.askPx
          );

        const yesBid =
          Number(
            eventTicker?.bidPx
          );

        const yesLast =
          Number(
            eventTicker?.last
          );

        /*
          For EVENT markets,
          OKX returns YES-side
          market data.
        */
        const yesEntry =
          yesAsk > 0
            ? yesAsk
            : yesLast;

        const yesExit =
          yesBid > 0
            ? yesBid
            : yesLast;

        if (
          !priceValid(
            yesEntry
          )
        ) {
          continue;
        }

        if (
          !(
            yesExit > 0 &&
            yesExit < 1
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
            NO = DOWN
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

        const yesModelProb =
          model.probability;

        const noModelProb =
          1 -
          yesModelProb;

        const yesMarketProb =
          yesEntry;

        /*
          NO price derived from
          YES bid.

          This follows OKX's
          EVENTS market-data rule.
        */
        const noEntry =
          1 -
          yesExit;

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
            yesEntry;

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
          !priceValid(
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
          `[EVENT] candidate ${inst.instId}:`,
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
   EVENT ORDER
========================================================= */

async function placeEventOrder(
  candidate,
  stake
) {

  const inst =
    candidate.inst;

  /*
    EVENT contract quantity
    is number of contracts.

    Stake ≈ price × contracts
  */
  const lotSz =
    Number(
      inst.lotSz ||
      1
    );

  const minSz =
    Number(
      inst.minSz ||
      lotSz
    );

  let sz =
    roundDown(
      stake /
      candidate.entryPx,
      lotSz
    );

  if (
    sz < minSz
  ) {
    sz =
      minSz;
  }

  const tickSz =
    Number(
      inst.tickSz ||
      0.001
    );

  const px =
    roundToTick(
      candidate.entryPx,
      tickSz
    );

  const actualNotional =
    px *
    sz;

  /*
    Prevent accidental
    oversized order.
  */
  if (
    actualNotional >
    stake *
    1.03
  ) {

    throw new Error(
      `Order exceeds stake: ` +
      `stake=${stake.toFixed(4)} ` +
      `notional=${actualNotional.toFixed(4)}`
    );
  }

  /*
    =====================================================
    CRITICAL OKX EVENT CONTRACT FIX
    =====================================================

    tdMode MUST be isolated.

    cash -> 51000
    isolated -> correct for EVENTS

    speedBump is deliberately omitted.
    OKX removed it on 2026-07-24.
  */
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
      px.toFixed(6),

    sz:
      String(sz),

    outcome:
      candidate.side,

    clOrdId:
      `snr${Date.now().toString(36)}`
        .replace(
          /[^a-zA-Z0-9]/g,
          ''
        )
        .slice(
          0,
          32
        )
  };

  console.log(
    '[EVENT ORDER BODY]',
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
   CLOSE EVENT ORDER
========================================================= */

async function closeEventPosition(
  position,
  currentPx
) {

  const inst =
    position.inst;

  const tickSz =
    Number(
      inst.tickSz ||
      0.001
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
      'isolated',

    side:
      'sell',

    ordType:
      'ioc',

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
        .replace(
          /[^a-zA-Z0-9]/g,
          ''
        )
        .slice(
          0,
          32
        )
  };

  console.log(
    '[EVENT EXIT BODY]',
    JSON.stringify(
      body
    )
  );

  if (
    !LIVE_TRADING
  ) {

    return {

      state:
        'filled',

      avgPx:
        px,

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
   POSITION MANAGEMENT
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
      await getTicker(
        position.inst.instId,
        'EVENTS'
      );

    const yesBid =
      Number(
        ticker?.bidPx
      );

    const yesAsk =
      Number(
        ticker?.askPx
      );

    const yesLast =
      Number(
        ticker?.last
      );

    let currentPx;

    if (
      position.side ===
      'yes'
    ) {

      currentPx =
        yesBid > 0
          ? yesBid
          : yesLast;

    } else {

      /*
        NO price derived from
        YES ask.
      */
      const reference =
        yesAsk > 0
          ? yesAsk
          : yesLast;

      currentPx =
        1 -
        reference;
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
      '[POSITION]',
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
    await closeEventPosition(
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
    equity *
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
      '================================'
    );

    console.log(
      '[EVENT] ENTRY CANDIDATE'
    );

    console.log(
      'Instrument:',
      candidate.inst.instId
    );

    console.log(
      'Series:',
      candidate.seriesId
    );

    console.log(
      'Side:',
      candidate.side
    );

    console.log(
      'Entry:',
      candidate.entryPx
    );

    console.log(
      'Score:',
      candidate.score
    );

    console.log(
      'Model:',
      candidate.modelProb
    );

    console.log(
      'Market:',
      candidate.marketProb
    );

    console.log(
      'Edge:',
      candidate.edge
    );

    console.log(
      'Stake:',
      stake
    );

    console.log(
      '================================'
    );

    const order =
      await placeEventOrder(
        candidate,
        stake
      );

    let filled =
      order;

    /*
      IOC may return immediately.
      Query order for actual fill.
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

    const fillState =
      String(
        filled?.state ||
        ''
      ).toLowerCase();

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
      IOC can be canceled without fill.
    */
    if (
      !(
        fillSz > 0
      )
    ) {

      console.log(
        '[EVENT] NO FILL',
        fillState
      );

      await notify(
        `⚪ EVENT NO FILL\n` +
        `${candidate.inst.instId}\n` +
        `${candidate.side.toUpperCase()}\n` +
        `Entry ${candidate.entryPx.toFixed(4)}\n` +
        `Stake ${stake.toFixed(4)}U\n` +
        `State ${fillState || 'unknown'}\n` +
        `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
      );

      return;
    }

    const actualStake =
      avgPx *
      fillSz;

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
      `Actual ${actualStake.toFixed(4)}U\n` +
      `Requested ${stake.toFixed(4)}U\n` +
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
        ) ||
        'signal'
      }\n` +
      `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
    );

  } catch (err) {

    console.error(
      '[EVENT ORDER ERROR]',
      candidate?.inst?.instId,
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
   STATUS
========================================================= */

function getStatusObject() {

  return {

    ok:
      true,

    bot:
      'OKX EVENT CONTRACT SNR BOT',

    product:
      'EVENTS',

    live:
      LIVE_TRADING,

    baseUrl:
      BASE_URL,

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

            stake:
              state.position
                .stake
          }
        : null,

    halted:
      state.halted,

    consecutiveLosses:
      state.consecutiveLosses,

    realizedPnl:
      state.realizedPnl,

    paperEquity:
      state.paperEquity,

    lastTradeAt:
      state.lastTradeAt
  };
}

/* =========================================================
   HTTP
========================================================= */

app.get(
  '/',
  (req, res) => {

    res.json(
      getStatusObject()
    );
  }
);

app.get(
  '/health',
  (req, res) => {

    res.json({

      ok:
        true,

      bot:
        'OKX EVENT CONTRACT SNR BOT',

      product:
        'EVENTS',

      live:
        LIVE_TRADING,

      time:
        new Date()
          .toISOString()
    });
  }
);

app.get(
  '/status',
  (req, res) => {

    res.json(
      getStatusObject()
    );
  }
);

/* =========================================================
   EVENT DISCOVERY DEBUG
========================================================= */

app.get(
  '/event-discovery',
  async (req, res) => {

    try {

      const series =
        await discoverEventSeries();

      const preview = [];

      for (
        const seriesId of
        series.slice(
          0,
          20
        )
      ) {

        try {

          const instruments =
            await getEventInstruments(
              seriesId
            );

          preview.push({

            seriesId,

            count:
              Array.isArray(
                instruments
              )
                ? instruments.length
                : 0,

            instruments:
              Array.isArray(
                instruments
              )
                ? instruments
                    .slice(
                      0,
                      10
                    )
                    .map(
                      x => ({
                        instId:
                          x.instId,

                        instType:
                          x.instType,

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
                : []
          });

        } catch (err) {

          preview.push({

            seriesId,

            error:
              err.message
          });
        }
      }

      res.json({

        ok:
          true,

        count:
          series.length,

        series,

        preview
      });

    } catch (err) {

      res.status(500)
        .json({

          ok:
            false,

          error:
            err.message
        });
    }
  }
);

/* =========================================================
   START SERVER
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
      `PORT=${PORT}`
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
      `MIN_SCORE=${MIN_SCORE}`
    );

    console.log(
      `MIN_EDGE=${MIN_EDGE}`
    );

    console.log(
      `RISK_PCT=${RISK_PCT}`
    );

    console.log(
      `MAX_STAKE_PCT=${MAX_STAKE_PCT}`
    );

    console.log(
      'EVENT tdMode = isolated'
    );

    console.log(
      'EVENT speedBump = omitted'
    );

    console.log(
      '======================================'
    );

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
          '[OKX] server time:',
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
  }
);

/* =========================================================
   LOOPS
========================================================= */

setInterval(
  async () => {

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
        err.message
      );
    }

  },
  CHECK_INTERVAL
);

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

/*
  Immediate first run.
*/
(async () => {

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
      '[INITIAL LOOP]',
      err.message
    );
  }

})();
