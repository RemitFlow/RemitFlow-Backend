'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { RATES_TO_USD } = require('../src/config/rates');
const fxCache = require('../src/services/fxCacheService');
const fxProviders = require('../src/services/fxProviders');

const originalTtl = config.fx.cacheTtlMs;
const originalGrace = config.fx.staleGraceMs;
const originalNow = Date.now;
const t0 = 1_000_000;
const isOutage = (err) => err.statusCode === 503 && err.details.code === 'FX_PROVIDERS_DOWN';

beforeEach(() => {
  fxCache.reset();
  fxProviders.resetProviders();
  config.fx.cacheTtlMs = 1_000;
  config.fx.staleGraceMs = 1_000;
});

afterEach(() => {
  Date.now = originalNow;
  config.fx.cacheTtlMs = originalTtl;
  config.fx.staleGraceMs = originalGrace;
  fxCache.reset();
  fxProviders.resetProviders();
});

test('sequential outage requests share a failed refresh and retry at the deadline', () => {
  let calls = 0;
  let down = true;
  fxProviders.setProviders(['primary', 'fallback'].map((id) => ({
    id,
    fetch: ({ now }) => {
      calls++;
      if (down) throw new Error('private upstream details');
      return { ratesToUsd: RATES_TO_USD, fetchedAt: now, providerId: id };
    },
  })));

  for (let i = 0; i < 32; i++) {
    assert.throws(() => fxCache.getSnapshot({ now: t0 + i }), isOutage);
  }
  assert.equal(calls, 2, 'only one primary/fallback walk during the cooldown');
  assert.equal(fxCache.getProviderFetchCount(), 1);

  assert.throws(() => fxCache.getSnapshot({ now: t0 + 100 }), (err) => {
    assert.equal(err.details.retryAfterMs, 900);
    assert.equal(err.details.attempted[0].message, 'FX provider failed');
    err.details.attempted[0].message = 'caller mutation';
    return isOutage(err);
  });
  assert.throws(() => fxCache.getSnapshot({ now: t0 + 101 }), (err) => {
    assert.equal(err.details.attempted[0].message, 'FX provider failed');
    return isOutage(err);
  });

  down = false;
  assert.throws(() => fxCache.getSnapshot({ now: t0 + 999 }), isOutage);
  assert.equal(calls, 2);
  const recovered = fxCache.getSnapshot({ now: t0 + 1_000 });
  assert.equal(recovered.status, 'fresh');
  assert.equal(recovered.providerId, 'primary');
  assert.equal(calls, 3);
  assert.equal(fxCache.getSnapshot({ now: t0 + 1_001 }).cacheHit, true);
  assert.equal(calls, 3);
});

test('policy-specific cooldowns preserve stale display without extending its grace', () => {
  let calls = 0;
  let down = false;
  fxProviders.setProviders([{
    id: 'primary',
    fetch: () => {
      calls++;
      if (down) throw new Error('provider down');
      return { ratesToUsd: RATES_TO_USD, fetchedAt: t0 - 1_000 };
    },
  }]);

  // A response rejected for transfers may still be valid for display.
  assert.throws(() => fxCache.getSnapshot({ now: t0 }), isOutage);
  assert.equal(fxCache.getSnapshot({ now: t0, policy: 'allow_stale' }).stale, true);
  assert.equal(calls, 2);
  assert.throws(() => fxCache.getSnapshot({ now: t0 + 1 }), isOutage);
  assert.equal(calls, 2, 'a stale display success must not clear transfer failure state');

  down = true;
  const first = fxCache.getSnapshot({ now: t0 + 1, policy: 'allow_stale' });
  const second = fxCache.getSnapshot({ now: t0 + 2, policy: 'allow_stale' });
  assert.equal(first.source, 'cache-stale-outage');
  assert.equal(second.source, first.source);
  assert.equal(second.stale, true);
  assert.equal(second.fetchedAt, t0 - 1_000);
  assert.equal(calls, 3);
  assert.throws(
    () => fxCache.getSnapshot({ now: t0 + 1_000, policy: 'allow_stale' }), isOutage,
  );
  assert.equal(calls, 3, 'grace expiry rejects during cooldown without a provider retry');
});

test('cooldown starts after failure and cannot survive reset or a backward clock jump', () => {
  let clock = t0;
  let calls = 0;
  let down = true;
  Date.now = () => clock;
  fxProviders.setProviders(['primary', 'fallback'].map((id) => ({
    id,
    fetch: ({ now }) => {
      calls++;
      if (down) {
        clock += 600;
        throw new Error('slow failure');
      }
      return { ratesToUsd: RATES_TO_USD, fetchedAt: now };
    },
  })));
  assert.throws(() => fxCache.getSnapshot(), isOutage);
  assert.equal(clock, t0 + 1_200);
  clock += 999;
  assert.throws(() => fxCache.getSnapshot(), isOutage);
  assert.equal(calls, 2);

  down = false;
  clock = t0 - 1;
  assert.equal(fxCache.getSnapshot().status, 'fresh');
  assert.equal(calls, 3, 'clock rollback must not prolong the failure window');

  fxCache.reset();
  down = true;
  assert.throws(() => fxCache.getSnapshot(), isOutage);
  fxCache.reset();
  down = false;
  assert.equal(fxCache.getSnapshot().status, 'fresh');
  assert.equal(fxCache.getProviderFetchCount(), 1);
});
