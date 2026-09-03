const test=require('node:test');const assert=require('node:assert/strict');const a=require('../analytics');
test('zscore and severity are data based',()=>{assert.equal(a.zscore(3,[1,2,3,4,5]).toFixed(6),'0.000000');assert.equal(a.anomalySeverity(4,{elevated:1.5,high:2.5,extreme:3.5}),'極端異常');});
test('insufficient values remain null',()=>{assert.equal(a.pctChange(100,0),null);assert.equal(a.zscore(3,[]),null);});
