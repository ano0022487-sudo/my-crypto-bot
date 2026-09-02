'use strict';

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const client = axios.create({ baseURL: config.OKX_REST_BASE_URL, timeout: config.REQUEST_TIMEOUT_MS, headers: { Accept: 'application/json' } });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path, params = {}, attempts = config.RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      const response = await client.get(path, { params });
      const body = response.data;
      if (!body || body.code !== '0') throw new Error(`OKX ${path}: ${body?.code || 'unknown'} ${body?.msg || 'invalid response'}`);
      return body.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === attempts) break;
      const delay = config.BACKOFF_MS * (2 ** attempt);
      logger.warn('OKX request retry', { path, status, attempt: attempt + 1, delay });
      await sleep(delay);
    }
  }
  logger.error('OKX request failed', { path, error: lastError?.message });
  throw lastError;
}

module.exports = {
  getInstruments: () => get('/api/v5/public/instruments', { instType: 'SWAP' }),
  getTickers: () => get('/api/v5/market/tickers', { instType: 'SWAP' }),
  getTicker: instId => get('/api/v5/market/ticker', { instId }),
  getCandles: (instId, bar, limit = 300) => get('/api/v5/market/candles', { instId, bar, limit }),
  getHistoryCandles: (instId, bar, limit = 100) => get('/api/v5/market/history-candles', { instId, bar, limit }),
  getOpenInterest: () => get('/api/v5/public/open-interest', { instType: 'SWAP' }),
  getFundingRate: instId => get('/api/v5/public/funding-rate', { instId }),
  getFundingHistory: (instId, limit = 100) => get('/api/v5/public/funding-rate-history', { instId, limit }),
  getTrades: (instId, limit = 100) => get('/api/v5/market/trades', { instId, limit }),
  getHistoryTrades: (instId, limit = 100) => get('/api/v5/market/history-trades', { instId, limit }),
  getOrderBook: (instId, sz = config.MAX_ORDER_BOOK_LEVELS) => get('/api/v5/market/books', { instId, sz })
};
