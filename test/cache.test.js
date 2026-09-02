const test=require('node:test');const assert=require('node:assert/strict');const {TTLCache}=require('../cache');
test('TTL cache stores and expires values',async()=>{const c=new TTLCache();c.set('x',1,10);assert.equal(c.get('x'),1);await new Promise(r=>setTimeout(r,15));assert.equal(c.get('x'),undefined);});
