# Readiness timer range — 4 October 2026

Continuation of RemitFlow-Backend PR 140 / issue 134 on the original branch.

## Behavior

An overflowing configured delay or an infinite override previously reached Node's
`setTimeout`. Node replaces delays above 2,147,483,647 milliseconds with one
millisecond, so a healthy asynchronous dependency could incorrectly time out.
The returned `timeoutMs` also failed to describe the effective timer.

The service now normalizes configured budgets, readiness overrides and direct
`runCheck` arguments. Invalid overrides fall back to the configured valid budget;
an invalid configured budget falls back to the existing 1,000-millisecond default.
Positive supported values retain Node's integer truncation and one-millisecond
minimum. The supported maximum remains valid. Probe sharing, release, adapter
identity, reason codes and timeout recovery are unchanged.

Node timer contract: https://nodejs.org/api/timers.html#settimeoutcallback-delay-args

## Focused execution

Node.js v22.16.0, Linux x64. Exactly the same three maintained cases were run
against the original and changed complete service source, with the unchanged
complete `inFlightProbe.js`. The baseline failed all three cases and emitted
`TimeoutOverflowWarning`; the changed source passed all three with no failures,
skips, cancellations or overflow warning. No full suite or build was run.

The cases cover configured overflow, override fallback, reported integer budgets,
the maximum supported delay, the direct-call path, a genuine short timeout and
recovery after completion. Healthy probes use actual Node timers, not a fake clock.

Execution used a task-local CommonJS preload providing four explicit collaborator
modules: mutable health config, two empty store maps and unused payment/FX ping
adapters. The maintained test replaces probes through the service's existing test
hook. The real service, promise race, timer handling and probe pool ran unchanged
between the two executions except for the timeout-normalization patch. This is
source-level service execution, not HTTP routing, live dependencies or full-app CI.
In a regular checkout with its dependencies installed, run:

```sh
node --test test/dependencyHealthTimerRange.test.js
```

| Source | Git blob |
| --- | --- |
| Baseline service at `4fd4284ccead15abede008a95779c680aab2682b` | `f1d574ff23df4440aa350ca57ace9df51b88080b` |
| Changed complete service | `7cc1334e9cf79ccdf621ad59b6b015480e10c45c` |
| Unchanged complete probe pool | `5dfabe9ed6437b00e336b0eb8e3dca58e9bc5279` |
| Three-case maintained regression | `329dd0c28acaf5ca71f0bd5474204b167b547ca9` |

The downloaded earlier dependency artifact was not needed or executed for this
bounded run. Historical test results retain their original source pins; this
continuation makes no deployment, maintainer acceptance, award or payment claim.
