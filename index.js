'use strict';

// Single Render entrypoint: OKX USDT perpetual contracts only.
if (process.env.LIVE_TRADING === undefined) process.env.LIVE_TRADING = 'false';
if (process.env.BOT_STATE_FILE === undefined) process.env.BOT_STATE_FILE = 'perpetual-state.json';
console.log('[BOOT] OKX Perpetual Contract Bot');
console.log(`[BOOT] mode=${process.env.LIVE_TRADING === 'true' ? 'LIVE' : 'PAPER'}`);
require('./telegram-control.js');
require('./perpetual-bot.js');
