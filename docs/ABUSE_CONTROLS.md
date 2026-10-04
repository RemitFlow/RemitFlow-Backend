# Abuse controls and correlation IDs

RemitFlow Backend bounds high-volume retries and automated abuse on mutation
and provider-adjacent routes, and propagates a safe correlation id on every
request so incidents can be traced without leaking account secrets.

## Global limit

Every `/api/*` request is subject to an IP-keyed fixed-window limit:

| Setting | Env | Default |
|---|---|---|
| Window | `RATE_LIMIT_WINDOW_MS` | `60000` |
| Max requests | `RATE_LIMIT_MAX` | `100` |
| Max tracked keys | `RATE_LIMIT_MAX_KEYS` | `10000` |

Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, and `X-RateLimit-Policy`. Exhausted budgets answer
`429` with `Retry-After` and a JSON error that includes `requestId`.

## Mutation / route-family limits

Authenticated write paths use a **stricter actor-keyed** budget on top of the
global limit. The actor key is a truncated SHA-256 fingerprint of the API
token (or admin key) — never the raw secret. Public quote uses the client IP.

| Family | Routes | Env (window / max) | Default max / min |
|---|---|---|---|
| `transfers` | `POST /api/transfers`, claim, cancel, archive, unarchive | `MUTATION_RATE_LIMIT_TRANSFERS_*` | 30 / 60s |
| `users` | `POST /api/users` | `MUTATION_RATE_LIMIT_USERS_*` | 20 / 60s |
| `quote` | `GET /api/quote` | `MUTATION_RATE_LIMIT_QUOTE_*` | 60 / 60s |
| `admin` | `GET /api/admin/diagnostics` | `MUTATION_RATE_LIMIT_ADMIN_*` | 30 / 60s |

Shared cap: `MUTATION_RATE_LIMIT_MAX_KEYS` (default `10000`).

Actors are isolated: one token burning its transfer budget does not exhaust
another token's budget. Limiter tables are bounded. Expired windows are pruned
first; when every key is still live, a new identity receives 429 with
`Retry-After` until a slot expires. This preserves active budgets under an
identity flood, at the cost of delaying new identities when the table is full.

## Proxy trust

`TRUST_PROXY=true` uses Express `trust proxy` for one proxy hop. Rate
limiting reads Express's resolved `req.ip`, so an attacker-controlled left-most
`X-Forwarded-For` value cannot rotate the identity when the trusted proxy
appends the connecting address. Enable this only when the deployment has
exactly one trusted reverse proxy; otherwise leave it off until the app's
trust proxy setting matches the deployment topology.

## Correlation IDs

On every request, the [request-ID middleware](../src/middleware/requestId.js):

- Trims leading and trailing whitespace from each candidate header value.
- Accepts a nonempty value of at most 128 characters after trimming, matching
  `^[A-Za-z0-9._:-]+$`.
- Rejects a candidate containing the Bearer token or `X-Admin-Token` supplied
  on the same request, even when the candidate otherwise matches the format.
  This runs before authentication and does not change authorization decisions.
- Uses a valid, credential-independent `X-Request-Id` first, otherwise a valid,
  credential-independent `X-Correlation-Id`. If neither is acceptable,
  generates a fresh UUID.
- Echoes the selected value on both `X-Request-Id` and `X-Correlation-Id`.
- Exposes it as `req.id` / `req.correlationId` and on error envelopes as
  `error.requestId`.

Values outside this format or containing a credential presented with the same
request are ignored; accepted identifiers are not hashed or redacted. The
credential exclusion only recognizes those presented Bearer/admin tokens. It
does not identify unrelated credentials, account identifiers or arbitrary
personal data, so a syntactically valid ID is not proof that its content is safe.

Supply a fresh opaque ID, such as a UUID, and keep credentials, account details
and other personal data out of both headers. Omit both headers when a
server-generated ID is sufficient. Accepted IDs are echoed and written by the
[request logger](../src/middleware/requestLogger.js), so treat them as values
that can appear in response headers, error envelopes and logs.

