# Quote GC expiry parsing benchmark

## Change and boundary

The collector repeatedly scans retained quotes once the map reaches 256
entries. Previously every scan reparsed every ISO expiry string, including
unchanged live quotes. Cache the parsed expiry per quote in a WeakMap, keyed
by both object identity and its current expiry string. Non-string values are
still parsed on each access. Grace remains read at collection time; no
retention threshold, eviction order, quote response field, or pricing term
changes.

The tradeoff is a small cache record per scanned, reachable quote. Weak keys
do not themselves retain an evicted quote. This benchmark does not measure
heap usage or establish a memory reduction.

## Measured result

Node v22.16.0, Linux, 20,000 sequential still-live quote insertions with
distinct expiry strings. One warmup and five timed samples per version;
Date.parse calls are counted in a separate untimed run.

| Measure | Baseline | Patched |
| --- | ---: | ---: |
| Median GC-kernel time | 2733.05 ms | 1730.78 ms |
| Expiry Date.parse calls | 7,587,952 | 19,999 |
| Final retained quotes | 288 | 288 |

Measured median time falls 36.67%
(1.58x speedup); parse calls fall
99.74%.
Both versions retain exactly quote-19712 through quote-19999, with SHA-256
`be45a565a0850672b2626ac3e772fb80c4110ea5bb93bdccf9c829a3acfdda51`
for the JSON array of retained IDs.

Baseline complete source blob: `eb903d4b79e6aba3cfabb33ad256af9469f1b677` at commit
`823d05059cd4f0e6f190d43311ec3c8487ebdc74`.
Patched complete source blob: `0cac87ce332749f8d8ff0bea84a9149e6fbfedb5`.

Baseline milliseconds: 2763.464, 2733.046, 2657.702, 2667.135, 2735.772.
Patched milliseconds: 1737.870, 1730.777, 1717.096, 1727.002, 1743.507.

This is a **GC-kernel microbenchmark**, not application, HTTP, transfer,
provider, or fleet throughput. The script loads the complete service source
in an isolated Node VM and exposes its private collector for measurement;
only ordinary store/config fixtures are exercised. Unrelated imports are
not loaded or invoked. VM overhead, retained input records and machine
conditions affect timings. There are no external provider calls, dependency
installs, wall-time thresholds in tests, or production API changes.

## Reproduce

```sh
git show 823d05059cd4f0e6f190d43311ec3c8487ebdc74:src/services/quoteService.js > /tmp/quote-service-before.js
node scripts/bench-quote-gc.js /tmp/quote-service-before.js 20000
node scripts/bench-quote-gc.js src/services/quoteService.js 20000
node --test test/quoteGc.test.js
```

The focused regression file produces 2 passes / 1 failure against baseline
(the ten-scan case reparses 3,000 times rather than 300), and 3 passes / 0
failures against the patched collector. It also checks unchanged payloads,
changed expiry strings, exact grace boundaries, configuration changes,
invalid/non-string expiry behavior, and insertion-order capacity eviction.
The existing npm test glob includes it. Full application tests and current
CI were not run as part of this isolated measurement; no prior full-suite
result is presented as current evidence.
