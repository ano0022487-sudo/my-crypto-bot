'use strict';

const path = require('path');

const runtime = path.join(__dirname, 'event-bot-runtime.js');

try {
  console.log('[Runner] Starting Event Contract bot...');
  require(runtime);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exit(1);
}
