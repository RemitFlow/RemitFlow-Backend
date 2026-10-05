'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rateService = require('../src/services/rateService');
const fxCacheService = require('../src/services/fxCacheService');
const { RATES_TO_USD, SUPPORTED_CURRENCIES } = require('../src/config/rates');

test('currency support avoids cache copies for configured codes and retains extensions', () => {
  fxCacheService.reset();
  const originalPeek = fxCacheService.peek;
  let peeks = 0;
  fxCacheService.peek = (...args) => {
    peeks += 1;
    return originalPeek(...args);
  };
  try {
    // Both cold and expired caches must preserve configured currency support.
    for (const seeded of [false, true]) {
      if (seeded) fxCacheService.seed({ ratesToUsd: { ...RATES_TO_USD, CAD: 0.73 }, fetchedAt: 0 });
      for (const code of SUPPORTED_CURRENCIES) {
        assert.equal(rateService.isSupported(` ${code.toLowerCase()} `), true);
      }
      for (const invalid of ['', ' ', null, undefined, 42, {}]) {
        assert.equal(rateService.isSupported(invalid), false);
      }
    }
    assert.equal(peeks, 0, 'configured and invalid codes need no cache materialization');
    assert.equal(rateService.isSupported(' cad '), true);
    assert.equal(rateService.isSupported('ZZZ'), false);
    assert.equal(rateService.isSupported('__proto__'), false);
    assert.equal(peeks, 3, 'only nonconfigured nonempty codes inspect the cache');
    assert.deepEqual(originalPeek().ratesToUsd, { ...RATES_TO_USD, CAD: 0.73 });
    assert.equal(fxCacheService.getProviderFetchCount(), 0);
  } finally {
    fxCacheService.peek = originalPeek;
    fxCacheService.reset();
  }
});
