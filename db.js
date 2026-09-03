'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

let pool = null;
let ready = false;
const metrics = { connectionErrors: 0, queryErrors: 0, batchWrites: 0, batchRows: 0 };
function enabled() { return Boolean(process.env.DATABASE_URL); }
function getPool() {
  if (!enabled()) return null;
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }, max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 15000), keepAlive: true });
    pool.on('error', error => { metrics.connectionErrors += 1; logger.error('PostgreSQL pool error', { error: error.message }); });
  }
  return pool;
}
async function query(text, params=[]) {
  const p=getPool();
  if(!p) throw new Error('DATABASE_URL is not configured');
  try { return await p.query(text, params); }
  catch(error) { metrics.queryErrors += 1; throw error; }
}
async function migrate() {
  if (!enabled()) { logger.warn('PostgreSQL disabled: DATABASE_URL is not configured'); return false; }
  const sql=fs.readFileSync(path.join(__dirname,'db','schema.sql'),'utf8');
  await query(sql);
  ready=true; logger.info('PostgreSQL schema ready'); return true;
}
async function ping() { if(!enabled()) return false; await query('SELECT 1'); return true; }
function isReady(){ return ready; }
function stats(){ const p=getPool(); return { connectionErrors:metrics.connectionErrors, queryErrors:metrics.queryErrors, batchWrites:metrics.batchWrites, batchRows:metrics.batchRows, totalConnections:p?.totalCount||0, idleConnections:p?.idleCount||0, waitingRequests:p?.waitingCount||0 }; }
async function close(){ if(pool) await pool.end(); pool=null; ready=false; }

