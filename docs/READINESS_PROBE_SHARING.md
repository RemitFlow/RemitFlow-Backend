# Bounded readiness probe work

Follow-up to the existing dependency-readiness contribution, PR #140 / issue #134.

## Behavior

A request deadline previously stopped waiting without stopping the underlying operation. Repeated readiness requests could therefore accumulate unfinished calls to a hung payment or FX adapter. The service now shares only an unfinished operation for each dependency and adapter generation. Every request retains its own timeout; a timed-out request removes its subscriber instead of leaving another callback attached to the hung operation. Completed results are discarded, not cached as healthy or failed.

The payment and FX method references and their receiver objects are captured before execution. Replacing an adapter does not inherit the old adapter's pending operation; an old completion cannot evict its successor. Existing stable reason codes, redaction, forced test states and the liveness/business-API rate-limit distinction are unchanged.

**Limit:** this bounds outstanding work for an unchanged adapter; it does not cancel an arbitrary Promise. A truly never-settling adapter stays not-ready rather than spawning more calls. Recovery occurs when the operation settles or the adapter is replaced. A real external driver still needs transport-level cancellation/timeouts. Deliberately replacing adapters repeatedly can leave their old uncancellable operations outstanding; this is not a global provider quota or fleet-wide limiter.

## Executed evidence — October 4, 2026

Source commit `b4c9505ee1ac758ebb3fff659bbe39747febaa6b`, tree `9a49ce0645d3b95eed16aa8d2671dbc19682e989`, sole parent `67c4e52d8bcb6b286922104702e717c75cdfa053`.

- Production service blob: `f1d574ff23df4440aa350ca57ace9df51b88080b`.
- Shared-operation helper: `5dfabe9ed6437b00e336b0eb8e3dca58e9bc5279`.
- New regression file: `6148d44d1e1f46d05a2920531ae0bf9986028b44`.

[Final run 37193635966](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37193635966), Node 24.21.0 on Ubuntu, executed:

```sh
npm ci --no-audit --no-fund
node --unhandled-rejections=strict --test --test-reporter=tap test/dependencyHealth.test.js test/readinessProbeSharing.test.js
```

**29 tests passed; zero failures, skips or cancellations.** Existing health tests and dependency manifests stayed byte-identical. This includes actual Express HTTP requests and default adapter wrappers, with controlled local provider promises; no live Stellar/FX/database connection is claimed.

The repeated-timeout regression sent 40 readiness requests. Before the repair it made 40 provider calls; afterward it made one unfinished provider call, retained liveness HTTP 200 and recovered after completion. The other new cases cover independent caller deadlines, shared redacted rejection and a late predecessor completion. The earlier default-adapter tests also prove replacement recovery.

The initial baseline run [37192889105](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37192889105) reproduced all four new failures. Its wrapper then stopped because it expected TAP while Node emitted the spec reporter; that run is not represented as a repair pass. The first repaired candidate [37193040714](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37193040714) passed 27 tests but failed two existing adapter-replacement recovery cases. Capturing and keying the actual adapter generation repaired those failures without changing any existing assertion. The original baseline was not rerun.

[Final artifact 11299902454](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37193635966/artifacts/11299902454) retains TAP output, commands, source diff and identities. ZIP SHA-256: `a08f9dad1374587e4b202b190fa97b897a602522d20888a670d45dd726995c5f`. Earlier baseline and failed-candidate artifacts remain attached to their runs. This result does not establish full-suite, deployment, live-provider, bounty-acceptance or payment status.
