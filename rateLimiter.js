'use strict';

class RequestLimiter {
  constructor({ intervalMs = 2000, maxRequests = 18 } = {}) {
    this.intervalMs = intervalMs;
    this.maxRequests = maxRequests;
    this.timestamps = [];
    this.queue = Promise.resolve();
  }

  schedule(task) {
    const run = this.queue.then(async () => {
      await this.waitForSlot();
      return task();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async waitForSlot() {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter(ts => now - ts < this.intervalMs);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = Math.max(1, this.intervalMs - (now - this.timestamps[0]) + 1);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

module.exports = { RequestLimiter };
