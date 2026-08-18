'use strict';

// Stable launcher for the Event Contract bot.
// Loads event-bot.js from the project directory so dependencies resolve from
// the project's node_modules. It also repairs the malformed loadState() line
// present in the current generated event-bot.js before compiling it.
const fs = require('fs');
const path = require('path');
const Module = require('module');

const source = path.join(__dirname, 'event-bot.js');

try {
  if (!fs.existsSync(source)) {
    throw new Error(`找不到 event-bot.js: ${source}`);
  }

  let code = fs.readFileSync(source, 'utf8');

  // Current file has a malformed one-line loadState() function where the
  // catch block is attached to the try expression before its closing brace.
  // Replace only that exact function; leave all trading logic untouched.
  const badLoadState = /function loadState\(\) \{ try \{ if \(!fs\.existsSync\(BOT_STATE_FILE\)\) return freshState\(\); return \{ \.\.\.freshState\(\), \.\.\.JSON\.parse\(fs\.readFileSync\(BOT_STATE_FILE, 'utf8'\)\) \}; catch \(err\) \{ console\.error\('State load:', err\.message\); return freshState\(\); \} \}/;

  const goodLoadState = `function loadState() {
  try {
    if (!fs.existsSync(BOT_STATE_FILE)) return freshState();
    return {
      ...freshState(),
      ...JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf8'))
    };
  } catch (err) {
    console.error('State load:', err.message);
    return freshState();
  }
}`;

  if (badLoadState.test(code)) {
    code = code.replace(badLoadState, goodLoadState);
    console.log('[Runner] Repaired malformed loadState() before startup.');
  }

  // Compile from the real project directory so require('express'), axios,
  // and node-telegram-bot-api resolve from /opt/render/project/src/node_modules.
  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);

} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
