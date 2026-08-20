'use strict';
const fs=require('fs');
const path=require('path');
const Module=require('module');
const source=path.join(__dirname,'event-bot.js');
const bayesPath=path.join(__dirname,'bayes-model.js');
const LOCK='/tmp/okx-event-bot.singleton.lock';
let fd=null;
function acquire(){try{fd=fs.openSync(LOCK,'wx');fs.writeFileSync(fd,String(process.pid));const release=()=>{try{if(fd!==null)fs.closeSync(fd)}catch{}try{if(fs.existsSync(LOCK))fs.unlinkSync(LOCK)}catch{}};process.once('exit',release);process.once('SIGTERM',()=>{release();process.exit(0)});process.once('SIGINT',()=>{release();process.exit(0)});console.log('[Runner] Singleton lock acquired pid='+process.pid);return true}catch(e){try{const p=Number(fs.readFileSync(LOCK,'utf8').trim());if(p>0){try{process.kill(p,0);console.error('[Runner] Another bot process is already running pid='+p+'; refusing duplicate startup.');return false}catch{try{fs.unlinkSync(LOCK)}catch{}return acquire()}}}catch{}try{fs.unlinkSync(LOCK)}catch{}return acquire()}}
if(!acquire()){process.exitCode=0;return;}
try{
  let code=fs.readFileSync(source,'utf8');
  if(!fs.existsSync(bayesPath))throw Error('[Runner] bayes-model.js not found');
  code=code.replace(/const\s+LIVE_TRADING\s*=\s*[^;]+;/,'const LIVE_TRADING = false;');
  // Telegram polling is intentional: this Runner owns the only bot instance.
  code=code.replace(/polling\s*:\s*(true|false)/g,'polling: true');
  code=code.replace(/const\s+TARGET_STAKE\s*=\s*[^;]+;/,'const TARGET_STAKE=1;');
  code=code.replace(/const\s+MIN_ENTRY_PRICE\s*=\s*[^;]+;/,'const MIN_ENTRY_PRICE=0.25;');
  code=code.replace(/const\s+MAX_ENTRY_PRICE\s*=\s*[^;]+;/,'const MAX_ENTRY_PRICE=0.40;');
  code=code.replace(/const\s+MIN_SCORE\s*=\s*[^;]+;/,'const MIN_SCORE=90;');
  code=code.replace(/const\s+MIN_MODEL_PROB\s*=\s*[^;]+;/,'const MIN_MODEL_PROB=0.75;');
  code=code.replace(/const\s+MIN_EDGE\s*=\s*[^;]+;/,'const MIN_EDGE=0.15;');
  code=code.replace(/const\s+MAX_CONSECUTIVE_LOSSES\s*=\s*[^;]+;/,'const MAX_CONSECUTIVE_LOSSES=3;');
  if(!code.includes('const TARGET_STAKE=1;'))throw Error('[Runner] TARGET_STAKE override failed');
  if(!code.includes('const MIN_ENTRY_PRICE=0.25;'))throw Error('[Runner] MIN_ENTRY_PRICE override failed');
  if(!code.includes('const MAX_ENTRY_PRICE=0.40;'))throw Error('[Runner] MAX_ENTRY_PRICE override failed');
  if(!code.includes('const MIN_SCORE=90;'))throw Error('[Runner] MIN_SCORE override failed');
  if(!code.includes('const MIN_MODEL_PROB=0.75;'))throw Error('[Runner] MIN_MODEL_PROB override failed');
  if(!code.includes('const MIN_EDGE=0.15;'))throw Error('[Runner] MIN_EDGE override failed');
  if(!code.includes('const MAX_CONSECUTIVE_LOSSES=3;'))throw Error('[Runner] MAX_CONSECUTIVE_LOSSES override failed');

  // Bayesian calibration: preserve the existing evidence model, then replace its
  // neutral-prior posterior with an empirical-prior posterior from closed trades.
  const bayesInject=`\n/* [RUNNER BAYES CALIBRATION] */\nconst {calibrateBayes:__calibrateBayes}=require(${JSON.stringify(bayesPath)});\n`;
  const modelMarker='model=modelProbability(price,strike,c5,c15)';
  if(!code.includes(modelMarker))throw Error('[Runner] modelProbability call marker not found');
  code=code.replace(modelMarker,'model=__calibrateBayes(modelProbability(price,strike,c5,c15),state.trades)');
  code=code.replace('const state=loadState();','const state=loadState();'+bayesInject);

  console.log('[Runner] PAPER ONLY');
  console.log('[Runner] Strategy logic loaded directly from event-bot.js');
  console.log('[Runner] No formula-gate source injection; avoids marker mismatch deployments.');
  console.log('[Runner] Stake=1U / Score>=90 / Model>=75% / Edge>=15% / Entry 0.25-0.40');
  console.log('[Runner] Bayesian: empirical prior + Bayes factor + posterior');
  console.log('[Runner] Telegram: POLLING mode / singleton protected');
  const m=new Module(source,module);m.filename=source;m.paths=Module._nodeModulePaths(__dirname);m._compile(code,source);
}catch(e){console.error('[Runner Error]',e&&e.stack||e);process.exitCode=1;}
