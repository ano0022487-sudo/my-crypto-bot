const test = require('node:test');
const assert = require('node:assert/strict');
const { isUsdtSwap } = require('../market');
const { normalizeCandle, normalizeTicker, normalizeOI, normalizeFunding, normalizeTrade, normalizeOrderBook } = require('../normalize');

test('instruments filters live SWAP markets with USDT quote or settlement', () => {
  assert.equal(isUsdtSwap({ instType: 'SWAP', state: 'live', quoteCcy: 'USDT', settleCcy: 'USDT' }), true);
  assert.equal(isUsdtSwap({ instType: 'SWAP', state: 'live', quoteCcy: 'BTC', settleCcy: 'BTC' }), false);
  assert.equal(isUsdtSwap({ instType: 'FUTURES', state: 'live', quoteCcy: 'USDT', settleCcy: 'USDT' }), false);
  assert.equal(isUsdtSwap({ instType: 'SWAP', state: 'suspend', quoteCcy: 'USDT', settleCcy: 'USDT' }), false);
});

test('candle normalization preserves OKX candle semantics and confirmation', () => {
  assert.deepEqual(normalizeCandle(['1000','1','2','0.5','1.5','10','20','30','1']), { timestamp:1000, open:1, high:2, low:0.5, close:1.5, volume:10, volumeCurrency:20, volumeQuote:30, confirmed:true });
});

test('ticker normalization keeps derivative volume in base currency and contracts', () => {
  const x = normalizeTicker({ instId:'BTC-USDT-SWAP', last:'100', open24h:'90', volCcy24h:'2.5', vol24h:'1000', ts:'123' });
  assert.equal(x.price, 100); assert.equal(x.change24h, 100/9); assert.equal(x.volume, 2.5); assert.equal(x.volumeUnit, 'base currency'); assert.equal(x.volumeContracts, 1000);
});

test('OI, funding, trade and orderbook normalization uses numeric fields without inventing values', () => {
  assert.deepEqual(normalizeOI({ instId:'BTC-USDT-SWAP', oi:'10', oiCcy:'0.1', oiUsd:'10000', ts:'123' }), { symbol:'BTC-USDT-SWAP', oi:10, oiCcy:0.1, oiUsd:10000, timestamp:123 });
  assert.equal(normalizeFunding({ instId:'BTC-USDT-SWAP', fundingRate:'0.001', fundingTime:'100', nextFundingTime:'200', ts:'123' }).fundingRate, 0.001);
  assert.deepEqual(normalizeTrade({ ts:'123', px:'100', sz:'2', side:'buy', tradeId:'t1', source:'0' }), { timestamp:123, price:100, size:2, side:'buy', tradeId:'t1', source:'0' });
  assert.deepEqual(normalizeOrderBook(['100','2','3']), { price:100, volume:2, orders:3 });
});
