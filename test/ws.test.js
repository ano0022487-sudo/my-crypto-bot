'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {OKXPublicWS}=require('../ws');

test('websocket starts with one multiplexed connection state',()=>{
 const ws=new OKXPublicWS();
 ws.instIds=Array.from({length:446},(_,i)=>`TEST-${i}`);
 const snapshot=ws.snapshot();
 assert.equal(snapshot.activeSockets,0);
 assert.equal(snapshot.subscribedInstruments,0);
 assert.equal(snapshot.staleSubscriptionCount,446);
});

test('reconnect delay stays within configured bounds',()=>{
 const ws=new OKXPublicWS();
 for(let attempt=0;attempt<8;attempt+=1){ws.reconnectAttempt=attempt;const delay=ws.nextReconnectDelay();assert.ok(delay>=1000);assert.ok(delay<=30000);}
});

test('reconnect scheduling is single-flight',()=>{
 const ws=new OKXPublicWS();
 ws.connect=()=>{};
 ws.scheduleReconnect('test');
 const first=ws.timer;
 ws.scheduleReconnect('duplicate');
 assert.equal(ws.timer,first);
 ws.stop();
 assert.equal(ws.reconnectScheduled,false);
});
