'use strict';
const fs=require('fs'),path=require('path'),Module=require('module');
const source=path.join(__dirname,'event-bot.js');
const LOCK='/tmp/okx-event-bot.singleton.lock';
let fd=null;
function release(){try{if(fd!==null)fs.closeSync(fd)}catch{}try{if(fs.existsSync(LOCK))fs.unlinkSync(LOCK)}catch{}}
function acquire(){try{fd=fs.openSync(LOCK,'wx');fs.writeFileSync(fd,String(process.pid));process.once('exit',release);process.once('SIGTERM',()=>{release();process.exit(0)});process.once('SIGINT',()=>{release();process.exit(0)});console.log('[Runner] Singleton lock acquired pid='+process.pid);return true}catch(e){try{const p=Number(fs.readFileSync(LOCK,'utf8').trim());if(p>0){try{process.kill(p,0);console.error('[Runner] Another bot process is already running pid='+p+'; refusing duplicate startup.');return false}catch{try{fs.unlinkSync(LOCK)}catch{}return acquire()}}}catch{}try{fs.unlinkSync(LOCK)}catch{}return acquire()}}
if(!acquire()){process.exitCode=0;return;}
try{
 let code=fs.readFileSync(source,'utf8');
 code=code.replace(/const\s+LIVE_TRADING\s*=\s*[^;]+;/,'const LIVE_TRADING = false;');
 code=code.replace(/polling\s*:\s*(true|false)/g,'polling: false');
 const cfg='const TARGET_STAKE=1;const MIN_EDGE=0.15;const MIN_SCORE=90;const MIN_MODEL_PROB=0.75;const MIN_ENTRY_PRICE=0.25;const MAX_ENTRY_PRICE=0.40;const EARLY_TP_PCT=0.30;const EARLY_SL_PCT=0.25;const MIN_MINUTES_TO_EXPIRY=2;const MAX_MINUTES_TO_EXPIRY=20;const DAILY_LOSS_PCT=0.10;const MAX_CONSECUTIVE_LOSSES=3;const COOLDOWN_MS=30*60*1000;';
 const cs=code.indexOf('const TARGET_STAKE='); const ce=code.indexOf(';',code.indexOf('MAX_CONSECUTIVE_LOSSES=',cs));
 if(cs<0||ce<0)throw Error('[Runner] strategy config not found');
 code=code.slice(0,cs)+cfg+code.slice(ce+1);
 code=code.replace('const MIN_ENTRY_PRICE=0.25;','const MIN_ENTRY_PRICE=0.25;const MIN_MODEL_RATIO=1.50;');
 const rejectRe=/let reject=null;if\(model\.score<MIN_SCORE\)reject=`score \$\{model\.score\}<\$\{MIN_SCORE\}`;else if\(modelProb<MIN_MODEL_PROB\)reject=`(?:model|bayes) \$\{\(modelProb\*100\)\.toFixed\(1\)\}%<\$\{MIN_MODEL_PROB\*100\}%`;else if\(edge<MIN_EDGE\)reject=`(?:edge|bayes edge) \$\{\(edge\*100\)\.toFixed\(1\)\}%<\$\{MIN_EDGE\*100\}%`;/;
 const rejectNew='let reject=null;if(model.score<MIN_SCORE)reject=`score ${model.score}<${MIN_SCORE}`;else if(modelProb<MIN_MODEL_PROB)reject=`model ${(modelProb*100).toFixed(1)}%<${MIN_MODEL_PROB*100}%`;else if(edge<MIN_EDGE)reject=`edge ${(edge*100).toFixed(1)}%<${MIN_EDGE*100}%`;else if(modelProb<=entryPx)reject=`EV ${(modelProb-entryPx).toFixed(4)}<=0`;else if(entryPx<=0||modelProb/entryPx<MIN_MODEL_RATIO)reject=`model/market ${(entryPx>0?modelProb/entryPx:0).toFixed(2)}<${MIN_MODEL_RATIO}`;';
 if(!rejectRe.test(code))throw Error('[Runner] formula gate marker not found: unsupported event-bot.js gate format');
 code=code.replace(rejectRe,rejectNew);
 const syncRe=/function syncAccounting\(\)\{[\s\S]*?\n\}/;
 const syncNew=`function syncAccounting(){const trades=Array.isArray(state.trades)?state.trades:[];const pnl=trades.reduce((s,t)=>s+Number(t&&t.pnl||0),0);state.startEquity=START_CAPITAL;state.realizedPnl=Number(pnl.toFixed(4));if(!LIVE_TRADING){const expected=Number((START_CAPITAL+pnl).toFixed(4));if(!Number.isFinite(Number(state.paperEquity))||Math.abs(Number(state.paperEquity)-expected)>0.0001)state.paperEquity=Math.max(0,expected);}}`;
 if(!syncRe.test(code))throw Error('[Runner] syncAccounting marker not found');code=code.replace(syncRe,syncNew);
 const exitRe=/state\.position=null;syncAccounting\(\);if\(state\.consecutiveLosses>=MAX_CONSECUTIVE_LOSSES\)\{state\.halted=true;state\.cooldownUntil=Date\.now\(\)\+COOLDOWN_MS;\}saveState\(\);/;
 const exitNew='state.position=null;syncAccounting();if(pnl<0)state.consecutiveLosses=Number(state.consecutiveLosses||0)+1;else if(pnl>0)state.consecutiveLosses=0;if(state.consecutiveLosses>=MAX_CONSECUTIVE_LOSSES){state.halted=true;state.cooldownUntil=Date.now()+COOLDOWN_MS;console.log(`[RISK] ${state.consecutiveLosses} consecutive NEW losses -> 30m cooldown`);}saveState();';
 if(!exitRe.test(code))throw Error('[Runner] exit risk marker not found');code=code.replace(exitRe,exitNew);
 const riskRe=/function riskBlocked\(\)\{[\s\S]*?\n\}/;
 const riskNew=`function riskBlocked(){const now=Date.now();const until=Number(state.cooldownUntil||0);if(until>0){if(now>=until){state.cooldownUntil=0;state.halted=false;state.consecutiveLosses=0;saveState();console.log('[RISK] COOLDOWN_EXPIRED -> AUTO_RESUME');return false;}state.halted=true;saveState();return true;}if(state.halted){state.halted=false;saveState();}return false;}`;
 if(!riskRe.test(code))throw Error('[Runner] riskBlocked marker not found');code=code.replace(riskRe,riskNew);
 const listen='app.listen(';if(!code.includes(listen))throw Error('[Runner] app.listen marker not found');
 const startup=`state.cooldownUntil=0;state.halted=false;state.consecutiveLosses=0;saveState();setInterval(()=>{try{const until=Number(state.cooldownUntil||0);if(until>0&&Date.now()>=until){state.cooldownUntil=0;state.halted=false;state.consecutiveLosses=0;saveState();console.log('[RISK] COOLDOWN_EXPIRED -> AUTO_RESUME');}}catch(e){console.error('[RISK TIMER]',e.message||e);}},5000);console.log('[RISK] startup: 3 NEW losses -> 30m cooldown');`;
 code=code.replace(listen,startup+listen);
 console.log('[Runner] PAPER ONLY');
 console.log('[Runner] Strategy: 1U / Score>=90 / Model>=75% / Edge>=15% / EV>0 / Model÷Market>=1.50 / Entry 0.25-0.40');
 console.log('[Runner] Risk: 3 NEW consecutive losses -> 30 minute cooldown -> auto resume');
 const m=new Module(source,module);m.filename=source;m.paths=Module._nodeModulePaths(__dirname);m._compile(code,source);
}catch(e){console.error('[Runner Error]',e&&e.stack||e);process.exitCode=1;}
