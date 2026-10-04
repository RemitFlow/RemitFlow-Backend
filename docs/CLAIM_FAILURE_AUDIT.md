# Claim failure state and audit outcome

An adapter failure now leaves the pending transfer, timestamp and claimable-balance fields unchanged. It records a hash-chained failure outcome with actor fingerprint, target, scope and request correlation, then propagates the original exception. Raw error messages, stacks and credentials are not copied into audit storage. A successful retry records its separate success outcome; repeated failure with the same event identity retains the existing deduplication behavior. Missing or terminal targets never call the adapter.

The Stellar adapter in this repository is an explicit in-memory simulation. The regression injects a thrown error at that adapter boundary; it is not a live Stellar outage, blockchain transaction or durable settlement test. Other source changes, including JSON-key and sparse-array integrity repairs, are preserved.

## Focused execution

Node22.16.0, unchanged npm-ci lock, run 37193202657.

Before, only new failure cases:
```
node --test --test-name-pattern="claim failure:" test/auditIntegrity.test.js
# tests 3
# pass 1
# fail 2
# skipped 0
```

After, the maintained audit-integrity file:
```
node --test test/auditIntegrity.test.js
# tests 27
# pass 27
# fail 0
# skipped 0
```

Source blobs: {'src/services/transferService.js': 'a080e89302a8b04eb6a759fddaf5a742895fc7cf', 'test/auditIntegrity.test.js': 'a9a8c7adb7ddea9ec90ca3ee5eeb66a2fbc8b276'}

No broad suite, deployment, live provider call or dependency change. A failed local dependency installation could not reach the registry; the recorded execution above used the cloud runner and original locked dependencies.
