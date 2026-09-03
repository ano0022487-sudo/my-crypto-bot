'use strict';
const WebSocket=require('ws');
const config=require('./config');
const logger=require('./logger');

class OKXPublicWS{
 constructor(onEvent=()=>{}){
  this.ws=null;this.timer=null;this.pingTimer=null;this.instIds=[];this.reconnectAttempt=0;this.reconnectScheduled=false;this.connected=false;this.stopping=false;this.subscriptions=new Set();this.subscribedArgs=new Set();this.subscribedChannelsSet=new Set();this.subscribedInstruments=new Set();this.unsupported=new Set();this.subscribing=false;this.socketGeneration=0;this.connectionCount=0;this.reconnectCount=0;this.lastMessageAt=null;this.lastTradeAt=null;this.lastTickerAt=null;this.lastSuccessfulMessageAt=null;this.timeoutCount=0;this.lastErrorLogAt=0;this.lastReconnectLogAt=0;
  this.latest={tickers:new Map(),openInterest:new Map(),funding:new Map(),liquidations:[]};
  this.lastTradeByInstrument=new Map();this.lastTickerByInstrument=new Map();this.onEvent=onEvent;
 }
 async start(instIds){this.stopping=false;this.instIds=[...new Set(instIds)];this.reconnectAttempt=0;this.clearReconnectTimer();this.connect();}
 stop(){this.stopping=true;this.clearReconnectTimer();this.stopHeartbeat();const ws=this.ws;this.ws=null;this.connected=false;this.cleanupSocket(ws);this.subscriptions.clear();this.subscribedArgs.clear();this.subscribedChannelsSet.clear();this.subscribedInstruments.clear();}
 clearReconnectTimer(){if(this.timer){clearTimeout(this.timer);this.timer=null;}this.reconnectScheduled=false;}
 cleanupSocket(ws){if(!ws)return;try{ws.removeAllListeners();if(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING)ws.close();if(ws.readyState!==WebSocket.CLOSED)ws.terminate();}catch{} }
 connect(){
  if(this.stopping)return;if(this.ws&&(this.ws.readyState===WebSocket.OPEN||this.ws.readyState===WebSocket.CONNECTING))return;
  this.clearReconnectTimer();const generation=++this.socketGeneration;const ws=new WebSocket(config.OKX_PUBLIC_WS_URL,{handshakeTimeout:config.REQUEST_TIMEOUT_MS});
  this.ws=ws;this.connectionCount+=1;this.subscriptions.clear();this.subscribedArgs.clear();this.subscribedChannelsSet.clear();this.subscribedInstruments.clear();this.subscribing=false;
  ws.on('open',()=>{if(generation!==this.socketGeneration)return;this.connected=true;this.reconnectAttempt=0;this.reconnectScheduled=false;this.lastSuccessfulMessageAt=Date.now();logger.info('OKX public WebSocket connected',{connections:this.connectionCount,instruments:this.instIds.length,unsupported:this.unsupported.size});this.subscribe(ws,generation);this.startHeartbeat(ws,generation);});
  ws.on('message',raw=>{if(generation===this.socketGeneration)this.onMessage(raw);});
  ws.on('error',e=>{if(generation!==this.socketGeneration)return;this.rateLimitedError('OKX public WebSocket error',{error:e.message});});
  ws.on('close',(code,reason)=>{if(generation!==this.socketGeneration)return;this.connected=false;this.stopHeartbeat();this.subscriptions.clear();this.subscribedArgs.clear();this.subscribedChannelsSet.clear();this.subscribedInstruments.clear();this.subscribing=false;this.ws=null;this.scheduleReconnect(`close:${code}${reason?.toString()?`:${reason.toString().slice(0,80)}`:''}`);this.rateLimitedReconnect('OKX public WebSocket disconnected',{code,reason:reason?.toString()||'',backoff:this.nextReconnectDelay()});});
 }
 nextReconnectDelay(){const base=Math.min(config.WS_RECONNECT_MAX_MS,config.WS_RECONNECT_BASE_MS*(2**this.reconnectAttempt));return Math.min(config.WS_RECONNECT_MAX_MS,base+Math.floor(Math.random()*(config.WS_RECONNECT_JITTER_MS+1)));}
 scheduleReconnect(reason){if(this.stopping||this.reconnectScheduled)return;this.reconnectScheduled=true;const delay=this.nextReconnectDelay();this.reconnectAttempt+=1;this.reconnectCount+=1;this.lastReconnectLogAt=Date.now();this.timer=setTimeout(()=>{this.timer=null;this.reconnectScheduled=false;if(!this.stopping)this.connect();},delay);logger.warn('OKX WebSocket reconnect scheduled',{reason,attempt:this.reconnectAttempt,delay});}
 startHeartbeat(ws,generation){this.stopHeartbeat();this.pingTimer=setInterval(()=>{if(generation!==this.socketGeneration||ws!==this.ws||ws.readyState!==WebSocket.OPEN)return;const age=Date.now()-(this.lastMessageAt||Date.now());if(age<config.WS_HEARTBEAT_MS)return;if(ws._okxPongDeadline&&Date.now()>ws._okxPongDeadline){this.timeoutCount+=1;this.rateLimitedError('OKX public WebSocket heartbeat timeout',{timeoutCount:this.timeoutCount});this.cleanupSocket(ws);this.ws=null;this.connected=false;this.stopHeartbeat();this.scheduleReconnect('heartbeat-timeout');return;}ws._okxPongDeadline=Date.now()+config.WS_HEARTBEAT_MS;try{ws.send('ping');}catch(error){this.rateLimitedError('OKX public WebSocket ping failed',{error:error.message});this.cleanupSocket(ws);this.ws=null;this.connected=false;this.stopHeartbeat();this.scheduleReconnect('ping-failed');}},5000);}
 stopHeartbeat(){if(this.pingTimer){clearInterval(this.pingTimer);this.pingTimer=null;}}
 async subscribe(ws,generation){
  if(this.subscribing||!ws||ws.readyState!==WebSocket.OPEN)return;this.subscribing=true;const args=[];
  for(const id of this.instIds){for(const channel of ['tickers','trades','candle5m','open-interest','funding-rate']){if(!this.unsupported.has(`${channel}:${id}`))args.push({channel,instId:id});}}args.push({channel:'liquidation-orders',instType:'SWAP'});const size=Math.max(1,config.WS_SUBSCRIBE_BATCH_SIZE);
  try{for(let i=0;i<args.length;i+=size){if(generation!==this.socketGeneration||ws!==this.ws||ws.readyState!==WebSocket.OPEN)break;const batch=args.slice(i,i+size);const key=JSON.stringify(batch);if(this.subscriptions.has(key))continue;ws.send(JSON.stringify({op:'subscribe',args:batch}));this.subscriptions.add(key);if(i+size<args.length)await new Promise(resolve=>setTimeout(resolve,config.WS_SUBSCRIBE_BATCH_DELAY_MS));}}
  catch(error){this.rateLimitedError('OKX public WebSocket subscribe failed',{error:error.message});this.cleanupSocket(ws);this.ws=null;this.connected=false;this.scheduleReconnect('subscribe-failed');}
  finally{if(generation===this.socketGeneration)this.subscribing=false;}
 }
 markUnsupported(channel,instId,detail){
  const key=`${channel}:${instId}`;if(this.unsupported.has(key))return false;this.unsupported.add(key);
  logger.warn('OKX WebSocket channel disabled for instrument',{channel,instId,reason:detail,unsupportedCount:this.unsupported.size});
  return true;
 }
 rateLimitedError(message,data){const now=Date.now();if(now-this.lastErrorLogAt<5000)return;this.lastErrorLogAt=now;logger.error(message,data);}
 rateLimitedReconnect(message,data){const now=Date.now();if(now-this.lastReconnectLogAt<5000)return;this.lastReconnectLogAt=now;logger.warn(message,data);}
 emit(type,data){try{const result=this.onEvent(type,data);if(result?.catch)result.catch(e=>this.rateLimitedError('WebSocket event handler failed',{type,error:e.message}));}catch(e){this.rateLimitedError('WebSocket event handler failed',{type,error:e.message});}}
 onMessage(raw){
  const text=raw.toString();this.lastMessageAt=Date.now();this.lastSuccessfulMessageAt=this.lastMessageAt;
  if(text==='ping'){if(this.ws?.readyState===WebSocket.OPEN)this.ws.send('pong');return;}if(text==='pong'){if(this.ws)this.ws._okxPongDeadline=null;return;}
  let msg;try{msg=JSON.parse(text);}catch{return;}
  if(msg.event==='subscribe'){if(msg.arg){this.subscribedArgs.add(JSON.stringify(msg.arg));if(msg.arg.channel)this.subscribedChannelsSet.add(msg.arg.channel);if(msg.arg.instId)this.subscribedInstruments.add(msg.arg.instId);}return;}
  if(msg.event==='error'){
   const detail=String(msg.msg||'');const channel=msg.arg?.channel;const instId=msg.arg?.instId;const match=detail.match(/channel:([^,\s]+),instId:([^\s]+) doesn't exist/i);const badChannel=channel||match?.[1]||null;const badInst=instId||match?.[2]||null;
   if(badChannel&&badInst)this.markUnsupported(badChannel,badInst,detail);
   this.rateLimitedError('OKX public WebSocket subscription rejected',{code:msg.code,message:detail,channel:badChannel,instId:badInst});
   return;
  }
  if(!msg.data||!msg.arg)return;const ch=msg.arg.channel;
  if(ch==='tickers'){for(const d of msg.data){this.latest.tickers.set(d.instId,d);this.lastTickerAt=Number(d.ts)||Date.now();this.lastTickerByInstrument.set(d.instId,this.lastTickerAt);this.emit('ticker',d);}}
  else if(ch==='open-interest'){for(const d of msg.data){this.latest.openInterest.set(d.instId,d);this.emit('open-interest',d);}}
  else if(ch==='funding-rate'){for(const d of msg.data){this.latest.funding.set(d.instId,d);this.emit('funding-rate',d);}}
  else if(ch==='trades'){for(const d of msg.data){const ts=Number(d.ts)||Date.now();this.lastTradeAt=ts;this.lastTradeByInstrument.set(d.instId,ts);this.emit('trade',d);}}
  else if(ch==='candle5m'){for(const d of msg.data)this.emit('candle5m',d);}
  else if(ch==='liquidation-orders'){for(const group of msg.data||[]){for(const detail of group.details||[]){const e={symbol:group.instId,side:detail.side,price:Number(detail.bkPx),size:Number(detail.sz),timestamp:Number(detail.ts),raw:detail};this.latest.liquidations=[e,...this.latest.liquidations].slice(0,500);this.emit('liquidation',e);}}}
 }
 staleSubscriptions(){const now=Date.now();let count=0;for(const id of this.instIds){if(this.unsupported.has(`tickers:${id}`))continue;const ticker=this.lastTickerByInstrument.get(id)||0;if(!ticker||now-ticker>config.COLLECTOR_STALE_MS)count+=1;}return count;}
 snapshot(){return {connected:this.connected,connectionCount:this.connectionCount,activeSockets:this.ws?1:0,subscriptionRequests:this.subscriptions.size,subscribedChannels:this.subscribedChannelsSet.size,subscribedArguments:this.subscribedArgs.size,subscribedInstruments:this.subscribedInstruments.size,lastTradeTimestamp:this.lastTradeAt,lastTickerTimestamp:this.lastTickerAt,lastSuccessfulMessageTimestamp:this.lastSuccessfulMessageAt,reconnectCount:this.reconnectCount,timeoutCount:this.timeoutCount,staleSubscriptionCount:this.staleSubscriptions(),unsupportedSubscriptions:this.unsupported.size,unsupported:Array.from(this.unsupported),openInterest:Object.fromEntries(this.latest.openInterest),funding:Object.fromEntries(this.latest.funding),liquidations:this.latest.liquidations,tickers:Object.fromEntries(this.latest.tickers)};}
}
module.exports={OKXPublicWS};
