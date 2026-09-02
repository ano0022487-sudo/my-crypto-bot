'use strict';

const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

class OKXPublicWS {
  constructor() {
    this.ws = null;
    this.timer = null;
    this.pingTimer = null;
    this.instIds = [];
    this.reconnectAttempt = 0;
    this.connected = false;
    this.subscriptions = new Set();
    this.latest = { openInterest: new Map(), funding: new Map(), liquidations: [] };
  }

  async start(instIds) {
    this.instIds = [...new Set(instIds)];
    this.reconnectAttempt = 0;
    this.connect();
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.timer);
    this.ws = new WebSocket(config.OKX_PUBLIC_WS_URL);
    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      logger.info('OKX public WebSocket connected');
      this.subscribe();
      this.startHeartbeat();
    });
    this.ws.on('message', raw => this.onMessage(raw));
    this.ws.on('error', err => logger.error('OKX public WebSocket error', { error: err.message }));
    this.ws.on('close', () => {
      this.connected = false;
      this.subscriptions.clear();
      this.stopHeartbeat();
      this.scheduleReconnect();
      logger.warn('OKX public WebSocket disconnected');
    });
  }

  scheduleReconnect() {
    clearTimeout(this.timer);
    const delay = Math.min(config.WS_RECONNECT_MAX_MS, config.WS_RECONNECT_BASE_MS * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping');
    }, config.WS_HEARTBEAT_MS);
  }

  stopHeartbeat() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const args = [];
    for (const instId of this.instIds) {
      args.push({ channel: 'open-interest', instId });
      args.push({ channel: 'funding-rate', instId });
    }
    args.push({ channel: 'liquidation-orders', instType: 'SWAP' });
    const unique = args.filter((arg, index, list) => {
      const key = JSON.stringify(arg);
      return list.findIndex(x => JSON.stringify(x) === key) === index;
    });
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      const key = JSON.stringify(batch);
      if (this.subscriptions.has(key)) continue;
      this.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
      this.subscriptions.add(key);
    }
  }

  onMessage(raw) {
    const text = raw.toString();
    if (text === 'ping') {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('pong');
      return;
    }
    if (text === 'pong') return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.event === 'error') {
      logger.error('OKX public WebSocket subscription error', { code: msg.code, message: msg.msg });
      return;
    }
    if (!msg.data || !msg.arg) return;
    const ch = msg.arg.channel;
    if (ch === 'open-interest') {
      for (const d of msg.data) this.latest.openInterest.set(d.instId, d);
    } else if (ch === 'funding-rate') {
      for (const d of msg.data) this.latest.funding.set(d.instId, d);
    } else if (ch === 'liquidation-orders') {
      const events = [];
      for (const group of msg.data) {
        for (const detail of group.details || []) {
          events.push({
            symbol: group.instId,
            side: detail.side,
            price: Number(detail.bkPx),
            size: Number(detail.sz),
            timestamp: Number(detail.ts)
          });
        }
      }
      this.latest.liquidations = [...events, ...this.latest.liquidations].slice(0, 200);
    }
  }

  snapshot() {
    return {
      connected: this.connected,
      subscriptions: this.subscriptions.size,
      openInterest: Object.fromEntries(this.latest.openInterest),
      funding: Object.fromEntries(this.latest.funding),
      liquidations: this.latest.liquidations
    };
  }
}

module.exports = { OKXPublicWS };
