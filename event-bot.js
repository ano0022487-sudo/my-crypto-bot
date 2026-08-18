'use strict';

/*
  OKX EVENT CONTRACT SNR ROLLING BOT
  ----------------------------------
  Product:
    OKX EVENT CONTRACTS only

  Features:
    - Auto discovery of Event Contract series
    - BTC / ETH / SOL
    - 5m + 15m trend confirmation
    - EMA20 / EMA50
    - RSI
    - ATR volatility filter
    - SNR pivot filter
    - Volume filter
    - Model probability
    - Market probability
    - Edge filter
    - Rolling position sizing
    - One position at a time
    - Early TP / SL
    - Daily loss protection
    - Consecutive-loss protection
    - Telegram notification
    - Render health endpoints

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

const PORT = Number(process.env.PORT || 3000);

const LIVE_TRADING =
  String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';

const API_KEY =
  String(process.env.OK_ACCESS_KEY || '').trim();

const SECRET_KEY =
  String(process.env.OK_ACCESS_SECRET || '').trim();

const PASSPHRASE =
  String(process.env.OKX_PASSPHRASE || '').trim();

const BASE_URL =
  String(
    process.env.OKX_BASE_URL ||
    'https://openapi.okx.com'
  ).replace(/\/$/, '');

const TELEGRAM_BOT_TOKEN =
  String(process.env.TELEGRAM_BOT_TOKEN || '')
    .trim()
    .replace(/["']/g, '');

const TELEGRAM_CHAT_ID =
  String(process.env.TELEGRAM_CHAT_ID || '').trim();

const CHECK_INTERVAL =
  Number(process.env.CHECK_INTERVAL || 15000);

const POSITION_CHECK_INTERVAL =
  Number(process.env.POSITION_CHECK_INTERVAL || 5000);

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

const MIN_ENTRY_PRICE =
  Number(process.env.MIN_ENTRY_PRICE || 0.22);

const MAX_ENTRY_PRICE =
  Number(process.env.MAX_ENTRY_PRICE || 0.78);

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
  String(
    process.env.AUTO_DISCOVER_SERIES || 'true'
  ).toLowerCase() === 'true';

const BOT_STATE_FILE =
  process.env.BOT_STATE_FILE ||
  path.join(__dirname, 'event-bot-state.json');

/*
  Event Contract underlying mapping.

  These are SWAP instruments used ONLY for
  underlying price / technical analysis.
*/
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
  : null;

async function notify(text) {
  if (!bot || !TELEGRAM_CHAT_ID) return;

  try {
    await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      text
    );
  } catch (err) {
    console.error(
      'Telegram:',
      err.message
    );
  }
}

/* =========================================================
   UTIL
========================================================= */

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function q(params) {
  return Object.entries(params)
    .filter(([, value]) =>
      value !== undefined &&
      value !== null &&
      value !== ''
    )
    .map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join('&');
}

async function request(config, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await axios({
        timeout: 15000,
        ...config
      });
    } catch (err) {
      lastError = err;

      if (i < retries - 1) {
        await sleep(500 * (i + 1));
      }
    }
  }

  throw lastError;
}

/* =========================================================
   OKX PUBLIC API
========================================================= */

