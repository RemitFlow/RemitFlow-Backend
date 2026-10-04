'use strict';

// Compare the actual production modules in two checkouts; no installed packages
// or external services are needed. Only request objects and the clock are fixed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const [beforeDir, afterDir, output] = process.argv.slice(2);
if (!beforeDir || !afterDir || !output) {
  console.error('Usage: node benchmark-rate-limit-batch-expiry.cjs BEFORE AFTER NEW_RESULT.json');
  process.exit(1);
}
const filename = (root) => path.resolve(root, 'src/middleware/rateLimit.js');
const modules = { before: require(filename(beforeDir)), after: require(filename(afterDir)) };
const nativeNow = Date.now;
let now = 0;
Date.now = () => now;

function invoke(limiter, key) {
  const headers = {};
  let error = null;
  limiter({ key }, { set(name, value) { headers[name] = value; } }, (err) => {
    if (err) error = { statusCode: err.statusCode, message: err.message, details: err.details };
  });
  return { headers, error, size: limiter.size() };
}

function sample(build, staggered, countDeletes = false) {
  const capacity = 10000;
  const rounds = 20;
  const NativeMap = global.Map;
  let deletes = 0;
  class CountedMap extends NativeMap {
    delete(key) { deletes += 1; return super.delete(key); }
  }
  let limiter;
  try {
    if (countDeletes) global.Map = CountedMap;
    limiter = build({ maxKeys: capacity, windowMs: capacity, max: 1,
      forceInTest: true, keyGenerator: (req) => req.key });
  } finally { global.Map = NativeMap; }
  const request = { key: '' };
  const response = { set() {} };
  const next = (error) => { assert.equal(error, undefined); };
  const digest = crypto.createHash('sha256');
  const expirySamples = [];
  let admissionMs = 0;
  let expiryDeletes = 0;
  for (let round = 0; round < rounds; round += 1) {
    limiter.reset();
    const start = round * capacity * 3;
    const admitStart = performance.now();
    for (let index = 0; index < capacity; index += 1) {
      now = start + (staggered ? index : 0);
      request.key = `identity-${index}`;
      limiter(request, response, next);
    }
    admissionMs += performance.now() - admitStart;
    assert.equal(limiter.size(), capacity);
    now = start + capacity + (staggered ? capacity - 1 : 0);
    const previousDeletes = deletes;
    const expiryStart = performance.now();
    const admitted = invoke(limiter, 'new');
    expirySamples.push(performance.now() - expiryStart);
    expiryDeletes += deletes - previousDeletes;
    assert.equal(admitted.error, null);
    assert.equal(admitted.size, 1);
    const blocked = invoke(limiter, 'new');
    assert.equal(blocked.error.statusCode, 429);
    digest.update(JSON.stringify({ admitted, blocked }));
  }
  return { capacity, rounds, expiry_ms: expirySamples,
    admission_ms: admissionMs, expiry_deletes: countDeletes ? expiryDeletes : null,
    digest: digest.digest('hex') };
}

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function blob(root) {
  const bytes = fs.readFileSync(filename(root));
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

try {
  const result = { node: process.version, before_blob: blob(beforeDir), after_blob: blob(afterDir), workloads: {} };
  for (const [label, staggered] of [['same_deadline', false], ['staggered_all_expired', true]]) {
    const counted = {};
    for (const phase of ['before', 'after']) counted[phase] = sample(modules[phase], staggered, true);
    assert.equal(counted.before.digest, counted.after.digest);
    const pairs = [];
    for (let index = 0; index < 5; index += 1) {
      const pair = { order: index % 2 ? ['after', 'before'] : ['before', 'after'] };
      for (const phase of pair.order) pair[phase] = sample(modules[phase], staggered);
      assert.equal(pair.before.digest, pair.after.digest);
      pairs.push(pair);
    }
    const summary = {};
    for (const phase of ['before', 'after']) {
      const times = pairs.flatMap((pair) => pair[phase].expiry_ms);
      summary[phase] = { expiry_median_ms: median(times), expiry_range_ms: [Math.min(...times), Math.max(...times)],
        admission_median_ms: median(pairs.map((pair) => pair[phase].admission_ms)),
        expiry_deletes: counted[phase].expiry_deletes, digest: counted[phase].digest };
    }
    result.workloads[label] = { summary, pairs };
  }
  result.boundary = 'Production middleware and real ApiError/clientIdentity modules; controlled clock/request/response, local component timing. Not HTTP, deployed service, provider or fleet throughput.';
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ node: result.node, before_blob: result.before_blob, after_blob: result.after_blob,
    workloads: Object.fromEntries(Object.entries(result.workloads).map(([key, value]) => [key, value.summary])) }, null, 2));
} finally { Date.now = nativeNow; }
