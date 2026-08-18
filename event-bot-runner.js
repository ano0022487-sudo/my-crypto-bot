'use strict';

const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, 'event-bot.js');
const runtime = path.join(__dirname, 'okx-event-bot-runtime.js');

try {
  if (!fs.existsSync(source)) {
    throw new Error(`找不到 event-bot.js: ${source}`);
  }

  let code = fs.readFileSync(source, 'utf8');

  // 事件合約使用 cash，不要自動改成 isolated
  // 保留 event-bot.js 原始設定

  fs.writeFileSync(runtime, code, 'utf8');

  console.log('[Runner] Successfully generated runtime file.');
  console.log(`[Runner] Source: ${source}`);
  console.log(`[Runner] Runtime: ${runtime}`);

  require(runtime);

} catch (err) {
  console.error('[Runner Error]', err);
  process.exit(1);
}
