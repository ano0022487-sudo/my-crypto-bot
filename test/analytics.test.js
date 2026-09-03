const test=require('node:test');const assert=require('node:assert/strict');const a=require('../analytics');
test('CVD uses only official side values',()=>{assert.equal(a.cvdDelta([{size:2,side:'buy'},{size:1,side:'sell'},{size:9,side:'x'}]),1);});
test('OI/price structure classification',()=>{assert.equal(a.classifyStructure(2,3),'上漲 / OI 增加');assert.equal(a.classifyStructure(-2,3),'下跌 / OI 增加');assert.equal(a.classifyStructure(2,-3),'上漲 / OI 減少');assert.equal(a.classifyStructure(-2,-3),'下跌 / OI 減少');assert.equal(a.classifyStructure(null,3),'資料不足');});
test('zscore and severity are data based',()=>{assert.equal(a.zscore(3,[1,2,3,4,5]).toFixed(6),'0.000000');assert.equal(a.anomalySeverity(4,{elevated:1.5,high:2.5,extreme:3.5}),'極端異常');});
test('event research returns and excursions',()=>{const r=a.eventResearch(100,[105,95,110,90,102]);assert.equal(r.t5Return,5);assert.equal(r.t15Return,-5);assert.equal(r.mfe,10);assert.equal(r.mae,-10);});
test('insufficient values remain null',()=>{assert.equal(a.pctChange(100,0),null);assert.equal(a.zscore(3,[]),null);});
