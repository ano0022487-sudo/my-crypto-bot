'use strict';

/*
  OKX EVENT CONTRACT SNR + ROLLING BOT
  2026 API VERSION

  - EVENT CONTRACT ONLY
  - Auto discovers live EVENTS instruments
  - No /api/v5/public/series
  - Uses /api/v5/public/instruments?instType=EVENTS
  - 5m + 15m underlying confirmation
  - EMA20 / EMA50
  - RSI
  - ATR
  - Volume
  - SNR
  - Edge filter
  - Rolling position sizing
  - One event position at a time
  - Early TP / SL
  - Daily loss protection
  - Consecutive loss protection
  - Telegram notifications
  - LIVE_TRADING controlled by environment
*/

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

/* =========================
   BASIC CONFIG
========================= */

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
    .replace(/["']+/g, '');

const TELEGRAM_CHAT_ID =
  String(process.env.TELEGRAM_CHAT_ID || '').trim();

/* =========================
   TIMERS
========================= */

const CHECK_INTERVAL =
  Number(process.env.CHECK_INTERVAL || 15000);

const POSITION_CHECK_INTERVAL =
  Number(process.env.POSITION_CHECK_INTERVAL || 10000);

/* =========================
   RISK
========================= */

const START_CAPITAL =
  Number(process.env.START_CAPITAL || 20);

const RISK_PCT =
  Number(process.env.RISK_PCT || 0.10);

const MAX_STAKE_PCT =
  Number(process.env.MAX_STAKE_PCT || 0.20);

const MIN_STAKE =
  Number(process.env.MIN_STAKE || 1);

const MAX_OPEN_POSITIONS =
  Number(process.env.MAX_OPEN_POSITIONS || 1);

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

/*
  Optional:
  BTC,ETH,SOL
  Leave empty to scan all supported assets.
*/
const EVENT_ASSETS =
  String(process.env.EVENT_ASSETS || 'BTC,ETH,SOL')
    .split(',')
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);

/*
  Optional explicit series.
  Example:
  BTC-UPDOWN-15MIN
  Leave empty for automatic discovery.
*/
const EVENT_SERIES =
  String(process.env.EVENT_SERIES || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

/* =========================
   FILE STATE
========================= */

const BOT_STATE_FILE =
  process.env.BOT_STATE_FILE ||
  path.join(__dirname, 'event-bot-state.json');

/* =========================
   UNDERLYING
========================= */

const UNDERLYING_MAP = {
  BTC: 'BTC-USDT-SWAP',
  ETH: 'ETH-USDT-SWAP',
  SOL: 'SOL-USDT-SWAP'
};

/* =========================
   TELEGRAM
========================= */

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

/* =========================
   HTTP
========================= */

function q(params) {
  return Object.entries(params)
    .filter(([, v]) =>
      v !== undefined &&
      v !== null &&
      v !== ''
    )
    .map(
      ([k, v]) =>
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
        await new Promise(
          r => setTimeout(r, 500 * (i + 1))
        );
      }
    }
  }

  throw lastError;
}

/* =========================
   PUBLIC API
========================= */

async function publicGet(
  pathname,
  params = {}
) {
  const query =
    Object.keys(params).length
      ? `?${q(params)}`
      : '';

  const r = await request({
    method: 'GET',
    url: `${BASE_URL}${pathname}${query}`
  });

  if (
    !r.data ||
    String(r.data.code) !== '0'
  ) {
    throw new Error(
      `OKX public error ${r.status}: ${JSON.stringify(r.data)}`
    );
  }

  return r.data.data;
}

/* =========================
   SIGNATURE
========================= */

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

/* =========================
   PRIVATE API
========================= */

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
      `OKX private error ${r.status}: ${JSON.stringify(r.data)}`
    );
  }

  return Array.isArray(r.data.data)
    ? r.data.data
    : [];
}

/* =========================
   STATE
========================= */

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
  } catch (e) {
    console.error(
      'State load:',
      e.message
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
  } catch (e) {
    console.error(
      'State save:',
      e.message
    );
  }
}

/* =========================
   DAILY RESET
========================= */

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

/* =========================
   CANDLE HELPERS
========================= */

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

/* =========================
   EMA
========================= */

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

  let value =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) /
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

/* =========================
   RSI
========================= */

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

    if (d >= 0)
      gains += d;
    else
      losses -= d;
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
      ) /
      period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        Math.max(-d, 0)
      ) /
      period;
  }

  if (avgLoss === 0)
    return 100;

  return (
    100 -
    100 /
      (
        1 +
        avgGain /
          avgLoss
      )
  );
}

