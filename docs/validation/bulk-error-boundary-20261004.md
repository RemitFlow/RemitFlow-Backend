# Bulk error boundary

Bulk transfer actions now use the same error-disclosure boundary as the central HTTP handler: only an intentional ApiError controls the public status/message; other thrown values become 500 / Internal server error. Canonical missing-transfer errors, intended API conflicts and scope checks remain intact. Null and string throws remain per-item failures instead of crashing the batch. Independent items still execute.

This change does not alter transfer state transitions or claim to roll back provider failures.

## Executed evidence

Base `b0c161f1c9c8200d762e5810ba82c15995a1be0a`; source before `e82ec442dec7a190eae24f0efddcaabfceff4a17`, after `41b91b665e183547619af829b2b5e82d739728e3`; new test `aeceda6e5cf69b31f20488af440442e941c5d16d`. Runtime `v22.23.3`.

Original production with new HTTP regressions: 2 pass / 6 fail, exit 1. Failures cover ordinary and status-bearing provider errors, null/string throws, and single-item/bulk message parity.

Repaired source with maintained token-scope suite and new HTTP regressions: 33 pass / 0 fail / 0 cancelled / 0 skipped, exit 0. Existing tests unchanged.

```sh
NODE_ENV=test node --test --test-reporter=tap test/tokenScopes.test.js test/bulkErrorBoundary.test.js
```

Real createApp, Express authentication, service and loopback HTTP with synthetic provider failures and existing mock settlement. No live credentials, external provider, durable storage, full-suite or settlement rollback claim.
