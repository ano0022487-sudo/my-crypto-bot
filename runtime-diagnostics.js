'use strict';

/*
  Runtime diagnostics hook.
  Loaded before event-bot-runner.js. The runner dynamically compiles
  event-bot.js, so this hook instruments the final generated source without
  changing trading decisions or order parameters.
*/

const Module = require('module');
const originalCompile = Module.prototype._compile;
const TARGET = 'event-bot.js';

Module.prototype._compile = function patchedCompile(content, filename) {
  if (!String(filename || '').endsWith(TARGET)) {
    return originalCompile.call(this, content, filename);
  }

  let code = content;

  /* Heartbeat at every main-loop pass. */
  code = code.replace(
    /async function mainLoop\(\)\s*\{/,
    `async function mainLoop() {
  console.log('[HEARTBEAT] mainLoop start ' + new Date().toISOString());`
  );

  /* Make the silent equity failure visible. */
  code = code.replace(
    /\} catch \(err\) \{\n\s*return;\n\s*\}\n\n\s*if \(\n\s*!state\.startEquity\)/,
    `} catch (err) {
    console.error('[EQUITY ERROR]', err.message || err);
    return;
  }

  if (
    !state.startEquity)`
  );

  /* Make the silent candidate-scan failure visible. */
  code = code.replace(
    /candidates =\s*await scanCandidates\(\);\s*\}\s*catch \(err\) \{\s*return;\s*\}/,
    `candidates = await scanCandidates();
  } catch (err) {
    console.error('[SCAN ERROR]', err.message || err);
    return;
  }`
  );

  /* Explicit scan lifecycle. */
  code = code.replace(
    /async function scanCandidates\(\)\s*\{/,
    `async function scanCandidates() {
  console.log('[SCAN START] ' + new Date().toISOString());`
  );

  code = code.replace(
    /const instruments =\s*await discoverEventInstruments\(\);/,
    `const instruments = await discoverEventInstruments();
  console.log('[SCAN DISCOVERY] instruments=' + instruments.length);`
  );

  code = code.replace(
    /const filtered =\s*instruments\.filter\(/,
    `const filtered = instruments.filter(`
  );

  code = code.replace(
    /const candidates = \[\];/,
    `console.log('[SCAN FILTER] live-updown=' + filtered.length);

  const candidates = [];`
  );

  code = code.replace(
    /return candidates\.sort\(/,
    `console.log('[SCAN RESULT] candidates=' + candidates.length);
  if (candidates.length) {
    console.log('[SCAN TOP]', JSON.stringify({
      instId: candidates[0].inst?.instId,
      side: candidates[0].side,
      entryPx: candidates[0].entryPx,
      score: candidates[0].score,
      modelProb: candidates[0].modelProb,
      edge: candidates[0].edge,
      minutesToExpiry: candidates[0].minutesToExpiry
    }));
  }

  return candidates.sort(`
  );

  /* Report the empty-candidate path instead of silently returning. */
  code = code.replace(
    /if \(\s*!candidates\.length\s*\) \{\s*return;\s*\}/,
    `if (!candidates.length) {
    console.log('[SCAN] no candidates passed all filters');
    return;
  }`
  );

  /* Report every candidate execution failure. */
  code = code.replace(
    /\} catch \(err\) \{\n\s*console\.error\(\s*'🔴 EVENT ORDER ERROR',\s*err\.message\s*\);\s*\}/,
    `} catch (err) {
    console.error('[EVENT ORDER ERROR]', err.message || err);
    console.error('[EVENT ORDER STACK]', err.stack || 'no stack');
  }`
  );

  console.log('[RUNTIME DIAGNOSTICS] event-bot instrumentation active');
  return originalCompile.call(this, code, filename);
};
