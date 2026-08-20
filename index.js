'use strict';

/* Canonical Render entrypoint: start the bot directly. */
console.log('[DEPLOY ENTRY] MATH-1H-RR-2.2');
if (process.env.LIVE_TRADING === undefined) process.env.LIVE_TRADING = 'false';
require('./event-bot.js');
