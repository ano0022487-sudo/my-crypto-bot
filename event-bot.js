'use strict';

/*
===========================================================
 OKX EVENT CONTRACT SNR ROLLING BOT
===========================================================

產品：
  OKX EVENTS / Event Contracts

目前策略：
  BTC / ETH / SOL
  UPDOWN 15MIN
  5m + 15m trend
  EMA20 / EMA50
  RSI
  ATR
  SNR
  Volume
  Model probability
  Market probability
  Edge filter

交易：
  LIVE_TRADING=false 預設
  LIVE_TRADING=true 才會真的下單

重要：
  EVENTS tdMode = isolated
  outcome = yes / no

  speedBump：
    2026-07-24 OKX changelog 已移除
    本程式不再送 speedBump

===========================================================
 REQUIRED ENV
===========================================================

OK_ACCESS_KEY
OK_ACCESS_SECRET
OKX_PASSPHRASE

===========================================================
 OPTIONAL ENV
===========================================================

LIVE_TRADING=false

START_CAPITAL=20

RISK_PCT=0.10
MAX_STAKE_PCT=0.20
MIN_STAKE=1

MIN_EDGE=0.075
MIN_SCORE=78

MIN_ENTRY_PRICE=0.22
MAX_ENTRY_PRICE=0.78

EARLY_TP_PCT=0.30
EARLY_SL_PCT=0.25

MIN_MINUTES_TO_EXPIRY=1
MAX_MINUTES_TO_EXPIRY=20

DAILY_LOSS_PCT=0.20
MAX_CONSECUTIVE_LOSSES=3

CHECK_INTERVAL=15000
POSITION_CHECK_INTERVAL=5000

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

EVENT_SERIES=
AUTO_DISCOVER_SERIES=true

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
  OKX Taiwan/global API endpoint.
*/
const BASE_URL =
  String(
    process.env.OKX_BASE_URL ||
    'https://www.okx.com'
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
    process.env.MIN_MINUTES_TO_EXPIRY || 1
  );

const MAX_MINUTES_TO_EXPIRY =
  Number(
    process.env.MAX_MINUTES_TO_EXPIRY || 20
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

/*
  Technical-analysis underlying.
*/
const UNDERLYING_MAP = {
  BTC: 'BTC-USDT-SWAP',
  ETH: 'ETH-USDT-SWAP',
  SOL: 'SOL-USDT-SWAP'
};

const ASSETS = [
  'BTC',
  'ETH',
  'SOL'
];

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
  不依賴 /start。
  只有真正交易事件才通知。
*/

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
      'Telegram:',
      err.message
    );
  }
}

/* =========================================================
   TELEGRAM POLLING ERROR
========================================================= */

