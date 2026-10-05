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



test('config loads default FX cache options', () => {
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');

  assert.ok(config.fx);
  assert.equal(config.fx.cacheTtlMs, 30 * 1000);
  assert.equal(config.fx.staleGraceMs, 60 * 1000);
  assert.equal(config.fx.allowStaleForTransfers, false);
  assert.equal(config.fx.quoteTtlMs, 60 * 1000);
});

test('config respects FX environment variables', () => {
  const originalEnv = {
    FX_CACHE_TTL_MS: process.env.FX_CACHE_TTL_MS,
    FX_STALE_GRACE_MS: process.env.FX_STALE_GRACE_MS,
    FX_ALLOW_STALE_TRANSFERS: process.env.FX_ALLOW_STALE_TRANSFERS,
    FX_QUOTE_TTL_MS: process.env.FX_QUOTE_TTL_MS,
  };

  try {
    process.env.FX_CACHE_TTL_MS = '5000';
    process.env.FX_STALE_GRACE_MS = '15000';
    process.env.FX_ALLOW_STALE_TRANSFERS = 'true';
    process.env.FX_QUOTE_TTL_MS = '9000';

    delete require.cache[require.resolve('../src/config')];
    const config = require('../src/config');

    assert.equal(config.fx.cacheTtlMs, 5000);
    assert.equal(config.fx.staleGraceMs, 15000);
    assert.equal(config.fx.allowStaleForTransfers, true);
    assert.equal(config.fx.quoteTtlMs, 9000);
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
