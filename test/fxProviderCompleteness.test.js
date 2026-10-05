'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fxProviders = require('../src/services/fxProviders');
const { RATES_TO_USD, SUPPORTED_CURRENCIES } = require('../src/config/rates');

const NOW = 1_791_100_000_000;

test.afterEach(() => fxProviders.resetProviders());

test('an incomplete primary snapshot falls back for every supported currency', () => {
  for (const missing of SUPPORTED_CURRENCIES) {
    const partial = { ...RATES_TO_USD };
    delete partial[missing];
    const attempts = [];
    const accepted = [];
    fxProviders.setProviders([
      { id: 'primary', fetch: () => {
        attempts.push('primary');
        return { ratesToUsd: partial, fetchedAt: NOW };
      } },
      { id: 'fallback', fetch: () => {
        attempts.push('fallback');
        return { ratesToUsd: { ...RATES_TO_USD }, fetchedAt: NOW };
      } },
    ]);

    const snapshot = fxProviders.fetchWithFallback({ now: NOW, acceptSnapshot(candidate) {
      accepted.push(candidate.providerId);
      return true;
    } });
    assert.deepEqual(attempts, ['primary', 'fallback'], missing);
    assert.deepEqual(accepted, ['fallback'], 'partial rates never reach cache admission');
    assert.equal(snapshot.providerId, 'fallback');
    assert.deepEqual(snapshot.ratesToUsd, RATES_TO_USD);
  }
});

test('inherited rates cannot make an incomplete snapshot usable', () => {
  const missing = SUPPORTED_CURRENCIES.find((code) => code !== 'USD');
  const inherited = Object.assign(Object.create({ [missing]: RATES_TO_USD[missing] }), RATES_TO_USD);
  delete inherited[missing];
  const attempts = [];
  fxProviders.setProviders([
    { id: 'primary', fetch: () => {
      attempts.push('primary');
      return { ratesToUsd: inherited, fetchedAt: NOW };
    } },
    { id: 'fallback', fetch: () => {
      attempts.push('fallback');
      return { ratesToUsd: { USD: 1 }, fetchedAt: NOW };
    } },
  ]);

  assert.throws(() => fxProviders.fetchWithFallback({ now: NOW }), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.details.code, 'FX_PROVIDERS_DOWN');
    assert.deepEqual(error.details.attempted.map((attempt) => attempt.providerId), attempts);
    assert.deepEqual(attempts, ['primary', 'fallback']);
    assert.ok(error.details.attempted.every((attempt) => /omitted supported currency/.test(attempt.message)));
    return true;
  });
});

test('complete default rates retain provider ordering and freshness admission', () => {
  fxProviders.resetProviders();
  const primary = fxProviders.fetchWithFallback({ now: NOW });
  assert.equal(primary.providerId, 'primary');
  assert.equal(primary.fetchedAt, NOW);
  assert.deepEqual(primary.ratesToUsd, RATES_TO_USD);
  primary.ratesToUsd.USD = 99;
  assert.equal(RATES_TO_USD.USD, 1);

  const visited = [];
  const fallback = fxProviders.fetchWithFallback({ now: NOW, acceptSnapshot(candidate) {
    visited.push(candidate.providerId);
    return candidate.providerId === 'fallback';
  } });
  assert.deepEqual(visited, ['primary', 'fallback']);
  assert.equal(fallback.providerId, 'fallback');
  assert.equal(fallback.ratesToUsd.USD, 1);
});