if (bot) {

  bot.on(
    'polling_error',
    err => {

      console.error(
        '[Telegram polling_error]',
        err.message
      );

    }
  );

  /*
    不處理 /start。
    你的需求是開單通知即可。
  */
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
   OKX PUBLIC
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
   OKX SIGN
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
   OKX PRIVATE
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
   CANDLES
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

  const trueRanges = [];

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
    trueRanges.slice(
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

  return rows?.[0] ||
    null;
}

/* =========================================================
   EVENT SERIES
========================================================= */

/*
  不再呼叫：

    /api/v5/public/event-series
    /api/v5/public/series

  這兩個路徑造成你之前的 404。

  EVENTS instruments 官方需要 seriesId。
*/

function getConfiguredSeries() {

  if (
    !EVENT_SERIES
  ) {

    return [];
  }

  return EVENT_SERIES

    .split(',')

    .map(
      x =>
        x.trim()
    )

    .filter(Boolean);
}

/*
  目前主要交易：
    BTC-UPDOWN-15MIN
    ETH-UPDOWN-15MIN
    SOL-UPDOWN-15MIN

  這裡產生系列候選。
*/
function generatedSeries() {

  const result = [];

  for (
    const coin of ASSETS
  ) {

    result.push(
      `${coin}-UPDOWN-15MIN`
    );
  }

  return result;
}

/*
  解析事件時間。

  例如：

  SOL-UPDOWN-15MIN-260818-2230-2245

  年月日：
    26 08 18

  時間：
    22:30
    22:45
*/
function parseExpiryFromInstId(
  instId
) {

  const text =
    String(
      instId || ''
    ).toUpperCase();

  const match =
    text.match(
      /-(\d{6})-(\d{4})-(\d{4})$/
    );

  if (
    !match
  ) {

    return null;
  }

  const datePart =
    match[1];

  const endPart =
    match[3];

  const yy =
    Number(
      datePart.slice(0, 2)
    );

  const mm =
    Number(
      datePart.slice(2, 4)
    );

  const dd =
    Number(
      datePart.slice(4, 6)
    );

  const hh =
    Number(
      endPart.slice(0, 2)
    );

  const min =
    Number(
      endPart.slice(2, 4)
    );

  /*
    OKX instrument time is UTC.
  */
  const year =
    2000 + yy;

  return Date.UTC(
    year,
    mm - 1,
    dd,
    hh,
    min,
    0,
    0
  );
}

/*
  如果 API 回傳 expTime，
  優先使用 API。

  沒有 expTime，
  再從 instId 解析。
*/
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
    values.length
  ) {

    return Math.max(
      ...values
    );
  }

  return parseExpiryFromInstId(
    inst.instId
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

/*
  不使用 API expiry 時，
  允許已經進入交易的 15m 合約。
*/
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

async function discoverEventInstruments() {

  /*
    如果手動指定 EVENT_SERIES，
    優先使用。
  */
  let series =
    getConfiguredSeries();

  /*
    沒有指定才自動產生。
  */
  if (
    !series.length &&
    AUTO_DISCOVER_SERIES
  ) {

    series =
      generatedSeries();
  }

  if (
    !series.length
  ) {

    throw new Error(
      'No EVENT series configured'
    );
  }

  console.log(
    '[EVENT] Checking series:',
    series.join(', ')
  );

  const all = [];

  for (
    const seriesId of series
  ) {

    try {

      const rows =
        await getEventInstruments(
          seriesId
        );

      if (
        Array.isArray(rows)
      ) {

        for (
          const inst of rows
        ) {

          all.push({
            ...inst,
            seriesId:
              inst.seriesId ||
              seriesId
          });
        }
      }

    } catch (err) {

      console.error(
        `[EVENT] ${seriesId}:`,
        err.message
      );
    }
  }

  return all;
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
    const coin of ASSETS
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

/*
  UPDOWN：
    YES = 上漲
    NO  = 下跌

  本機器人只做 UPDOWN。
*/
function isUpDown(
  inst
) {

  const text =
    `${inst.instId || ''} ` +
    `${inst.seriesId || ''}`
      .toUpperCase();

  return text.includes(
    'UPDOWN'
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
    'triggerPx'
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

  return null;
}

/* =========================================================
   ROUNDING
========================================================= */

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
      ) *
      step
    ).toFixed(
      decimals
    )
  );
}

function roundToTick(
  price,
  tick
) {

  if (
    !(tick > 0)
  ) {

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
    price >=
      MIN_ENTRY_PRICE &&
    price <=
      MAX_ENTRY_PRICE
  );
}

/* =========================================================
   MODEL
========================================================= */

