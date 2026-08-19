'use strict';

/*
  OKX Event Contract launcher
  `node index.js` now starts the existing event-bot-runner.js.

  The runner loads event-bot.js, forces Telegram polling OFF to avoid
  ETELEGRAM 409 conflicts, and applies the configured event-contract
  entry/risk rules before starting the bot.
*/

require('./event-bot-runner.js');
