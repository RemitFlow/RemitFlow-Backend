'use strict';

/**
 * Share only unfinished provider work. Each caller owns a detachable waiter,
 * so a timed-out readiness request leaves no callback on a hung provider.
 * The three dependency names bound retained operations in normal use.
 */
function createProbePool() {
  const pending = new Map();

  function acquire(name, probe, identity = probe) {
    let entry = pending.get(name);
    if (!entry || entry.identity !== identity) {
      entry = { identity, waiters: new Set() };
      pending.set(name, entry);
      const current = entry;
      const finish = (ok, value) => {
        // Replaced adapters may finish after their successor started.
        if (pending.get(name) === current) pending.delete(name);
        for (const waiter of current.waiters) {
          if (ok) waiter.resolve(value);
          else waiter.reject(value);
        }
        current.waiters.clear();
      };
      // One fulfillment/rejection pair per actual operation, not per request.
      // Synchronous throws and thenables follow the same failure path.
      Promise.resolve().then(probe).then(
        (value) => finish(true, value),
        (error) => finish(false, error)
      );
    }

    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      entry.waiters.add(waiter);
    });
    return {
      promise,
      release() { entry.waiters.delete(waiter); },
    };
  }

  return {
    acquire,
    // Test adapter resets cannot let an old operation remove its replacement.
    clear() { pending.clear(); },
  };
}

module.exports = { createProbePool };
