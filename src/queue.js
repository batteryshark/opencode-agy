/** Unbounded async FIFO with a per-read timeout. */
export const TIMEOUT = Symbol("timeout");

export class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
  }

  push(item) {
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }

  /** Put an item back at the head (it is delivered before anything queued). */
  unshift(item) {
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.unshift(item);
  }

  get size() {
    return this.items.length;
  }

  /** Next item, or TIMEOUT after `ms` (no timeout when ms is not finite / <= 0). */
  next(ms) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => {
      let timer = null;
      const waiter = (item) => {
        if (timer) clearTimeout(timer);
        resolve(item);
      };
      this.waiters.push(waiter);
      if (Number.isFinite(ms) && ms > 0) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(TIMEOUT);
        }, ms);
        timer.unref?.();
      }
    });
  }
}
