# Quote receive-amount range

## Repair

`getQuote` already rejects source amounts outside the money helper's supported
cent-arithmetic range. FX multiplication can exceed that range even when the
source amount and conversion ratio are individually finite. Reject the converted
amount with the same helper before rounding, assigning a quote identity, or
inserting it into `store.quotes`. Transfer binding without a supplied quote ID
uses the same guarded path. Valid amounts, fees, rates, provenance and stale/TTL
policy remain unchanged.

This complements the provider cross-rate check: a representable rate does not
imply that multiplying it by a valid amount produces a representable amount.

## Focused execution

Integration parent: `4efd7b7304484206640c04f1f0fc31d9c9269ab9`.
The concurrent provider-ratio and configured-currency lookup repairs are retained.
All 12 loaded source/test preimages were matched against their Git blob hashes;
the two changed dependency modules were refreshed to the integration parent.

Node v22.16.0, Linux, default fee/FX configuration, one existing test file:

| Source | Passed | Failed | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: |
| Original quote service, current dependencies | 2 | 3 | 0 | 1 |
| Guarded quote service, same dependencies | 5 | 0 | 0 | 0 |

The three added cases cover quote creation and implicit transfer binding for an
unsafe converted amount, plus multiplication overflow with a finite FX ratio.
The two existing precision/provenance cases are unchanged. The rejection cases
check that no quote is stored; ordinary subsequent quotes retain version 1,
expected receive amounts and successful binding.

The large-input service case uses the configured USD/NGN rates. It exceeds the
application's default maximum transfer amount, so it is not evidence that the
public transfer endpoint admits that request. The separate overflow case uses
amount 100 and a controlled finite-rate snapshot (`NGN: 1e-307`). These are
service-level numeric boundary checks, not a live financial/provider scenario.

Source blobs:

- Original `quoteService.js`: `cae92cf78909b809777ff0e6cc9028dc003978cc`.
- Guarded `quoteService.js`: `4438da7b30a4b0486fa2afe2292b252a870d2338`.
- Executed `exchangeRatePrecision.test.js`: `cfe95650050ed04dec603c8abbbaaca42bd67ba2`.
- Current `rateService.js`: `e48be1aba814ba1443d64554b5d22ad8e1591d2d`.
- Current `fxProviders.js`: `feaff602fe217dfeeaf705dbbbd3669cbfec97dd`.
- `fxCacheService.js`: `91201bc01251b888ad86678038c68b4f74a66013`.

## Reproduction and limits

With the repository's normal dependencies installed, the maintained selection is:

```sh
node --test test/exchangeRatePrecision.test.js
```

That dependency-complete command was not run here. The actual offline command
loaded the complete, hash-matched production quote, rate, cache, provider, money,
currency, error, ID, configuration and store modules with the following temporary
import adapter (not a product dependency or workflow):

```js
'use strict';
const Module = require('node:module');
const crypto = require('node:crypto');
const path = require('node:path');
const original = Module._load;
// Place this temporary adapter at evidence/offline-imports.cjs.
const storePath = path.resolve(__dirname, '../src/store/index.js');
const idsPath = path.resolve(__dirname, '../src/utils/ids.js');
const configPath = path.resolve(__dirname, '../src/config/index.js');
const untouched = () => { throw new Error('Unused collaborator was unexpectedly invoked'); };
for (const key of ['TRANSFER_FEE_PERCENT', 'TRANSFER_FEE_FLAT', 'FX_CACHE_TTL_MS',
  'FX_STALE_GRACE_MS', 'FX_ALLOW_STALE_TRANSFERS', 'FX_QUOTE_TTL_MS', 'API_TOKENS']) {
  delete process.env[key];
}
Module._load = function(request, parent, isMain) {
  if (request === 'dotenv' && parent?.filename === configPath) return { config: () => ({}) };
  if (request === 'uuid' && parent?.filename === idsPath) return { v4: crypto.randomUUID };
  if (parent?.filename === storePath && request === '../services/auditService') return { reset: untouched };
  if (parent?.filename === storePath && request === '../utils/orderedIndex') {
    return { OrderedIndex: class { reset() { untouched(); } } };
  }
  return original.apply(this, arguments);
};
```

```sh
node --require ./evidence/offline-imports.cjs --test test/exchangeRatePrecision.test.js
```

The adapter replaces `.env` loading, the UUID package call, and unused audit/index
initialization only; it does not replace quote arithmetic, cache admission,
freshness classification or quote persistence. The same adapter and maintained
test bytes ran before and after the fix. No provider HTTP calls, transfer HTTP
handler, full application startup, dependency-complete suite or hosted CI result
is asserted. No unrelated test was removed, weakened or skipped.
