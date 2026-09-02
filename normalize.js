'use strict';

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandle(x) {
  return { timestamp: numberOrNull(x[0]), open: numberOrNull(x[1]), high: numberOrNull(x[2]), low: numberOrNull(x[3]), close: numberOrNull(x[4]), volume: numberOrNull(x[5]), volumeCurrency: numberOrNull(x[6]), volumeQuote: numberOrNull(x[7]), confirmed: x[8] === '1' };
}
function normalizeTicker(x) {
  const last = numberOrNull(x.last); const open24h = numberOrNull(x.open24h);
  return { symbol: x.instId, price: last, change24h: last !== null && open24h ? ((last - open24h) / open24h) * 100 : null, volume: numberOrNull(x.volCcy24h), volumeUnit: 'base currency', volumeContracts: numberOrNull(x.vol24h), timestamp: numberOrNull(x.ts) };
}
function normalizeOI(x) { return { symbol: x.instId, oi: numberOrNull(x.oi), oiCcy: numberOrNull(x.oiCcy), oiUsd: numberOrNull(x.oiUsd), timestamp: numberOrNull(x.ts) }; }
function normalizeFunding(x, symbol = x.instId) { return { symbol, fundingRate: numberOrNull(x.fundingRate), fundingTime: numberOrNull(x.fundingTime), nextFundingTime: numberOrNull(x.nextFundingTime), timestamp: numberOrNull(x.ts) }; }
function normalizeTrade(x) { return { timestamp: numberOrNull(x.ts), price: numberOrNull(x.px), size: numberOrNull(x.sz), side: x.side, tradeId: x.tradeId, source: x.source }; }
function normalizeOrderBook(x) { return { price: numberOrNull(x[0]), volume: numberOrNull(x[1]), orders: numberOrNull(x[3] ?? x[2]) }; }

module.exports = { numberOrNull, normalizeCandle, normalizeTicker, normalizeOI, normalizeFunding, normalizeTrade, normalizeOrderBook };
