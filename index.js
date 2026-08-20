'use strict';

// Single Render entrypoint. Never start the bot from any other file.
if (process.env.LIVE_TRADING === undefined) process.env.LIVE_TRADING = 'false';
console.log('[BOOT] OKX Event Contract Bot');
console.log(`[BOOT] mode=${process.env.LIVE_TRADING === 'true' ? 'LIVE' : 'PAPER'}`);
require('./event-bot.js');
