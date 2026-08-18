'use strict';

const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, 'event-bot.js');
const runtime = path.join(__dirname, 'okx-event-bot-runtime.js');

try {
  let code = fs.readFileSync(source, 'utf8');
  code = code.replace(/tdMode:\s*'cash'/g, "tdMode: 'isolated'");

  fs.writeFileSync(runtime, code, 'utf8');
  console.log('[Runner] Successfully generated runtime file.');

  require(runtime);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exit(1);
}