/* =========================
   ATR
========================= */

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
      Number(
        candles[i - 1][4]
      );

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

/* =========================
   CONFIRMED CANDLES
========================= */

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

/* =========================
   PIVOTS
========================= */

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
          i +
            lookback +
            1
        )
      );

    const lo =
      Math.min(
        ...l.slice(
          i - lookback,
          i +
            lookback +
            1
        )
      );

    if (h[i] === hi)
      resistance.push(
        h[i]
      );

    if (l[i] === lo)
      support.push(
        l[i]
      );
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
  return (
    levels
      .filter(
        x => x > price
      )
      .sort(
        (a, b) => a - b
      )[0] ||
    null
  );
}

function nearestBelow(
  levels,
  price
) {
  return (
    levels
      .filter(
        x => x < price
      )
      .sort(
        (a, b) => b - a
      )[0] ||
    null
  );
}

/* =========================
   MARKET DATA
========================= */

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
        instId
      }
    );

  return rows[0] || null;
}

/* =========================
   EVENTS DISCOVERY
========================= */

/*
  IMPORTANT:
  Do NOT call:
    /api/v5/public/series

  We discover live event instruments directly.
*/

async function discoverEventInstruments() {
  const rows =
    await publicGet(
      '/api/v5/public/instruments',
      {
        instType: 'EVENTS'
      }
    );

  return Array.isArray(rows)
    ? rows
    : [];
}

function seriesAllowed(
  inst
) {
  if (
    !EVENT_SERIES.length
  ) {
    return true;
  }

  const series =
    String(
      inst.seriesId ||
      ''
    );

  return EVENT_SERIES.includes(
    series
  );
}

function assetAllowed(
  inst
) {
  const text =
    `${inst.baseCcy || ''} ${
      inst.instId || ''
    } ${
      inst.seriesId || ''
    }`.toUpperCase();

  return EVENT_ASSETS.some(
    coin =>
      text.includes(
        coin
      )
  );
}

function eventExpiry(
  inst
) {
  const candidates = [
    Number(inst.expTime),
    Number(inst.expiryTime),
    Number(inst.endTime)
  ].filter(
    Number.isFinite
  );

  return candidates.length
    ? Math.max(
        ...candidates
      )
    : null;
}

function allowedExpiry(
  inst
) {
  const exp =
    eventExpiry(inst);

  if (!exp)
    return false;

  const minutes =
    (
      exp -
      Date.now()
    ) /
    60000;

  return (
    minutes >=
      MIN_MINUTES_TO_EXPIRY &&
    minutes <=
      MAX_MINUTES_TO_EXPIRY
  );
}

/* =========================
   EVENT TYPE
========================= */

