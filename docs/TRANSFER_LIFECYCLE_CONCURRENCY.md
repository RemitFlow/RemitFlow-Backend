# Transfer lifecycle concurrency

Transfer creation already uses actor-scoped idempotency. Terminal lifecycle
mutations now add optimistic resource versions.

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
2. compare expected version and allowed transition;
3. prepare the provider-side artifact with a stable provider operation key;
4. re-check observed status and version;
5. commit status, version, provider result, and replay receipt;
6. append the audit event.

A provider failure occurs before the local terminal commit, so the transfer
remains pending and the reservation is released for a safe retry. The mock
Stellar adapter models provider-side idempotency by remembering operation
receipts independently from application transfer state.

## Storage boundary

The current demo store is process-local. Its mutation is synchronous, so the
version check plus mutation is a compare-and-set within this process. When the
store moves to a database, preserve the contract atomically with an update
constrained by transfer id and version, and move lifecycle idempotency records
to the same durable/shared boundary so multiple workers share reservation and
replay state.

The regression source in test/transferLifecycleConcurrency.test.js covers the
state-machine race, duplicate provider callback, service-worker reload,
provider rollback/retry, and one-terminal-outcome behavior.
