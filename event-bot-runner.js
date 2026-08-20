'use strict';

/*
  Single-process launcher for the OKX event bot.
  - PAPER only
  - Telegram polling enabled once
  - Bayesian calibration loaded once
  - Prevent duplicate main-loop execution inside one Node process
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

  /* Selection policy: EV is the primary gate. Score is diagnostic only. */
  code = code.replace(/const\s+TARGET_STAKE\s*=\s*[^;]+;/, 'const TARGET_STAKE=1;');
  code = code.replace(/const\s+MIN_ENTRY_PRICE\s*=\s*[^;]+;/, 'const MIN_ENTRY_PRICE=0.25;');
  code = code.replace(/const\s+MAX_ENTRY_PRICE\s*=\s*[^;]+;/, 'const MAX_ENTRY_PRICE=0.40;');
  code = code.replace(/const\s+MIN_SCORE\s*=\s*[^;]+;/, 'const MIN_SCORE=0;');
  code = code.replace(/const\s+MIN_MODEL_PROB\s*=\s*[^;]+;/, 'const MIN_MODEL_PROB=0.75;');
  code = code.replace(/const\s+MIN_EDGE\s*=\s*[^;]+;/, 'const MIN_EDGE=0;');
  code = code.replace(/const\s+MAX_CONSECUTIVE_LOSSES\s*=\s*[^;]+;/, 'const MAX_CONSECUTIVE_LOSSES=3;');

  /* One Bayesian path only: final model probability is for the selected side. */
  const bayesInject = `\n/* [RUNNER MARKET BAYES] */\nconst {calibrateMarketBayes:__calibrateMarketBayes}=require(${JSON.stringify(bayesPath)});\n`;
  const modelCall = /model\s*=\s*modelProbability\s*\(\s*price\s*,\s*strike\s*,\s*c5\s*,\s*c15\s*\)/;
  if (!modelCall.test(code)) throw new Error('[Runner] modelProbability call not found');
  code = code.replace(modelCall, 'model=__calibrateMarketBayes(modelProbability(price,strike,c5,c15),state.trades,marketYesProb,marketNoProb)');
  code = code.replace('const state=loadState();', 'const state=loadState();' + bayesInject);

  /*
     Runtime showed two mainLoop starts at the same millisecond.
     A timer guard alone is insufficient because the source can invoke
     mainLoop directly as well as through an interval. Guard the function
     itself so overlapping/repeated invocations cannot scan twice.
  */
  const mainMarker = 'async function mainLoop() {';
  if (!code.includes(mainMarker)) throw new Error('[Runner] mainLoop marker not found');
  code = code.replace(mainMarker, `async function __mainLoopCore() {`);
  const mainGuard = `
let __mainLoopRunning=false;
async function mainLoop(){
  if(__mainLoopRunning){
    console.error('[Runner] Duplicate mainLoop invocation blocked');
    return;
  }
  __mainLoopRunning=true;
  try{return await __mainLoopCore();}
  finally{__mainLoopRunning=false;}
}
`;
  const intervalMarker = /\n\s*mainLoop\(\);/;
  const intervalMatch = code.match(intervalMarker);
  if (!intervalMatch) throw new Error('[Runner] mainLoop startup marker not found');
  code = code.replace(intervalMarker, mainGuard + '\n  mainLoop();');

  console.log('[Runner] PAPER ONLY');
  console.log('[Runner] Strategy: EV = P / Entry - 1; Score diagnostic only');
  console.log('[Runner] Gates: Model>=75% / EV>0 / Entry 0.25-0.40 / expiry RR>=2');
  console.log('[Runner] Bayesian: technical evidence + empirical prior + market calibration');
  console.log('[Runner] Risk: 1U / 3 consecutive losses -> 30 minute cooldown');
  console.log('[Runner] Trend: 4H+15m main trend / 5m confirmation');
  console.log('[Runner] Telegram: POLLING / singleton protected');
  console.log('[Runner] MainLoop guard: duplicate invocations blocked');

  const m = new Module(source, module);
  m.filename = source;
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(code, source);
} catch (e) {
  console.error('[Runner Error]', e && e.stack || e);
  process.exitCode = 1;
}
