'use strict';

// GC-kernel microbenchmark, not HTTP/FX throughput. Load the supplied complete
// service source unchanged, then expose its private GC function in an isolated
// VM. Only store/config are exercised; no application dependencies are loaded.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');

const sourcePath = process.argv[2] || path.join(__dirname, '../src/services/quoteService.js');
const count = Number(process.argv[3] || 20_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
  throw new Error('Count must be an integer from 1 to 1000000');
}
const source = fs.readFileSync(sourcePath, 'utf8');
const now = 1_000_000;
// Distinct valid deadlines prevent identical-string memoization from biasing
// the result. This models repeated GC during a burst of still-live quotes.
const records = Array.from({ length: count }, (_, i) => ({
  quoteId: `quote-${i}`,
  quoteExpiresAt: new Date(now + 60_000 + i).toISOString(),
}));

function sample(countParses) {
  const store = { quotes: new Map() };
  const config = { fx: { staleGraceMs: 60_000 } };
  let dateParses = 0;
  class BenchDate extends Date {}
  if (countParses) BenchDate.parse = (value) => { dateParses += 1; return Date.parse(value); };
  const context = vm.createContext({
    module: { exports: {} },
    Date: BenchDate, Map, WeakMap, Number,
    require(id) {
      if (id === '../config') return config;
      if (id === '../store') return { store };
      return {}; // Other imports are deliberately not exercised by this kernel.
    },
  });
  new vm.Script(`${source}\nmodule.exports.benchmarkGc = gcQuotes;`, { filename: sourcePath })
    .runInContext(context);
  const gc = context.module.exports.benchmarkGc;
  const start = performance.now();
  for (const quote of records) {
    gc(now);
    store.quotes.set(quote.quoteId, quote);
  }
  const elapsedMs = performance.now() - start;
  return {
    elapsedMs, dateParses,
    survivors: [...store.quotes.keys()],
  };
}

sample(false); // Warm up; excluded from reported timings.
const runs = Array.from({ length: 5 }, () => sample(false));
const counted = sample(true); // Counts are measured separately from wall time.
const elapsed = runs.map((r) => r.elapsedMs).sort((a, b) => a - b);
const survivingIds = JSON.stringify(counted.survivors);
console.log(JSON.stringify({
  kind: 'quote-gc-kernel-not-application-throughput',
  node: process.version,
  sourceBlob: createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex'),
  count, samplesMs: runs.map((r) => r.elapsedMs), medianMs: elapsed[2],
  dateParses: counted.dateParses, retained: counted.survivors.length,
  firstRetained: counted.survivors[0], lastRetained: counted.survivors.at(-1),
  retainedIdsSha256: createHash('sha256').update(survivingIds).digest('hex'),
}, null, 2));
