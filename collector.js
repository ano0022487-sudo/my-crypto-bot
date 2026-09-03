'use strict';
const okx=require('./okx'),db=require('./db'),config=require('./config');
const {normalizeTicker,normalizeCandle,normalizeTrade,normalizeOrderBook,numberOrNull,normalizeOI,normalizeFunding}=require('./normalize');
const {zscore,anomalySeverity}=require('./analytics');
const logger=require('./logger');

class Collector{
 constructor(ws){
  this.ws=ws;this.ids=[];this.orderbookTimer=null;this.analyticsTimer=null;this.fundingTimer=null;this.cleanupTimer=null;this.flushTimer=null;this.healthTimer=null;this.lastPersist=new Map();
  this.tradeQueue=[];this.tickerQueue=[];this.flushInProgress=false;this.flushBlockedUntil=0;this.flushFailures=0;this.lastFlushAt=null;this.lastDbErrorAt=null;this.droppedTrades=0;this.droppedTickers=0;this.eventsReceived=0;
  this.lastEventAt={trade:null,ticker:null};this.staleMarkets=new Set();this.lastHealthLogAt=0;
 }
 async start(){
  if(!db.enabled())return;
  this.ids=(await okx.getInstruments()).filter(x=>x.instType==='SWAP'&&x.state==='live'&&(x.quoteCcy==='USDT'||x.settleCcy==='USDT'));
  await db.upsertInstruments(this.ids);
  this.flushTimer=setInterval(()=>this.flushQueues().catch(()=>{}),config.COLLECTOR_FLUSH_MS);
  this.healthTimer=setInterval(()=>this.logHealth(),config.COLLECTOR_HEALTH_LOG_MS);
  this.orderbookTimer=setInterval(()=>this.pollOrderBooks().catch(e=>logger.error('Orderbook collector failed',{error:e.message})),config.ORDERBOOK_POLL_MS);
  this.analyticsTimer=setInterval(()=>this.runAnalytics().catch(e=>logger.error('Analytics collector failed',{error:e.message})),config.ANALYTICS_POLL_MS);
  this.fundingTimer=setInterval(()=>this.pollFundingHistory().catch(e=>logger.warn('Funding history poll failed',{error:e.message})),10*60*1000);
  this.cleanupTimer=setInterval(()=>db.cleanup().catch(e=>logger.error('Cleanup failed',{error:e.message})),6*60*60*1000);
  await this.pollFundingHistory();await this.pollOrderBooks();this.logHealth(true);
 }
 stop(){for(const x of [this.orderbookTimer,this.analyticsTimer,this.fundingTimer,this.cleanupTimer,this.flushTimer,this.healthTimer])clearInterval(x);this.orderbookTimer=this.analyticsTimer=this.fundingTimer=this.cleanupTimer=this.flushTimer=this.healthTimer=null;}
 enqueue(queue,item,maxSize,dropCounter){if(queue.length>=maxSize){queue.shift();this[dropCounter]+=1;}queue.push(item);}
 async handle(type,data){
  if(!db.isReady())return;this.eventsReceived+=1;
  try{
   if(type==='ticker'){
    const x=normalizeTicker(data),k=`ticker:${x.symbol}`;this.lastEventAt.ticker=x.timestamp||Date.now();
    if(x.symbol)this.staleMarkets.delete(x.symbol);
    if(this.lastPersist.get(k)&&Date.now()-this.lastPersist.get(k)<5000)return;
    this.lastPersist.set(k,Date.now());this.enqueue(this.tickerQueue,x,config.COLLECTOR_MAX_TICKER_QUEUE,'droppedTickers');
   }else if(type==='trade'){
    const x={...normalizeTrade(data),instId:data.instId,raw:data};this.lastEventAt.trade=x.timestamp||Date.now();this.enqueue(this.tradeQueue,x,config.COLLECTOR_MAX_TRADE_QUEUE,'droppedTrades');
   }else if(type==='candle5m'){const x=normalizeCandle(data);x.symbol=data.instId;await db.upsertCandle(x,'5m');}
   else if(type==='open-interest')await db.insertOI(normalizeOI(data));
   else if(type==='funding-rate')await db.insertFunding(normalizeFunding(data,data.instId));
   else if(type==='liquidation')await db.insertLiquidation(data);
  }catch(e){this.lastDbErrorAt=Date.now();this.rateLimitedDbError(type,e);}
 }
 rateLimitedDbError(type,e){const now=Date.now();if(now-this.lastHealthLogAt<5000)return;logger.error('Collector persistence error',{type,error:e.message});}
 recordFlushFailure(e){this.flushFailures+=1;this.lastDbErrorAt=Date.now();this.flushBlockedUntil=Date.now()+Math.min(30000,1000*(2**Math.min(this.flushFailures,5)));const now=Date.now();if(now-this.lastHealthLogAt>=5000){this.lastHealthLogAt=now;logger.error('Collector batch flush failed',{error:e.message,flushFailures:this.flushFailures,backoffMs:this.flushBlockedUntil-now});}}
 async flushQueues(){
  if(this.flushInProgress||Date.now()<this.flushBlockedUntil||!db.isReady())return;
  if(!this.tradeQueue.length&&!this.tickerQueue.length)return;
  this.flushInProgress=true;let trades=[];let tickers=[];
  try{
   trades=this.tradeQueue.splice(0,config.COLLECTOR_TRADE_BATCH_SIZE);tickers=this.tickerQueue.splice(0,config.COLLECTOR_TICKER_BATCH_SIZE);
   if(trades.length)await db.insertTradesBatch(trades);
   if(tickers.length)await db.insertTickersBatch(tickers);
   this.flushFailures=0;this.flushBlockedUntil=0;this.lastFlushAt=Date.now();
  }catch(e){
   if(tickers.length)this.tickerQueue.splice(0,0,...tickers);
   if(trades.length)this.tradeQueue.splice(0,0,...trades);
   this.recordFlushFailure(e);
   throw e;
  }finally{this.flushInProgress=false;}
 }
 updateStale(){
  const now=Date.now();const snap=this.ws?.snapshot?.();if(!snap)return;
  const tickers=this.ws.lastTickerByInstrument||new Map();this.staleMarkets.clear();
  for(const id of this.ids.map(x=>x.instId)){const ts=tickers.get(id)||0;if(!ts||now-ts>config.COLLECTOR_STALE_MS)this.staleMarkets.add(id);}
 }
 health(){this.updateStale();const ws=this.ws?.snapshot?.()||{};const database=db.stats();return {timestamp:Date.now(),websocket:{connections:ws.connectionCount||0,activeSockets:ws.activeSockets||0,subscriptionRequests:ws.subscriptionRequests||0,subscribedChannels:ws.subscribedChannels||0,subscribedInstruments:ws.subscribedInstruments||this.ids.length,reconnectCount:ws.reconnectCount||0,timeoutCount:ws.timeoutCount||0,lastTradeTimestamp:ws.lastTradeTimestamp||this.lastEventAt.trade,lastTickerTimestamp:ws.lastTickerTimestamp||this.lastEventAt.ticker,lastSuccessfulMessageTimestamp:ws.lastSuccessfulMessageTimestamp||null,staleSubscriptionCount:this.staleMarkets.size},queues:{trade:this.tradeQueue.length,ticker:this.tickerQueue.length,maxTrade:config.COLLECTOR_MAX_TRADE_QUEUE,maxTicker:config.COLLECTOR_MAX_TICKER_QUEUE,droppedTrades:this.droppedTrades,droppedTickers:this.droppedTickers},database:{...database,lastDbErrorTimestamp:this.lastDbErrorAt},lastFlushTimestamp:this.lastFlushAt};}
 logHealth(force=false){const now=Date.now();if(!force&&now-this.lastHealthLogAt<config.COLLECTOR_HEALTH_LOG_MS)return;this.lastHealthLogAt=now;logger.info('Collector health summary',this.health());}
 async pollFundingHistory(){for(const id of this.ids){try{const rows=await okx.getFundingHistory(id.instId,100);for(const x of rows)await db.insertFundingHistory(id.instId,{fundingTime:numberOrNull(x.fundingTime),fundingRate:numberOrNull(x.fundingRate),realizedRate:numberOrNull(x.realizedRate),raw:x});}catch(e){logger.warn('Funding history unavailable',{symbol:id.instId,error:e.message});}}}
 async pollOrderBooks(){for(const id of this.ids){try{const raw=(await okx.getOrderBook(id.instId,config.MAX_ORDER_BOOK_LEVELS))[0];if(!raw?.bids?.length||!raw?.asks?.length)continue;const bids=raw.bids.map(normalizeOrderBook),asks=raw.asks.map(normalizeOrderBook),bidVolume=bids.reduce((s,x)=>s+(x.volume||0),0),askVolume=asks.reduce((s,x)=>s+(x.volume||0),0),bestBid=bids[0]?.price??null,bestAsk=asks[0]?.price??null,total=bidVolume+askVolume;await db.insertOrderBook({symbol:id.instId,timestamp:numberOrNull(raw.ts),bestBid,bestAsk,spread:bestBid!=null&&bestAsk!=null?bestAsk-bestBid:null,bidVolume,askVolume,bidAskRatio:askVolume?bidVolume/askVolume:null,depthImbalance:total?(bidVolume-askVolume)/total:null,bids,asks});}catch(e){logger.warn('Orderbook snapshot unavailable',{symbol:id.instId,error:e.message});}}}
 async runAnalytics(){if(!db.isReady())return;const rs=await db.query(`SELECT i.inst_id,t.price,t.ts,t.volume FROM instruments i LEFT JOIN LATERAL(SELECT price,volume,ts FROM ticker_snapshots WHERE inst_id=i.inst_id ORDER BY ts DESC LIMIT 1)t ON true`);for(const x of rs.rows){if(x.volume==null)continue;const base=await db.query(`SELECT volume FROM ticker_snapshots WHERE inst_id=$1 AND ts>now()-interval '24 hours' AND volume IS NOT NULL ORDER BY ts DESC LIMIT $2`,[x.inst_id,config.ANOMALY_BASELINE_POINTS]);const z=zscore(x.volume,base.rows.map(r=>r.volume));const severity=anomalySeverity(z,config.ANOMALY_THRESHOLDS);if(severity==='正常'||severity==='資料不足')continue;const id=await db.insertAnomaly({symbol:x.inst_id,timestamp:new Date(x.ts).getTime(),anomalyType:'volume',severity,measuredValue:x.volume,baseline:{mean:base.rows.length?base.rows.reduce((s,r)=>s+Number(r.volume),0)/base.rows.length:null,zscore:z,sampleSize:base.rows.length},metadata:{source:'ticker_snapshots',definition:'24h historical ticker volume baseline'}});if(id)await db.query(`INSERT INTO research_events(anomaly_id,inst_id,t0) VALUES($1,$2,to_timestamp($3/1000.0))`,[id,x.inst_id,new Date(x.ts).getTime()]);}await db.query(`UPDATE research_events r SET t5_price=(SELECT close FROM candles c WHERE c.inst_id=r.inst_id AND c.bar='5m' AND c.ts>=r.t0+interval '5 minutes' ORDER BY c.ts LIMIT 1),t15_price=(SELECT close FROM candles c WHERE c.inst_id=r.inst_id AND c.bar='5m' AND c.ts>=r.t0+interval '15 minutes' ORDER BY c.ts LIMIT 1),t1h_price=(SELECT close FROM candles c WHERE c.inst_id=r.inst_id AND c.bar='5m' AND c.ts>=r.t0+interval '1 hour' ORDER BY c.ts LIMIT 1),t4h_price=(SELECT close FROM candles c WHERE c.inst_id=r.inst_id AND c.bar='5m' AND c.ts>=r.t0+interval '4 hours' ORDER BY c.ts LIMIT 1),t24h_price=(SELECT close FROM candles c WHERE c.inst_id=r.inst_id AND c.bar='5m' AND c.ts>=r.t0+interval '24 hours' ORDER BY c.ts LIMIT 1),completed_at=CASE WHEN now()>=r.t0+interval '24 hours' THEN now() ELSE completed_at END WHERE r.completed_at IS NULL`);await db.query(`UPDATE research_events r SET t5_return=CASE WHEN t5_price IS NOT NULL THEN (t5_price-(SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1))/NULLIF((SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1),0)*100 END,t15_return=CASE WHEN t15_price IS NOT NULL THEN (t15_price-(SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1))/NULLIF((SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1),0)*100 END,t1h_return=CASE WHEN t1h_price IS NOT NULL THEN (t1h_price-(SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1))/NULLIF((SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1),0)*100 END,t4h_return=CASE WHEN t4h_price IS NOT NULL THEN (t4h_price-(SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1))/NULLIF((SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1),0)*100 END,t24h_return=CASE WHEN t24h_price IS NOT NULL THEN (t24h_price-(SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY ts DESC LIMIT 1))/NULLIF((SELECT price FROM ticker_snapshots t WHERE t.inst_id=r.inst_id AND t.ts<=r.t0 ORDER BY t.ts DESC LIMIT 1),0)*100 END WHERE r.completed_at IS NULL OR r.completed_at>now()-interval '24 hours'`);}
}
module.exports={Collector};