async function upsertInstruments(rows){ if(!ready) return; for(const x of rows){ await query(`INSERT INTO instruments(inst_id,inst_type,quote_ccy,settle_ccy,state,raw,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,now()) ON CONFLICT(inst_id) DO UPDATE SET inst_type=EXCLUDED.inst_type,quote_ccy=EXCLUDED.quote_ccy,settle_ccy=EXCLUDED.settle_ccy,state=EXCLUDED.state,raw=EXCLUDED.raw,updated_at=now()`,[x.instId,x.instType,x.quoteCcy||null,x.settleCcy||null,x.state||'unknown',JSON.stringify(x)]); } }
async function insertTicker(x){ if(!ready||x.timestamp==null) return; await query(`INSERT INTO ticker_snapshots(inst_id,ts,price,change_24h,volume,volume_contracts,raw) VALUES($1,to_timestamp($2/1000.0),$3,$4,$5,$6,$7::jsonb)`,[x.symbol,x.timestamp,x.price,x.change24h,x.volume,x.volumeContracts,JSON.stringify(x)]); }
async function insertTickersBatch(rows){ if(!ready||!rows.length)return; const values=[]; const params=[]; rows.forEach((x,i)=>{const b=i*7;values.push(`($${b+1},to_timestamp($${b+2}/1000.0),$${b+3},$${b+4},$${b+5},$${b+6},$${b+7}::jsonb)`);params.push(x.symbol,x.timestamp,x.price,x.change24h,x.volume,x.volumeContracts,JSON.stringify(x));}); await query(`INSERT INTO ticker_snapshots(inst_id,ts,price,change_24h,volume,volume_contracts,raw) VALUES ${values.join(',')}`,params); metrics.batchWrites+=1; metrics.batchRows+=rows.length; }
async function upsertCandle(x,bar){ if(!ready||x.timestamp==null) return; await query(`INSERT INTO candles(inst_id,bar,ts,open,high,low,close,volume,volume_currency,volume_quote,confirmed,raw) VALUES($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT(inst_id,bar,ts) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,volume_currency=EXCLUDED.volume_currency,volume_quote=EXCLUDED.volume_quote,confirmed=EXCLUDED.confirmed,raw=EXCLUDED.raw`,[x.symbol,bar,x.timestamp,x.open,x.high,x.low,x.close,x.volume,x.volumeCurrency,x.volumeQuote,x.confirmed,JSON.stringify(x)]); }
async function upsertCandlesBatch(rows,bar='5m'){ if(!ready||!rows.length)return; const unique=new Map(); for(const x of rows){if(!x?.symbol||x.timestamp==null)continue;unique.set(`${x.symbol}|${bar}|${x.timestamp}`,x);} const deduped=[...unique.values()]; if(!deduped.length)return; const values=[]; const params=[]; deduped.forEach((x,i)=>{const b=i*12;values.push(`($${b+1},$${b+2},to_timestamp($${b+3}/1000.0),$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12}::jsonb)`);params.push(x.symbol,bar,x.timestamp,x.open,x.high,x.low,x.close,x.volume,x.volumeCurrency,x.volumeQuote,x.confirmed,JSON.stringify(x));}); await query(`INSERT INTO candles(inst_id,bar,ts,open,high,low,close,volume,volume_currency,volume_quote,confirmed,raw) VALUES ${values.join(',')} ON CONFLICT(inst_id,bar,ts) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,volume_currency=EXCLUDED.volume_currency,volume_quote=EXCLUDED.volume_quote,confirmed=EXCLUDED.confirmed,raw=EXCLUDED.raw`,params); metrics.batchWrites+=1; metrics.batchRows+=deduped.length; }
async function insertTrade(x,instId){ if(!ready||x.tradeId==null||x.timestamp==null)return; await query(`INSERT INTO trades(trade_id,inst_id,ts,price,size,side,source,raw) VALUES($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8::jsonb) ON CONFLICT(inst_id,trade_id) DO NOTHING`,[String(x.tradeId),instId,x.timestamp,x.price,x.size,x.side||null,x.source||null,JSON.stringify(x.raw||x)]); }
async function insertTradesBatch(rows){ if(!ready||!rows.length)return; const values=[]; const params=[]; rows.forEach((x,i)=>{const b=i*8;values.push(`($${b+1},$${b+2},to_timestamp($${b+3}/1000.0),$${b+4},$${b+5},$${b+6},$${b+7},$${b+8}::jsonb)`);params.push(String(x.tradeId),x.instId,x.timestamp,x.price,x.size,x.side||null,x.source||null,JSON.stringify(x.raw||x));}); await query(`INSERT INTO trades(trade_id,inst_id,ts,price,size,side,source,raw) VALUES ${values.join(',')} ON CONFLICT(inst_id,trade_id) DO NOTHING`,params); metrics.batchWrites+=1; metrics.batchRows+=rows.length; }
async function insertOI(x){ if(!ready||x.timestamp==null)return; await query(`INSERT INTO open_interest_snapshots(inst_id,ts,oi,oi_ccy,oi_usd,raw) VALUES($1,to_timestamp($2/1000.0),$3,$4,$5,$6::jsonb) ON CONFLICT(inst_id,ts) DO UPDATE SET oi=EXCLUDED.oi,oi_ccy=EXCLUDED.oi_ccy,oi_usd=EXCLUDED.oi_usd,raw=EXCLUDED.raw`,[x.symbol,x.timestamp,x.oi,x.oiCcy,x.oiUsd,JSON.stringify(x)]); }
async function insertOIBatch(rows){ if(!ready||!rows.length)return; const unique=new Map(); for(const x of rows){if(x?.symbol&&x.timestamp!=null)unique.set(`${x.symbol}|${x.timestamp}`,x);} const deduped=[...unique.values()]; if(!deduped.length)return; const values=[]; const params=[]; deduped.forEach((x,i)=>{const b=i*6;values.push(`($${b+1},to_timestamp($${b+2}/1000.0),$${b+3},$${b+4},$${b+5},$${b+6}::jsonb)`);params.push(x.symbol,x.timestamp,x.oi,x.oiCcy,x.oiUsd,JSON.stringify(x));}); await query(`INSERT INTO open_interest_snapshots(inst_id,ts,oi,oi_ccy,oi_usd,raw) VALUES ${values.join(',')} ON CONFLICT(inst_id,ts) DO UPDATE SET oi=EXCLUDED.oi,oi_ccy=EXCLUDED.oi_ccy,oi_usd=EXCLUDED.oi_usd,raw=EXCLUDED.raw`,params); metrics.batchWrites+=1; metrics.batchRows+=deduped.length; }
async function insertFunding(x){ if(!ready||x.timestamp==null)return; await query(`INSERT INTO funding_snapshots(inst_id,ts,funding_rate,funding_time,next_funding_time,raw) VALUES($1,to_timestamp($2/1000.0),$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6::jsonb) ON CONFLICT(inst_id,ts) DO UPDATE SET funding_rate=EXCLUDED.funding_rate,funding_time=EXCLUDED.funding_time,next_funding_time=EXCLUDED.next_funding_time,raw=EXCLUDED.raw`,[x.symbol,x.timestamp,x.fundingRate,x.fundingTime,x.nextFundingTime,JSON.stringify(x)]); }
async function insertFundingHistory(instId,x){ if(!ready||x.fundingTime==null)return; await query(`INSERT INTO funding_history(inst_id,funding_time,funding_rate,realized_rate,raw) VALUES($1,to_timestamp($2/1000.0),$3,$4,$5::jsonb) ON CONFLICT(inst_id,funding_time) DO NOTHING`,[instId,x.fundingTime,x.fundingRate,x.realizedRate,JSON.stringify(x.raw||x)]); }
async function insertOrderBook(x){ if(!ready||x.timestamp==null)return; await query(`INSERT INTO orderbook_snapshots(inst_id,ts,best_bid,best_ask,spread,bid_volume,ask_volume,bid_ask_ratio,depth_imbalance,bids,asks) VALUES($1,to_timestamp($2/1000.0),$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,[x.symbol,x.timestamp,x.bestBid,x.bestAsk,x.spread,x.bidVolume,x.askVolume,x.bidAskRatio,x.depthImbalance,JSON.stringify(x.bids||[]),JSON.stringify(x.asks||[])]); }
async function insertLiquidation(x){ if(!ready||x.timestamp==null)return; await query(`INSERT INTO liquidation_events(inst_id,ts,side,bk_px,size,raw) VALUES($1,to_timestamp($2/1000.0),$3,$4,$5,$6::jsonb)`,[x.symbol,x.timestamp,x.side,x.price,x.size,JSON.stringify(x.raw||x)]); }
async function insertAnomaly(x){ if(!ready)return null; const r=await query(`INSERT INTO market_anomalies(inst_id,ts,anomaly_type,severity,measured_value,baseline,metadata) VALUES($1,to_timestamp($2/1000.0),$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,[x.symbol,x.timestamp,x.anomalyType,x.severity,x.measuredValue,JSON.stringify(x.baseline||{}),JSON.stringify(x.metadata||{})]); return r.rows[0]?.id||null; }
async function cleanup(){ if(!ready)return; const days=config.DATA_RETENTION_DAYS; const sqls=[`DELETE FROM ticker_snapshots WHERE ts < now() - ($1 || ' days')::interval`,`DELETE FROM candles WHERE ts < now() - ($1 || ' days')::interval`,`DELETE FROM trades WHERE ts < now() - ($1 || ' days')::interval`,`DELETE FROM orderbook_snapshots WHERE ts < now() - ($1 || ' days')::interval`,`DELETE FROM open_interest_snapshots WHERE ts < now() - ($1 || ' days')::interval`,`DELETE FROM funding_snapshots WHERE ts < now() - ($1 || ' days')::interval`,`DELETE FROM funding_history WHERE funding_time < now() - ($1 || ' days')::interval`,`DELETE FROM liquidation_events WHERE ts < now() - ($1 || ' days')::interval`,`DELETE FROM market_anomalies WHERE ts < now() - ($1 || ' days')::interval`]; for(const s of sqls)await query(s,[days]); }

module.exports={enabled,getPool,query,migrate,ping,isReady,stats,close,upsertInstruments,insertTicker,insertTickersBatch,upsertCandle,upsertCandlesBatch,insertTrade,insertTradesBatch,insertOI,insertOIBatch,insertFunding,insertFundingHistory,insertOrderBook,insertLiquidation,insertAnomaly,cleanup};