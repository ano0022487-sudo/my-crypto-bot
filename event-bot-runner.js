'use strict';

/* OKX Event Contract launcher - controlled runtime patch */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const source = path.join(__dirname, 'event-bot.js');

function replaceOrThrow(code, target, replacement, label) {
  if (!code.includes(target)) throw new Error(`[Runner] required pattern not found: ${label}`);
  return code.replace(target, replacement);
}

try {
  if (!fs.existsSync(source)) throw new Error(`找不到 event-bot.js: ${source}`);
  let code = fs.readFileSync(source, 'utf8');

  code = code.replace(/polling\s*:\s*true/g, 'polling: false');
  try {
    const TelegramBot = require('node-telegram-bot-api');
    TelegramBot.prototype.startPolling = async function () {
      console.log('[Telegram] polling disabled; notification-only mode');
      return this;
    };
  } catch (err) {
    console.error('[Runner Telegram Patch Error]', err.message || err);
  }

  code = replaceOrThrow(code, 'const ORDER_SIZE_FIXED = 5;', `const TARGET_STAKE_USDT = Number(process.env.TARGET_STAKE_USDT || 5);
const MIN_COMPOSITE_PROB = Number(process.env.MIN_COMPOSITE_PROB || 0.70);
const ROLL_BASE_STAKE = TARGET_STAKE_USDT;
const ROLL_MULTIPLIER = 1.5;
const ROLL_RESET_LOSSES = 6;`, 'ORDER_SIZE_FIXED');

  code = code.replace(/const MIN_EDGE =\s*Number\(\s*process\.env\.MIN_EDGE \|\| 0\.075\s*\);/s, 'const MIN_EDGE = Number(process.env.MIN_EDGE || 0.10);');
  code = code.replace(/const MIN_SCORE =\s*Number\(\s*process\.env\.MIN_SCORE \|\| 78\s*\);/s, 'const MIN_SCORE = Number(process.env.MIN_SCORE || 85);');
  code = code.replace(/const MAX_CONSECUTIVE_LOSSES =\s*Number\(\s*process\.env\.MAX_CONSECUTIVE_LOSSES \|\| 3\s*\);/s, 'const MAX_CONSECUTIVE_LOSSES = Number(process.env.MAX_CONSECUTIVE_LOSSES || 999999);');

  code = replaceOrThrow(code, `trades:\n      []`, `trades:
      [],

    rollStake:
      ROLL_BASE_STAKE,

    rollStep:
      0`, 'state.trades');

  code = replaceOrThrow(code, `const state =\n  loadState();`, `const state =
  loadState();

if (!Number.isFinite(Number(state.rollStake)) || Number(state.rollStake) < ROLL_BASE_STAKE) state.rollStake = ROLL_BASE_STAKE;
if (!Number.isFinite(Number(state.rollStep)) || Number(state.rollStep) < 0) state.rollStep = 0;
if (!Array.isArray(state.usedEventIds)) state.usedEventIds = [];
state.usedEventIds = state.usedEventIds.map(x => String(x || '').trim()).filter(Boolean).slice(-500);`, 'state initialization');

  /* Calculate contract quantity inside placeEventOrder scope. */
  code = replaceOrThrow(code, 'const sz = ORDER_SIZE_FIXED;', `var sz = 0;

  const currentRollStake = Math.max(ROLL_BASE_STAKE, Number(state.rollStake || ROLL_BASE_STAKE));
  const lotSz = Math.max(0.00000001, Number(candidate.inst.lotSz || candidate.inst.minSz || 0.1));
  const minSz = Math.max(lotSz, Number(candidate.inst.minSz || lotSz));
  const rawSz = currentRollStake / candidate.entryPx;
  const roundedSz = Math.ceil(rawSz / lotSz - 1e-12) * lotSz;
  sz = Math.max(minSz, Number(roundedSz.toFixed(8)));`, 'order quantity');

  code = replaceOrThrow(code, `const inst =\n    candidate.inst;`, `const inst =
    candidate.inst;

  if (LIVE_TRADING) {
    const freshTicker = await getTicker(inst.instId, 'EVENTS');
    const freshYesAsk = Number(freshTicker?.askPx || freshTicker?.last);
    const freshYesBid = Number(freshTicker?.bidPx || freshTicker?.last);
    const freshEntryPx = candidate.side === 'yes' ? freshYesAsk : 1 - freshYesBid;
    if (!(freshEntryPx > 0 && freshEntryPx < 1)) throw new Error('[ENTRY SKIP] fresh event quote unavailable');
    if (!validPrice(freshEntryPx)) throw new Error('[ENTRY SKIP] fresh event price outside configured range');
    const freshEdge = candidate.modelProb - freshEntryPx;
    if (freshEdge < MIN_EDGE) throw new Error('[ENTRY SKIP] stale signal: freshEdge=' + freshEdge.toFixed(4) + ' required=' + MIN_EDGE.toFixed(4));
    candidate.entryPx = freshEntryPx;
    candidate.edge = freshEdge;
  }`, 'fresh quote protection');

  code = replaceOrThrow(code, `ordType:\n      'ioc',`, `ordType:
      'fok',`, 'entry order type');

  code = replaceOrThrow(code, `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }`, `if (
        model.score <
        MIN_SCORE
      ) {
        continue;
      }
      if (modelProb < MIN_COMPOSITE_PROB) continue;
      const requiredConfirmations = ['5m trend', '15m trend', 'RSI', 'volume'];
      if (!requiredConfirmations.every(reason => model.reasons.includes(reason))) continue;`, 'high-confidence filter');

  code = replaceOrThrow(code, `const candidate =\n    candidates[0];`, `const availableCandidates = candidates.filter(item => !state.usedEventIds.includes(String(item.inst?.instId || '')));
  if (!availableCandidates.length) return;
  const candidate = availableCandidates[0];`, 'same event entry lock');

  code = replaceOrThrow(code, `const body = {\n\n    instId:`, `const actualTargetStake = px * sz;
  console.log('[ORDER SIZE]', JSON.stringify({ targetStake: currentRollStake, entryPx: px, lotSz, minSz, contracts: sz, actualStake: actualTargetStake }));
  const body = {

    instId:`, 'order-size diagnostic');

  /* Attach the requested contract quantity to the order result so maybeTrade
     never references the local `sz` variable from placeEventOrder. */
  code = replaceOrThrow(code, `const result =\n    rows?.[0];`, `const result =
    rows?.[0];
    if (result) result.requestedContracts = sz;
    console.log('[ENTRY ORDER RESPONSE]', JSON.stringify(result || null));`, 'entry response + requested size');

  code = replaceOrThrow(code, `const filled =\n      await getOrder(\n        inst.instId,\n        result.ordId\n      );`, `const filled =
      await getOrder(
        inst.instId,
        result.ordId
      );

    console.log('[ENTRY ORDER STATE]', JSON.stringify({
      ordId: result.ordId,
      state: filled?.state,
      accFillSz: filled?.accFillSz,
      avgPx: filled?.avgPx,
      fillPx: filled?.fillPx,
      fillSz: filled?.fillSz,
      cancelSource: filled?.cancelSource,
      sCode: result.sCode,
      sMsg: result.sMsg
    }));`, 'entry state logging');

  /* IMPORTANT: use order.requestedContracts here, not `sz` from another scope. */
  code = replaceOrThrow(code, `const fillSz =\n      Number(\n        filled?.accFillSz ||\n        filled?.fillSz ||\n        ORDER_SIZE_FIXED\n      );`, `const fillSz = Number(filled?.accFillSz ?? filled?.fillSz ?? 0);

    console.log('[ENTRY FILL CHECK]', JSON.stringify({
      state: filled?.state,
      requestedContracts: Number(order?.requestedContracts || 0),
      filledContracts: fillSz,
      avgPx: filled?.avgPx,
      cancelSource: filled?.cancelSource
    }));`, 'strict fill quantity');

  code = replaceOrThrow(code, `if (\n      !(\n        fillSz > 0\n      )\n    ) {\n\n      return;\n    }`, `if (!(fillSz > 0) || (LIVE_TRADING && String(filled?.state || '').toLowerCase() !== 'filled')) {
      console.warn('[ENTRY NOT FILLED]', JSON.stringify({
        ordId: result?.ordId || null,
        state: filled?.state || null,
        requestedContracts: Number(order?.requestedContracts || 0),
        filledContracts: fillSz,
        cancelSource: filled?.cancelSource || null,
        sCode: result?.sCode || null,
        sMsg: result?.sMsg || null
      }));
      return;
    }`, 'strict filled state');

  code = replaceOrThrow(code, `state.lastTradeAt =\n      Date.now();\n\n    saveState();`, `state.lastTradeAt =
      Date.now();

    const usedEventId = String(candidate.inst.instId || '').trim();
    if (usedEventId && !state.usedEventIds.includes(usedEventId)) {
      state.usedEventIds.push(usedEventId);
      if (state.usedEventIds.length > 500) state.usedEventIds.shift();
    }

    saveState();`, 'mark event used after entry');

  /* Startup diagnostics. */
  code = code.replace(/console\.log\(\s*`OKX EVENT CONTRACT BOT RUNNING ON PORT \$\{PORT\}`\s*\);/s, `console.log('OKX EVENT CONTRACT BOT RUNNING ON PORT ' + PORT);
console.log('[CONFIG] TARGET=' + ROLL_BASE_STAKE + 'U MIN_SCORE=' + MIN_SCORE + ' MIN_EDGE=' + MIN_EDGE + ' MIN_MODEL=' + MIN_COMPOSITE_PROB);
console.log('[EVENT LOCK] Same event contract can enter only once');
console.log('[ENTRY] FOK + fresh quote + strict fill verification');
console.log('[Telegram] polling forced OFF');`);

  const runtimeModule = new Module(source, module);
  runtimeModule.filename = source;
  runtimeModule.paths = Module._nodeModulePaths(__dirname);
  runtimeModule._compile(code, source);
} catch (err) {
  console.error('[Runner Error]', err);
  process.exitCode = 1;
}