function modelProbability(
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

  /*
    UP probability
  */
  let score =
    50;

  const reasons = [];

  /*
    5m trend
  */
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

  /*
    15m trend
  */
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

  /*
    RSI
  */
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

  /*
    Volume
  */
  if (
    volumeRatio >= 1.15
  ) {

    score += 8;

    reasons.push(
      'volume'
    );
  }

  /*
    Resistance test
  */
  const resistance =
    nearestAbove(
      [
        ...p5.resistance,
        ...p15.resistance
      ],
      price
    );

  if (
    resistance &&
    price >=
      resistance * 0.999
  ) {

    score += 8;

    reasons.push(
      'SNR resistance test'
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
      ) /
      price;

    if (
      price >
      strikePx
    ) {

      score += 8;

      reasons.push(
        'above strike'
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

  /*
    ATR
  */
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

  /*
    Model mapping

    50 = 50%
    80 = 68%
    90 = 74%
    100 = 80%
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

  /*
    DOWN probability
  */
  const downProbability =
    1 -
    probability;

  return {

    score,

    upProbability:
      probability,

    downProbability,

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
      0,
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
    rows?.[0]
      ?.details
      ?.find(
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

  /*
    不超過帳戶本金
  */
  return Math.min(
    equity,
    Math.max(
      MIN_STAKE,
      Math.min(
        maximum,
        calculated
      )
    )
  );
}

/* =========================================================
   FIND EVENT CANDIDATES
========================================================= */

async function scanCandidates() {

  const instruments =
    await discoverEventInstruments();

  console.log(
    `[EVENT] Instruments found: ${instruments.length}`
  );

  if (
    !instruments.length
  ) {

    return [];
  }

  /*
    只保留：
      BTC / ETH / SOL
      UPDOWN
      live
      1~20 min expiry
  */
  const filtered =
    instruments.filter(
      inst => {

        const coin =
          getBaseAsset(
            inst
          );

        if (
          !coin
        ) {

          return false;
        }

        if (
          !isUpDown(
            inst
          )
        ) {

          return false;
        }

        if (
          inst.state &&
          String(
            inst.state
          ).toLowerCase() !==
            'live'
        ) {

          return false;
        }

        return allowedExpiry(
          inst
        );
      }
    );

  console.log(
    `[EVENT] Valid UPDOWN contracts: ${filtered.length}`
  );

  const candidates = [];

  /*
    技術資料快取。
    同一個幣不要重複抓 5m / 15m。
  */
  const marketCache =
    {};

  for (
    const inst of filtered
  ) {

    try {

      const coin =
        getBaseAsset(
          inst
        );

      const underlying =
        UNDERLYING_MAP[
          coin
        ];

      if (
        !marketCache[
          coin
        ]
      ) {

        const [
          c5,
          c15
        ] =
          await Promise.all([

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

        marketCache[
          coin
        ] = {
          c5,
          c15
        };
      }

      const {
        c5,
        c15
      } =
        marketCache[
          coin
        ];

      if (
        !c5.length ||
        !c15.length
      ) {

        continue;
      }

      /*
        EVENT ticker
      */
      const ticker =
        await getTicker(
          inst.instId,
          'EVENTS'
        );

      const yesAsk =
        Number(
          ticker?.askPx ||
          ticker?.last
        );

      const yesBid =
        Number(
          ticker?.bidPx ||
          ticker?.last
        );

      if (
        !(
          yesAsk > 0 &&
          yesBid > 0
        )
      ) {

        continue;
      }

      if (
        yesAsk >= 1 ||
        yesBid <= 0
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

      const model =
        modelProbability(
          underlyingPrice,
          strikePx,
          c5,
          c15
        );

      /*
        YES = UP
        NO = DOWN
      */

      const yesModel =
        model.upProbability;

      const noModel =
        model.downProbability;

      /*
        YES executable price
        = ask

        NO executable approximation
        = 1 - YES bid
      */
      const yesEntry =
        yesAsk;

      const noEntry =
        1 -
        yesBid;

      if (
        !validPrice(
          yesEntry
        )
      ) {

        continue;
      }

      if (
        !validPrice(
          noEntry
        )
      ) {

        continue;
      }

      const yesMarket =
        yesEntry;

      const noMarket =
        noEntry;

      const yesEdge =
        yesModel -
        yesMarket;

      const noEdge =
        noModel -
        noMarket;

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
          yesModel;

        marketProb =
          yesMarket;

        edge =
          yesEdge;

      } else {

        side =
          'no';

        entryPx =
          noEntry;

        modelProb =
          noModel;

        marketProb =
          noMarket;

        edge =
          noEdge;
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

        seriesId:
          inst.seriesId,

        coin,

        underlying,

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
        `[EVENT CANDIDATE ERROR] ${inst.instId}:`,
        err.message
      );
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

  /*
    官方 EVENTS：
      tdMode = isolated
  */

  const tdMode =
    'isolated';

  const lotSz =
    Number(
      inst.lotSz ||
      0.1
    );

  const minSz =
    Number(
      inst.minSz ||
      lotSz
    );

  const tickSz =
    Number(
      inst.tickSz ||
      0.001
    );

  if (
    !(
      candidate.entryPx >
      0 &&
      candidate.entryPx <
      1
    )
  ) {

    throw new Error(
      `Invalid event price: ${candidate.entryPx}`
    );
  }

  /*
    contracts =
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
    sz <
    minSz
  ) {

    sz =
      minSz;
  }

  const px =
    roundToTick(
      candidate.entryPx,
      tickSz
    );

  const requestedNotional =
    px *
    sz;

  console.log(
    '[EVENT ORDER CALC]',
    JSON.stringify({

      stake,

      entryPx:
        candidate.entryPx,

      price:
        px,

      lotSz,

      minSz,

      rawSz,

      contracts:
        sz,

      requestedNotional
    })
  );

  /*
    防止最小 lotSz 導致超過 stake 太多
  */
  if (
    requestedNotional >
    stake * 1.05
  ) {

    throw new Error(
      `Order exceeds stake: ` +
      `stake=${stake.toFixed(4)} ` +
      `notional=${requestedNotional.toFixed(4)}`
    );
  }

  /*
    OKX EVENTS
    tdMode = isolated
    outcome = yes/no

    speedBump 不再送。
  */
  const body = {

    instId:
      inst.instId,

    tdMode:
      tdMode,

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

  console.log(
    '[EVENT ORDER RESPONSE]',
    JSON.stringify(
      result
    )
  );

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

  /*
    等待成交資料
  */
  if (
    result.ordId
  ) {

    await sleep(
      500
    );

    const filled =
      await getOrder(
        inst.instId,
        result.ordId
      );

    console.log(
      '[EVENT ORDER FILLED]',
      JSON.stringify(
        filled
      )
    );

    return {

      ...result,

      ...filled
    };
  }

  return result;
}

/* =========================================================
   GET ORDER
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

  const sz =
    Number(
      position.sz
    );

  if (
    !(sz > 0)
  ) {

    throw new Error(
      `Invalid close size: ${sz}`
    );
  }

  /*
    EVENTS：
      tdMode = isolated
  */
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
      String(sz),

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
    '[EVENT EXIT ORDER]',
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
        px -
        position.entryPx
      ) *
      sz;

    return {

      state:
        'filled',

      avgPx:
        px,

      accFillSz:
        sz,

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

  console.log(
    '[EVENT EXIT RESPONSE]',
    JSON.stringify(
      result
    )
  );

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

  if (
    result.ordId
  ) {

    await sleep(
      500
    );

    const filled =
      await getOrder(
        inst.instId,
        result.ordId
      );

    console.log(
      '[EVENT EXIT FILLED]',
      JSON.stringify(
        filled
      )
    );

    return {

      ...result,

      ...filled
    };
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

    const yesAsk =
      Number(
        ticker?.askPx ||
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
      YES：
        exit reference = YES bid

      NO：
        exit reference =
          1 - YES ask

      用 ask 評估 NO 賣出，
      避免拿錯邊價格。
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
        (
          yesAsk > 0
            ? yesAsk
            : yesBid
        );
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
      '[EVENT POSITION]',
      JSON.stringify({

        instId:
          position.inst.instId,

        side:
          position.side,

        entry:
          position.entryPx,

        current:
          currentPx,

        change:
          (
            change * 100
          ).toFixed(2) +
          '%'
      })
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
      '[EVENT POSITION MANAGER]',
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

  /*
    EVENTS position PnL
    = price difference × contracts
  */
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

    `Entry ${
      position.entryPx.toFixed(4)
    }\n` +

    `Exit ${
      exitPx.toFixed(4)
    }\n` +

    `Contracts ${
      position.sz
    }\n` +

    `PnL ${
      pnl >= 0 ? '+' : ''
    }${pnl.toFixed(4)}U\n` +

    `${
      LIVE_TRADING
        ? 'LIVE'
        : 'PAPER'
    }`
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
    一次只允許一個事件倉位
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
      '[EVENT EQUITY]',
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
    Daily loss
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
      `PnL ${
        state.realizedPnl.toFixed(4)
      }U`
    );

    return;
  }

  let candidates;

  try {

    candidates =
      await scanCandidates();

  } catch (err) {

    console.error(
      '[EVENT SCAN]',
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
  const stake =
    stakeForEquity(
      equity
    );

  if (
    !(
      stake > 0
    )
  ) {

    return;
  }

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

  try {

    const order =
      await placeEventOrder(
        candidate,
        stake
      );

    let filled =
      order;

    /*
      LIVE 再讀一次 order
    */
    if (
      LIVE_TRADING &&
      order?.ordId
    ) {

      await sleep(
        500
      );

      filled =
        await getOrder(
          candidate.inst.instId,
          order.ordId
        );
    }

    /*
      真正成交數量
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
      IOC 完全沒成交
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

    const actualStake =
      avgPx *
      fillSz;

    console.log(
      '[EVENT ACTUAL FILL]',
      JSON.stringify({

        requestedStake:
          stake,

        fillSz,

        avgPx,

        actualStake
      })
    );

    /*
      如果成交量小於要求的 80%，
      不把它當正常倉位。

      這是針對你之前：

        Requested 4.964U
        Actual 0.041U

      的保護。
    */
    const minimumFill =
      stake * 0.80;

    if (
      actualStake <
      minimumFill
    ) {

      console.error(
        `[EVENT] FILL TOO SMALL ` +
        `requested=${stake.toFixed(4)} ` +
        `actual=${actualStake.toFixed(4)}`
      );

      /*
        LIVE：
        嘗試立即平掉異常小倉位。
      */
      if (
        LIVE_TRADING
      ) {

        try {

          await closePosition(

            {
              inst:
                candidate.inst,

              side:
                candidate.side,

              sz:
                fillSz,

              entryPx:
                avgPx
            },

            avgPx
          );

          console.log(
            '[EVENT] Small fill closed'
          );

        } catch (closeErr) {

          console.error(
            '[EVENT] Emergency close:',
            closeErr.message
          );

          /*
            如果平不掉，
            仍然記錄實際倉位，
            避免機器人遺失倉位。
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

          saveState();
        }
      }

      return;
    }

    /*
      正常成交
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

    /*
      Telegram
    */
    await notify(

      `🟡 EVENT ENTRY\n` +

      `${candidate.inst.instId}\n` +

      `${candidate.side.toUpperCase()}\n` +

      `Entry ${
        avgPx.toFixed(4)
      }\n` +

      `Contracts ${
        fillSz
      }\n` +

      `Actual ${
        actualStake.toFixed(4)
      }U\n` +

      `Requested ${
        stake.toFixed(4)
      }U\n` +

      `Score ${
        candidate.score
      }\n` +

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

      `${
        LIVE_TRADING
          ? 'LIVE'
          : 'PAPER'
      }`
    );

  } catch (err) {

    console.error(
      '🔴 EVENT ORDER ERROR',
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

      tdMode:
        'isolated',

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

      tdMode:
        'isolated',

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
   EVENT DISCOVERY DEBUG
========================================================= */

app.get(
  '/event-discovery',
  async (req, res) => {

    try {

      const instruments =
        await discoverEventInstruments();

      res.json({

        ok:
          true,

        count:
          instruments.length,

        instruments:
          instruments
            .slice(
              0,
              100
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

                parsedExpiry:
                  getExpiry(
                    inst
                  ),

                minutesToExpiry:
                  minutesToExpiry(
                    inst
                  ),

                tickSz:
                  inst.tickSz,

                lotSz:
                  inst.lotSz,

                minSz:
                  inst.minSz
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
   MANUAL TEST DISCOVERY
========================================================= */

app.get(
  '/event-test',
  async (req, res) => {

    try {

      const instruments =
        await discoverEventInstruments();

      res.json({

        ok:
          true,

        count:
          instruments.length,

        sample:
          instruments
            .slice(
              0,
              20
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

                tickSz:
                  x.tickSz,

                lotSz:
                  x.lotSz,

                minSz:
                  x.minSz
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
   MAIN LOOP
========================================================= */

let loopRunning =
  false;

async function mainLoop() {

  if (
    loopRunning
  ) {

    console.log(
      '[EVENT] Previous loop still running'
    );

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
      '[EVENT MAIN LOOP]',
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
      `PRODUCT=EVENTS`
    );

    console.log(
      `TD_MODE=isolated`
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
      不自動發 Telegram 測試訊息。
    */
  }
);

/* =========================================================
   INTERVALS
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

mainLoop()
  .catch(
    err =>
      console.error(
        '[EVENT INITIAL LOOP]',
        err
      )
  );
