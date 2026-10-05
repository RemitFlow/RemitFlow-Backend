'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createApp = require('../src/app');
const { store, reset } = require('../src/store');
const { RATES_TO_USD } = require('../src/config/rates');
const fxProviders = require('../src/services/fxProviders');
const fxCacheService = require('../src/services/fxCacheService');

test('HTTP FX failures hide adapter messages and retain ordered fallback recovery', async () => {
  reset();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const url = `http://127.0.0.1:${server.address().port}/api/quote?amount=100&from=USD&to=EUR`;
  const attempted = [];
  const primary = {
    id: 'primary',
    fetch() {
      attempted.push('primary');
      throw new Error('GET https://provider.invalid/rates?api_key=synthetic-secret-primary');
    },
  };
  try {
    fxProviders.setProviders([
      primary,
      { id: 'fallback', fetch() {
        attempted.push('fallback');
        throw 'Bearer synthetic-secret-fallback';
      } },
    ]);
    const rejected = await fetch(url);
    const failure = await rejected.json();
    assert.equal(rejected.status, 503);
    assert.equal(failure.error.message, 'All FX providers failed');
    assert.equal(failure.error.details.code, 'FX_PROVIDERS_DOWN');
    assert.deepEqual(attempted, ['primary', 'fallback']);
    assert.deepEqual(failure.error.details.attempted, [
      { providerId: 'primary', message: 'FX provider failed' },
      { providerId: 'fallback', message: 'FX provider failed' },
    ]);
    assert.equal(JSON.stringify(failure).includes('synthetic-secret'), false);
    assert.equal(store.quotes.size, 0);
    assert.equal(store.transfers.size, 0);
    assert.equal(fxCacheService.peek(), null);

    fxProviders.setProviders([
      primary,
      { id: 'fallback', fetch({ now }) {
        attempted.push('fallback');
        return { ratesToUsd: { ...RATES_TO_USD }, fetchedAt: now };
      } },
    ]);
    const recovered = await fetch(url);
    const quote = await recovered.json();
    assert.equal(recovered.status, 200);
    assert.equal(quote.freshness.providerId, 'fallback');
    assert.equal(quote.stale, false);
    assert.deepEqual(attempted, ['primary', 'fallback', 'primary', 'fallback']);
    assert.equal(store.quotes.size, 1);
    assert.equal(store.transfers.size, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    reset();
  }
});
