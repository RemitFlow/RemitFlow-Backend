'use strict';

// Usage: node benchmark/auditCrypto.js /absolute/path/to/baseline/auditCrypto.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

if (!process.argv[2]) {
  throw new Error('Pass the original auditCrypto.js path to compare real implementations.');
}
const baselinePath = path.resolve(process.argv[2]);
const currentPath = path.resolve(__dirname, '../src/utils/auditCrypto.js');
const baseline = require(baselinePath);
const current = require(currentPath);
const prevHash = 'ab'.repeat(32);
const samples = 9;
let checksum = 0;

function fixture(index, changes) {
  const entry = {
    id: `audit-${index}`,
    chainSeq: index,
    action: 'transfer.updated',
    scope: 'transfers',
    target: `transfer-${index % 8}`,
    actor: `actor:${index.toString(16).padStart(16, '0')}`,
    correlationId: `request-${index}`,
    outcome: index % 3 ? 'success' : 'denied',
    mutationId: index % 2 ? `mutation-${index}` : undefined,
    changes,
    at: '2026-10-04T11:00:00.000Z',
  };
  return { entry, value: { ...entry, prevHash } };
}

const workloads = {
  transfer: Array.from({ length: 32 }, (_, index) => fixture(index, {
    amount: 1250 + index, currency: 'USD', status: { from: 'pending', to: 'approved' },
  })),
  nested: Array.from({ length: 32 }, (_, index) => fixture(index, {
    config: {
      limits: { daily: 50000 + index, perTransfer: 5000, enabled: true },
      destinations: ['treasury', 'settlement', 'reserve'],
      policy: { roles: ['operator', 'auditor'], token: '[REDACTED]', reason: 'Updated "daily" limit\n€' },
    },
    previous: { daily: 25000, notes: null },
    ignored: undefined,
  })),
  bulk: Array.from({ length: 32 }, (_, index) => fixture(index, {
    transfers: Array.from({ length: 32 }, (_, offset) => ({
      id: `transfer-${index}-${offset}`, amount: offset * 100, approved: offset % 2 === 0,
      tags: ['settlement', `batch-${index}`], metadata: { currency: 'USD', attempt: 1 },
    })),
  })),
};

for (const fixtures of Object.values(workloads)) {
  for (const item of fixtures) {
    assert.equal(current.canonicalize(item.value), baseline.canonicalize(item.value));
    assert.equal(current.computeEntryHash(item.entry, prevHash), baseline.computeEntryHash(item.entry, prevHash));
  }
}

function measure(operation, implementation, fixtures, iterations) {
  let total = 0;
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const item = fixtures[index % fixtures.length];
    const result = operation === 'canonicalize'
      ? implementation.canonicalize(item.value)
      : implementation.computeEntryHash(item.entry, prevHash);
    total = (total + result.length + result.charCodeAt(0)) | 0;
  }
  const elapsed = performance.now() - start;
  checksum ^= total;
  return elapsed;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

const results = [];
for (const [workload, fixtures] of Object.entries(workloads)) {
  for (const operation of ['canonicalize', 'computeEntryHash']) {
    measure(operation, baseline, fixtures, 4000);
    measure(operation, current, fixtures, 4000);
    const calibration = measure(operation, baseline, fixtures, 1000);
    const iterations = Math.max(1000, Math.ceil(120000 / calibration));
    const times = { baseline: [], current: [] };
    for (let sample = 0; sample < samples; sample += 1) {
      // Alternate order so one implementation does not always get a warmer CPU.
      const order = sample % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
      for (const name of order) {
        times[name].push(measure(operation, name === 'baseline' ? baseline : current, fixtures, iterations));
      }
    }
    const baselineMs = median(times.baseline);
    const currentMs = median(times.current);
    results.push({
      workload, operation, iterations, samples,
      baselineOpsPerSecond: Math.round(iterations * 1000 / baselineMs),
      currentOpsPerSecond: Math.round(iterations * 1000 / currentMs),
      throughputGainPercent: Number(((baselineMs / currentMs - 1) * 100).toFixed(1)),
      milliseconds: times,
    });
  }
}

function sourceHash(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

console.log(JSON.stringify({
  node: process.version,
  cpu: os.cpus()[0].model,
  baselineSourceSha256: sourceHash(baselinePath),
  currentSourceSha256: sourceHash(currentPath),
  samples, checksum, results,
}, null, 2));
