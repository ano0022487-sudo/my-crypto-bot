'use strict';

/*
  Single-process launcher for the OKX event bot.
  - PAPER only
  - Telegram polling enabled once
  - Bayesian calibration loaded once
  - Prevent duplicate 15s main-loop timers inside one Node process
  - No fragile formula-marker replacement
*/
const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');
const bayesPath = path.join(__dirname, 'market-bayes.js');
const LOCK = '/tmp/okx-event-bot.singleton.lock';
const CHECK_MS = Number(process.env.CHECK_INTERVAL || 15000);

let fd = null;
function acquire() {
  try {
    fd = fs.openSync(LOCK, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    const release = () => {
      try { if (fd !== null) fs.closeSync(fd); } catch {}
      try { if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK); } catch {}
    };
    process.once('exit', release);
    process.once('SIGTERM', () => { release(); process.exit(0); });
    process.once('SIGINT', () => { release(); process.exit(0); });
    console.log('[Runner] Singleton lock acquired pid=' + process.pid);
    return true;
  } catch (e) {
    try {
      const p = Number(fs.readFileSync(LOCK, 'utf8').trim());
      if (p > 0) {
        try {
          process.kill(p, 0);
          console.error('[Runner] Another bot process is already running pid=' + p + '; refusing duplicate startup.');
          return false;
        } catch {}
      }
    } catch {}
    try { fs.unlinkSync(LOCK); } catch {}
    return acquire();
  }
}

if (!acquire()) {
  process.exitCode = 0;
  return;
}

if (!fs.existsSync(source)) throw new Error('[Runner] event-bot.js not found');
if (!fs.existsSync(bayesPath)) throw new Error('[Runner] market-bayes.js not found');

try {
  let code = fs.readFileSync(source, 'utf8');

  /* Hard safety: this launcher is always PAPER. */
  code = code.replace(/const\s+LIVE_TRADING\s*=\s*[^;]+;/, 'const LIVE_TRADING = false;');
  code = code.replace(/polling\s*:\s*(true|false)/g, 'polling: true');

  /* Keep the configured risk/selection gates deterministic. */
  code = code.replace(/const\s+TARGET_STAKE\s*=\s*[^;]+;/, 'const TARGET_STAKE=1;');
  code = code.replace(/const\s+MIN_ENTRY_PRICE\s*=\s*[^;]+;/, 'const MIN_ENTRY_PRICE=0.25;');
  code = code.replace(/const\s+MAX_ENTRY_PRICE\s*=\s*[^;]+;/, 'const MAX_ENTRY_PRICE=0.40;');
  code = code.replace(/const\s+MIN_SCORE\s*=\s*[^;]+;/, 'const MIN_SCORE=90;');
  code = code.replace(/const\s+MIN_MODEL_PROB\s*=\s*[^;]+;/, 'const MIN_MODEL_PROB=0.75;');
  code = code.replace(/const\s+MIN_EDGE\s*=\s*[^;]+;/, 'const MIN_EDGE=0.15;');
  code = code.replace(/const\s+MAX_CONSECUTIVE_LOSSES\s*=\s*[^;]+;/, 'const MAX_CONSECUTIVE_LOSSES=3;');

  /* One Bayesian path only: final model probability is for the selected side. */
  const bayesInject = `\n/* [RUNNER MARKET BAYES] */\nconst {calibrateMarketBayes:__calibrateMarketBayes}=require(${JSON.stringify(bayesPath)});\n`;
  const modelCall = /model\s*=\s*modelProbability\s*\(\s*price\s*,\s*strike\s*,\s*c5\s*,\s*c15\s*\)/;
  if (!modelCall.test(code)) throw new Error('[Runner] modelProbability call not found');
  code = code.replace(modelCall, 'model=__calibrateMarketBayes(modelProbability(price,strike,c5,c15),state.trades,marketYesProb,marketNoProb)');
  code = code.replace('const state=loadState();', 'const state=loadState();' + bayesInject);

  /*
     The log showed two mainLoop starts at the same millisecond.
     Deduplicate only the 15s scan timer. Keep the 5s position timer intact.
  */
  const realSetInterval = global.setInterval;
  let scanTimerCreated = false;
  global.setInterval = function guardedSetInterval(fn, delay, ...args) {
    const ms = Number(delay);
    if (ms === CHECK_MS) {
      if (scanTimerCreated) {
        console.error('[Runner] Duplicate scan timer blocked delay=' + ms + 'ms');
        return { unref() {}, ref() {}, hasRef() { return false; } };
      }
      scanTimerCreated = true;
      console.log('[Runner] Main scan timer registered once delay=' + ms + 'ms');
    }
    return realSetInterval(fn, delay, ...args);
  };

  console.log('[Runner] PAPER ONLY');
  console.log('[Runner] Strategy source: event-bot.js');
  console.log('[Runner] Bayesian: technical evidence + empirical prior + market calibration');
  console.log('[Runner] Risk: 1U / Score>=90 / Model>=75% / Edge>=15% / Entry 0.25-0.40');
  console.log('[Runner] Trend: 4H+15m main trend / 5m confirmation when supplied by launcher');
  console.log('[Runner] Telegram: POLLING / singleton protected');
  console.log('[Runner] Timer guard: duplicate 15s scan loops blocked');

  const m = new Module(source, module);
  m.filename = source;
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(code, source);
} catch (e) {
  console.error('[Runner Error]', e && e.stack || e);
  process.exitCode = 1;
}