async function publicGet(pathname, params = {}) {
  const query = q(params);

  const requestPath =
    query
      ? `${pathname}?${query}`
      : pathname;

  const response = await request({
    method: 'GET',
    url: `${BASE_URL}${requestPath}`
  });

  if (
    !response.data ||
    String(response.data.code) !== '0'
  ) {
    throw new Error(
      `OKX public error ${response.status}: ` +
      JSON.stringify(response.data)
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
      ? JSON.stringify(bodyObj)
      : '';

  const headers = {
    'OK-ACCESS-KEY': API_KEY,
    'OK-ACCESS-SIGN': sign(
      timestamp,
      method,
      requestPath,
      body
    ),
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': PASSPHRASE,
    'Content-Type': 'application/json'
  };

  const response = await request({
    method,
    url: `${BASE_URL}${requestPath}`,
    data: body || undefined,
    headers
  });

  if (
    !response.data ||
    String(response.data.code) !== '0'
  ) {
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
   TIME
========================================================= */

async function getServerTime() {
  try {
    const rows =
      await publicGet(
        '/api/v5/public/time'
      );

    return Number(rows?.[0]?.ts || Date.now());

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
      'State load:',
      err.message
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
  } catch (err) {
    console.error(
      'State save:',
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

  if (state.day !== today) {
    state.day = today;

    state.startEquity =
      LIVE_TRADING
        ? 0
        : Number(
            state.paperEquity ||
            START_CAPITAL
          );

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

function ema(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let value =
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

    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
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
    const change =
      values[i] -
      values[i - 1];

    avgGain =
      (
        avgGain *
          (period - 1) +
        Math.max(change, 0)
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        Math.max(-change, 0)
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
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

  const trueRanges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const high =
      Number(candles[i][2]);

    const low =
      Number(candles[i][3]);

    const previousClose =
      Number(candles[i - 1][4]);

    trueRanges.push(
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
    trueRanges.slice(-period);

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) / recent.length
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
      x => String(x[8]) === '1'
    );
}

/* =========================================================
   PIVOTS / SNR
========================================================= */

function pivots(
  candles,
  lookback = 3
) {
  const h = highs(candles);
  const l = lows(candles);

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

    if (h[i] === highest) {
      resistance.push(h[i]);
    }

    if (l[i] === lowest) {
      support.push(l[i]);
    }
  }

  return {
    resistance:
      resistance.slice(-10),

    support:
      support.slice(-10)
  };
}

function nearestAbove(
  levels,
  price
) {
  return levels
    .filter(x => x > price)
    .sort(
      (a, b) => a - b
    )[0] || null;
}

function nearestBelow(
  levels,
  price
) {
  return levels
    .filter(x => x < price)
    .sort(
      (a, b) => b - a
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

  return confirmed(rows);
}

async function getTicker(
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

  return rows?.[0] || null;
}

/* =========================================================
   EVENT SERIES DISCOVERY
========================================================= */

/*
  IMPORTANT:

  We do NOT call the old broken:

    /api/v5/public/series

  with instType=EVENTS.

  Instead, we use the current Event Contract
  series endpoint.

  If OKX returns a different response shape,
  normalizeSeries() handles the common forms.
*/

function normalizeSeries(row) {
  if (!row) return null;

  return (
    row.seriesId ||
    row.id ||
    row.seriesID ||
    row.series ||
    null
  );
}

async function discoverEventSeries() {

  /*
    If user explicitly configured EVENT_SERIES,
    use it first.
  */
  if (EVENT_SERIES) {

    const configured =
      EVENT_SERIES
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);

    console.log(
      '[EVENT] Configured series:',
      configured
    );

    return configured;
  }

  if (!AUTO_DISCOVER_SERIES) {
    console.log(
      '[EVENT] AUTO_DISCOVER_SERIES=false'
    );

    return [];
  }

  /*
    Current Event Contract series API.
  */
  const possiblePaths = [
    '/api/v5/public/event-series',
    '/api/v5/public/series'
  ];

  let lastError = null;

  for (
    const pathname of possiblePaths
  ) {

    try {

      const rows =
        await publicGet(
          pathname,
          {}
        );

      let list = [];

      if (Array.isArray(rows)) {
        list = rows;
      } else if (
        rows &&
        Array.isArray(
          rows.data
        )
      ) {
        list = rows.data;
      } else if (
        rows &&
        Array.isArray(
          rows.series
        )
      ) {
        list = rows.series;
      }

      const series =
        list
          .map(normalizeSeries)
          .filter(Boolean);

      if (series.length) {

        console.log(
          `[EVENT] Series discovery OK via ${pathname}`
        );

        console.log(
          '[EVENT] Series count:',
          series.length
        );

        return series;
      }

    } catch (err) {

      lastError = err;

      console.error(
        `[EVENT] Series discovery ${pathname}:`,
        err.message
      );
    }
  }

  throw new Error(
    `EVENT discovery failed: ${
      lastError
        ? lastError.message
        : 'no series returned'
    }`
  );
}

/* =========================================================
   EVENT INSTRUMENTS
========================================================= */

async function getEventInstruments(
  seriesId
) {

  /*
    Current official V5 requirement:

      instType=EVENTS
      seriesId=<seriesId>
  */

  return publicGet(
    '/api/v5/public/instruments',
    {
      instType: 'EVENTS',
      seriesId
    }
  );
}

/* =========================================================
   EVENT HELPERS
========================================================= */

function getBaseAsset(inst) {

  const text =
    `${inst.baseCcy || ''} ` +
    `${inst.instId || ''} ` +
    `${inst.seriesId || ''}`.toUpperCase();

  for (
    const coin of
    Object.keys(
      UNDERLYING_MAP
    )
  ) {
    if (
      text.includes(coin)
    ) {
      return coin;
    }
  }

  return null;
}

function getExpiry(inst) {

  const candidates = [
    Number(inst.expTime),
    Number(inst.expiryTime),
    Number(inst.endTime)
  ].filter(Number.isFinite);

  if (!candidates.length) {
    return null;
  }

  return Math.max(
    ...candidates
  );
}

/*
  Detect event direction.

  ABOVE / UP  -> YES means bullish
  BELOW / DOWN -> YES means bearish

  UPDOWN contracts:
    instId:
      BTC-UPDOWN-15MIN-...

  For UPDOWN:
    YES = price UP
    NO  = price DOWN
*/
function getDirection(inst) {

  const text =
    `${inst.seriesId || ''} ` +
    `${inst.instId || ''} ` +
    `${inst.ruleType || ''}`.toUpperCase();

  if (
    text.includes('UPDOWN')
  ) {
    return 'UPDOWN';
  }

  if (
    text.includes('ABOVE') ||
    text.includes('UP')
  ) {
    return 'ABOVE';
  }

  if (
    text.includes('BELOW') ||
    text.includes('DOWN')
  ) {
    return 'BELOW';
  }

  return 'UNKNOWN';
}

/*
  Extract strike / target if present.
*/
function getStrike(inst) {

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
      Number(inst[key]);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }

  const text =
    `${inst.instId || ''} ` +
    `${inst.seriesId || ''}`;

  const match =
    text.match(
      /(?:^|[-_])(\d+(?:\.\d+)?)(?:[-_]|$)/
    );

  return match
    ? Number(match[1])
    : null;
}

function minutesToExpiry(inst) {

  const exp =
    getExpiry(inst);

  if (!exp) {
    return null;
  }

  return (
    exp -
    Date.now()
  ) / 60000;
}

function allowedExpiry(inst) {

  const mins =
    minutesToExpiry(inst);

  if (
    !Number.isFinite(mins)
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

/* =========================================================
   PRICE / TICK
========================================================= */

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
      (
        String(step)
          .split('.')[1] ||
        ''
      ).length
    );

  return Number(
    (
      Math.floor(
        value / step
      ) * step
    ).toFixed(decimals)
  );
}

function roundToTick(
  price,
  tick
) {

  if (!(tick > 0)) {
    return price;
  }

  const decimals =
    Math.max(
      0,
      (
        String(tick)
          .split('.')[1] ||
        ''
      ).length
    );

  return Number(
    (
      Math.round(
        price / tick
      ) * tick
    ).toFixed(decimals)
  );
}

function validPrice(price) {

  return (
    Number.isFinite(price) &&
    price >
      MIN_ENTRY_PRICE &&
    price <
      MAX_ENTRY_PRICE
  );
}

/* =========================================================
   PROBABILITY
========================================================= */

function marketProbability(
  entryPrice,
  outcome
) {

  if (
    !(
      entryPrice > 0 &&
      entryPrice < 1
    )
  ) {
    return null;
  }

  /*
    For YES:
      market probability = YES price

    For NO:
      market probability = 1 - YES price
  */

  return outcome === 'yes'
    ? entryPrice
    : 1 - entryPrice;
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

  const recentVolume =
    vol5.slice(-20);

  const avgVol =
    recentVolume.length
      ? recentVolume.reduce(
          (a, b) => a + b,
          0
        ) /
        recentVolume.length
      : 0;

  const currentVolume =
    vol5[
      vol5.length - 1
    ] || 0;

  const volRatio =
    avgVol > 0
      ? currentVolume /
        avgVol
      : 1;

  let score = 50;

  const reasons = [];

  /*
    UP / ABOVE
  */
  if (
    direction === 'ABOVE' ||
    direction === 'UPDOWN_UP'
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

  /*
    DOWN / BELOW
  */
  if (
    direction === 'BELOW' ||
    direction === 'UPDOWN_DOWN'
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

  /*
    Volume
  */
  if (
    volRatio >= 1.15
  ) {
    score += 8;
    reasons.push(
      'volume'
    );
  }

  /*
    SNR
  */
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
      direction === 'ABOVE' ||
      direction ===
        'UPDOWN_UP'
    ) &&
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
    (
      direction === 'BELOW' ||
      direction ===
        'UPDOWN_DOWN'
    ) &&
    support &&
    price <=
      support * 1.001
  ) {
    score += 8;
    reasons.push(
      'SNR support test'
    );
  }

  /*
    Strike
  */
  if (
    strikePx &&
    strikePx > 0
  ) {

    const distance =
      Math.abs(
        price -
          strikePx
      ) / price;

    if (
      direction === 'ABOVE' &&
      price > strikePx
    ) {
      score += 8;
      reasons.push(
        'above strike'
      );
    }

    if (
      direction === 'BELOW' &&
      price < strikePx
    ) {
      score += 8;
      reasons.push(
        'below strike'
      );
    }

    if (
      distance < 0.0025
    ) {
      score -= 10;
      reasons.push(
        'strike too close'
      );
    }
  }

  /*
    ATR
  */
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
    Mapping:
      score 50 -> 50%
      score 80 -> 68%
      score 90 -> 74%
      score 100 -> 80%
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
    rows?.[0]?.details?.find(
      x =>
        x.ccy === 'USDT'
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
      equity
    ) &&
    equity > 0
  ) {
    return equity;
  }

  if (
    Number.isFinite(
      available
    ) &&
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
   SCAN
========================================================= */

async function scanCandidates() {

  const series =
    await discoverEventSeries();

  const candidates = [];

  console.log(
    `[EVENT] Scanning ${series.length} series`
  );

  for (
    const seriesId of series
  ) {

    let instruments;

    try {

      instruments =
        await getEventInstruments(
          seriesId
        );

    } catch (err) {

      console.error(
        `[EVENT] Series ${seriesId}:`,
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
      const inst of instruments
    ) {

      try {

        /*
          State filtering
        */
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

        /*
          Expiry
        */
        if (
          !allowedExpiry(inst)
        ) {
          continue;
        }

        const coin =
          getBaseAsset(inst);

        if (!coin) {
          continue;
        }

        const underlying =
          UNDERLYING_MAP[
            coin
          ];

        /*
          Direction
        */
        let direction =
          getDirection(inst);

        /*
          Parse UPDOWN
        */
        if (
          direction ===
          'UPDOWN'
        ) {

          const id =
            String(
              inst.instId ||
              ''
            ).toUpperCase();

          /*
            For UPDOWN:
              YES is interpreted as UP
              NO is interpreted as DOWN
          */

          direction =
            id.includes(
              'UPDOWN'
            )
              ? 'UPDOWN'
              : 'UNKNOWN';
        }

        if (
          direction ===
          'UNKNOWN'
        ) {
          continue;
        }

        /*
          Market ticker
        */
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

        /*
          EVENTS API returns YES market data.
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

        /*
          Candidate side.

          ABOVE:
            buy YES

          BELOW:
            buy YES

          UPDOWN:
            model both outcomes.
        */

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
          Strike
        */
        const strikePx =
          getStrike(inst);

        /*
          Handle UPDOWN:
          evaluate YES as UP.
        */
        let modelDirection =
          direction;

        if (
          direction ===
          'UPDOWN'
        ) {
          modelDirection =
            'UPDOWN_UP';
        }

        const model =
          modelProbability(
            modelDirection,
            underlyingPrice,
            strikePx,
            c5,
            c15
          );

        /*
          YES entry
        */
        const yesEntry =
          yesAsk;

        /*
          NO entry:
            1 - YES bid
        */
        const noEntry =
          1 - yesBid;

        /*
          Evaluate YES
        */
        const yesMarketProb =
          marketProbability(
            yesEntry,
            'yes'
          );

        /*
          Evaluate NO
        */
        const noMarketProb =
          marketProbability(
            noEntry,
            'no'
          );

        /*
          For UPDOWN:
            model YES = bullish probability
            model NO = bearish probability
        */

        let yesModelProb =
          model.probability;

        let noModelProb =
          1 -
          yesModelProb;

        /*
          For ABOVE / BELOW:
            YES is the event outcome.
        */

        if (
          direction ===
          'ABOVE'
        ) {

          yesModelProb =
            model.probability;

          noModelProb =
            1 -
            yesModelProb;
        }

        if (
          direction ===
          'BELOW'
        ) {

          yesModelProb =
            model.probability;

          noModelProb =
            1 -
            yesModelProb;
        }

        const yesEdge =
          yesModelProb -
          yesMarketProb;

        const noEdge =
          noModelProb -
          noMarketProb;

        /*
          Pick the better side.
        */
        let side;
        let entryPx;
        let modelProb;
        let marketProb;
        let edge;

        if (
          yesEdge >= noEdge
        ) {
          side = 'yes';
          entryPx = yesEntry;
          modelProb =
            yesModelProb;
          marketProb =
            yesMarketProb;
          edge = yesEdge;
        } else {
          side = 'no';
          entryPx = noEntry;
          modelProb =
            noModelProb;
          marketProb =
            noMarketProb;
          edge = noEdge;
        }

        if (
          !validPrice(
            entryPx
          )
        ) {
          continue;
        }

        /*
          Filters
        */
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
          modelDirection,
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
            getExpiry(inst),
          minutesToExpiry:
            minutesToExpiry(inst)
        });

      } catch (err) {

        console.error(
          `[EVENT] Candidate ${inst.instId}:`,
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
   PLACE EVENT ORDER
========================================================= */

async function placeEventOrder(
  candidate,
  stake
) {

  const inst =
    candidate.inst;

  const lotSz =
    Number(
      inst.lotSz || 1
    );

  const minSz =
    Number(
      inst.minSz ||
      lotSz
    );

  /*
    Event contract quantity:
      stake / price
  */
  const rawSz =
    stake /
    candidate.entryPx;

  let sz =
    roundDown(
      rawSz,
      lotSz
    );

  if (
    sz < minSz
  ) {
    sz = minSz;
  }

  const notional =
    sz *
    candidate.entryPx;

  /*
    Safety:
    Don't exceed stake by more than 3%.
  */
  if (
    notional >
    stake * 1.03
  ) {
    throw new Error(
      `Order exceeds stake: ` +
      `stake=${stake.toFixed(4)} ` +
      `notional=${notional.toFixed(4)}`
    );
  }

  /*
    Get tick size.
  */
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

  /*
    Event Contract:
      tdMode = cash
      outcome = yes/no

    speedBump is intentionally NOT included.
    OKX changelog dated 2026-07-24 says
    speedBump was removed / ignored.
  */
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
      px.toFixed(6),

    sz:
      String(sz),

    outcome:
      candidate.side,

    clOrdId:
      `snr${Date.now().toString(36)}`
        .slice(0, 32)
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
  if (!LIVE_TRADING) {

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
    !result ||
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

  return rows?.[0] || null;
}

/* =========================================================
   CLOSE EVENT POSITION
========================================================= */

async function closePosition(
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
      'cash',

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
        .slice(0, 32)
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
      await getTicker(
        position.inst.instId,
        'EVENTS'
      );

    const yesBid =
      Number(
        ticker?.bidPx ||
        ticker?.last
      );

    if (
      !(
        yesBid > 0
      )
    ) {
      return;
    }

    /*
      YES position:
        current = YES bid

      NO position:
        current = 1 - YES ask/bid approximation

      We use YES bid for the
      current executable reference.
    */
    const currentPx =
      position.side === 'yes'
        ? yesBid
        : 1 - yesBid;

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

    /*
      TP
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
      SL
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
      'Position manager:',
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
    `PnL ${
      pnl >= 0 ? '+' : ''
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
      'Equity:',
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
    Daily loss protection
  */
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
      'Scan:',
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

  /*
    Stake
  */
  const calculatedStake =
    stakeForEquity(
      equity
    );

  const stake =
    Math.min(
      calculatedStake,
      equity
    );

  /*
    Don't enter if the
    event itself cannot fit.
  */
  if (
    stake <= 0
  ) {
    return;
  }

  try {

    console.log(
      '[EVENT] Candidate:',
      candidate.inst.instId
    );

    console.log(
      '[EVENT] Side:',
      candidate.side
    );

    console.log(
      '[EVENT] Entry:',
      candidate.entryPx
    );

    console.log(
      '[EVENT] Score:',
      candidate.score
    );

    console.log(
      '[EVENT] Model:',
      candidate.modelProb
    );

    console.log(
      '[EVENT] Market:',
      candidate.marketProb
    );

    console.log(
      '[EVENT] Edge:',
      candidate.edge
    );

    const order =
      await placeEventOrder(
        candidate,
        stake
      );

    let filled =
      order;

    /*
      Query actual fill
    */
    if (
      LIVE_TRADING &&
      order.ordId
    ) {

      await sleep(1000);

      filled =
        await getOrder(
          candidate.inst.instId,
          order.ordId
        );
    }

    /*
      IMPORTANT:
      Use actual exchange fill size.
    */
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
      !(
        fillSz > 0
      )
    ) {

      console.log(
        '[EVENT] No fill'
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
      'Trade:',
      err.message
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
        'OKX Event Contract SNR Rolling Bot',

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
        state.realizedPnl
    });
  }
);

app.get(
  '/health',
  async (req, res) => {

    res.json({

      ok:
        true,

      live:
        LIVE_TRADING,

      product:
        'EVENTS',

      time:
        new Date().toISOString()
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
   DEBUG EVENT DISCOVERY
========================================================= */

app.get(
  '/event-discovery',
  async (req, res) => {

    try {

      const series =
        await discoverEventSeries();

      res.json({

        ok:
          true,

        count:
          series.length,

        series:
          series.slice(
            0,
            100
          )
      });

    } catch (err) {

      res.status(500).json({

        ok:
          false,

        error:
          err.message
      });
    }
  }
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

  } catch (err) {

    console.error(
      'MAIN LOOP:',
      err.message ||
        err
    );
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
      '======================================'
    );

    /*
      Test server time.
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
        '[OKX] Time check:',
        err.message
      );
    }

    /*
      Telegram test is intentionally
      NOT sent automatically.
    */
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

mainLoop().catch(
  err =>
    console.error(
      'Initial loop:',
      err
    )
);
