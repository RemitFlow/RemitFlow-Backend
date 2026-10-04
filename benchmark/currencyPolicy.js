#!/usr/bin/env node
'use strict';

// Compare real service modules with a separate checkout of the previous source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');

if (!process.argv[2]) {
  console.error('Usage: node benchmark/currencyPolicy.js /path/to/baseline-checkout');
  process.exit(1);
}
process.env.TRANSFER_FEE_PERCENT = '1.5';
process.env.TRANSFER_FEE_FLAT = '0.3';
process.env.MAX_TRANSFER_AMOUNT = '50000';
const previous = path.resolve(process.argv[2]);
const current = path.resolve(__dirname, '..');
const load = root => ({
  policy: require(path.join(root, 'src/utils/currencyPolicy.js')),
  quote: require(path.join(root, 'src/services/quoteService.js')),
});
const baseline = load(previous);
const candidate = load(current);
const args = [
  [123.455, 'USD'],
  [-1.005, 'USD'],
  [3, 'JPY', { divisor: 2 }],
  [-3, 'JPY', { divisor: 2 }],
  [123.45, 'USD', { multiplier: null, divisor: null, addend: null }],
  ['12.345', 'USD', { multiplier: '1', divisor: '1', addend: '0' }],
  [1, 'USD', { divisor: 0 }],
  [1, 'USD', { multiplier: '0x1' }],
  [1, 'USD', { multiplier: Infinity }],
  [Number.MAX_SAFE_INTEGER, 'JPY'],
  [1, 'USD', { multiplier: Number.MAX_SAFE_INTEGER, divisor: Number.MAX_SAFE_INTEGER }],
  [1e30, 'JPY', { divisor: 1e30 }],
  ['90071992547409.91', 'USD'],
];
function capture(run) {
  try { return { value: run() }; }
  catch (error) { return { error: error.name, message: error.message }; }
}
for (const input of args) {
  assert.deepStrictEqual(
    capture(() => candidate.policy.roundToCurrency(...input)),
    capture(() => baseline.policy.roundToCurrency(...input))
  );
}

const inputs = Array.from({ length: 32 }, (_, index) => 1000 + index + 0.05);
const tasks = [
  { name: 'minor-unit rounding', run: (modules, index) => modules.policy.roundToCurrency(inputs[index % 32], 'USD') },
  { name: 'USD/EUR quote', run: (modules, index) => modules.quote.getQuote(inputs[index % 32], 'USD', 'EUR') },
  { name: 'JPY/USD quote', run: (modules, index) => modules.quote.getQuote(40000 + index % 32, 'JPY', 'USD') },
];
for (const task of tasks) {
  for (let index = 0; index < 32; index += 1) {
    assert.deepStrictEqual(task.run(candidate, index), task.run(baseline, index));
  }
}
let observed;
function timed(task, modules, iterations) {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) observed = task.run(modules, index);
  return performance.now() - start;
}
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}
const measurements = tasks.map(task => {
  timed(task, baseline, 2000);
  timed(task, candidate, 2000);
  const calibration = timed(task, baseline, 2000);
  const iterations = Math.max(2000, Math.min(100000, Math.ceil(2000 * 120 / calibration)));
  const times = { baseline: [], candidate: [] };
  for (let batch = 0; batch < 7; batch += 1) {
    const order = batch % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const name of order) times[name].push(timed(task, name === 'baseline' ? baseline : candidate, iterations));
  }
  const before = median(times.baseline);
  const after = median(times.candidate);
  return {
    workload: task.name, iterations, batches: times,
    baseline_median_ms: before, candidate_median_ms: after,
    baseline_ops_per_second: iterations * 1000 / before,
    candidate_ops_per_second: iterations * 1000 / after,
    throughput_gain_percent: (before / after - 1) * 100,
  };
});
const sha256 = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
console.log(JSON.stringify({
  node: process.version, cpu: os.cpus()[0].model,
  baseline_source_sha256: sha256(path.join(previous, 'src/utils/currencyPolicy.js')),
  candidate_source_sha256: sha256(path.join(current, 'src/utils/currencyPolicy.js')),
  fee: { percent: 1.5, flat: 0.3 }, max_transfer_amount: 50000,
  compatibility: 'Exact values, errors and all quote fields matched before timing.',
  measurements,
  last_result: observed,
}, null, 2));
