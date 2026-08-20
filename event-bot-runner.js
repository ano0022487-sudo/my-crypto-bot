'use strict';
const fs=require('fs');
const path=require('path');
const Module=require('module');
const source=path.join(__dirname,'event-bot.js');
const bayesPath=path.join(__dirname,'market-bayes.js');
const LOCK='/tmp/okx-event-bot.singleton.lock';
let fd=null;
function acquire(){try{fd=fs.openSync(LOCK,'wx');fs.writeFileSync(fd,String(process.pid));const release=()=>{try{if(fd!==null)fs.closeSync(fd)}catch{}try{if(fs.existsSync(LOCK))fs.unlinkSync(LOCK)}catch{}};process.once('exit',release);process.once('SIGTERM',()=>{release();process.exit(0)});process.once('SIGINT',()=>{release();process.exit(0)});console.log('[Runner] Singleton lock acquired pid='+process.pid);return true}catch(e){try{const p=Number(fs.readFileSync(LOCK,'utf8').trim());if(p>0){try{process.kill(p,0);console.error('[Runner] Another bot process is already running pid='+p+'; refusing duplicate startup.');return false}catch{try{fs.unlinkSync(LOCK)}catch{}return acquire()}}}catch{}try{fs.unlinkSync(LOCK)}catch{}return acquire()}}
if(!acquire()){process.exitCode=0;return;}
try{
  let code=fs.readFileSync(source,'utf8');
  if(!fs.existsSync(bayesPath))throw Error('[Runner] market-bayes.js not found');
  code=code.replace(/const\s+LIVE_TRADING\s*=\s*[^;]+;/,'const LIVE_TRADING = false;');
  code=code.replace(/polling\s*:\s*(true|false)/g,'polling: true');
  code=code.replace(/const\s+TARGET_STAKE\s*=\s*[^;]+;/,'const TARGET_STAKE=1;');
  code=code.replace(/const\s+MIN_ENTRY_PRICE\s*=\s*[^;]+;/,'const MIN_ENTRY_PRICE=0.25;');
  code=code.replace(/const\s+MAX_ENTRY_PRICE\s*=\s*[^;]+;/,'const MAX_ENTRY_PRICE=0.40;');
  code=code.replace(/const\s+MIN_SCORE\s*=\s*[^;]+;/,'const MIN_SCORE=90;');
  code=code.replace(/const\s+MIN_MODEL_PROB\s*=\s*[^;]+;/,'const MIN_MODEL_PROB=0.75;');
  code=code.replace(/const\s+MIN_EDGE\s*=\s*[^;]+;/,'const MIN_EDGE=0.15;');
  code=code.replace(/const\s+MAX_CONSECUTIVE_LOSSES\s*=\s*[^;]+;/,'const MAX_CONSECUTIVE_LOSSES=3;');
  const checks=['const TARGET_STAKE=1;','const MIN_ENTRY_PRICE=0.25;','const MAX_ENTRY_PRICE=0.40;','const MIN_SCORE=90;','const MIN_MODEL_PROB=0.75;','const MIN_EDGE=0.15;','const MAX_CONSECUTIVE_LOSSES=3;'];
  for(const marker of checks)if(!code.includes(marker))throw Error('[Runner] strategy override failed: '+marker);

  const bayesInject=`\n/* [RUNNER MARKET BAYES] */\nconst {calibrateMarketBayes:__calibrateMarketBayes}=require(${JSON.stringify(bayesPath)});\n`;
  const modelCall=/model\s*=\s*modelProbability\s*\(\s*price\s*,\s*strike\s*,\s*c5\s*,\s*c15\s*\)/;
  if(!modelCall.test(code))throw Error('[Runner] modelProbability call not found');
  code=code.replace(modelCall,'model=__calibrateMarketBayes(modelProbability(price,strike,c5,c15),state.trades,marketYesProb,marketNoProb)');
  code=code.replace('const state=loadState();','const state=loadState();'+bayesInject);

  console.log('[Runner] PAPER ONLY');
  console.log('[Runner] Strategy logic loaded directly from event-bot.js');
  console.log('[Runner] No formula-gate source injection.');
  console.log('[Runner] Stake=1U / Score>=90 / Model>=75% / Edge>=15% / Entry 0.25-0.40');
  console.log('[Runner] Bayesian: technical evidence + empirical prior + live market price + posterior');
  console.log('[Runner] Telegram: POLLING mode / singleton protected');
  const m=new Module(source,module);m.filename=source;m.paths=Module._nodeModulePaths(__dirname);m._compile(code,source);
}catch(e){console.error('[Runner Error]',e&&e.stack||e);process.exitCode=1;}
