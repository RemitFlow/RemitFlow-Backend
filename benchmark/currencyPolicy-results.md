# Exact currency arithmetic throughput

The decimal ratio helper now converts safe integer Numbers directly to BigInt
numerators with a denominator of one. Those values already have an exact
integer representation. This avoids decimal-string allocation, regular-expression
matching and power-of-ten construction for the identity factors, percentage
divisor, whole-currency amounts and integer readbacks used during rounding.

All strings still use the existing decimal grammar. Unsafe integer Numbers,
fractional values, non-finite values, division by zero, tie handling, supported
currency checks and exact decimal readback retain the previous path. No cache,
currency table, fee, rate or API contract was changed.

## Measurement

Baseline product source: `b685aaeab819de52af02ebcfc0009703c141af13`.
The subsequent `731294140d2a2a8c187c17ee49c2422e383659a5` changes only the
README and is preserved by this continuation.

Node.js v24.19.0 on an AMD EPYC 9V74 in a shared Linux cloud environment.
Each result uses seven paired batches, alternating execution order, after
warmup. Both versions receive the same inputs and iteration counts. Rates
below come from the median duration, with complete samples in
[currencyPolicy-results.json](currencyPolicy-results.json).

| Actual production call | Baseline calls/s | Changed calls/s | Measured throughput change |
| --- | ---: | ---: | ---: |
| USD minor-unit rounding | 744,647 | 824,744 | +10.8% |
| USD/EUR `getQuote` | 123,376 | 128,129 | +3.9% |
| JPY/USD `getQuote` | 120,332 | 233,243 | +93.8% |

The larger JPY gain reflects whole-unit amounts and fees reaching the integer
path repeatedly. The small USD/EUR difference should not be generalized from
one environment. Timing outliers remain in the raw batches.

## Compatibility and scope

Before timing, the command compared exact returned values and error names and
messages across rounding ties, explicit and absent factors, null defaults,
string decimals, an invalid hexadecimal factor, non-finite input, a zero
divisor, safe-integer limits, unsafe-integer factors and decimal readback
rejection. It also compared every returned field of both measured quote
workloads and all rounding inputs. Any mismatch exits nonzero.

The command executes the real currency policy, quote service, rate service,
configuration and error helper from the two source trees. Fee configuration
is fixed to 1.5 percent plus 0.3 source units and a 50,000 source-unit transfer
ceiling for reproducibility. The original static demo FX table is unchanged.
The local runtime used upstream dotenv v16.6.1 source, matching the lockfile's
version. No dependency manifest or lockfile was changed.

These results measure synchronous production service calls in process. They
exclude Express, HTTP, authorization, provider latency and live Stellar
settlement. Existing unrelated checks were not repeated; this is not a new
full-suite or hosted-CI result.

## Reproduce

Provide a source checkout of the pinned baseline with its normal dependencies:

```sh
node benchmark/currencyPolicy.js /path/to/baseline-checkout
```

The command runs the current checkout as the candidate, validates parity,
then prints JSON with source hashes and all measured batches. The captured
baseline file had one additional trailing newline; its measured hash and the
exact repository hash are recorded separately in the results.
