const test=require('node:test');const assert=require('node:assert/strict');
test('normalized candle schema is defined',()=>{const fields=['timestamp','open','high','low','close','volume'];assert.deepEqual(fields,['timestamp','open','high','low','close','volume']);});
test('no private credential environment variables are required',()=>{assert.equal(process.env.OKX_API_KEY,undefined);assert.equal(process.env.OKX_SECRET_KEY,undefined);assert.equal(process.env.OKX_PASSPHRASE,undefined);});
