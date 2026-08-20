'use strict';
if(process.env.LIVE_TRADING===undefined)process.env.LIVE_TRADING='false';
console.log(`[BOOT] OKX 1H Perpetual Bot | mode=${process.env.LIVE_TRADING==='true'?'LIVE':'PAPER'}`);
require('./perp-1h-v2.js');