function baseAsset(
  inst
) {
  const text =
    `${inst.baseCcy || ''} ${
      inst.instId || ''
    } ${
      inst.seriesId || ''
    }`.toUpperCase();

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

function eventType(
  inst
) {
  const text =
    `${inst.seriesId || ''} ${
      inst.instId || ''
    } ${
      inst.ruleType || ''
    }`.toUpperCase();

  /*
    UP / ABOVE = YES means upward outcome
    DOWN / BELOW = YES means downward outcome
  */

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

/* =========================
   STRIKE / TARGET
========================= */

function strike(
  inst
) {
  const fields = [
    'stk',
    'strike',
    'strikePx',
    'targetPx',
    'triggerPx',
    'barrier',
    'threshold'
  ];

  for (
    const key of fields
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

  /*
    Try numeric fields from
    nested / alternative OKX
    event structures.
  */

  const nested = [
    inst.target,
    inst.targetPrice,
    inst.thresholdPx
  ];

  for (
    const value of nested
  ) {
    const n =
      Number(value);

    if (
      Number.isFinite(n) &&
      n > 0
    ) {
      return n;
    }
  }

  return null;
}

/* =========================
   PRICE
========================= */

function validPrice(
  price
) {
  return (
    Number.isFinite(price) &&
    price >
      MIN_ENTRY_PRICE &&
    price <
      MAX_ENTRY_PRICE
  );
}

function marketProbability(
  price,
  outcome
) {
  if (
    !(price > 0) ||
    !(price < 1)
  ) {
    return null;
  }

  return outcome === 'yes'
    ? price
    : 1 - price;
}

/* =========================
   MODEL
========================= */

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

  const recentVolumes =
    vol5.slice(-20);

  const avgVol =
    recentVolumes.length
      ? recentVolumes.reduce(
          (a, b) => a + b,
          0
        ) /
        recentVolumes.length
      : 0;

  const lastVol =
    vol5[vol5.length - 1];

  const volRatio =
    avgVol > 0
      ? lastVol / avgVol
      : 1;

  let score = 50;

  const reasons = [];

  const bullish =
    direction ===
    'ABOVE';

  const trend5 =
    bullish
      ? ema20_5 >
        ema50_5
      : ema20_5 <
        ema50_5;

  const trend15 =
    bullish
      ? ema20_15 >
        ema50_15
      : ema20_15 <
        ema50_15;

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

  if (
    volRatio >=
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
    !bullish &&
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
      ) / price;

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
      !bullish &&
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
      atr5 / price;

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
        0.90,
        0.50 +
          (
            score - 50
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

/* =========================
   EQUITY
========================= */

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

  const details =
    rows[0]?.details || [];

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

/* =========================
   STAKE
========================= */

function stakeForEquity(
  equity
) {
  const risk =
    equity *
    RISK_PCT;

  const maximum =
    equity *
    MAX_STAKE_PCT;

  return Math.max(
    MIN_STAKE,
    Math.min(
      maximum,
      risk
    )
  );
}

/* =========================
   ROUNDING
========================= */

function decimalsForStep(
  step
) {
  const text =
    String(step);

  if (
    !text.includes('.')
  ) {
    return 0;
  }

  return text.split(
    '.'
  )[1].length;
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

  const result =
    Math.floor(
      value / step
    ) * step;

  return Number(
    result.toFixed(
      decimalsForStep(
        step
      )
    )
  );
}

/* =========================
   ORDER SIZE
========================= */

function calculateContracts(
  stake,
  price,
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

  /*
    Events:
    sz = number of contracts

    Capital used ≈
    contracts × YES/NO price
  */

  const raw =
    stake /
    price;

  let sz =
    roundDown(
      raw,
      lotSz
    );

  /*
    If rounding produces
    less than minimum,
    use minimum only if
    it stays within budget.
  */

  if (
    sz <
    minSz
  ) {
    if (
      minSz *
        price <=
      stake *
        1.01
    ) {
      sz = minSz;
    } else {
      return {
        sz: 0,
        lotSz,
        minSz,
        required:
          minSz *
          price
      };
    }
  }

  return {
    sz,
    lotSz,
    minSz,
    required:
      sz * price
  };
}

/* =========================
   SCAN CANDIDATES
========================= */

async function scanCandidates() {
  let instruments;

  try {
    instruments =
      await discoverEventInstruments();
  } catch (e) {
    console.error(
      'EVENT discovery:',
      e.message
    );

    return [];
  }

  const live =
    instruments.filter(
      inst => {
        if (
          inst.state &&
          inst.state !==
            'live'
        ) {
          return false;
        }

        if (
          !assetAllowed(
            inst
          )
        ) {
          return false;
        }

        if (
          !seriesAllowed(
            inst
          )
        ) {
          return false;
        }

        if (
          !allowedExpiry(
            inst
          )
        ) {
          return false;
        }

        return true;
      }
    );

  const candidates = [];

  /*
    Avoid hammering OKX:
    only inspect a reasonable
    number of nearest live
    contracts.
  */

  const selected =
    live
      .sort(
        (a, b) =>
          (
            eventExpiry(a) ||
            Infinity
          ) -
          (
            eventExpiry(b) ||
            Infinity
          )
      )
      .slice(
        0,
        50
      );

  for (
    const inst of selected
  ) {
    const coin =
      baseAsset(inst);

    const direction =
      eventType(inst);

    if (
      !coin ||
      direction ===
        'UNKNOWN'
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

    try {
      const [
        eventTicker,
        c5,
        c15
      ] =
        await Promise.all([
          ticker(
            inst.instId
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

      const ask =
        yesAsk > 0
          ? yesAsk
          : yesLast;

      const bid =
        yesBid > 0
          ? yesBid
          : yesLast;

      if (
        !(
          ask > 0 &&
          bid > 0
        )
      ) {
        continue;
      }

      /*
        For an ABOVE / UP event:
        YES = bullish outcome.

        For BELOW / DOWN:
        NO = bearish outcome.
      */

      const side =
        direction ===
        'ABOVE'
          ? 'yes'
          : 'no';

      const entryPx =
        side === 'yes'
          ? ask
          : 1 - bid;

      if (
        !validPrice(
          entryPx
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

      const strikePx =
        strike(inst);

      /*
        If OKX did not expose
        a strike field, don't
        reject the contract.
      */

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
        marketProb ===
        null
      ) {
        continue;
      }

      const edge =
        model.probability -
        marketProb;

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
        direction,
        side,
        entryPx,
        modelProb:
          model.probability,
        marketProb,
        edge,
        score:
          model.score,
        reasons:
          model.reasons,
        underlyingPrice,
        strikePx
      });
    } catch (e) {
      /*
        Do not kill entire scan
        because one expired or
        unavailable market failed.
      */

      console.error(
        `Candidate ${inst.instId}:`,
        e.message
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

/* =========================
   PLACE EVENT ORDER
========================= */

async function placeEventOrder(
  candidate,
  stake
) {
  const inst =
    candidate.inst;

  const sizing =
    calculateContracts(
      stake,
      candidate.entryPx,
      inst
    );

  if (
    !(sizing.sz > 0)
  ) {
    throw new Error(
      `Stake too small. ` +
      `stake=${stake.toFixed(4)} ` +
      `price=${candidate.entryPx.toFixed(4)} ` +
      `minSz=${sizing.minSz} ` +
      `required=${Number(
        sizing.required || 0
      ).toFixed(4)}`
    );
  }

  const body = {
    instId:
      inst.instId,

    /*
      Events are not isolated
      perpetual margin positions.
      Keep cash.
    */
    tdMode:
      'cash',

    side:
      'buy',

    ordType:
      'ioc',

    px:
      candidate.entryPx.toFixed(6),

    sz:
      String(
        sizing.sz
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
  };

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
        candidate.entryPx,

      accFillSz:
        sizing.sz,

      simulated:
        true,

      body,

      stake,
      contracts:
        sizing.sz,
      notional:
        sizing.required
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
    String(
      result.sCode
    ) !== '0'
  ) {
    throw new Error(
      `Order rejected: ${JSON.stringify(
        result
      )}`
    );
  }

  return {
    ...result,
    requestedStake:
      stake,
    requestedContracts:
      sizing.sz,
    requestedNotional:
      sizing.required
  };
}

/* =========================
   GET ORDER
========================= */

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

/* =========================
   POSITIONS
========================= */

async function getEventPositions(
  instId = null
) {
  const query = {
    instType:
      'EVENTS'
  };

  if (
    instId
  ) {
    query.instId =
      instId;
  }

  return privateRequest(
    'GET',
    `/api/v5/account/positions?${q(
      query
    )}`
  );
}

/* =========================
   CLOSE POSITION
========================= */

async function closePosition(
  position,
  currentPx
) {
  /*
    Events use:
      side=sell
      outcome=yes/no

    tdMode remains cash.
  */

  const body = {
    instId:
      position.inst.instId,

    tdMode:
      'cash',

    side:
      'sell',

    ordType:
      'ioc',

    px:
      Number(
        currentPx
      ).toFixed(6),

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
      `Exit rejected: ${JSON.stringify(
        result
      )}`
    );
  }

  return result;
}

/* =========================
   POSITION MANAGER
========================= */

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
        p.inst.instId
      );

    const yesBid =
      Number(
        t?.bidPx
      );

    const yesLast =
      Number(
        t?.last
      );

    const marketBid =
      yesBid > 0
        ? yesBid
        : yesLast;

    if (
      !(
        marketBid > 0
      )
    ) {
      return;
    }

    const currentBid =
      p.side === 'yes'
        ? marketBid
        : 1 - marketBid;

    const change =
      (
        currentBid -
        p.entryPx
      ) /
      p.entryPx;

    /*
      EARLY TP
    */

    if (
      change >=
      EARLY_TP_PCT
    ) {
      await exitPosition(
        p,
        currentBid,
        'EARLY_TP'
      );

      return;
    }

    /*
      EARLY SL
    */

    if (
      change <=
      -EARLY_SL_PCT
    ) {
      await exitPosition(
        p,
        currentBid,
        'EARLY_SL'
      );

      return;
    }

    /*
      Expiry protection
    */

    const exp =
      eventExpiry(
        p.inst
      );

    if (exp) {
      const minutes =
        (
          exp -
          Date.now()
        ) /
        60000;

      /*
        Don't carry too close
        to expiry.
      */

      if (
        minutes <= 1
      ) {
        await exitPosition(
          p,
          currentBid,
          'EXPIRY_PROTECTION'
        );
      }
    }
  } catch (e) {
    console.error(
      'Position manager:',
      e.message
    );
  }
}

/* =========================
   EXIT POSITION
========================= */

async function exitPosition(
  p,
  currentPx,
  reason
) {
  const result =
    await closePosition(
      p,
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
      p.entryPx
    ) *
    p.sz;

  state.realizedPnl +=
    pnl;

  state.paperEquity =
    Math.max(
      0,
      Number(
        state.paperEquity ||
          START_CAPITAL
      ) +
        pnl
    );

  state.consecutiveLosses =
    pnl < 0
      ? state.consecutiveLosses + 1
      : 0;

  state.trades.push({
    at:
      new Date()
        .toISOString(),

    instId:
      p.inst.instId,

    side:
      p.side,

    entryPx:
      p.entryPx,

    exitPx,

    sz:
      p.sz,

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
    `${p.inst.instId}\n` +
    `${p.side.toUpperCase()}\n` +
    `Reason ${reason}\n` +
    `Entry ${p.entryPx.toFixed(4)}\n` +
    `Exit ${exitPx.toFixed(4)}\n` +
    `Contracts ${p.sz}\n` +
    `PnL ${
      pnl >= 0
        ? '+'
        : ''
    }${pnl.toFixed(3)}U\n` +
    `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
  );
}

/* =========================
   TRADE
========================= */

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
    DAILY LOSS
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
      `PnL ${state.realizedPnl.toFixed(3)}U`
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

  const stake =
    Math.min(
      stakeForEquity(
        equity
      ),
      equity
    );

  try {
    const order =
      await placeEventOrder(
        c,
        stake
      );

    let filled =
      order;

    if (
      LIVE_TRADING &&
      order.ordId
    ) {
      await new Promise(
        r =>
          setTimeout(
            r,
            1000
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
        filled?.sz ||
        0
      );

    const avgPx =
      Number(
        filled?.avgPx ||
        filled?.fillPx ||
        c.entryPx
      );

    if (
      !(fillSz > 0)
    ) {
      console.error(
        'Order has no fill:',
        JSON.stringify(
          filled
        )
      );

      return;
    }

    const actualNotional =
      fillSz *
      avgPx;

    state.position = {
      inst:
        c.inst,

      side:
        c.side,

      sz:
        fillSz,

      entryPx:
        avgPx,

      stake:
        actualNotional,

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
      `Contracts ${fillSz}\n` +
      `Actual Stake ${actualNotional.toFixed(3)}U\n` +
      `Requested Stake ${stake.toFixed(3)}U\n` +
      `Score ${c.score}\n` +
      `Model ${(c.modelProb * 100).toFixed(1)}%\n` +
      `Market ${(c.marketProb * 100).toFixed(1)}%\n` +
      `Edge ${(c.edge * 100).toFixed(1)}%\n` +
      `Reason ${c.reasons.join(', ')}\n` +
      `${LIVE_TRADING ? 'LIVE' : 'PAPER'}`
    );
  } catch (e) {
    console.error(
      'Trade:',
      e.message
    );
  }
}

/* =========================
   HTTP
========================= */

app.get(
  '/',
  (req, res) => {
    res.json({
      ok: true,

      bot:
        'OKX Event Contract SNR Rolling Bot',

      live:
        LIVE_TRADING,

      baseUrl:
        BASE_URL,

      position:
        state.position
          ? {
              instId:
                state.position
                  .inst.instId,

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
  (req, res) => {
    res.json({
      ok: true,
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
    res.json({
      live:
        LIVE_TRADING,

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

      eventAssets:
        EVENT_ASSETS,

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

/*
  Useful diagnostic endpoint.
  Browser:
  /events
*/

app.get(
  '/events',
  async (req, res) => {
    try {
      const instruments =
        await discoverEventInstruments();

      const result =
        instruments
          .filter(
            assetAllowed
          )
          .filter(
            seriesAllowed
          )
          .filter(
            allowedExpiry
          )
          .slice(
            0,
            100
          )
          .map(
            x => ({
              instId:
                x.instId,

              seriesId:
                x.seriesId,

              baseCcy:
                x.baseCcy,

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
          );

      res.json({
        ok: true,
        count:
          result.length,
        events:
          result
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error:
          e.message
      });
    }
  }
);

/* =========================
   MAIN LOOP
========================= */

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
      e.message ||
        e
    );
  }
}

/* =========================
   START
========================= */

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
      `EVENT_ASSETS=${EVENT_ASSETS.join(',')}`
    );

    console.log(
      'EVENT API discovery = /api/v5/public/instruments?instType=EVENTS'
    );
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
  e =>
    console.error(
      e
    )
);
