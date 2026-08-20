'use strict';

// Single Render entrypoint. Never start the trading bot from any other file.
if (process.env.LIVE_TRADING === undefined) process.env.LIVE_TRADING = 'false';
console.log('[BOOT] OKX Event Contract Bot');
console.log(`[BOOT] mode=${process.env.LIVE_TRADING === 'true' ? 'LIVE' : 'PAPER'}`);

// Exactly one Telegram polling owner. event-bot.js remains outbound-only.
require('./telegram-control.js');
require('./event-bot.js');
