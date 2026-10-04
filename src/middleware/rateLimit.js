'use strict';

const ApiError = require('../utils/ApiError');
const { resolveClientIp } = require('../utils/clientIdentity');

/**
 * In-memory fixed-window rate limiter with a bounded key table.
 *
 * Counters live only in process memory (fine for a single-node demo). A
 * production deployment should back this with a shared store such as Redis.
 * The map is capped by `maxKeys`: expired entries are pruned first. When
 * all slots are live, new identities receive 429 until a slot expires rather
 * than evicting an active budget and allowing repeat attempts.
 *
 * Under `NODE_ENV=test` the limiter is a no-op unless
 * `ENABLE_RATE_LIMIT_IN_TEST=1`, so the rest of the suite is not coupled to
 * the abuse budget. Dedicated limiter and abuse-control tests opt back in.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs] - length of the window in milliseconds.
 * @param {number} [options.max] - max requests allowed per window per key.
 * @param {number} [options.maxKeys] - hard cap on tracked identities.
 * @param {(req: import('express').Request) => string} [options.keyGenerator]
 * @param {string} [options.name] - label included in 429 details (no secrets).
 * @param {boolean} [options.trustProxy] - whether to honour X-Forwarded-For.
 * @param {boolean} [options.forceInTest] - enforce even when NODE_ENV=test.
 * @returns {import('express').RequestHandler & { reset: Function, size: Function }}
 */
function rateLimit(options = {}) {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 100;
  const maxKeys = options.maxKeys || 10_000;
  const name = options.name || 'default';
  const trustProxy = Boolean(options.trustProxy);
  const forceInTest = Boolean(options.forceInTest);
  const keyGenerator =
    options.keyGenerator ||
    ((req) => resolveClientIp(req, { trustProxy }));

  /** @type {Map<string, { count: number, resetAt: number, touchedAt: number }>} */
  const hits = new Map();
  // One heap node per tracked identity. A rolled-back clock can give a newly
  // admitted key an earlier deadline, so insertion order is not expiry order.
  const expiries = [];
  // Maximum deadline, independent of admission order after clock rollback.
  let latestResetAt = -Infinity;

  function scheduleExpiry(key, entry) {
    latestResetAt = Math.max(latestResetAt, entry.resetAt);
    const node = { key, entry };
    let index = expiries.length;
    expiries.push(node);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (expiries[parent].entry.resetAt <= entry.resetAt) break;
      expiries[index] = expiries[parent];
      index = parent;
    }
    expiries[index] = node;
  }

  function pruneExpired(now) {
    // A burst can expire the whole table together. No budget survives this
    // deadline, even after clock rollback, so avoid removing each heap node.
    if (expiries.length && now >= latestResetAt) {
      hits.clear();
      expiries.length = 0;
      latestResetAt = -Infinity;
      return;
    }
    // Remove expired entries without scanning the surviving budgets. Repeated
    // hits never enqueue again; pruning before renewal keeps both tables bounded.
    while (expiries.length && now >= expiries[0].entry.resetAt) {
      const expired = expiries[0];
      const tail = expiries.pop();
      if (expiries.length) {
        let index = 0;
        while (index * 2 + 1 < expiries.length) {
          let child = index * 2 + 1;
          if (child + 1 < expiries.length &&
              expiries[child + 1].entry.resetAt < expiries[child].entry.resetAt) {
            child += 1;
          }
          if (tail.entry.resetAt <= expiries[child].entry.resetAt) break;
          expiries[index] = expiries[child];
          index = child;
        }
        expiries[index] = tail;
      }
      if (hits.get(expired.key) === expired.entry) hits.delete(expired.key);
    }
  }

  function hasCapacity(now) {
    // Also prune before renewal below capacity, removing the old generation
    // from the expiry index before the same identity receives a new budget.
    pruneExpired(now);
    return hits.size < maxKeys;
  }

  function capacityRetryAfter(now) {
    const nextResetAt = expiries.length ? expiries[0].entry.resetAt : Infinity;
    return Math.max(1, Math.ceil((nextResetAt - now) / 1000));
  }

  function rateLimitMiddleware(req, res, next) {
    const skipForTest =
      process.env.NODE_ENV === 'test' &&
      process.env.ENABLE_RATE_LIMIT_IN_TEST !== '1' &&
      !forceInTest;
    if (skipForTest) {
      return next();
    }

    const now = Date.now();
    const key = keyGenerator(req) || 'unknown';
    let entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      if (!hasCapacity(now)) {
        const retryAfter = capacityRetryAfter(now);
        const resetAt = expiries.length ? expiries[0].entry.resetAt : Infinity;
        res.set('X-RateLimit-Limit', String(max));
        res.set('X-RateLimit-Remaining', '0');
        res.set('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
        res.set('X-RateLimit-Policy', name);
        res.set('Retry-After', String(retryAfter));
        return next(
          ApiError.tooManyRequests('Rate limit capacity reached, please try again later', {
            retryAfter,
            limit: max,
            windowMs,
            policy: name,
          })
        );
      }
      entry = { count: 0, resetAt: now + windowMs, touchedAt: now };
      hits.delete(key);
      hits.set(key, entry);
      scheduleExpiry(key, entry);
    }

    entry.count += 1;
    entry.touchedAt = now;

    const remaining = Math.max(0, max - entry.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    res.set('X-RateLimit-Policy', name);

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return next(
        ApiError.tooManyRequests('Too many requests, please try again later', {
          retryAfter,
          limit: max,
          windowMs,
          policy: name,
        })
      );
    }

    return next();
  }

  rateLimitMiddleware.reset = function reset() {
    hits.clear();
    expiries.length = 0;
    latestResetAt = -Infinity;
  };

  rateLimitMiddleware.size = function size() {
    return hits.size;
  };

  return rateLimitMiddleware;
}

module.exports = rateLimit;
