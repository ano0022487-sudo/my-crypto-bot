'use strict';

// Stable launcher for the OKX Event Contract bot.
// Keeps event-bot.js as the strategy source, while applying the live
// Event-Contract execution/risk rules below before compiling it.
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Telegram is notification-only. Do not start getUpdates polling on Render.
try {
  const TelegramBot = require('node-telegram-bot-api');
  TelegramBot.prototype.startPolling = async function () {
    console.log('[Telegram] polling disabled; notification-only mode');
    return this;
  };
} catch (err) {
  console.error('[Runner Telegram Patch Error]', err.message || err);
}

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) {
    throw new Error(`找不到 event-bot.js: ${source}`);
  }

  let code = fs.readFileSync(source, 'utf8');

  // ===== Event Contract live rules =====
  // One trade targets 5 USDT of stake. Because EVENTS quantity is in contracts,
  // quantity is calculated from price and floored so the stake never exceeds 5U.
  code = code.replace(
    'const ORDER_SIZE_FIXED = 5;',
    `const TARGET_STAKE_USDT = Number(process.env.TARGET_STAKE_USDT || 5);\nconst MIN_COMPOSITE_PROB = Number(process.env.MIN_COMPOSITE_PROB || 0.70);`
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
    'const sz = ORDER_SIZE_FIXED;',
    'const sz = Math.max(1, Math.floor(TARGET_STAKE_USDT / candidate.entryPx));'
  );

  // Only accept signals where the selected direction itself has >=70% model
  // probability and all four core confirmations are present.
  code = code.replace(
    `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }`,
    `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }\n\n      if (modelProb < MIN_COMPOSITE_PROB) {\n        continue;\n      }\n\n      const requiredConfirmations = [\n        '5m trend',\n        '15m trend',\n        'RSI',\n        'volume'\n      ];\n\n      if (!requiredConfirmations.every(x => model.reasons.includes(x))) {\n        continue;\n      }`
  );

  // Current OKX EVENTS API requires speedBump=1 for non-post-only orders.
  code = code.replace(
    `outcome:\n      candidate.side,\n\n    clOrdId:`,
    `outcome:\n      candidate.side,\n\n    speedBump:\n      '1',\n\n    clOrdId:`
  );

  code = code.replace(
    `outcome:\n      position.side,\n\n    clOrdId:`,
    `outcome:\n      position.side,\n\n    speedBump:\n      '1',\n\n    clOrdId:`
  );

  // Add visible startup configuration.
  code = code.replace(
    "console.log(\n      `OKX EVENT CONTRACT BOT RUNNING ON PORT ${PORT}`\n    );",
    "console.log(`OKX EVENT CONTRACT BOT RUNNING ON PORT ${PORT}`);\n    console.log(`[CONFIG] TARGET_STAKE=${TARGET_STAKE_USDT}U MIN_SCORE=${MIN_SCORE} MIN_EDGE=${MIN_EDGE} MIN_MODEL=${MIN_COMPOSITE_PROB}`);"
  );

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);

} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
