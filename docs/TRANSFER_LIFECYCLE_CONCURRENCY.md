# Transfer lifecycle concurrency

Transfer creation already uses actor-scoped idempotency. Terminal lifecycle
mutations (claim / cancel) add optimistic resource versions, a per-transfer
lease, and an idempotent settlement worker.

## Client contract

Every single-transfer response carries an ETag containing the integer transfer
version, for example:

    ETag: "1"

To claim or cancel a transfer, clients send both:

    If-Match: "1"
    Idempotency-Key: <stable operation key>

The server reserves the actor/key pair before provider work. A repeated request
with the same key replays the first terminal result. A request based on an old
version returns HTTP 409 with expected version, actual version, and current
status. A missing If-Match returns HTTP 428. Invalid state transitions also
return 409.

Creation starts at version 1. Every lifecycle, archive, or unarchive mutation
increments the version.

## Commit order

Terminal mutations follow this order:

1. reserve the actor-scoped operation key;
2. acquire an exclusive per-transfer lifecycle lease;
3. compare expected version and allowed transition;
4. prepare the provider-side artifact via the settlement worker (stable
   operation key);
5. compare-and-set status + version (single commit path);
6. complete the replay receipt and append the audit event;
7. release the lease.

A provider failure occurs before the local terminal commit, so the transfer
remains pending and both the lease and reservation are released for a safe
retry. The lease is what closes the double-settlement window when two different
operation keys race: only one caller may prepare provider work for a given
transfer at a time.

## Storage boundary

The current demo store is process-local. Version check plus mutation is a
compare-and-set within this process. When the store moves to a database,
preserve the contract atomically with an update constrained by transfer id and
version, and move lifecycle idempotency, leases, and settlement receipts to the
same durable/shared boundary so multiple workers share reservation and replay
state.

Regression coverage lives in `test/transferLifecycleConcurrency.test.js` and
`test/transferLifecycleHttp.test.js`.
