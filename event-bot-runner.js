'use strict';

/* Single Render launcher. No legacy strategy injection. */
const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, 'event-bot.js');
const loader = path.join(__dirname, 'math-strategy-loader.js');
const LOCK = '/tmp/okx-event-bot.singleton.lock';
let fd = null;

function releaseLock(){
  try{if(fd!==null)fs.closeSync(fd);}catch{}
  try{if(fs.existsSync(LOCK))fs.unlinkSync(LOCK);}catch{}
  fd=null;
}
function acquire(){
  try{
    fd=fs.openSync(LOCK,'wx');
    fs.writeFileSync(fd,String(process.pid));
    process.once('exit',releaseLock);
    process.once('SIGTERM',()=>{releaseLock();process.exit(0);});
    process.once('SIGINT',()=>{releaseLock();process.exit(0);});
    console.log('[Runner] Singleton lock acquired pid='+process.pid);
    return true;
  }catch(e){
    try{
      const p=Number(fs.readFileSync(LOCK,'utf8').trim());
      if(p>0){try{process.kill(p,0);console.error('[Runner] Duplicate process blocked pid='+p);return false;}catch{}}
    }catch{}
    try{fs.unlinkSync(LOCK);}catch{}
    return acquire();
  }
}

if(!acquire()){process.exitCode=0;return;}
if(!fs.existsSync(source)){console.error('[Runner Error] event-bot.js not found');releaseLock();process.exitCode=1;return;}
if(!fs.existsSync(loader)){console.error('[Runner Error] math-strategy-loader.js not found');releaseLock();process.exitCode=1;return;}

try{
  process.env.LIVE_TRADING='false';
  console.log('[DEPLOY VERSION] MATH-1H-RR-2.0');
  console.log('[Runner] PAPER ONLY');
  console.log('[Runner] 1H pure mathematical trend; trend-following only');
  console.log('[Runner] 1H UP -> YES / 1H DOWN -> NO');
  console.log('[Runner] No EMA / RSI / MACD / SNR / ATR / volume / Bayesian logic');
  console.log('[Runner] Gates: 1U / Model>=75% / Edge>=15% / RR>=1.50 / EV>=0.15U / Entry 0.25-0.40');
  console.log('[Runner] Risk: 3 consecutive losses -> 30 minute cooldown');
  require('./math-strategy-loader.js').load();
}catch(e){
  console.error('[Runner Error]',e&&e.stack||e);
  releaseLock();
  process.exitCode=1;
}
