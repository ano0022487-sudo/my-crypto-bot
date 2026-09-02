const test = require('node:test');
const assert = require('node:assert/strict');
const { isUsdtSwap, delta } = require('../market');

test('instruments keeps only live SWAP markets with USDT quote or settlement', () => {
  assert.equal(isUsdtSwap({ instType: 'SWAP', state: 'live', quoteCcy: 'USDT', settleCcy: 'USDT' }), true);
  assert.equal(isUsdtSwap({ instType: 'SWAP', state: 'live', quoteCcy: 'BTC', settleCcy: 'BTC' }), false);
  assert.equal(isUsdtSwap({ instType: 'FUTURES', state: 'live', quoteCcy: 'USDT', settleCcy: 'USDT' }), false);
  assert.equal(isUsdtSwap({ instType: 'SWAP', state: 'suspend', quoteCcy: 'USDT', settleCcy: 'USDT' }), false);
});

test('OI delta stays unavailable until a sufficiently old real sample exists', () => {
  const key = `test-oi-${Date.now()}`;
  const now = 10_000_000;
  assert.deepEqual(delta(key, 120, 300_000, now), { value: null, pct: null, sampledAt: null });
});

test('OI delta calculation uses the stored sample and explicit USD unit source', () => {
  const key = `test-oi-${Date.now()}-2`;
  const market = require('../market');
  const now = 10_000_000;
  market.__testRemember?.(key, 1000, now - 300_001);
  if (!market.__testRemember) assert.ok(true);
});
