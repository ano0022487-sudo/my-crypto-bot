'use strict';

/* OKX Event Contract launcher - controlled runtime patch + scan diagnostics */
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

  /* Per-candidate rejection diagnostics. We intentionally log reasons without changing thresholds. */
  code = code.replace(/const candidates = \[\];/, `const candidates = [];
  const scanStats = { filtered: filtered.length, rejected: 0, errors: 0, passed: 0 };
  const rejectCandidate = (instId, reason, extra = {}) => {
    scanStats.rejected++;
    console.log('[EVENT REJECT]', JSON.stringify({ instId, reason, ...extra }));
  };`);

  /* Add diagnostics to the high-confidence filters currently injected by the runner. */
  code = code.replace(
    /if \(model\.score < MIN_SCORE\) \{?\s*continue;\s*\}?/,
    `if (model.score < MIN_SCORE) {
        rejectCandidate(inst.instId, 'score', { score: model.score, required: MIN_SCORE });
        continue;
      }`
  );
  code = code.replace(
    /if \(modelProb < MIN_COMPOSITE_PROB\) continue;/,
    `if (modelProb < MIN_COMPOSITE_PROB) {
        rejectCandidate(inst.instId, 'model_probability', { modelProb, required: MIN_COMPOSITE_PROB });
        continue;
      }`
  );
  code = code.replace(
    /if \(!requiredConfirmations\.every\(reason => model\.reasons\.includes\(reason\)\)\) continue;/,
    `const missingConfirmations = requiredConfirmations.filter(reason => !model.reasons.includes(reason));
      if (missingConfirmations.length) {
        rejectCandidate(inst.instId, 'confirmation', { missing: missingConfirmations, reasons: model.reasons });
        continue;
      }`
  );
  code = code.replace(
    /if \(\n        edge <\n        MIN_EDGE\n      \) \{\s*continue;\s*\}/s,
    `if (
        edge <
        MIN_EDGE
      ) {
        rejectCandidate(inst.instId, 'edge', { edge, required: MIN_EDGE, side, entryPx, modelProb });
        continue;
      }`
  );

  /* Diagnostics for common early exits inside scanCandidates. */
  code = code.replace(/if \(\n        !c5\.length \|\|\n        !c15\.length\n      \) \{\s*continue;\s*\}/s, `if (!c5.length || !c15.length) {
        rejectCandidate(inst.instId, 'candles_unavailable', { c5: c5.length, c15: c15.length });
        continue;
      }`);
  code = code.replace(/if \(\n          !\(\n            yesAsk > 0 &&\n            yesBid > 0\n          \)\n        \) \{\s*continue;\s*\}/s, `if (!(yesAsk > 0 && yesBid > 0)) {
        rejectCandidate(inst.instId, 'ticker_unavailable', { yesAsk, yesBid });
        continue;
      }`);
  code = code.replace(/if \(\n        yesAsk >= 1 \|\|\n        yesBid <= 0\n      \) \{\s*continue;\s*\}/s, `if (yesAsk >= 1 || yesBid <= 0) {
        rejectCandidate(inst.instId, 'invalid_event_quote', { yesAsk, yesBid });
        continue;
      }`);
  code = code.replace(/if \(\n        !Number\.isFinite\(\n          underlyingPrice\n        \)\n      \) \{\s*continue;\s*\}/s, `if (!Number.isFinite(underlyingPrice)) {
        rejectCandidate(inst.instId, 'invalid_underlying_price', { underlyingPrice });
        continue;
      }`);
  code = code.replace(/if \(\n        !validPrice\(\n          yesEntry\n        \)\n      \) \{\s*continue;\s*\}/s, `if (!validPrice(yesEntry)) {
        rejectCandidate(inst.instId, 'invalid_yes_price', { yesEntry });
        continue;
      }`);
  code = code.replace(/if \(\n        !validPrice\(\n          noEntry\n        \)\n      \) \{\s*continue;\s*\}/s, `if (!validPrice(noEntry)) {
        rejectCandidate(inst.instId, 'invalid_no_price', { noEntry });
        continue;
      }`);

  code = replaceOrThrow(code, `if (\n        model.score <\n        MIN_SCORE\n      ) {\n\n        continue;\n      }`, `if (
        model.score <
        MIN_SCORE
      ) {
        rejectCandidate(inst.instId, 'score', { score: model.score, required: MIN_SCORE });
        continue;
      }
      if (modelProb < MIN_COMPOSITE_PROB) {
        rejectCandidate(inst.instId, 'model_probability', { modelProb, required: MIN_COMPOSITE_PROB });
        continue;
      }
      const requiredConfirmations = ['5m trend', '15m trend', 'RSI', 'volume'];
      const missingConfirmations = requiredConfirmations.filter(reason => !model.reasons.includes(reason));
      if (missingConfirmations.length) {
        rejectCandidate(inst.instId, 'confirmation', { missing: missingConfirmations, reasons: model.reasons });
        continue;
      }`, 'high-confidence filter');

  code = code.replace(/candidates\.push\(\{/, `scanStats.passed++;
      console.log('[EVENT PASS]', JSON.stringify({ instId: inst.instId, side, entryPx, modelProb, edge, score: model.score, reasons: model.reasons }));

      candidates.push({`);
  code = code.replace(/return candidates\.sort\(/, `console.log('[SCAN DIAGNOSTICS]', JSON.stringify(scanStats));
  console.log('[SCAN RESULT] candidates=' + candidates.length);
  return candidates.sort(`);

  code = replaceOrThrow(code, `const candidate =\n    candidates[0];`, `const availableCandidates = candidates.filter(item => !state.usedEventIds.includes(String(item.inst?.instId || '')));
  if (!availableCandidates.length) {
    console.log('[EVENT SKIP] all candidates already used');
    return;
  }
  const candidate = availableCandidates[0];`, 'same event entry lock');

  code = replaceOrThrow(code, `const body = {\n\n    instId:`, `const actualTargetStake = px * sz;
  console.log('[ORDER SIZE]', JSON.stringify({ targetStake: currentRollStake, entryPx: px, lotSz, minSz, contracts: sz, actualStake: actualTargetStake }));
  const body = {

    instId:`, 'order-size diagnostic');

  code = replaceOrThrow(code, `const result =\n    rows?.[0];`, `const result =
    rows?.[0];
    if (result) result.requestedContracts = sz;
    console.log('[ENTRY ORDER RESPONSE]', JSON.stringify(result || null));`, 'entry response + requested size');
  code = replaceOrThrow(code, `const filled =\n      await getOrder(\n        inst.instId,\n        result.ordId\n      );`, `const filled =
      await getOrder(
        inst.instId,
        result.ordId
      );
    console.log('[ENTRY ORDER STATE]', JSON.stringify({ ordId: result.ordId, state: filled?.state, accFillSz: filled?.accFillSz, avgPx: filled?.avgPx, fillPx: filled?.fillPx, fillSz: filled?.fillSz, cancelSource: filled?.cancelSource, sCode: result.sCode, sMsg: result.sMsg }));`, 'entry state logging');
  code = replaceOrThrow(code, `const fillSz =\n      Number(\n        filled?.accFillSz ||\n        filled?.fillSz ||\n        ORDER_SIZE_FIXED\n      );`, `const fillSz = Number(filled?.accFillSz ?? filled?.fillSz ?? 0);
    console.log('[ENTRY FILL CHECK]', JSON.stringify({ state: filled?.state, requestedContracts: Number(order?.requestedContracts || 0), filledContracts: fillSz, avgPx: filled?.avgPx, cancelSource: filled?.cancelSource }));`, 'strict fill quantity');
  code = replaceOrThrow(code, `if (\n      !(\n        fillSz > 0\n      )\n    ) {\n\n      return;\n    }`, `if (!(fillSz > 0) || (LIVE_TRADING && String(filled?.state || '').toLowerCase() !== 'filled')) {
      console.warn('[ENTRY NOT FILLED]', JSON.stringify({ ordId: order?.ordId || null, state: filled?.state || null, requestedContracts: Number(order?.requestedContracts || 0), filledContracts: fillSz, cancelSource: filled?.cancelSource || null, sCode: order?.sCode || null, sMsg: order?.sMsg || null }));
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
