# Archive and settlement lease regression

Archive and unarchive now check the existing transfer-scoped lifecycle lease before changing state. Without that check, a reentrant archive can increment the resource version after provider preparation; the claim then rejects locally despite the retained provider receipt. The check is inside the actual archive mutation, so a retry of an already archived transfer remains a no-op. Other transfers and operations after lease release remain available. No provider, CAS, resource-version or idempotency policy is removed.

## Executed evidence

Base: `b67b7e7639bada58642a12abffa6da6ac5293c5b`. Production blob before: `da558d83b3852188adfc61f12b94ca8ccf8f837d`; after: `75ec847a3610607b171b5f716a016f57ad9dcac5`. Test blob: `c629e2049e3c86a93faee27c4ed8c1bc8c30be5c`. Runtime: `v22.23.3`.

The five new cases on the original production source: 3 pass / 2 fail, exit 1. The archive and unarchive settlement interleavings both fail before the repair.

After the repair, the four focused files below: 42 pass / 0 fail / 0 cancelled / 0 skipped; exit 0. Existing state-machine, worker-reload, duplicate-callback, rollback and HTTP tests were not altered.

```sh
NODE_ENV=test node --test --test-reporter=tap test/transferLifecycleConcurrency.test.js test/transferLifecycleHttp.test.js test/transferArchive.test.js test/transferArchiveSettlement.test.js
```

Actual synchronous in-memory transfer service, existing mock Stellar adapter and maintained HTTP/lifecycle tests; no live provider, durable database, deployment or full-suite claim.
