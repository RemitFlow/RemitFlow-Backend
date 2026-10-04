# Capacity rejection reset header

A full limiter table already returned the correct policy, limit, remaining
budget and Retry-After. It omitted X-RateLimit-Reset. When global and mutation
limiters ran in sequence, that omission retained the global policy's deadline
on a mutation-policy 429 response. A standalone limiter omitted the header.

The capacity response now sets X-RateLimit-Reset to the earliest retained
expiry, rounded up to epoch seconds, using the existing expiry index.
This is two added production lines. Budget admission, capacity, pruning,
Retry-After, credential handling and existing timing results are unchanged.

## Observed HTTP behavior

The same three maintained cases ran once against the preceding production
source and once against the repair on Node 24.19.0. Each phase sent 14 actual
loopback HTTP requests. The preceding source failed all three header assertions;
the repaired source passed all three cases with no skipped or cancelled cases.

| Case | Previous reset header | Repaired reset header |
| --- | --- | --- |
| Global window starts at 0 s; mutation window at 30 s; capacity rejection at 45 s | 1700000060, 30 seconds early | 1700000090 |
| Standalone limiter; earliest expiry at epoch 1700000061.250 | Absent | 1700000062 |
| First slot expires and is reused; another live slot next expires at 70 s | 1700000122, 52 seconds late | 1700000070 |

The cases also check status, policy, limit, remaining budget, Retry-After and
error details. Requests immediately before the relevant deadline remain
rejected, while a request at the deadline can take the expired slot. Partial
expiry advances the advertised deadline to the next surviving entry.

## Reproduce

From the repository root:

    node --test test/rateLimitCapacity.test.js

The regression uses only Node built-ins and the actual rateLimit, ApiError
and clientIdentity production modules. The HTTP server supplies the response
adapter that the middleware normally receives from Express, a controlled clock
and a synthetic authenticated-token assignment. It does not substitute limiter,
expiry, actor-key or error-class logic. No dependencies were installed for this
execution, and no provider requests or complete application suite were run.
The result establishes the response-header repair, not authentication,
full Express application integration or a throughput benchmark.

## Executed source

- Preceding commit: 752ec30bbc36825e75c78e5fba8e921f19d15a70.
- Preceding rateLimit.js Git blob: 91979defd7337634903af5219926112b635cbb1a.
- Repaired rateLimit.js Git blob: a51b607ff3cd526748da98e26c3c1f9db337d22e.
- Unchanged ApiError.js Git blob: 6b586f60d991ab4e5174e0af4e0d94cf1e3ceb58.
- Unchanged clientIdentity.js Git blob: 68c51d25194ef031b6b5a329b982a24c25662271.
- Identical regression Git blob in both phases: efa7ac2553db731f743fbbdd601344483e8d3542.

Existing expiry-index and batch-expiry repairs and their historical evidence
remain intact. The original PR and contribution are retained.
