'use strict';
const express=require('express');
const path=require('path');
const market=require('./market');
const config=require('./config');
const logger=require('./logger');
const db=require('./db');
const {OKXPublicWS}=require('./ws');
const {OKXCandleWS}=require('./candleWs');
const {Collector}=require('./collector');

const app=express();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
const realtime=new OKXPublicWS();
const collector=new Collector(realtime);
const candleRealtime=new OKXCandleWS((type,data)=>collector.handle(type,data));
realtime.onEvent=(type,data)=>collector.handle(type,data);
const safe=fn=>async(req,res)=>{try{res.json({ok:true,data:await fn(req)});}catch(e){logger.error('API route failed',{path:req.path,error:e.message});res.status(503).json({ok:false,error:'資料暫時無法取得'});}};

app.get('/api/health',async(req,res)=>{let database='not_configured';if(db.enabled()){try{database=await db.ping()?'connected':'unavailable';}catch{database='unavailable';}}res.json({ok:true,data:{service:'OKX Public Market Research',timestamp:Date.now(),privateApi:false,tradingExecution:false,database,websocket:realtime.snapshot(),candleWebsocket:candleRealtime.snapshot(),collector:collector.health()}});});
app.get('/api/realtime',(req,res)=>res.json({ok:true,data:{public:realtime.snapshot(),candles:candleRealtime.snapshot(),collector:collector.health()}}));
app.get('/api/instruments',safe(()=>market.instruments()));
app.get('/api/markets',safe(()=>market.markets()));
app.get('/api/candles/:instId',safe(req=>market.candles(req.params.instId,req.query.bar||'5m')));
app.get('/api/trades/:instId',safe(req=>market.trades(req.params.instId,Math.min(Number(req.query.limit||100),500))));
app.get('/api/orderbook/:instId',safe(req=>market.orderBook(req.params.instId,Math.min(Number(req.query.sz||20),config.MAX_ORDER_BOOK_LEVELS))));
app.get('/api/funding/:instId',safe(req=>market.funding(req.params.instId)));
app.get('/api/funding-history/:instId',safe(req=>market.fundingHistory(req.params.instId,Math.min(Number(req.query.limit||100),100))));
app.get('/api/oi/:instId',safe(req=>market.oi(req.params.instId)));
app.get('/api/liquidations/:instId',safe(req=>db.isReady()?db.query(`SELECT EXTRACT(EPOCH FROM ts)*1000 timestamp,side,bk_px "bkPx",size FROM liquidation_events WHERE inst_id=$1 ORDER BY ts DESC LIMIT $2`,[req.params.instId,Math.min(Number(req.query.limit||100),500)]).then(r=>r.rows.reverse()):[]));

const server=app.listen(config.PORT,async()=>{logger.info(`Scanner listening on ${config.PORT}`);try{await db.migrate();if(db.isReady()){try{await db.cleanup();logger.info('Startup database cleanup completed');}catch(e){logger.warn('Startup database cleanup skipped',{error:e.message});}}const ids=(await market.instruments()).map(x=>x.instId);await realtime.start(ids);await candleRealtime.start(ids);await collector.start();logger.info('Public market data platform initialized',{markets:ids.length,database:db.enabled(),publicWebSocket:realtime.connected,candleWebSocket:candleRealtime.connected});}catch(e){logger.error('Initialization failed',{error:e.message});}});
server.on('error',e=>logger.error('Server error',{error:e.message}));
process.on('unhandledRejection',e=>logger.error('Unhandled rejection',{error:e?.message||String(e)}));
process.on('uncaughtException',e=>logger.error('Uncaught exception',{error:e.message}));
module.exports={app,server,realtime,candleRealtime,collector};
