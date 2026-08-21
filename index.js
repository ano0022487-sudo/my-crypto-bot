'use strict';

// Single Render entrypoint: OKX USDT perpetual contracts only.
// LIVE_TRADING defaults to false so deployment remains PAPER until explicitly enabled.
if (process.env.LIVE_TRADING === undefined) process.env.LIVE_TRADING = 'false';
console.log('[BOOT] OKX Perpetual Contract Bot');
console.log(`[BOOT] mode=${process.env.LIVE_TRADING === 'true' ? 'LIVE' : 'PAPER'}`);

// Exactly one Telegram polling owner.
require('./telegram-control.js');
require('./perpetual-bot.js');
