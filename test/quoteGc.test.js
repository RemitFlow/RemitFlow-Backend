'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual private GC without loading unrelated FX/HTTP services.
// Exposing it here does not add an export to the production module.
function loadGc() {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/quoteService.js'), 'utf8');
  const store = { quotes: new Map() };
  const config = { fx: { staleGraceMs: 1_000 } };
  let parses = 0;
  class CountingDate extends Date {
    static parse(value) { parses += 1; return Date.parse(value); }
  }
  const context = vm.createContext({
    module: { exports: {} }, Date: CountingDate, Map, WeakMap, Number,
    require(id) {
      if (id === '../store') return { store };
      if (id === '../config') return config;
      return {};
    },
  });
  new vm.Script(`${source}\nmodule.exports.testGc = gcQuotes;`).runInContext(context);
  return { gc: context.module.exports.testGc, store, config, parses: () => parses };
}

const NOW = 1_000_000;
function seed(env, count) {
  for (let i = 0; i < count; i += 1) {
    env.store.quotes.set(`quote-${i}`, {
      quoteId: `quote-${i}`,
      quoteExpiresAt: new Date(NOW + 60_000 + i).toISOString(),
    });
  }
}

test('live quote GC parses each unchanged expiry string once without changing payloads', () => {
  const env = loadGc();
  seed(env, 300);
  const before = JSON.stringify([...env.store.quotes]);
  for (let i = 0; i < 10; i += 1) env.gc(NOW + i);
  assert.equal(env.parses(), 300);
  assert.equal(JSON.stringify([...env.store.quotes]), before);
});

test('GC respects changed expiry strings, live grace settings and uncacheable values', () => {
  const env = loadGc();
  seed(env, 256);
  env.gc(NOW);
  const first = env.store.quotes.get('quote-0');
  first.quoteExpiresAt = new Date(NOW - 1_000).toISOString();
  env.gc(NOW); // Exact grace boundary is retained, matching existing policy.
  assert.equal(env.store.quotes.has('quote-0'), true);
  env.config.fx.staleGraceMs = 999;
  env.gc(NOW);
  assert.equal(env.store.quotes.has('quote-0'), false);

  env.store.quotes.set('invalid', { quoteExpiresAt: 'not-a-date' });
  env.gc(NOW);
  assert.equal(env.store.quotes.has('invalid'), true);
  let expires = new Date(NOW + 60_000).toISOString();
  env.store.quotes.get('quote-1').quoteExpiresAt = { toString: () => expires };
  env.gc(NOW);
  assert.equal(env.store.quotes.has('quote-1'), true);
  expires = new Date(NOW - 1_000).toISOString();
  env.gc(NOW);
  assert.equal(env.store.quotes.has('quote-1'), false);
});

test('capacity GC keeps the same insertion-order survivors', () => {
  const env = loadGc();
  for (let i = 0; i < 530; i += 1) {
    env.gc(NOW);
    env.store.quotes.set(`quote-${i}`, { quoteExpiresAt: new Date(NOW + 60_000).toISOString() });
  }
  assert.deepEqual(
    [...env.store.quotes.keys()],
    Array.from({ length: 274 }, (_, i) => `quote-${i + 256}`)
  );
});
