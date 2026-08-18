'use strict';

// Production runner for event-bot.js.
// OKX currently requires Event Contract orders to use tdMode=isolated.

const fs = require('fs');
const path = require('path');

// 確保 Node.js 在執行 /tmp 暫存檔時能正確找到專案內的 node_modules
module.paths.push(path.join(__dirname, 'node_modules'));

const source = path.join(__dirname, 'event-bot.js');
const runtime = path.join('/tmp', 'okx-event-bot-runtime.js');

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
