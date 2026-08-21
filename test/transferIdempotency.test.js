'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { store, reset } = require('../src/store');
const transferService = require('../src/services/transferService');
const idempotencyService = require('../src/services/idempotencyService');
const stellarService = require('../src/services/stellarService');
const auditService = require('../src/services/auditService');
const ApiError = require('../src/utils/ApiError');

const ACTOR = 'test-token-admin';
const OTHER_ACTOR = 'test-token-write';

const PAYLOAD = {
  senderName: 'Alice',
  recipientName: 'Bob',
  amount: 100,
  from: 'USD',
  to: 'EUR',
};

/** Build the idempotency context the controller would pass. */
function ctx(key, payload = PAYLOAD, actor = ACTOR) {
  return { actor, key, fingerprint: idempotencyService.fingerprint(payload) };
}

/** Count how many times the provider was asked to move money. */
let providerCalls;
const realSubmitPayment = stellarService.submitPayment;

beforeEach(() => {
  reset();
  providerCalls = 0;
  stellarService.submitPayment = (...args) => {
    providerCalls += 1;
    return realSubmitPayment(...args);
  };
});

afterEach(() => {
  stellarService.submitPayment = realSubmitPayment;
});

/** Audit entries recorded for transfer creation. */
function creationAudits() {
  return auditService.getEntries().filter((e) => e.action === 'transfer.created');
}

// ============================================================================
// The original failure mode
// ============================================================================

test('a retry returns the original transfer instead of creating a second one', () => {
  const first = transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-retry'));
  const second = transferService.createTransfer(PAYLOAD, 'req-2', ctx('k-retry'));

  assert.equal(second.id, first.id);
  assert.deepEqual(second, first);
  assert.equal(store.transfers.size, 1);
});

test('a retry produces exactly one provider command and one audit record', () => {
  transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-once'));
  transferService.createTransfer(PAYLOAD, 'req-2', ctx('k-once'));
  transferService.createTransfer(PAYLOAD, 'req-3', ctx('k-once'));

  // This is the assertion that would have failed before the fix: the provider
  // was called on every attempt, so three retries moved money three times.
  assert.equal(providerCalls, 1);
  assert.equal(creationAudits().length, 1);
});

test('a replay does not recompute the quote, so a moved rate cannot change the answer', () => {
  const first = transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-rate'));
  const rateAtCreation = first.rate;

  const replay = transferService.createTransfer(PAYLOAD, 'req-2', ctx('k-rate'));

  assert.equal(replay.rate, rateAtCreation);
  assert.equal(replay.sendAmount, first.sendAmount);
  assert.equal(replay.receiveAmount, first.receiveAmount);
});

// ============================================================================
// Conflicting reuse
// ============================================================================

test('reusing a key with a different payload fails with 409 and moves no money', () => {
  transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-conflict'));
  const callsAfterFirst = providerCalls;

  assert.throws(
    () =>
      transferService.createTransfer(
        { ...PAYLOAD, amount: 250 },
        'req-2',
        ctx('k-conflict', { ...PAYLOAD, amount: 250 })
      ),
    (err) => err instanceof ApiError && err.statusCode === 409
  );

  assert.equal(providerCalls, callsAfterFirst);
  assert.equal(store.transfers.size, 1);
});

test('the conflict message names the header, so the client knows what to change', () => {
  transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-msg'));

  assert.throws(
    () =>
      transferService.createTransfer(
        { ...PAYLOAD, recipientName: 'Carol' },
        'req-2',
        ctx('k-msg', { ...PAYLOAD, recipientName: 'Carol' })
      ),
    /Idempotency-Key was already used with a different request payload/
  );
});

// ============================================================================
// Canonical fingerprint
// ============================================================================

test('property order does not make a legitimate retry look like a conflict', () => {
  const reordered = {
    to: PAYLOAD.to,
    amount: PAYLOAD.amount,
    senderName: PAYLOAD.senderName,
    from: PAYLOAD.from,
    recipientName: PAYLOAD.recipientName,
  };

  const first = transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-order'));
  const retry = transferService.createTransfer(reordered, 'req-2', ctx('k-order', reordered));

  assert.equal(retry.id, first.id);
  assert.equal(providerCalls, 1);
});

test('two different keys with an identical payload are two deliberate transfers', () => {
  const a = transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-a'));
  const b = transferService.createTransfer(PAYLOAD, 'req-2', ctx('k-b'));

  assert.notEqual(a.id, b.id);
  assert.equal(store.transfers.size, 2);
  assert.equal(providerCalls, 2);
});

// ============================================================================
// Actor scoping
// ============================================================================

test('the same key from a different actor is a separate operation', () => {
  const mine = transferService.createTransfer(PAYLOAD, 'req-1', ctx('shared-key'));
  const theirs = transferService.createTransfer(
    PAYLOAD,
    'req-2',
    ctx('shared-key', PAYLOAD, OTHER_ACTOR)
  );

  // Keys are chosen by clients. Without actor scoping one caller could collide
  // with another's key and be handed back a transfer that is not theirs.
  assert.notEqual(mine.id, theirs.id);
  assert.equal(store.transfers.size, 2);
});

test('one actor cannot read another actor transfer by guessing the key', () => {
  const theirs = transferService.createTransfer(
    PAYLOAD,
    'req-1',
    ctx('guessable', PAYLOAD, OTHER_ACTOR)
  );
  const mine = transferService.createTransfer(PAYLOAD, 'req-2', ctx('guessable'));

  assert.notEqual(mine.id, theirs.id);
});

