# Currency-support lookup — 4 October 2026

This continuation of RemitFlow-Backend PR 141 changes only currency-membership
lookup. Configured currencies return before `fxCacheService.peek()` materializes
an entire decorated rate snapshot. Nonconfigured codes still inspect the current
cache, preserving provider-added currencies. Currency normalization, cache
freshness, quote pricing, provider selection and HTTP contracts are unchanged.

## Source and execution boundary

Parent: `8f3bf8b8e16ac01cc9ef9cce9d66772e03fc59ba`.

| Complete module | Git blob SHA |
| --- | --- |
| Original rateService.js | fdd533cc12d82ede4ace0776b83d25786214ea6c |
| Candidate rateService.js | e48be1aba814ba1443d64554b5d22ad8e1591d2d |
| Unchanged fxCacheService.js | 91201bc01251b888ad86678038c68b4f74a66013 |
| Unchanged config/rates.js | 52f235a875affcbf31a15ac19108d2a12c0e6bad |
| Unchanged utils/currency.js | a1afbf1eaceeca0ff9922ab3d39038cda981016b |
| New rateSupportLookup.test.js | 746380e00ae682f5123d440a631cc9b51b2c88df |

The complete modules were copied through native GitHub reads and their Git blob
hashes verified. Node v22.16.0, Linux/x64, AMD EPYC 9V74. An offline CommonJS
loader executed the actual source. It supplied FX configuration defaults
(30,000 ms TTL; 60,000 ms stale grace); unused money, ApiError and provider
collaborators throw if accessed. The real cache's seed, peek, decorate, reset and
provider-count paths ran. No dependency installation, live provider, HTTP app,
full project test suite or hosted CI was run in this continuation.

## Focused regression

One new maintained Node test checks normalized configured currencies with cold
and expired caches, invalid input, a provider-added CAD rate, unknown/prototype
names, unchanged cache contents and zero provider fetches. The original code
fails the optimization assertion: 18 cache peeks instead of zero. The candidate
passes: 1 test, 1 pass, 0 fail, 0 skipped. The same complete test file ran through
the loader below; this is component evidence, not an installed-project run.

Installed-checkout command (provided for reproduction, not claimed executed):
`node --test test/rateSupportLookup.test.js`.

## Measured lookup workload

Each sample performed 500,000 calls, including normalization. Three warmup pairs
preceded seven alternating before/after pairs. All input-level membership results
and per-sample hit counts matched. Warm fixtures used the nine configured rates
plus CAD; mixed input also included CAD, an unknown code, empty text and null.
The figures are medians, not a claim about request latency, fleet throughput,
provider quota, live settlement or peak memory.

| Scenario | Before ms | After ms | Less time | Ratio |
| --- | ---: | ---: | ---: | ---: |
| cold-configured | 43.505870 | 25.565094 | 41.24% | 1.702x |
| warm-configured | 95.430961 | 26.843440 | 71.87% | 3.555x |
| warm-mixed | 76.241695 | 33.418068 | 56.17% | 2.281x |

### Raw paired samples (milliseconds)

| Scenario | Pair | Before | After | Hits (both) |
| --- | ---: | ---: | ---: | ---: |
| cold-configured | 0 | 43.305808000 | 26.070304000 | 500000 |
| cold-configured | 1 | 43.598279000 | 25.642260000 | 500000 |
| cold-configured | 2 | 43.464998000 | 25.641859000 | 500000 |
| cold-configured | 3 | 43.505870000 | 24.358448000 | 500000 |
| cold-configured | 4 | 44.560766000 | 24.981597000 | 500000 |
| cold-configured | 5 | 44.138401000 | 24.929238000 | 500000 |
| cold-configured | 6 | 42.766747000 | 25.565094000 | 500000 |
| warm-configured | 0 | 97.255455000 | 28.125888000 | 500000 |
| warm-configured | 1 | 98.593778000 | 27.937825000 | 500000 |
| warm-configured | 2 | 96.640700000 | 26.224358000 | 500000 |
| warm-configured | 3 | 94.896015000 | 26.637379000 | 500000 |
| warm-configured | 4 | 93.976282000 | 26.276546000 | 500000 |
| warm-configured | 5 | 95.430961000 | 27.398524000 | 500000 |
| warm-configured | 6 | 93.858485000 | 26.843440000 | 500000 |
| warm-mixed | 0 | 82.886692000 | 34.384162000 | 384617 |
| warm-mixed | 1 | 82.598257000 | 34.149749000 | 384617 |
| warm-mixed | 2 | 76.686774000 | 35.834523000 | 384617 |
| warm-mixed | 3 | 72.199315000 | 32.852197000 | 384617 |
| warm-mixed | 4 | 74.809962000 | 30.814562000 | 384617 |
| warm-mixed | 5 | 75.485167000 | 32.893410000 | 384617 |
| warm-mixed | 6 | 76.241695000 | 33.418068000 | 384617 |

