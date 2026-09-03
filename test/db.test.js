const test=require('node:test');const assert=require('node:assert/strict');const db=require('../db');
test('PostgreSQL layer reports configuration state without faking connectivity',()=>{if(!process.env.DATABASE_URL){assert.equal(db.enabled(),false);assert.equal(db.isReady(),false);}else{assert.equal(db.enabled(),true);}});
