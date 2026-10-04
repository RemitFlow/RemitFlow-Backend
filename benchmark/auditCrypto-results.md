# Audit encoding throughput

The encoder now appends serialized items directly, avoiding the temporary
arrays previously produced by `Array.from()` and `map()` before `join()`.
Object keys are still filtered and sorted in the original order. Arrays still
capture their length and visit every index, so holes encode as `null`.
`computeEntryHash`, redaction, field selection, and primitive JSON encoding
are unchanged.

## Measured result

Baseline: original PR 142 head `7192af8e4cc854abe3e0b344ce741c8a0cf097ee`,
using its actual `src/utils/auditCrypto.js` implementation. The baseline and
candidate source SHA-256 values are recorded in `auditCrypto-results.json`.
The measured baseline materialization added one trailing newline; that file's
hash and the exact repository source hash are both retained.

Environment: Node.js `v24.19.0`, AMD EPYC 9V74 80-Core Processor, shared Linux
cloud environment. All numbers below are operations per second calculated
from the median elapsed time of nine batches per implementation.

| Workload | Operation | Baseline ops/s | Changed ops/s | Throughput gain |
| --- | --- | ---: | ---: | ---: |
| Transfer event | `canonicalize` | 231,872 | 254,396 | 9.7% |
| Transfer event | `computeEntryHash` | 154,730 | 168,089 | 8.6% |
| Nested configuration | `canonicalize` | 93,662 | 109,206 | 16.6% |
| Nested configuration | `computeEntryHash` | 78,433 | 91,882 | 17.1% |
| Bulk changes | `canonicalize` | 8,012 | 16,196 | 102.1% |
| Bulk changes | `computeEntryHash` | 9,863 | 16,103 | 63.3% |

## Method and compatibility

The benchmark calls the exported production functions from both files. Each
workload cycles through 32 distinct events: ordinary transfer changes, nested
configuration changes with arrays and escaped text, or an event containing 32
transfer records. Half of the events omit `mutationId`.

Before timing, the benchmark compares the exact canonical string and entry
hash produced by both implementations for every event. Each operation has
4,000 warmup calls per implementation, followed by a baseline calibration
targeting 120 ms batches. Both implementations then use the same iteration
count. Execution order alternates between batches. Raw elapsed times, iteration
counts, and source hashes are retained in `auditCrypto-results.json`.

The existing focused regression command passed all three cases:

```sh
node --test test/auditCrypto.test.js
```

Those cases cover preserving own JSON keys through redaction, binding that
evidence into the integrity hash, and retaining the previous ordinary event
digest.

## Reproduction

Materialize the original source from the pinned head, then pass its path:

```sh
git show 7192af8e4cc854abe3e0b344ce741c8a0cf097ee:src/utils/auditCrypto.js > /tmp/auditCrypto-baseline.js
node benchmark/auditCrypto.js /tmp/auditCrypto-baseline.js
```

These are in-process encoding and SHA-256 measurements. They do not measure
HTTP requests, authorization, persistence, or total endpoint latency. The
shared environment produced timing outliers; the raw batches are included
so readers can assess the spread. The percentages describe this measured
workload and environment, not a guaranteed application-wide improvement.
