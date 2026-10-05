'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const cache = require('../src/services/fxCacheService');
const providers = require('../src/services/fxProviders');
const { RATES_TO_USD } = require('../src/config/rates');

const ORIGINAL_TTL = config.fx.cacheTtlMs;
const ORIGINAL_GRACE = config.fx.staleGraceMs;
const ORIGINAL_NOW = Date.now;
const NOW = 10_000_000;
let clock;

beforeEach(() => {
  clock = NOW;
  Date.now = () => clock;
  config.fx.cacheTtlMs = 1_000;
  config.fx.staleGraceMs = 5_000;
  cache.reset();
  providers.resetProviders();
});

afterEach(() => {
  Date.now = ORIGINAL_NOW;
  config.fx.cacheTtlMs = ORIGINAL_TTL;
  config.fx.staleGraceMs = ORIGINAL_GRACE;
  cache.reset();
  providers.resetProviders();
});

test('a provider that expires during its fetch yields to a current fallback', () => {
  const attempts = [];
  providers.setProviders([
    { id: 'slow', fetch: ({ now }) => {
      attempts.push('slow');
      clock += 2_000;
      return { ratesToUsd: RATES_TO_USD, fetchedAt: now };
    } },
    { id: 'fallback', fetch: ({ now }) => {
      attempts.push('fallback');
      return { ratesToUsd: RATES_TO_USD, fetchedAt: now };
    } },
  ]);

  const snapshot = cache.getSnapshot({ policy: 'reject_stale' });
  assert.deepEqual(attempts, ['slow', 'fallback']);
  assert.equal(snapshot.providerId, 'fallback');
  assert.equal(snapshot.fetchedAt, clock);
  assert.equal(snapshot.expiresAt, clock + 1_000);
  assert.equal(snapshot.status, 'fresh');
  assert.equal(snapshot.ageMs, 0);
  assert.equal(cache.getProviderFetchCount(), 1);
});

test('display data ages through provider execution and is marked stale on return', () => {
  providers.setProviders([
    { id: 'slow', fetch: ({ now }) => {
      clock += 1_500;
      return { ratesToUsd: RATES_TO_USD, fetchedAt: now };
    } },
  ]);

  const snapshot = cache.getSnapshot({ policy: 'allow_stale' });
  assert.equal(snapshot.providerId, 'slow');
  assert.equal(snapshot.fetchedAt, NOW);
  assert.equal(snapshot.expiresAt, NOW + 1_000);
  assert.equal(snapshot.ageMs, 1_500);
  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.stale, true);
});

test('an outage cannot return cached data after its grace expires during the fetch', () => {
  cache.seed({ fetchedAt: NOW - 1_500, providerId: 'cached' });
  providers.setProviders([
    { id: 'down', fetch: () => {
      clock += 5_000;
      throw new Error('provider unavailable');
    } },
  ]);

  assert.throws(() => cache.getSnapshot({ policy: 'allow_stale' }), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.details.code, 'FX_PROVIDERS_DOWN');
    return true;
  });
  assert.equal(cache.peek().providerId, 'cached');
  assert.equal(cache.peek().status, 'expired');
  providers.resetProviders();
  assert.equal(cache.getSnapshot().providerId, 'primary');
});

test('an explicit snapshot time stays deterministic even if the wall clock advances', () => {
  providers.setProviders([
    { id: 'fixed', fetch: ({ now }) => {
      clock += 2_000;
      return { ratesToUsd: RATES_TO_USD, fetchedAt: now };
    } },
  ]);

  const snapshot = cache.getSnapshot({ now: NOW });
  assert.equal(snapshot.providerId, 'fixed');
  assert.equal(snapshot.fetchedAt, NOW);
  assert.equal(snapshot.status, 'fresh');
  assert.equal(snapshot.ageMs, 0);
});
