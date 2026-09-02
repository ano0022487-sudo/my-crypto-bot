'use strict';

const express = require('express');
const path = require('path');
const market = require('./market');
const config = require('./config');
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const safe = fn => async (req,res) => { try { res.json({ok:true,data:await fn(req)}); } catch(error) { logger.error('API route failed',{path:req.path,error:error.message}); res.status(503).json({ok:false,error:'資料暫時無法取得'}); } };

app.get('/api/health',(req,res)=>res.json({ok:true,data:{service:'OKX Public Market Scanner',timestamp:Date.now(),privateApi:false}}));
app.get('/api/instruments',safe(()=>market.instruments()));
app.get('/api/markets',safe(async()=>{ const [tickers,oi]=await Promise.all([market.tickers(),market.openInterest()]); const oiMap=new Map(oi.map(x=>[x.symbol,x])); const rows=tickers.map(t=>({...t,oi:oiMap.get(t.symbol)?.oiUsd??null,oiChanges:oiMap.get(t.symbol)?.changes??null})); return {count:rows.length,updatedAt:Date.now(),markets:rows}; }));
app.get('/api/candles/:instId',safe(req=>market.candles(req.params.instId,req.query.bar||'5m')));
app.get('/api/trades/:instId',safe(req=>market.trades(req.params.instId,Math.min(Number(req.query.limit||100),500))));
app.get('/api/orderbook/:instId',safe(req=>market.orderBook(req.params.instId,Math.min(Number(req.query.sz||20),config.MAX_ORDER_BOOK_LEVELS))));
app.get('/api/funding/:instId',safe(req=>market.funding(req.params.instId)));
app.get('/api/funding-history/:instId',safe(req=>market.fundingHistory(req.params.instId,Math.min(Number(req.query.limit||100),100))));

const server=app.listen(config.PORT,()=>logger.info(`Scanner listening on ${config.PORT}`));
server.on('error',error=>logger.error('Server error',{error:error.message}));
process.on('unhandledRejection',error=>logger.error('Unhandled rejection',{error:error?.message||String(error)}));
process.on('uncaughtException',error=>logger.error('Uncaught exception',{error:error.message}));
module.exports={app,server};
