# Archive reason input validation — 2026-10-04

PR: https://github.com/RemitFlow/RemitFlow-Backend/pull/144

## Change

Reject object and array `reason` values with a 400 validation error before archive or unarchive looks up a transfer. The previous `String(reason)` conversion could throw for valid JSON such as `{"toString":null}`; the application error handler then rendered an internal-error envelope (500). Plain objects and arrays could also become meaningless audit-reason strings.

The three-line guard preserves the existing normalization of omitted, null, empty-string, string, number, and boolean reasons. This change does not alter archive history, timestamp ordering, or concurrency checks.

## Source pins

| Input | Git object |
| --- | --- |
| Baseline branch head | `a9d97a6d386119a8fe01d7cc867c70b09bd76355` |
| Original `src/services/transferService.js` | `0d421aeeac2cd3d7e9f131918c74d1cc086269bf` |
| Candidate `src/services/transferService.js` | `dc550d29e0fc0463de352ac834a835acac0c9b88` |
| `test/archiveReasonValidation.test.js` | `fd295a1489615673eaf11f7b7d2e44d280ddd94a` |
| Unchanged `src/utils/ApiError.js` | `6b586f60d991ab4e5174e0af4e0d94cf1e3ceb58` |
| Unchanged `src/middleware/errorHandler.js` | `e75a516bde4ec4052d39bea396298e9f2ac5c981` |
| Unchanged `src/services/errorTrackingService.js` | `205391bbd86d48478edc854bf4d5e4a4813596ac` |

## Focused execution

Node.js v24.19.0; the same three `node:test` cases executed once against each service version.

| Case | Original | Candidate |
| --- | --- | --- |
| Reject structured reasons before transfer lookup | Failed: reached missing-transfer 404 | Passed: 400 for both actions |
| Preserve scalar normalization | Passed: retained missing-transfer 404 | Passed: retained missing-transfer 404 |
| Render malformed JSON reason through the application error handler | Failed: 500 instead of 400 | Passed: 400 validation envelope and request ID |

Original: **1 passed, 2 failed**, exit 1. Candidate: **3 passed, 0 failed**, exit 0. Both executions had zero skipped or cancelled cases.

The execution used `node --test-reporter=tap` with a CommonJS source loader in memory. It loaded the complete service, ApiError, error handler, and error-tracking source at the pins above, plus the unchanged regression-test source in both phases. Explicit collaborators were an empty transfer map, a logging sink, error tracking disabled in config, and empty unused service dependencies. The cases stop at reason normalization or missing-transfer lookup.

This establishes the source and error-envelope behavior. It does not establish full Express routing, authentication, successful archive mutations, history integration, or full-suite acceptance. No dependency install or full-suite run was performed for this change.

The maintained regression file can be run in a normal repository checkout with dependencies installed:

```bash
node --test test/archiveReasonValidation.test.js
```
