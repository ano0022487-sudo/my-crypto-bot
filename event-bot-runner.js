'use strict';
const fs=require('fs');
const path=require('path');
const Module=require('module');
const source=path.join(__dirname,'event-bot.js');
const LOCK='/tmp/okx-event-bot.singleton.lock';
let fd=null;
function acquire(){try{fd=fs.openSync(LOCK,'wx');fs.writeFileSync(fd,String(process.pid));const release=()=>{try{if(fd!==null)fs.closeSync(fd)}catch{}try{if(fs.existsSync(LOCK))fs.unlinkSync(LOCK)}catch{}};process.once('exit',release);process.once('SIGTERM',()=>{release();process.exit(0)});process.once('SIGINT',()=>{release();process.exit(0)});console.log('[Runner] Singleton lock acquired pid='+process.pid);return true}catch(e){try{const p=Number(fs.readFileSync(LOCK,'utf8').trim());if(p>0){try{process.kill(p,0);console.error('[Runner] Another bot process is already running pid='+p+'; refusing duplicate startup.');return false}catch{try{fs.unlinkSync(LOCK)}catch{}return acquire()}}}catch{}try{fs.unlinkSync(LOCK)}catch{}return acquire()}}
if(!acquire()){process.exitCode=0;return;}
try{
  let code=fs.readFileSync(source,'utf8');
  code=code.replace(/const\s+LIVE_TRADING\s*=\s*[^;]+;/,'const LIVE_TRADING = false;');
  code=code.replace(/polling\s*:\s*(true|false)/g,'polling: false');
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

  // Telegram: polling is disabled to avoid getUpdates 409 conflicts.
  // Deliver updates through the Render HTTPS webhook instead.
  const botDecl='const bot=TG_TOKEN?new TelegramBot(TG_TOKEN,{polling:false}):null;';
  const webhook=`
/* [RUNNER TELEGRAM WEBHOOK] */
const __tgWebhookBase=String(process.env.TELEGRAM_WEBHOOK_URL||process.env.RENDER_EXTERNAL_URL||'').trim().replace(/\\/$/,'');
if(typeof app!=='undefined'&&typeof bot!=='undefined'&&bot&&__tgWebhookBase){
  app.post('/telegram/webhook',(req,res)=>{try{bot.processUpdate(req.body);res.sendStatus(200);}catch(e){console.error('[Telegram webhook process error]',e.message||e);res.sendStatus(500);}});
  const __tgWebhookUrl=__tgWebhookBase+'/telegram/webhook';
  bot.deleteWebHook().catch(()=>{}).then(()=>bot.setWebHook(__tgWebhookUrl)).then(()=>console.log('[Telegram] Webhook enabled:',__tgWebhookUrl)).catch(e=>console.error('[Telegram webhook setup error]',e.message||e));
}else if(typeof bot!=='undefined'&&bot){console.warn('[Telegram] Webhook not configured: missing RENDER_EXTERNAL_URL/TELEGRAM_WEBHOOK_URL');}
`;
  if(code.includes(botDecl)&&!code.includes('[RUNNER TELEGRAM WEBHOOK]'))code=code.replace(botDecl,botDecl+webhook);

  console.log('[Runner] PAPER ONLY');
  console.log('[Runner] Strategy logic loaded directly from event-bot.js');
  console.log('[Runner] No formula-gate source injection; avoids marker mismatch deployments.');
  console.log('[Runner] Stake=1U / Score>=90 / Model>=75% / Edge>=15% / Entry 0.25-0.40');
  console.log('[Runner] Telegram: WEBHOOK mode / polling disabled');
  const m=new Module(source,module);m.filename=source;m.paths=Module._nodeModulePaths(__dirname);m._compile(code,source);
}catch(e){console.error('[Runner Error]',e&&e.stack||e);process.exitCode=1;}
