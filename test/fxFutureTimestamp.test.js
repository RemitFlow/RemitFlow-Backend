'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const fxCacheService = require('../src/services/fxCacheService');
const fxProviders = require('../src/services/fxProviders');

const ORIGINAL_TTL = config.fx.cacheTtlMs;
const ORIGINAL_GRACE = config.fx.staleGraceMs;
const NOW = 10_000_000;
const { RATES_TO_USD: RATES } = require('../src/config/rates');
const isProvidersDown = (err) => err.statusCode === 503 &&
  err.details && err.details.code === 'FX_PROVIDERS_DOWN';

beforeEach(() => {
  fxCacheService.reset();
  fxProviders.resetProviders();
  config.fx.cacheTtlMs = 1_000;
  config.fx.staleGraceMs = 5_000;
});

afterEach(() => {
  fxCacheService.reset();
  fxProviders.resetProviders();
  config.fx.cacheTtlMs = ORIGINAL_TTL;
  config.fx.staleGraceMs = ORIGINAL_GRACE;
});

test('future-dated snapshots cannot suppress a usable fallback under either policy', () => {
  for (const policy of ['reject_stale', 'allow_stale']) {
    for (const offset of [1, 1_000, 86_400_000]) {
      fxCacheService.reset();
      const attempted = [];
      fxProviders.setProviders([
        { id: 'future', fetch: () => {
          attempted.push('future');
          return { ratesToUsd: RATES, fetchedAt: NOW + offset };
        } },
        { id: 'current', fetch: () => {
          attempted.push('current');
          return { ratesToUsd: RATES, fetchedAt: NOW };
        } },
        { id: 'unused', fetch: () => {
          attempted.push('unused');
          throw new Error('Provider after the first usable snapshot must not run');
        } },
      ]);
      const snapshot = fxCacheService.getSnapshot({ now: NOW, policy });
      assert.deepEqual(attempted, ['future', 'current'], `${policy}, offset ${offset}`);
      assert.equal(snapshot.providerId, 'current');
      assert.equal(snapshot.fetchedAt, NOW);
      assert.equal(snapshot.expiresAt, NOW + 1_000);
      assert.equal(snapshot.ageMs, 0);
      assert.equal(snapshot.stale, false);
      assert.equal(fxCacheService.peek(NOW).providerId, 'current');
      assert.equal(fxCacheService.getProviderFetchCount(), 1);
    }
  }
});

test('all-future providers leave no cache entry and release the refresh guard for recovery', () => {
  for (const policy of ['reject_stale', 'allow_stale']) {
    fxCacheService.reset();
    fxProviders.setProviders([
      { id: 'future', fetch: () => ({ ratesToUsd: RATES, fetchedAt: NOW + 86_400_000 }) },
    ]);
    assert.throws(() => fxCacheService.getSnapshot({ now: NOW, policy }), isProvidersDown);
    assert.equal(fxCacheService.peek(NOW), null);
    fxProviders.resetProviders();
    const recovered = fxCacheService.getSnapshot({ now: NOW, policy });
    assert.equal(recovered.providerId, 'primary');
    assert.equal(recovered.fetchedAt, NOW);
    assert.equal(recovered.stale, false);
    assert.equal(fxCacheService.getProviderFetchCount(), 2);
  }
});

test('future provider data cannot replace a stale display cache or extend its grace period', () => {
  const fetchedAt = NOW - 1_500;
  fxCacheService.seed({ fetchedAt, ratesToUsd: RATES, providerId: 'cached' });
  fxProviders.setProviders([
    { id: 'future', fetch: () => ({ ratesToUsd: { ...RATES, EUR: 2 }, fetchedAt: NOW + 86_400_000 }) },
  ]);
  assert.throws(
    () => fxCacheService.getSnapshot({ now: NOW, policy: 'reject_stale' }),
    isProvidersDown
  );
  const displayed = fxCacheService.getSnapshot({ now: NOW, policy: 'allow_stale' });
  assert.equal(displayed.providerId, 'cached');
  assert.equal(displayed.fetchedAt, fetchedAt);
  assert.equal(displayed.expiresAt, fetchedAt + 1_000);
  assert.equal(displayed.ageMs, 1_500);
  assert.equal(displayed.stale, true);
  assert.equal(displayed.source, 'cache-stale-outage');
  assert.deepEqual(displayed.ratesToUsd, RATES);
  assert.throws(
    () => fxCacheService.getSnapshot({ now: fetchedAt + 6_000, policy: 'allow_stale' }),
    isProvidersDown
  );
  assert.equal(fxCacheService.peek(NOW).fetchedAt, fetchedAt);
});

test('a snapshot dated exactly now is accepted but still expires at the configured TTL', () => {
  let calls = 0;
  fxProviders.setProviders([
    { id: 'current', fetch: ({ now }) => {
      calls += 1;
      return { ratesToUsd: RATES, fetchedAt: now };
    } },
  ]);
  const first = fxCacheService.getSnapshot({ now: NOW });
  assert.equal(first.fetchedAt, NOW);
  assert.equal(first.expiresAt, NOW + 1_000);
  assert.equal(first.stale, false);
  assert.equal(calls, 1);
  assert.equal(fxCacheService.getSnapshot({ now: NOW + 999 }).cacheHit, true);
  assert.equal(calls, 1);
  const refreshed = fxCacheService.getSnapshot({ now: NOW + 1_000 });
  assert.equal(calls, 2);
  assert.equal(refreshed.cacheHit, false);
  assert.equal(refreshed.fetchedAt, NOW + 1_000);
});
