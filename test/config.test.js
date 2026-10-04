'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('config loads default database connection pooling options', () => {
  // Clear require cache for the config module to load it fresh
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');

  assert.ok(config.db);
  assert.ok(config.db.pool);
  assert.equal(config.db.pool.min, 2);
  assert.equal(config.db.pool.max, 10);
  assert.equal(config.db.pool.idleTimeoutMs, 30000);
  assert.equal(config.db.pool.connectionTimeoutMs, 2000);
});

test('config respects database environment variables', () => {
  const originalEnv = {
    DB_POOL_MIN: process.env.DB_POOL_MIN,
    DB_POOL_MAX: process.env.DB_POOL_MAX,
    DB_POOL_IDLE_TIMEOUT_MS: process.env.DB_POOL_IDLE_TIMEOUT_MS,
    DB_POOL_CONNECTION_TIMEOUT_MS: process.env.DB_POOL_CONNECTION_TIMEOUT_MS,
  };

  try {
    process.env.DB_POOL_MIN = '5';
    process.env.DB_POOL_MAX = '20';
    process.env.DB_POOL_IDLE_TIMEOUT_MS = '15000';
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = '5000';

    delete require.cache[require.resolve('../src/config')];
    const config = require('../src/config');

    assert.equal(config.db.pool.min, 5);
    assert.equal(config.db.pool.max, 20);
    assert.equal(config.db.pool.idleTimeoutMs, 15000);
    assert.equal(config.db.pool.connectionTimeoutMs, 5000);
  } finally {
    // Restore environment variables
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    delete require.cache[require.resolve('../src/config')];
  }
});

test('config loads default caching options', () => {
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');

  assert.ok(config.cache);
  assert.equal(config.cache.defaultPolicy, 'no-store');
  assert.equal(config.cache.ratesMaxAge, 10);
});

test('config respects cache environment variables', () => {
  const originalEnv = {
    CACHE_DEFAULT_POLICY: process.env.CACHE_DEFAULT_POLICY,
    CACHE_RATES_MAX_AGE_SECONDS: process.env.CACHE_RATES_MAX_AGE_SECONDS,
  };

  try {
    process.env.CACHE_DEFAULT_POLICY = 'public';
    process.env.CACHE_RATES_MAX_AGE_SECONDS = '60';

    delete require.cache[require.resolve('../src/config')];
    const config = require('../src/config');

    assert.equal(config.cache.defaultPolicy, 'public');
    assert.equal(config.cache.ratesMaxAge, 60);
  } finally {
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    delete require.cache[require.resolve('../src/config')];
  }
});

for (const [label, percent, flat, expectedPercent, expectedFlat, fee, receiveAmount] of [
  ['default fees', undefined, undefined, 1.5, 0.3, 1.8, 90.93],
  ['blank fees', '', '', 1.5, 0.3, 1.8, 90.93],
  ['unparseable fees', 'invalid', 'invalid', 1.5, 0.3, 1.8, 90.93],
  ['zero percentage fee', '0', undefined, 0, 0.3, 0.3, 92.31],
  ['zero flat fee', undefined, '0.00', 1.5, 0, 1.5, 91.2],
  ['both fees waived', '0', '0', 0, 0, 0, 92.59],
  ['custom fees', '2.5', '0.25', 2.5, 0.25, 2.75, 90.05],
]) {
  test(`config and quote honor ${label}`, () => {
    const values = { TRANSFER_FEE_PERCENT: percent, TRANSFER_FEE_FLAT: flat };
    const originalEnv = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const clearFeeModules = () => {
      for (const path of [
        '../src/config', '../src/utils/currencyPolicy',
        '../src/services/rateService', '../src/services/quoteService',
      ]) delete require.cache[require.resolve(path)];
    };
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      clearFeeModules();
      const config = require('../src/config');
      const quote = require('../src/services/quoteService').getQuote(100, 'USD', 'EUR');
      assert.equal(config.fee.percent, expectedPercent);
      assert.equal(config.fee.flat, expectedFlat);
      assert.equal(quote.fee, fee);
      assert.equal(quote.amountAfterFee, 100 - fee);
      assert.equal(quote.receiveAmount, receiveAmount);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      clearFeeModules();
    }
  });
}