## Exact offline reproducer

In a disposable checkout of this change, create `work/rateService.before.js` with
`git show 8f3bf8b8e16ac01cc9ef9cce9d66772e03fc59ba:src/services/rateService.js`.
Save the following three blocks to the named files. This reproduces the loader
boundary without installing dependencies or starting the application.

### work/lookup-harness.cjs

```js
'use strict';
// Source-bound offline component loader. Does not load the HTTP application.
// All four source modules below are complete native GitHub blob copies.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function load(file, imports) {
  const module = { exports: {} };
  const filename = path.join(root, file);
  const run = vm.runInThisContext(`(function(require,module,exports){\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  run((name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name.startsWith('node:')) return require(name);
    throw new Error(`Unexpected import: ${name}`);
  }, module, module.exports);
  return module.exports;
}
const rates = load('src/config/rates.js', {});
const currency = load('src/utils/currency.js', {});
const unused = new Proxy({}, { get() { throw new Error('Unused collaborator invoked'); } });
const cache = load('src/services/fxCacheService.js', {
  '../config': { fx: { cacheTtlMs: 30000, staleGraceMs: 60000 } },
  './fxProviders': unused,
  '../utils/ApiError': unused,
  '../config/rates': rates,
});
const imports = {
  '../config/rates': rates, '../utils/currency': currency,
  '../utils/money': unused, '../utils/ApiError': unused, './fxCacheService': cache,
};
module.exports = { root, rates, cache, load, imports };
```

### work/check.cjs

```js
'use strict';
const h = require('./lookup-harness.cjs');
const candidate = h.load(process.env.LOOKUP_BEFORE ? 'work/rateService.before.js' : 'src/services/rateService.js', h.imports);
h.load('test/rateSupportLookup.test.js', {
  '../src/services/rateService': candidate,
  '../src/services/fxCacheService': h.cache,
  '../src/config/rates': h.rates,
});
```

### work/bench.cjs

```js
'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const h = require('./lookup-harness.cjs');
const before = h.load('work/rateService.before.js', h.imports).isSupported;
const after = h.load('src/services/rateService.js', h.imports).isSupported;
const codes = h.rates.SUPPORTED_CURRENCIES.map(code => ` ${code.toLowerCase()} `);
const iterations = 500000;
const raw = [];
function sample(fn, inputs) {
  let hits = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) hits += fn(inputs[i % inputs.length]) ? 1 : 0;
  return { ms: performance.now() - start, hits };
}
function median(a) { return a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]; }
for (const scenario of ['cold-configured', 'warm-configured', 'warm-mixed']) {
  h.cache.reset();
  if (scenario !== 'cold-configured') h.cache.seed({ ratesToUsd: { ...h.rates.RATES_TO_USD, CAD: 0.73 } });
  const inputs = scenario === 'warm-mixed' ? [...codes, 'cad', 'ZZZ', '', null] : codes;
  assert.deepEqual(inputs.map(before), inputs.map(after));
  for (let i = 0; i < 3; i++) { sample(before, inputs); sample(after, inputs); }
  const b = [], a = [];
  for (let i = 0; i < 7; i++) {
    const result = {};
    for (const [name, fn] of (i % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]])) {
      result[name] = sample(fn, inputs);
    }
    assert.equal(result.before.hits, result.after.hits);
    b.push(result.before.ms); a.push(result.after.ms);
    raw.push({ scenario, pair: i, ...result });
  }
  const summary = { scenario, iterations, beforeMedianMs: median(b), afterMedianMs: median(a), reductionPercent: (1 - median(a)/median(b))*100, ratio: median(b)/median(a) };
  console.error(JSON.stringify(summary));
}
console.log(JSON.stringify({ runtime: process.version, platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0].model, iterations, warmupPairs: 3, alternatingPairs: 7, providerFetches: h.cache.getProviderFetchCount(), raw }, null, 2));
```

### Executed commands

```sh
LOOKUP_BEFORE=1 node --test work/check.cjs > work/before.tap
# exit 1: expected 18-versus-0 cache-peek assertion
node --test work/check.cjs > work/after.tap
# exit 0: one test passes
node work/bench.cjs > work/raw.json 2> work/summary.jsonl
# exit 0: all paired results agree, providerFetches = 0
```

The original contribution, attribution history and publisher custody remain.
No new claim, award, upstream merge or payment is established by this result.
