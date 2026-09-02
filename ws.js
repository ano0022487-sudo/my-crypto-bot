'use strict';

const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

class OKXPublicWS {
  constructor() { this.ws = null; this.timer = null; this.instIds = []; this.latest = { openInterest: new Map(), funding: new Map(), liquidations: [] }; }
  async start(instIds) { this.instIds = instIds; this.connect(); }
  connect() {
    this.ws = new WebSocket(config.OKX_PUBLIC_WS_URL);
    this.ws.on('open', () => { logger.info('OKX public WebSocket connected'); this.subscribe(); });
    this.ws.on('message', raw => this.onMessage(raw));
    this.ws.on('error', err => logger.error('OKX public WebSocket error',{error:err.message}));
    this.ws.on('close', () => { logger.warn('OKX public WebSocket disconnected'); clearTimeout(this.timer); this.timer=setTimeout(()=>this.connect(),3000); });
  }
  subscribe() {
    const args=[];
    for(const instId of this.instIds){ args.push({channel:'open-interest',instId},{channel:'funding-rate',instId}); }
    args.push({channel:'liquidation-orders',instType:'SWAP'});
    for(let i=0;i<args.length;i+=100){ this.ws.send(JSON.stringify({op:'subscribe',args:args.slice(i,i+100)})); }
  }
  onMessage(raw) {
    let msg; try { msg=JSON.parse(raw.toString()); } catch { return; }
    if(!msg.data || !msg.arg) return;
    const ch=msg.arg.channel;
    if(ch==='open-interest') for(const d of msg.data) this.latest.openInterest.set(d.instId,d);
    else if(ch==='funding-rate') for(const d of msg.data) this.latest.funding.set(d.instId,d);
    else if(ch==='liquidation-orders') this.latest.liquidations=[...msg.data,...this.latest.liquidations].slice(0,200);
  }
  snapshot() { return { openInterest:Object.fromEntries(this.latest.openInterest), funding:Object.fromEntries(this.latest.funding), liquidations:this.latest.liquidations }; }
}
module.exports={OKXPublicWS};
