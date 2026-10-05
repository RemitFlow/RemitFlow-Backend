'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fxProviders = require('../src/services/fxProviders');
const { RATES_TO_USD } = require('../src/config/rates');

afterEach(() => fxProviders.resetProviders());

test('unrepresentable cross-rates try the next provider before snapshot acceptance', () => {
  const malformedTables = [
    { ...RATES_TO_USD, EUR: Number.MIN_VALUE },
    { ...RATES_TO_USD, EUR: Number.MAX_VALUE },
    { ...RATES_TO_USD, EUR: Number.MIN_VALUE, GBP: Number.MAX_VALUE },
  ];
  for (const ratesToUsd of malformedTables) {
    const attempts = [];
    const accepted = [];
    fxProviders.setProviders([
      { id: 'primary', fetch: () => {
        attempts.push('primary');
        return { ratesToUsd, fetchedAt: 1000 };
      } },
      { id: 'fallback', fetch: () => {
        attempts.push('fallback');
        return { ratesToUsd: RATES_TO_USD, fetchedAt: 1000 };
      } },
    ]);
    const result = fxProviders.fetchWithFallback({
      now: 1000,
      acceptSnapshot: (snapshot) => {
        accepted.push(snapshot.providerId);
        return true;
      },
    });
    assert.equal(result.providerId, 'fallback');
    assert.deepEqual(attempts, ['primary', 'fallback']);
    assert.deepEqual(accepted, ['fallback']);
    assert.deepEqual(result.ratesToUsd, RATES_TO_USD);
    assert.notStrictEqual(result.ratesToUsd, RATES_TO_USD);
  }
});

test('only unusable cross-rate tables produce the existing ordered unavailable error', () => {
  fxProviders.setProviders([
    { id: 'primary', fetch: () => ({ ratesToUsd: { ...RATES_TO_USD, EUR: Number.MIN_VALUE } }) },
    { id: 'fallback', fetch: () => ({ ratesToUsd: { ...RATES_TO_USD, GBP: Number.MAX_VALUE } }) },
  ]);
  assert.throws(() => fxProviders.fetchWithFallback({ now: 1000 }), (err) => {
    assert.equal(err.statusCode, 503);
    assert.equal(err.details.code, 'FX_PROVIDERS_DOWN');
    assert.deepEqual(err.details.attempted, [
      { providerId: 'primary', message: 'FX provider failed' },
      { providerId: 'fallback', message: 'FX provider failed' },
    ]);
    return true;
  });
});

test('large common rate scales retain ordinary first-success behavior', () => {
  const ratesToUsd = Object.fromEntries(
    Object.entries(RATES_TO_USD).map(([code, rate]) => [code, rate * 1e100])
  );
  let fallbackCalls = 0;
  fxProviders.setProviders([
    { id: 'primary', fetch: () => ({ ratesToUsd, fetchedAt: 1000 }) },
    { id: 'fallback', fetch: () => { fallbackCalls += 1; throw new Error('unused'); } },
  ]);
  const result = fxProviders.fetchWithFallback({ now: 1000 });
  assert.equal(result.providerId, 'primary');
  assert.deepEqual(result.ratesToUsd, ratesToUsd);
  assert.notStrictEqual(result.ratesToUsd, ratesToUsd);
  assert.equal(fallbackCalls, 0);
});
