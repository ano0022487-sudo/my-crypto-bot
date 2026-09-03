'use strict';
module.exports={
 PORT:Number(process.env.PORT||10000),
 OKX_REST_BASE_URL:process.env.OKX_REST_BASE_URL||'https://www.okx.com',
 OKX_PUBLIC_WS_URL:process.env.OKX_PUBLIC_WS_URL||'wss://ws.okx.com:8443/ws/v5/public',
 REQUEST_TIMEOUT_MS:Number(process.env.REQUEST_TIMEOUT_MS||8000),
 CACHE_TTL_MS:{instruments:5*60*1000,tickers:1500,candles:5000,openInterest:5000,funding:30000,trades:1500,orderBook:1000},
 RETRIES:Number(process.env.OKX_RETRIES||3),BACKOFF_MS:Number(process.env.OKX_BACKOFF_MS||300),MAX_REQUESTS_PER_2S:Number(process.env.MAX_REQUESTS_PER_2S||18),MAX_ORDER_BOOK_LEVELS:Number(process.env.MAX_ORDER_BOOK_LEVELS||20),
 BARS:['5m','15m','1H','4H'],WS_RECONNECT_BASE_MS:1000,WS_RECONNECT_MAX_MS:30000,WS_HEARTBEAT_MS:25000,
 ORDERBOOK_POLL_MS:Number(process.env.ORDERBOOK_POLL_MS||60000),ANALYTICS_POLL_MS:Number(process.env.ANALYTICS_POLL_MS||60000),DATA_RETENTION_DAYS:Number(process.env.DATA_RETENTION_DAYS||7),
 ANOMALY_THRESHOLDS:{elevated:Number(process.env.ANOMALY_Z_ELEVATED||1.5),high:Number(process.env.ANOMALY_Z_HIGH||2.5),extreme:Number(process.env.ANOMALY_Z_EXTREME||3.5)},
 ANOMALY_BASELINE_POINTS:Number(process.env.ANOMALY_BASELINE_POINTS||288),RESEARCH_HORIZONS_MIN:[5,15,60,240,1440]
};
