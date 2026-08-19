'use strict';

// Stable launcher for the OKX Event Contract bot.
const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) throw new Error(`找不到 event-bot.js: ${source}`);

  let code = fs.readFileSync(source, 'utf8');

  // ===== Telegram: notification-only. NEVER start getUpdates polling. =====
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

  // ===== High-confidence Event Contract rules =====
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

  // Rolling stake: each win increases the next stake by 50%.
  code = code.replace(
    `trades:\n      []`,
    `trades:\n      [],\n\n    rollStake:\n      ROLL_BASE_STAKE,\n\n    rollStep:\n      0`
  );

  code = code.replace(
    `const state =\n  loadState();`,
    `const state =\n  loadState();\n\nif (!Number.isFinite(Number(state.rollStake)) || Number(state.rollStake) < ROLL_BASE_STAKE) {\n  state.rollStake = ROLL_BASE_STAKE;\n}\nif (!Number.isFinite(Number(state.rollStep)) || Number(state.rollStep) < 0) {\n  state.rollStep = 0;\n}`
  );

  // ===== Correct Event Contract quantity =====
  // Event-contract sz is the number of shares/contracts, not USDT.
  // Target stake = price * contracts. Round UP to the instrument lot size
  // so the requested stake is reached rather than silently under-sizing.
  code = code.replace(
    'const sz = ORDER_SIZE_FIXED;',
    `const currentRollStake = Math.max(ROLL_BASE_STAKE, Number(state.rollStake || ROLL_BASE_STAKE));\n  const lotSz = Math.max(0.00000001, Number(candidate.inst.lotSz || candidate.inst.minSz || 0.1));\n  const minSz = Math.max(lotSz, Number(candidate.inst.minSz || lotSz));\n  const rawSz = currentRollStake / candidate.entryPx;\n  const roundedSz = Math.ceil(rawSz / lotSz - 1e-12) * lotSz;\n  const sz = Math.max(minSz, roundedSz);`
  );

  // Add a safety log immediately before placing the order.
  code = code.replace(
    `const body = {\n\n    instId:`,
    `const actualTargetStake = px * sz;\n\n  console.log(\n    '[ORDER SIZE]',\n    JSON.stringify({\n      targetStake: currentRollStake,\n      entryPx: px,\n      lotSz,\n      minSz,\n      contracts: sz,\n      actualStake: actualTargetStake\n    })\n  );\n\n  const body = {\n\n    instId:`
  );

  // High-confidence candidate confirmation.
  code = code.replace(
    `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }`,
    `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }\n\n      if (modelProb < MIN_COMPOSITE_PROB) {\n        continue;\n      }\n\n      const requiredConfirmations = ['5m trend', '15m trend', 'RSI', 'volume'];\n      if (!requiredConfirmations.every(x => model.reasons.includes(x))) {\n        continue;\n      }`
  );

  // OKX EVENTS non-post-only order parameter.
  code = code.replace(
    `outcome:\n      candidate.side,\n\n    clOrdId:`,
    `outcome:\n      candidate.side,\n\n    speedBump:\n      '1',\n\n    clOrdId:`
  );
  code = code.replace(
    `outcome:\n      position.side,\n\n    clOrdId:`,
    `outcome:\n      position.side,\n\n    speedBump:\n      '1',\n\n    clOrdId:`
  );

  // After each result: win => +50% next stake; 6 losses => reset to base.
  code = code.replace(
    `if (\n    pnl < 0\n  ) {\n\n    state.consecutiveLosses++;\n\n  } else {\n\n    state.consecutiveLosses =\n      0;\n  }`,
    `if (pnl < 0) {\n    state.consecutiveLosses++;\n\n    if (state.consecutiveLosses >= ROLL_RESET_LOSSES) {\n      state.rollStep = 0;\n      state.rollStake = ROLL_BASE_STAKE;\n      state.consecutiveLosses = 0;\n      state.halted = false;\n      console.log('[ROLLING] consecutive-loss reset -> base stake');\n    }\n  } else {\n    state.consecutiveLosses = 0;\n    state.rollStep = Number(state.rollStep || 0) + 1;\n    state.rollStake = ROLL_BASE_STAKE * Math.pow(ROLL_MULTIPLIER, state.rollStep);\n  }`
  );

  // Show target and actual stake in Telegram entry notification.
  code = code.replace(
    `await notify(\n\n      \`🟡 EVENT ENTRY\\n\` +`,
    `await notify(\n\n      \`🟡 EVENT ENTRY\\n\` +`
  );

  code = code.replace(
    `\`Actual ${\n        actualStake.toFixed(4)\n      }U\\n\` +`,
    `\`Target ${\n        (state.rollStake || ROLL_BASE_STAKE).toFixed(4)\n      }U\\n\` +\n\n      \`Actual ${\n        actualStake.toFixed(4)\n      }U\\n\` +`
  );

  code = code.replace(
    "console.log(`OKX EVENT CONTRACT BOT RUNNING ON PORT ${PORT}`);",
    "console.log(`OKX EVENT CONTRACT BOT RUNNING ON PORT ${PORT}`);\n    console.log(`[CONFIG] BASE=${ROLL_BASE_STAKE}U ROLL=+50% AFTER WIN RESET=${ROLL_RESET_LOSSES} LOSSES MIN_SCORE=${MIN_SCORE} MIN_EDGE=${MIN_EDGE} MIN_MODEL=${MIN_COMPOSITE_PROB}`);\n    console.log('[Telegram] polling forced OFF; sendMessage notifications remain enabled');"
  );

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
