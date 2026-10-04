# PR 144 body-precondition acceptance — 4 October 2026

## Result

The existing archive acceptance suites passed **46 tests, with 0 failures, skips,
or cancellations**, on source commit
`45d0bd4e8f1ad71a22ee3d759a84388ae2a9f968`.

This completes the previously unexecuted native validation of the body-precondition
continuation on [RemitFlow-Backend PR 144](https://github.com/RemitFlow/RemitFlow-Backend/pull/144).
That continuation was published while its execution environment was unavailable.

[Successful GitHub Actions run 37191775463](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37191775463)
contains the complete command output. The acceptance job is `111405306802`.
It ran on the public contributor fork and checked out the exact source commit
above before installing or executing anything.

## Execution

Runtime: **Node.js v22.23.3**, **npm 10.9.9**, Linux x64, GitHub-hosted
`ubuntu-latest`. The existing repository CI also selects Node.js 22.

The job used the unchanged manifest and lockfile with `npm ci`, followed by:

```bash
node --test --test-concurrency=1 \
  test/transferArchive.test.js \
  test/transferArchiveLifecycle.test.js
```

The test runner reported a total duration of 589.94016 ms. This is the duration
of that suite invocation, excluding checkout and dependency installation; it is
not a backend throughput or latency benchmark.

The existing HTTP cases execute the application through a local listener and
use its in-memory store and mock settlement adapter. The ten pending additions
all passed:

- Eight malformed body-precondition cases cover number, boolean, array, and
  object values for both archive and unarchive. They require
  `409 STALE_ARCHIVE_COMMAND` and unchanged transfer history and audit records.
- Two compatibility groups cover optional values, trimmed body precedence,
  bare and weak-quoted headers, valid header fallback for a non-string body,
  and a stale header fallback. The existing successful and stale-command
  behavior is preserved.

All 36 earlier tests in these two suites also passed. No source correction was
needed after execution.

## Source and artifact identities

| Item | Identity |
| --- | --- |
| Tested repository | `woahwhattheheck/RemitFlow-Backend` |
| Tested source commit | `45d0bd4e8f1ad71a22ee3d759a84388ae2a9f968` |
| Validation workflow commit | `8ab10b252c90b28d161ad804b65fd0a22e1f95bb` |
| Package manifest Git blob | `a1bf7b6726b103f58de2e8cf6f2bab71fca6883b` |
| Package lock Git blob | `be3ad84b812121d2ec4f47541df3a55816bb210c` |
| Package lock SHA-256 | `74077a5a97f6548a4049aa9756e14dfbc04beab1c82b57923942ff0d99524894` |
| Locked dependencies | 76 |
| Actions artifact | `11299062132` / `rfb144-body-precondition-a993` |
| Artifact ZIP SHA-256 | `523eb61c2ef23e0f865b7387bef0dad14931688b2f7939995b9de88f5cfb8a8f` |
| Dependency tar SHA-256 | `0ae2e8dba5fb52549442edcae73b55a93d4e7f5d5141c842431373c565f09680` |

The artifact contains `acceptance.tap`, `runtime-metadata.json`, and the
`node_modules.tar.gz` produced by that same lockfile installation. It expires
on **11 October 2026 at 09:19:31 UTC**. Its downloaded ZIP and dependency-tar
digests were verified. Reuse of these dependencies requires the matching
lockfile; the artifact does not establish execution of another source revision.

## Limits

Only the two named maintained suites ran in this continuation. There is no new
full-suite result, live-provider settlement result, deployment, or upstream
maintainer acceptance claim. The successful fork job does not replace upstream
CI approval.

The original contribution remains on `latch/remitflow-126-archive-timestamps`.
This receipt is an additive documentation change; its evidence refers to the
tested source commit above. The separate validation workflow stays on
`validation/rfb144-body-precondition-a993`.
