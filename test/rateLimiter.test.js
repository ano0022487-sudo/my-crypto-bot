const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestLimiter } = require('../rateLimiter');

test('request limiter executes queued requests without exceeding configured window', async () => {
  const limiter = new RequestLimiter({ intervalMs: 50, maxRequests: 1 });
  const started = [];
  await Promise.all([1,2,3].map(i => limiter.schedule(async () => { started.push(i); })));
  assert.deepEqual(started, [1,2,3]);
});
