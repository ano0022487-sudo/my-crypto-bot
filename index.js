'use strict';

/* Single compatibility entrypoint for Render.
   Whether Render starts `node index.js` or `npm start`, both paths converge on
   event-bot-runner.js. No runtime diagnostics or legacy strategy injection. */
console.log('[DEPLOY ENTRY] MATH-1H-RR-2.0');
require('./event-bot-runner.js');