## Test behaviour

When `NODE_ENV=test`, rate limiters are no-ops unless
`ENABLE_RATE_LIMIT_IN_TEST=1` (or a limiter is constructed with
`forceInTest: true`). This keeps the functional suite independent of the
abuse budget while still allowing focused regression coverage.

## Reproduce saturated-table HTTP load

With this checkout's normal dependencies installed, run:

```sh
node scripts/benchmark-rate-limit.cjs rate-limit-result.json > /dev/null
```

Use a new result filename. The script starts the real application on an ephemeral
loopback port, enables the limiter explicitly in test mode, and uses one trusted
proxy hop to generate distinct local identities. It admits 10,000 identities,
then measures three batches of 2,000 rejected newcomers at 32 concurrent
connections. Every measured response must be 429 with the global policy and
matching correlation ID; an exhausted original identity must remain blocked.
The script closes its server and connections when finished.

JSON output retains each elapsed/CPU sample, Node and Express versions, and
SHA-256 hashes of the application and limiter source. CPU includes both the
HTTP client and server in the same process. Standard application logs go to
stdout, so keep the same redirection for both versions being compared.

To compare another checkout with its dependencies already installed, pass its
path as the second argument. Alternate original/repaired/original/repaired runs
using the same script and distinct output filenames; report medians and ranges
because load on the host can vary. The workload uses generated local traffic and
does not measure deployed throughput or external provider behavior. Repeated
rejection does not traverse the table. Expiry cleanup uses the deadline index
described below.

## Staggered-window expiry

A binary min-heap now orders deadlines independently of insertion order. It has
one node per tracked identity, and both the map and heap remain bounded by
`maxKeys`. Repeated hits reuse the same node; renewal first removes the expired
generation. Reset clears both structures. This ordering also preserves the
existing behavior when the wall clock moves backward.

Admitting a new identity takes O(log n) heap work. Removing k expired identities
takes O(k log n), without scanning the n surviving identities. The additional
index costs O(n) memory. A maximum deadline also tracks when the entire table
has expired; that case clears both collections without popping individual heap
nodes. If any budget remains live, the existing heap pruning still applies and
expiring many older identities can do more work than a linear sweep. Both paths
preserve active budgets, capacity rejection and rounded-up `Retry-After`.

### Measured component result, October 4, 2026

The exact production middleware was loaded with its real `ApiError` and
`clientIdentity` modules on Node 24.19.0. A controlled clock admitted 10,000
identities with staggered windows, then 1,000 rolling newcomers while preserving
10,000 tracked identities. All 11,000 admissions and the final exhausted
survivor's 429 response matched the original implementation.

| Measurement | Original | Updated |
|---|---:|---:|
| Full-map entry visits during the rolling workload | 10,000,000 | 0 |
| Median rolling time, three alternating pairs | 224.325 ms | 2.818 ms |
| Rolling time range | 183.074–474.427 ms | 2.466–4.710 ms |

The timing ratio was 79.6× in this component workload. Map iteration counts do
not count heap operations or ordinary map lookups. Clock, request and response
objects were controlled; this does not measure HTTP service or fleet throughput.
A separate deterministic comparison covered 20,000 requests and 629 resets at
capacities 1, 2, 7, 31 and 256. Complete headers, errors, decisions and tracked
sizes matched, including backward-clock admissions and renewals.

Original source: commit `f501ce5f4fd6f6f96c82fb9fffed4dc58f3def8e`, limiter
blob `6748ce8105628e781cccea40c368d2bb3a830b17`. Updated limiter blob:
`84c97f7b183c1c8e96be0695e5f332f9c2e3acca`.
[Raw samples and response digests](validation/rate-limit-expiry-20261004.json)
retain every measured pair. The existing abuse-control suite retains all prior
cases and adds one regression for staggered expiry.

