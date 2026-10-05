'use strict';

// Deterministic adapter-call benchmark; no live FX services or network requests.
// Run with installed project dependencies: node scripts/benchmark-fx-retry-cooldown.js
// Each scenario sends 1,000 ordinary requests within one simulated 900ms window.
const assert = require('node:assert/strict');
const config = require('../src/config');
const cache = require('../src/services/fxCacheService');
const providers = require('../src/services/fxProviders');
const { RATES_TO_USD } = require('../src/config/rates');

const original = { ...config.fx };
const requests = 1_000;
const startedAt = 100_000;
const results = [];

try {
  config.fx.cacheTtlMs = 2_000;
  config.fx.staleGraceMs = 5_000;
  for (const scenario of ['stale-display', 'strict-outage', 'healthy-cache']) {
    cache.reset();
    providers.resetProviders();
    let providerCalls = 0;
    let freshResponses = 0;
    let staleResponses = 0;
    let unavailableResponses = 0;
    const healthy = scenario === 'healthy-cache';
    providers.setProviders(['primary', 'fallback'].map((id) => ({
      id,
      fetch: ({ now }) => {
        providerCalls += 1;
        if (!healthy) throw new Error('simulated outage');
        return { providerId: id, ratesToUsd: { ...RATES_TO_USD }, fetchedAt: now };
      },
    })));
    if (scenario === 'stale-display') {
      cache.seed({ fetchedAt: startedAt - config.fx.cacheTtlMs });
    }
    for (let i = 0; i < requests; i += 1) {
      try {
        const snapshot = cache.getSnapshot({
          now: startedAt + Math.floor(i * 900 / requests),
          policy: scenario === 'stale-display' ? 'allow_stale' : 'reject_stale',
        });
        assert.deepEqual(snapshot.ratesToUsd, RATES_TO_USD);
        if (snapshot.stale) staleResponses += 1;
        else freshResponses += 1;
      } catch (err) {
        assert.equal(err.statusCode, 503);
        assert.equal(err.details.code, 'FX_PROVIDERS_DOWN');
        unavailableResponses += 1;
      }
    }
    assert.equal(freshResponses, healthy ? requests : 0);
    assert.equal(staleResponses, scenario === 'stale-display' ? requests : 0);
    assert.equal(unavailableResponses, scenario === 'strict-outage' ? requests : 0);
    results.push({ scenario, requests, providerCalls, freshResponses, staleResponses, unavailableResponses });
  }
  console.log(JSON.stringify({ workload: 'synthetic synchronous adapters; 900ms simulated window', results }, null, 2));
} finally {
  Object.assign(config.fx, original);
  cache.reset();
  providers.resetProviders();
}