// ============================================================================
// Concurrency
// ============================================================================

test('a second request arriving while the first is in flight is rejected, not duplicated', () => {
  // The service is synchronous, so two requests cannot interleave on their own.
  // Re-entering from inside the provider call reproduces the exact window the
  // original bug lived in: the first operation has started and has not yet
  // recorded a result. Driving it this way tests the reservation rather than
  // simulating one.
  let reentrantError = null;
  stellarService.submitPayment = (...args) => {
    providerCalls += 1;
    if (reentrantError === null) {
      try {
        transferService.createTransfer(PAYLOAD, 'req-concurrent', ctx('k-race'));
        reentrantError = false;
      } catch (err) {
        reentrantError = err;
      }
    }
    return realSubmitPayment(...args);
  };

  const transfer = transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-race'));

  assert.ok(reentrantError instanceof ApiError, 'the concurrent attempt should have been refused');
  assert.equal(reentrantError.statusCode, 409);
  assert.match(reentrantError.message, /still in progress/i);
  assert.equal(store.transfers.size, 1);
  assert.equal(transfer.id, [...store.transfers.keys()][0]);
  assert.equal(providerCalls, 1);
});

test('a concurrent attempt with a conflicting payload reports the conflict, not the race', () => {
  // Order matters here: reporting "still in progress" for what is really a
  // client bug sends them into a retry loop that can never succeed.
  let seen = null;
  stellarService.submitPayment = (...args) => {
    providerCalls += 1;
    if (seen === null) {
      const other = { ...PAYLOAD, amount: 999 };
      try {
        transferService.createTransfer(other, 'req-x', ctx('k-race2', other));
        seen = false;
      } catch (err) {
        seen = err;
      }
    }
    return realSubmitPayment(...args);
  };

  transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-race2'));

  assert.ok(seen instanceof ApiError);
  assert.match(seen.message, /different request payload/i);
});

// ============================================================================
// Provider failure and retry
// ============================================================================

test('a provider failure releases the key so the client retry can still succeed', () => {
  stellarService.submitPayment = () => {
    providerCalls += 1;
    throw new Error('stellar horizon timed out');
  };

  assert.throws(
    () => transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-fail')),
    /stellar horizon timed out/
  );
  assert.equal(store.transfers.size, 0);

  // Burning the key on failure would be worse than the duplicate it prevents:
  // the client retries correctly, with the same key, and can never win.
  stellarService.submitPayment = (...args) => {
    providerCalls += 1;
    return realSubmitPayment(...args);
  };

  const recovered = transferService.createTransfer(PAYLOAD, 'req-2', ctx('k-fail'));
  assert.ok(recovered.id);
  assert.equal(store.transfers.size, 1);
  assert.equal(creationAudits().length, 1);
});

test('a failed attempt leaves no reservation behind', () => {
  stellarService.submitPayment = () => {
    throw new Error('provider down');
  };

  assert.throws(() => transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-clean')));
  assert.equal(store.idempotency.size, 0);
});

test('a completed key survives a later provider outage', () => {
  const original = transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-durable'));

  stellarService.submitPayment = () => {
    throw new Error('provider down');
  };

  // The replay must not reach the provider at all, so an outage cannot turn a
  // settled transfer into an error for a client that is merely retrying.
  const replay = transferService.createTransfer(PAYLOAD, 'req-2', ctx('k-durable'));
  assert.equal(replay.id, original.id);
});

// ============================================================================
// Restart
// ============================================================================

test('reservations and transfers are cleared together on restart', () => {
  transferService.createTransfer(PAYLOAD, 'req-1', ctx('k-restart'));
  assert.equal(store.idempotency.size, 1);
  assert.equal(store.transfers.size, 1);

  reset();

  // Records live in the same store as the transfers, so their durability is the
  // store's durability. Clearing together is the property that matters: a
  // surviving reservation would replay a transfer that no longer exists, which
  // is worse than losing both.
  assert.equal(store.idempotency.size, 0);
  assert.equal(store.transfers.size, 0);

  const afterRestart = transferService.createTransfer(PAYLOAD, 'req-2', ctx('k-restart'));
  assert.ok(afterRestart.id);
  assert.equal(store.transfers.size, 1);
});

// ============================================================================
// Backwards compatibility of the service entry point
// ============================================================================

test('a call with no idempotency context still creates a transfer', () => {
  // Idempotency is actor-scoped and internal callers have no actor. The HTTP
  // route requires the header, so every request-driven creation is covered.
  const transfer = transferService.createTransfer(PAYLOAD, 'req-1');
  assert.ok(transfer.id);
  assert.equal(store.transfers.size, 1);
  assert.equal(store.idempotency.size, 0);
});

// ============================================================================
// Fingerprint helper
// ============================================================================

test('fingerprint is stable across key order and nesting', () => {
  const a = idempotencyService.fingerprint({ x: 1, y: { b: 2, a: 3 }, z: [1, 2] });
  const b = idempotencyService.fingerprint({ z: [1, 2], y: { a: 3, b: 2 }, x: 1 });
  assert.equal(a, b);
});

test('fingerprint distinguishes array order, which is meaningful', () => {
  const a = idempotencyService.fingerprint({ items: [1, 2] });
  const b = idempotencyService.fingerprint({ items: [2, 1] });
  assert.notEqual(a, b);
});

test('fingerprint treats undefined and null alike so an omitted field is stable', () => {
  const a = idempotencyService.fingerprint({ a: 1, b: undefined });
  const b = idempotencyService.fingerprint({ a: 1, b: null });
  assert.equal(a, b);
});