To reproduce the component comparison from a checkout containing this change:

```sh
benchmark_dir=$(mktemp -d)
mkdir "$benchmark_dir/original" "$benchmark_dir/final"
git archive f501ce5f4fd6f6f96c82fb9fffed4dc58f3def8e | tar -x -C "$benchmark_dir/original"
git archive HEAD | tar -x -C "$benchmark_dir/final"
cp scripts/benchmark-rate-limit-expiry.cjs "$benchmark_dir/replay.cjs"
node "$benchmark_dir/replay.cjs"
```

The replay writes `results.json` inside the fresh benchmark directory. It uses
only Node built-ins and the archived production modules; it installs no packages
and makes no network requests. Host load can change the timing samples.

### Maintained application checks

On the updated limiter/test blobs above, `node --test test/abuseControls.test.js`
reported 17 passed and 0 failed; `npm test` reported 273 passed and 0 failed,
with no skipped or cancelled tests. These runs used Node 24.19.0 and the unchanged
lockfile `be3ad84b812121d2ec4f47541df3a55816bb210c`. The focused suite includes real
Express loopback requests for proxy identity, correlation, parser failures and
429 responses. The complete 178-file parent source was checked against its Git
blob identities before composing the two changed source/test files.

Dependencies came from the matching-lock artifact of the already-completed
[archive acceptance job](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37191775463).
That job's 46 archive passes concern PR #144; the 17/273 results above are separate
local executions of this PR #138 composition. Sharing dependencies adds no claim
that the hosted archive job executed the limiter patch.

### Whole-table expiry continuation, October 4, 2026

The maximum deadline is independent of insertion order. It changes only when
an identity is admitted, and resets when the limiter or whole table is cleared.
A clock rollback can create an earlier new deadline without causing a later
live budget to be removed. Clearing waits until the latest deadline, inclusive.
JavaScript collection clearing and later garbage collection remain runtime
costs; this is not a constant-time or process-throughput guarantee.

The following Node 24.19.0 measurements compare the exact preceding middleware
at `ebda2cb811d1c3ad35c1fec8af46cf83d45df8b3` with this continuation. Each
workload fills 10,000 identities, then measures the first admission once every
budget has expired. Five alternating before/after pairs contain 20 rounds each.

| First-admission latency | Previous median | Updated median |
|---|---:|---:|
| All identities share one deadline | 0.6200 ms | 0.01655 ms |
| Staggered deadlines, all expired | 1.8185 ms | 0.01114 ms |

Both versions return identical headers, errors and retained sizes, including
the next request's 429. Instrumented runs remove 200,000 expired-entry `Map`
deletions over 20 rounds; the new identity's normal insertion remains. These
are actual production middleware modules with a controlled clock and request
objects, not an HTTP or external-provider benchmark.

Admission-fill timings are also retained, not folded into the first-admission
claim. Across these pairs their medians changed from 174.5 to 227.1 ms for the
same-deadline workload and 164.3 to 181.8 ms for staggered deadlines. Allocation,
garbage collection and host load affect those measurements; the result
establishes less work on the expiry-triggering request, not higher total
throughput. Raw samples and source hashes are in
[the batch-expiry result](validation/rate-limit-batch-expiry-20261004.json).

Four maintained expiry/renewal regressions pass, including one new boundary,
clock-rollback and reset case. The exact command is:

```sh
node --test --test-name-pattern='expiry|renewal|clock rollback' test/abuseControls.test.js
```

The focused run uses the existing matching-lock dependency artifact referenced
above, without dependency changes. It does not rerun the full application suite.
Reproduce the component comparison with two checkouts and a new output filename:

```sh
node scripts/benchmark-rate-limit-batch-expiry.cjs BEFORE_CHECKOUT AFTER_CHECKOUT NEW_RESULT.json
```
