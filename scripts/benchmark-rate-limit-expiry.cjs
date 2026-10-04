'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const root = __dirname;
const before = require('./original/src/middleware/rateLimit');
const after = require('./final/src/middleware/rateLimit');
const nativeNow = Date.now;
let now = 0;
Date.now = () => now;
process.env.NODE_ENV = 'test';

function invoke(limiter, key) {
  const headers = {};
  let error = null;
  limiter({ key }, { set(name, value) { headers[name] = String(value); } }, (err) => {
    if (err) error = { name: err.name, statusCode: err.statusCode, message: err.message, details: err.details };
  });
  return { headers, error, size: limiter.size() };
}

function differential() {
  let seed = 0x138;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const hash = crypto.createHash('sha256');
  let calls = 0;
  let resets = 0;
  const capacities = [1, 2, 7, 31, 256];
  for (const maxKeys of capacities) {
    const options = { maxKeys, windowMs: 101, max: 3, forceInTest: true, keyGenerator: (req) => req.key };
    const old = before(options);
    const next = after(options);
    now = 1000;
    for (let index = 0; index < 4000; index += 1) {
      const action = random() % 30;
      if (action === 0) { old.reset(); next.reset(); resets += 1; }
      if (action < 4) now -= random() % 150;
      else now += random() % 24;
      const key = `actor-${random() % (maxKeys * 3 + 1)}`;
      const a = invoke(old, key);
      const b = invoke(next, key);
      assert.deepEqual(b, a, `capacity=${maxKeys}, index=${index}, now=${now}, key=${key}`);
      assert.ok(next.size() <= maxKeys);
      hash.update(JSON.stringify(a));
      calls += 1;
    }
  }
  return { calls, resets, capacities, outputs_identical: true, digest: hash.digest('hex') };
}

function rolling(build, instrument = false) {
  const NativeMap = global.Map;
  let visits = 0;
  class CountingMap extends NativeMap {
    *[Symbol.iterator]() {
      for (const entry of super[Symbol.iterator]()) { visits += 1; yield entry; }
    }
  }
  const maxKeys = 10000;
  let limiter;
  try {
    if (instrument) global.Map = CountingMap;
    limiter = build({ maxKeys, windowMs: maxKeys, max: 1, forceInTest: true, keyGenerator: (req) => req.key });
  } finally { global.Map = NativeMap; }
  let accepted = 0;
  const hash = crypto.createHash('sha256');
  const warmStart = performance.now();
  for (let index = 0; index < maxKeys; index += 1) {
    now = index;
    const result = invoke(limiter, `known-${index}`);
    assert.equal(result.error, null);
    accepted += 1;
    hash.update(JSON.stringify(result));
  }
  const warmMs = performance.now() - warmStart;
  const rollingStart = performance.now();
  for (let index = 0; index < 1000; index += 1) {
    now = maxKeys + index;
    const result = invoke(limiter, `new-${index}`);
    assert.equal(result.error, null);
    accepted += 1;
    hash.update(JSON.stringify(result));
  }
  const rollingMs = performance.now() - rollingStart;
  const survivor = invoke(limiter, `known-${maxKeys - 1}`);
  assert.equal(survivor.error.statusCode, 429);
  hash.update(JSON.stringify(survivor));
  return { warm_ms: warmMs, rolling_ms: rollingMs, accepted, tracked: limiter.size(), map_entry_visits: instrument ? visits : null, output_digest: hash.digest('hex') };
}

function gitBlob(file) {
  const data = fs.readFileSync(file);
  return crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

try {
  const semantic = differential();
  const counted = { before: rolling(before, true), after: rolling(after, true) };
  assert.equal(counted.before.map_entry_visits, 10000000);
  assert.equal(counted.after.map_entry_visits, 0);
  assert.equal(counted.before.output_digest, counted.after.output_digest);
  const pairs = [];
  for (let index = 0; index < 3; index += 1) {
    const pair = { order: index % 2 ? ['after', 'before'] : ['before', 'after'] };
    for (const phase of pair.order) pair[phase] = rolling(phase === 'before' ? before : after);
    assert.equal(pair.before.output_digest, pair.after.output_digest);
    pairs.push(pair);
  }
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const oldMedian = median(pairs.map((p) => p.before.rolling_ms));
  const newMedian = median(pairs.map((p) => p.after.rolling_ms));
  const result = {
    node: process.version,
    parent: 'f501ce5f4fd6f6f96c82fb9fffed4dc58f3def8e',
    before_blob: gitBlob(path.join(root, 'original/src/middleware/rateLimit.js')),
    after_blob: gitBlob(path.join(root, 'final/src/middleware/rateLimit.js')),
    semantic,
    counted,
    pairs,
    rolling_median_ms: { before: oldMedian, after: newMedian, ratio: oldMedian / newMedian },
    boundary: 'Unmodified loaded middleware modules and retained real ApiError/clientIdentity dependencies; simulated clock/requests/responses. No Express, HTTP stack, dependency install, external service or fleet throughput measurement.'
  };
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { Date.now = nativeNow; }
