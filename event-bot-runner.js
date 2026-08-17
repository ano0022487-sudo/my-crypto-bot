'use strict';

// Production runner for event-bot.js.
// OKX currently requires Event Contract orders to use tdMode=isolated.
// This wrapper keeps the strategy file intact and applies that exchange-specific mode before startup.

const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, 'event-bot.js');
const runtime = path.join('/tmp', 'okx-event-bot-runtime.js');

let code = fs.readFileSync(source, 'utf8');
code = code.replace(/tdMode:\s*'cash'/g, "tdMode: 'isolated'");

fs.writeFileSync(runtime, code, 'utf8');
require(runtime);
