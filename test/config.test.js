'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const invalidTokenMaps = [
  ['malformed JSON', '{"confidential-fixture-token":'],
  ['empty text', ''],
  ['whitespace', ' \n\t '],
  ['null', 'null'],
  ['number', '1'],
  ['string', '"token"'],
  ['array with privileged scopes', '[["admin:read","users:write"]]'],
  ['non-array scopes', '{"confidential-fixture-token":"admin:read"}'],
  ['null scopes', '{"confidential-fixture-token":null}'],
  ['non-string scope', '{"confidential-fixture-token":[null]}'],
  ['unknown scope', '{"confidential-fixture-token":["confidential-fixture-scope"]}'],
  ['empty token', '{"":["admin:read"]}'],
  ['padded token', '{" confidential-fixture-token ":["admin:read"]}'],
];

for (const [label, value] of invalidTokenMaps) {
  test(`config rejects supplied API_TOKENS ${label} before application startup`, () => {
    const child = spawnSync(process.execPath, ['-e', "require('./src/app')()"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production', API_TOKENS: value },
      encoding: 'utf8',
    });
    assert.notEqual(child.status, 0, 'invalid explicit credentials must not start a demo-credential app');
    assert.match(child.stderr, /API_TOKENS/);
    assert.doesNotMatch(child.stderr, /confidential-fixture-token|confidential-fixture-scope/,
      'configuration errors must not print token keys or supplied scope values');
  });
}

test('config accepts known scopes and explicit empty maps without adding demo credentials', () => {
  for (const value of ['{}', '{"fixture-token":["admin:read"],"read-token":["users:read"],"denied-token":[]}']) {
    const child = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/config').apiTokens))"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, API_TOKENS: value },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), JSON.parse(value));
  }
});

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
