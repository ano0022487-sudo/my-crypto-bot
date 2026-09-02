'use strict';

const express = require('express');
const path = require('path');
const market = require('./market');
const config = require('./config');
const logger = require('./logger');
const { OKXPublicWS } = require('./ws');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const realtime = new OKXPublicWS();

const safe = fn => async (req, res) => {
  try {
    res.json({ ok: true, data: await fn(req) });
  } catch (error) {
    logger.error('API route failed', { path: req.path, error: error.message });
    res.status(503).json({ ok: false, error: '資料暫時無法取得' });
  }
};

app.get('/api/health', (req, res) => res.json({
  ok: true,
  data: { service: 'OKX Public Market Scanner', timestamp: Date.now(), privateApi: false, tradingExecution: false }
}));
app.get('/api/realtime', (req, res) => res.json({ ok: true, data: realtime.snapshot() }));
app.get('/api/instruments', safe(() => market.instruments()));
app.get('/api/oi/:instId', safe(req => market.openInterest().then(rows => rows.find(x => x.symbol === req.params.instId) || null)));
app.get('/api/markets', safe(async () => {
  const [tickers, oi] = await Promise.all([market.tickers(), market.openInterest()]);
  const oiMap = new Map(oi.map(x => [x.symbol, x]));
  const rt = realtime.snapshot();
  const rows = tickers.map(t => {
    const f = rt.funding[t.symbol];
    const oiRow = oiMap.get(t.symbol);
    return {
      ...t,
      oi: oiRow?.oiUsd ?? null,
      oiUnit: 'USD',
      oiChanges: oiRow?.changes ?? { '5m': null, '15m': null, '1h': null },
      funding: f ? Number(f.fundingRate) : null,
      fundingTime: f ? Number(f.fundingTime) : null,
      nextFundingTime: f?.nextFundingTime ? Number(f.nextFundingTime) : null,
      dataUpdatedAt: t.timestamp
    };
  });
  return { count: rows.length, updatedAt: Date.now(), markets: rows, websocket: { connected: rt.connected } };
}));
app.get('/api/candles/:instId', safe(req => market.candles(req.params.instId, req.query.bar || '5m')));
app.get('/api/trades/:instId', safe(req => market.trades(req.params.instId, Math.min(Number(req.query.limit || 100), 500))));
app.get('/api/orderbook/:instId', safe(req => market.orderBook(req.params.instId, Math.min(Number(req.query.sz || 20), config.MAX_ORDER_BOOK_LEVELS))));
app.get('/api/funding/:instId', safe(req => market.funding(req.params.instId)));
app.get('/api/funding-history/:instId', safe(req => market.fundingHistory(req.params.instId, Math.min(Number(req.query.limit || 100), 100))));

const server = app.listen(config.PORT, async () => {
  logger.info(`Scanner listening on ${config.PORT}`);
  try {
    const ids = (await market.instruments()).map(x => x.instId);
    await realtime.start(ids);
    logger.info('Public WebSocket subscriptions initialized', { markets: ids.length });
  } catch (e) {
    logger.error('WebSocket initialization failed', { error: e.message });
  }
});
server.on('error', e => logger.error('Server error', { error: e.message }));
process.on('unhandledRejection', e => logger.error('Unhandled rejection', { error: e?.message || String(e) }));
process.on('uncaughtException', e => logger.error('Uncaught exception', { error: e.message }));

module.exports = { app, server, realtime };
