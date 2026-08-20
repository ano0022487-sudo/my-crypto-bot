'use strict';

/*
 * Telegram control plane.
 * One polling owner only: this file. event-bot.js keeps polling=false
 * and is responsible only for outbound notifications and trading.
 */

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/[\"']/g, '');
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const STATE_FILE = process.env.BOT_STATE_FILE || path.join(__dirname, 'bot-state.json');

if (!TOKEN) {
  console.log('[TELEGRAM CONTROL] token missing; command receiver disabled');
  module.exports = null;
  return;
}

const bot = new TelegramBot(TOKEN, {
  polling: {
    autoStart: true,
    params: { timeout: 30 }
  }
});

function allowed(msg) {
  if (!ALLOWED_CHAT_ID) return true;
  return String(msg.chat.id) === ALLOWED_CHAT_ID;
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[TELEGRAM CONTROL] state read:', e.message);
    return null;
  }
}

function n(value, digits = 4) {
  const x = Number(value || 0);
  return Number.isFinite(x) ? x.toFixed(digits) : '0';
}

function statsText(state) {
  if (!state) return '📊 統計\n\n目前還沒有 bot-state.json，尚未建立交易資料。';
  const trades = Array.isArray(state.trades) ? state.trades : [];
  const wins = trades.filter(t => Number(t.pnl) > 0).length;
  const losses = trades.filter(t => Number(t.pnl) < 0).length;
  const flat = trades.filter(t => Number(t.pnl) === 0).length;
  const pnl = trades.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const wr = trades.length ? wins / trades.length * 100 : 0;
  const equity = Number(state.paperEquity ?? 20) || 0;
  const cooldown = Number(state.cooldownUntil || 0) > Date.now();
  return [
    '📊 PAPER 統計',
    '',
    `交易筆數：${trades.length}`,
    `勝場：${wins}`,
    `敗場：${losses}`,
    `平局：${flat}`,
    `勝率：${wr.toFixed(1)}%`,
    `累計 PnL：${pnl >= 0 ? '+' : ''}${n(pnl)}U`,
    `目前資金：${n(equity)}U`,
    `連敗：${Number(state.consecutiveLosses || 0)}`,
    `冷卻：${cooldown ? '是' : '否'}`,
    `持倉：${state.position ? '有' : '無'}`,
    `資料檔：${STATE_FILE}`
  ].join('\n');
}

function statusText(state) {
  if (!state) return '⚠️ 機器人已啟動，但目前找不到統計資料檔。';
  const position = state.position;
  return [
    '🤖 BOT STATUS',
    '',
    `模式：${String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true' ? 'LIVE' : 'PAPER'}`,
    '策略：1H-MATH',
    '單筆：1U',
    `持倉：${position ? `${position.inst?.instId || position.instId || 'EVENT'} ${String(position.side || '').toUpperCase()} @ ${n(position.entryPx)}` : '無'}`,
    `連敗：${Number(state.consecutiveLosses || 0)}`,
    `冷卻：${Number(state.cooldownUntil || 0) > Date.now() ? '進行中' : '無'}`,
    `交易資料：${Array.isArray(state.trades) ? state.trades.length : 0} 筆`
  ].join('\n');
}

function tradesText(state) {
  const trades = Array.isArray(state?.trades) ? state.trades.slice(-10).reverse() : [];
  if (!trades.length) return '📋 最近交易\n\n目前沒有已完成交易。';
  const lines = ['📋 最近 10 筆交易', ''];
  for (const t of trades) {
    const p = Number(t.pnl || 0);
    lines.push(`${p >= 0 ? '🟢' : '🔴'} ${String(t.instId || '').slice(0, 42)}`);
    lines.push(`PnL ${p >= 0 ? '+' : ''}${n(p)}U | ${t.reason || 'N/A'} | ${t.at || ''}`);
  }
  return lines.join('\n');
}

function helpText() {
  return [
    '🤖 OKX EVENT BOT',
    '',
    '/start — 測試 Telegram 回覆',
    '/stats — 查看完整交易統計',
    '/status — 查看機器人狀態',
    '/trades — 查看最近 10 筆已完成交易',
    '/help — 查看指令'
  ].join('\n');
}

bot.onText(/^\/(start|help)(?:@[^ ]+)?$/i, async msg => {
  if (!allowed(msg)) return;
  await bot.sendMessage(msg.chat.id, helpText());
});

bot.onText(/^\/(stats|stat|統計)(?:@[^ ]+)?$/i, async msg => {
  if (!allowed(msg)) return;
  await bot.sendMessage(msg.chat.id, statsText(loadState()));
});

bot.onText(/^\/(status)(?:@[^ ]+)?$/i, async msg => {
  if (!allowed(msg)) return;
  await bot.sendMessage(msg.chat.id, statusText(loadState()));
});

bot.onText(/^\/(trades|交易)(?:@[^ ]+)?$/i, async msg => {
  if (!allowed(msg)) return;
  await bot.sendMessage(msg.chat.id, tradesText(loadState()));
});

bot.on('polling_error', error => {
  console.error('[TELEGRAM POLLING]', error?.message || error);
});

bot.getMe()
  .then(me => console.log(`[TELEGRAM CONTROL] connected @${me.username || me.id}`))
  .catch(error => console.error('[TELEGRAM CONTROL] connection failed:', error.message));

module.exports = bot;
