'use strict';

class TTLCache {
  constructor() { this.store = new Map(); }
  get(key) {
    const item = this.store.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= Date.now()) { this.store.delete(key); return undefined; }
    return item.value;
  }
  set(key, value, ttlMs) { this.store.set(key, { value, expiresAt: Date.now() + ttlMs }); return value; }
  delete(key) { this.store.delete(key); }
  clear() { this.store.clear(); }
}

module.exports = { TTLCache };
