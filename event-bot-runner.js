'use strict';

// Stable launcher: load event-bot.js directly from the project directory.
// This avoids copying the source to /tmp or another runtime path, which can
// break Node module resolution and can run a stale/generated file.
const path = require('path');

const source = path.join(__dirname, 'event-bot.js');

try {
  console.log(`[Runner] Loading: ${source}`);
  require(source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
