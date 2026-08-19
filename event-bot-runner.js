'use strict';

// Stable launcher for the OKX Event Contract bot.
// Telegram is notification-only; polling is forcibly disabled.
const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) throw new Error(`找不到 event-bot.js: ${source}`);

  let code = fs.readFileSync(source, 'utf8');

  // Never allow Telegram getUpdates polling in this service.
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

  // ===== Event Contract configuration =====
  code = code.replace(
    'const ORDER_SIZE_FIXED = 5;',
    `const TARGET_STAKE_USDT = Number(process.env.TARGET_STAKE_USDT || 5);\nconst MIN_COMPOSITE_PROB = Number(process.env.MIN_COMPOSITE_PROB || 0.70);\nconst ROLL_BASE_STAKE = TARGET_STAKE_USDT;\nconst ROLL_MULTIPLIER = 1.5;\nconst ROLL_RESET_LOSSES = 6;`
  );

  code = code.replace(
    "Number(\n    process.env.MIN_EDGE || 0.075\n  );",
    "Number(\n    process.env.MIN_EDGE || 0.10\n  );"
  );
  code = code.replace(
    "Number(\n    process.env.MIN_SCORE || 78\n  );",
    "Number(\n    process.env.MIN_SCORE || 85\n  );"
  );
  code = code.replace(
    "Number(\n    process.env.MAX_CONSECUTIVE_LOSSES || 3\n  );",
    "Number(\n    process.env.MAX_CONSECUTIVE_LOSSES || 999999\n  );"
  );

  // ===== Rolling stake state =====
  code = code.replace(
    `trades:\n      []`,
    `trades:\n      [],\n\n    rollStake:\n      ROLL_BASE_STAKE,\n\n    rollStep:\n      0`
  );

  code = code.replace(
    `const state =\n  loadState();`,
    `const state =\n  loadState();\n\nif (!Number.isFinite(Number(state.rollStake)) || Number(state.rollStake) < ROLL_BASE_STAKE) {\n  state.rollStake = ROLL_BASE_STAKE;\n}\nif (!Number.isFinite(Number(state.rollStep)) || Number(state.rollStep) < 0) {\n  state.rollStep = 0;\n}`
  );

  // ===== Correct Event Contract quantity =====
  // sz is contract/share quantity, not USDT. Target stake = entry price * sz.
  // Round UP to the instrument lot size so the target stake is reached.
  code = code.replace(
    'const sz = ORDER_SIZE_FIXED;',
    `const currentRollStake = Math.max(ROLL_BASE_STAKE, Number(state.rollStake || ROLL_BASE_STAKE));\n  const lotSz = Math.max(0.00000001, Number(candidate.inst.lotSz || candidate.inst.minSz || 0.1));\n  const minSz = Math.max(lotSz, Number(candidate.inst.minSz || lotSz));\n  const rawSz = currentRollStake / candidate.entryPx;\n  const roundedSz = Math.ceil(rawSz / lotSz - 1e-12) * lotSz;\n  const sz = Math.max(minSz, Number(roundedSz.toFixed(8)));`
  );

  // Log the exact order-size calculation immediately before placing the order.
  code = code.replace(
    `const body = {\n\n    instId:`,
    `const actualTargetStake = px * sz;\n\n  console.log('[ORDER SIZE]', JSON.stringify({\n    targetStake: currentRollStake,\n    entryPx: px,\n    lotSz,\n    minSz,\n    contracts: sz,\n    actualStake: actualTargetStake\n  }));\n\n  const body = {\n\n    instId:`
  );

  // High-confidence candidate confirmation.
  code = code.replace(
    `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }`,
    `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }\n\n      if (modelProb < MIN_COMPOSITE_PROB) {\n        continue;\n      }\n\n      const requiredConfirmations = ['5m trend', '15m trend', 'RSI', 'volume'];\n      if (!requiredConfirmations.every(x => model.reasons.includes(x))) {\n        continue;\n      }`
  );

  // Event Contract entry: require the full requested quantity to fill.
  code = code.replace(
    `ordType:\n      'ioc',`,
    `ordType:\n      'fok',`
  );

  // Keep close orders IOC so exits can fill immediately.
  // The replacement above intentionally only changes the first matching entry order.

  // Show target and actual stake in Telegram entry notification.
  code = code.replace(
    '`Actual ${actualStake.toFixed(4)}U\\n` +',
    '`Target ${(currentRollStake || ROLL_BASE_STAKE).toFixed(4)}U\\n` +\n\n      `Actual ${actualStake.toFixed(4)}U\\n` +'
  );

  code = code.replace(
    "console.log(`OKX EVENT CONTRACT BOT RUNNING ON PORT ${PORT}`);",
    "console.log(`OKX EVENT CONTRACT BOT RUNNING ON PORT ${PORT}`);\n    console.log(`[CONFIG] BASE=${ROLL_BASE_STAKE}U ROLL=+50% AFTER WIN RESET=${ROLL_RESET_LOSSES} LOSSES MIN_SCORE=${MIN_SCORE} MIN_EDGE=${MIN_EDGE} MIN_MODEL=${MIN_COMPOSITE_PROB}`);\n    console.log('[Telegram] polling forced OFF; entry FOK / exit IOC');"
  );

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
