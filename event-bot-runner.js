'use strict';

/*
  OKX Event Contract launcher

  IMPORTANT:
  - index.js starts this file.
  - This runner loads event-bot.js and applies ONLY safe configuration
    replacements before compiling it.
  - No Telegram message/template rewriting is performed here.
  - Telegram polling is disabled because Telegram is notification-only.
*/

const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');

function replaceOrThrow(code, target, replacement, label) {
  if (!code.includes(target)) {
    throw new Error(`[Runner] required pattern not found: ${label}`);
  }
  return code.replace(target, replacement);
}

try {
  if (!fs.existsSync(source)) {
    throw new Error(`找不到 event-bot.js: ${source}`);
  }

  let code = fs.readFileSync(source, 'utf8');

  /* =========================================================
     TELEGRAM: notification-only, never getUpdates polling
  ========================================================= */

  code = code.replace(/polling\s*:\s*true/g, 'polling: false');

  try {
    const TelegramBot = require('node-telegram-bot-api');
    TelegramBot.prototype.startPolling = async function () {
      console.log('[Telegram] polling disabled; notification-only mode');
      return this;
    };
  } catch (err) {
    console.error('[Runner Telegram Patch Error]', err.message || err);
  }

  /* =========================================================
     EVENT CONTRACT SETTINGS
  ========================================================= */

  code = replaceOrThrow(
    code,
    'const ORDER_SIZE_FIXED = 5;',
    `const TARGET_STAKE_USDT = Number(process.env.TARGET_STAKE_USDT || 5);
const MIN_COMPOSITE_PROB = Number(process.env.MIN_COMPOSITE_PROB || 0.70);
const ROLL_BASE_STAKE = TARGET_STAKE_USDT;
const ROLL_MULTIPLIER = 1.5;
const ROLL_RESET_LOSSES = 6;`,
    'ORDER_SIZE_FIXED'
  );

  code = code.replace(
    /const MIN_EDGE =\s*Number\(\s*process\.env\.MIN_EDGE \|\| 0\.075\s*\);/s,
    `const MIN_EDGE = Number(process.env.MIN_EDGE || 0.10);`
  );

  code = code.replace(
    /const MIN_SCORE =\s*Number\(\s*process\.env\.MIN_SCORE \|\| 78\s*\);/s,
    `const MIN_SCORE = Number(process.env.MIN_SCORE || 85);`
  );

  code = code.replace(
    /const MAX_CONSECUTIVE_LOSSES =\s*Number\(\s*process\.env\.MAX_CONSECUTIVE_LOSSES \|\| 3\s*\);/s,
    `const MAX_CONSECUTIVE_LOSSES = Number(process.env.MAX_CONSECUTIVE_LOSSES || 999999);`
  );

  /* =========================================================
     ROLLING STAKE STATE
  ========================================================= */

  code = replaceOrThrow(
    code,
    `trades:\n      []`,
    `trades:
      [],

    rollStake:
      ROLL_BASE_STAKE,

    rollStep:
      0`,
    'state.trades'
  );

  code = replaceOrThrow(
    code,
    `const state =\n  loadState();`,
    `const state =
  loadState();

if (!Number.isFinite(Number(state.rollStake)) || Number(state.rollStake) < ROLL_BASE_STAKE) {
  state.rollStake = ROLL_BASE_STAKE;
}
if (!Number.isFinite(Number(state.rollStep)) || Number(state.rollStep) < 0) {
  state.rollStep = 0;
}`,
    'state initialization'
  );

  /* =========================================================
     CORRECT EVENT CONTRACT QUANTITY

     OKX event-contract sz is contract/share quantity.
     Target USDT stake = entry price * contracts.
     Always round UP to the instrument lot size.
  ========================================================= */

  code = replaceOrThrow(
    code,
    'const sz = ORDER_SIZE_FIXED;',
    `const currentRollStake = Math.max(
    ROLL_BASE_STAKE,
    Number(state.rollStake || ROLL_BASE_STAKE)
  );

  const lotSz = Math.max(
    0.00000001,
    Number(candidate.inst.lotSz || candidate.inst.minSz || 0.1)
  );

  const minSz = Math.max(
    lotSz,
    Number(candidate.inst.minSz || lotSz)
  );

  const rawSz = currentRollStake / candidate.entryPx;
  const roundedSz = Math.ceil(rawSz / lotSz - 1e-12) * lotSz;
  const sz = Math.max(
    minSz,
    Number(roundedSz.toFixed(8))
  );`,
    'order quantity'
  );

  /* =========================================================
     ENTRY ORDER: FOK
  ========================================================= */

  code = replaceOrThrow(
    code,
    `ordType:\n      'ioc',`,
    `ordType:
      'fok',`,
    'entry order type'
  );

  /* =========================================================
     HIGH-CONFIDENCE FILTER
  ========================================================= */

  code = replaceOrThrow(
    code,
    `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }`,
    `if (
        model.score <
        MIN_SCORE
      ) {

        continue;
      }

      if (modelProb < MIN_COMPOSITE_PROB) {
        continue;
      }

      const requiredConfirmations = [
        '5m trend',
        '15m trend',
        'RSI',
        'volume'
      ];

      if (!requiredConfirmations.every(
        reason => model.reasons.includes(reason)
      )) {
        continue;
      }`,
    'high-confidence filter'
  );

  /* =========================================================
     DIAGNOSTIC LOGGING
  ========================================================= */

  code = replaceOrThrow(
    code,
    `const body = {\n\n    instId:`,
    `const actualTargetStake = px * sz;

  console.log('[ORDER SIZE]', JSON.stringify({
    targetStake: currentRollStake,
    entryPx: px,
    lotSz,
    minSz,
    contracts: sz,
    actualStake: actualTargetStake
  }));

  const body = {

    instId:`,
    'order-size diagnostic'
  );

  /* =========================================================
     STARTUP DIAGNOSTICS
  ========================================================= */

  code = code.replace(
    /console\.log\(`OKX EVENT CONTRACT BOT RUNNING ON PORT \$\{PORT\}`\);/,
    `console.log(\`OKX EVENT CONTRACT BOT RUNNING ON PORT \${PORT}\`);
    console.log(\`[CONFIG] TARGET=\${ROLL_BASE_STAKE}U ROLL=+50% MIN_SCORE=\${MIN_SCORE} MIN_EDGE=\${MIN_EDGE} MIN_MODEL=\${MIN_COMPOSITE_PROB}\`);
    console.log('[Telegram] polling forced OFF; entry FOK / exit IOC');`
  );

  /* =========================================================
     COMPILE
  ========================================================= */

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
