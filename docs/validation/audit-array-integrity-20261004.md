# Array positions in audit integrity hashes

Canonical array encoding now visits every numeric slot, including holes, and encodes absent values as JSON null. Previously map() skipped holes: changing an empty stored array to length one changed its JSON output from [] to [null] but left the canonical hash input as []. The existing verifier and HTTP integrity endpoint could therefore miss the edit.

The repair also makes sparse arrays agree with their JSON round trip. Ordinary dense JSON keeps the same bytes and digest. No record hash is rewritten. Existing pre-repair sparse-array records may fail verification under the corrected encoding; investigate them rather than silently rehashing or accepting the old ambiguous representation. The documented store is in-memory; any separate durable-store adopter must handle this compatibility boundary explicitly.

The previous own-JSON-key redaction repair is retained unchanged, as are actor fingerprints, compatibility-alias checks and the set of hashed event fields.

## Executed evidence

Base `d2962a3e9ea3778c02b2d941b2a7553da10d5deb`; source before `f225d3244c5dde9d2a1a085929410d04ad2cfa77`, after `5423fc9652af26952821d872bcd034582c522968`; new test `89e403bc43372fb706fcec21e755c1dd744143f2`. Runtime `v22.23.3`.

Original source with new regressions: 1 pass / 4 fail, exit 1. The actual service and authenticated integrity endpoint accepted an array-length edit before the repair.

Repaired source with maintained auditIntegrity and auditCrypto suites plus new regressions: 32 pass / 0 fail / 0 cancelled / 0 skipped, exit 0. Existing tests unchanged.

```sh
NODE_ENV=test node --test --test-reporter=tap test/auditIntegrity.test.js test/auditCrypto.test.js test/auditArrayIntegrity.test.js
```

Actual in-memory audit service, canonical hash implementation and authenticated loopback Express integrity endpoint. Synthetic records only; no live accounts, external provider, durable database or full-suite claim.
