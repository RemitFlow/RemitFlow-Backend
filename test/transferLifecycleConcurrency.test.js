'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { store, reset } = require('../src/store');
const transferService = require('../src/services/transferService');
const stellarService = require('../src/services/stellarService');
const settlementWorker = require('../src/services/settlementWorker');
const ApiError = require('../src/utils/ApiError');
const { TRANSFER_STATUS, TRANSFER_TRANSITIONS } = require('../src/config/constants');

const PAYLOAD = {
  senderName: 'Alice',
  recipientName: 'Bob',
  amount: 100,
  from: 'USD',
  to: 'EUR',
};

function lifecycle(key, version, actor = 'test-token-admin') {
  return { actor, key, expectedVersion: version };
}

let settleCalls;
const realSettleClaim = settlementWorker.settleClaim;
const realCreateClaimableBalanceId = stellarService.createClaimableBalanceId;

beforeEach(() => {
  reset();
  settleCalls = 0;
  settlementWorker.settleClaim = (operationId) => {
    settleCalls += 1;
    return realSettleClaim(operationId);
  };
});

afterEach(() => {
  settlementWorker.settleClaim = realSettleClaim;
  stellarService.createClaimableBalanceId = realCreateClaimableBalanceId;
});

// ============================================================================
// State machine
// ============================================================================

test('only transitions listed in TRANSFER_TRANSITIONS may commit', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  assert.equal(transfer.version, 1);
  assert.deepEqual(
    TRANSFER_TRANSITIONS[TRANSFER_STATUS.PENDING],
    [TRANSFER_STATUS.CLAIMED, TRANSFER_STATUS.CANCELLED]
  );
  assert.deepEqual(TRANSFER_TRANSITIONS[TRANSFER_STATUS.CLAIMED], []);
  assert.deepEqual(TRANSFER_TRANSITIONS[TRANSFER_STATUS.CANCELLED], []);

  assert.throws(
    () =>
      transferService.compareAndSetTransition(transfer, {
        expectedVersion: 1,
        nextStatus: 'pending',
      }),
    (err) => err instanceof ApiError && err.statusCode === 409
  );
});

test('compareAndSetTransition rejects a stale expected version without mutating', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  transferService.claimTransfer(transfer.id, 'req', lifecycle('claim-v', 1));

  assert.throws(
    () =>
      transferService.compareAndSetTransition(store.transfers.get(transfer.id), {
        expectedVersion: 1,
        nextStatus: TRANSFER_STATUS.CANCELLED,
      }),
    (err) =>
      err instanceof ApiError
      && err.statusCode === 409
      && err.details.actualVersion === 2
  );

  assert.equal(store.transfers.get(transfer.id).status, 'claimed');
  assert.equal(store.transfers.get(transfer.id).version, 2);
});

// ============================================================================
// One terminal outcome / race
// ============================================================================

test('one terminal outcome wins when claim and cancel race from the same version', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const claimed = transferService.claimTransfer(
    transfer.id,
    'req-claim',
    lifecycle('race-claim', transfer.version)
  );

  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.version, 2);

  assert.throws(
    () =>
      transferService.cancelTransfer(
        transfer.id,
        'req-cancel',
        lifecycle('race-cancel', 1)
      ),
    (err) =>
      err instanceof ApiError
      && err.statusCode === 409
      && err.details.actualVersion === 2
  );

  assert.equal(store.transfers.get(transfer.id).status, 'claimed');
  assert.equal(store.transfers.get(transfer.id).version, 2);
});

test('reentrant cancel during claim prepare loses; only one terminal outcome commits', () => {
  // Reproduce the original failure window: a competing mutation arrives while
  // the first operation has reserved work but has not yet committed.
  const transfer = transferService.createTransfer(PAYLOAD);
  let nestedError = null;

  settlementWorker.settleClaim = (operationId) => {
    settleCalls += 1;
    try {
      transferService.cancelTransfer(
        transfer.id,
        'req-nested-cancel',
        lifecycle('nested-cancel', 1)
      );
      nestedError = false;
    } catch (err) {
      nestedError = err;
    }
    return realSettleClaim(operationId);
  };

  const claimed = transferService.claimTransfer(
    transfer.id,
    'req-claim',
    lifecycle('outer-claim', 1)
  );

  assert.ok(nestedError instanceof ApiError, 'nested cancel must be refused');
  assert.equal(nestedError.statusCode, 409);
  assert.match(nestedError.message, /already in progress|version conflict/i);
  assert.equal(claimed.status, 'claimed');
  assert.equal(store.transfers.get(transfer.id).status, 'claimed');
  assert.equal(store.transfers.get(transfer.id).version, 2);
  assert.equal(settleCalls, 1);
});

test('two concurrent claim keys cannot double-settle the same transfer', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  let nestedError = null;

  settlementWorker.settleClaim = (operationId) => {
    settleCalls += 1;
    if (settleCalls === 1) {
      try {
        transferService.claimTransfer(
          transfer.id,
          'req-other',
          lifecycle('other-claim-key', 1)
        );
        nestedError = false;
      } catch (err) {
        nestedError = err;
      }
    }
    return realSettleClaim(operationId);
  };

  const first = transferService.claimTransfer(
    transfer.id,
    'req-1',
    lifecycle('first-claim-key', 1)
  );

  assert.ok(nestedError instanceof ApiError);
  assert.equal(nestedError.statusCode, 409);
  assert.match(nestedError.message, /already in progress/i);
  assert.equal(first.status, 'claimed');
  assert.equal(settleCalls, 1, 'provider settlement must run exactly once');
  assert.equal(store.settlementReceipts.size, 1);
  assert.equal(store.transfers.get(transfer.id).claimableBalanceId, first.claimableBalanceId);
});

// ============================================================================
// Duplicate callback / idempotency
// ============================================================================

test('duplicate claim callback replays the first provider artifact', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const ctx = lifecycle('provider-callback-42', transfer.version);

  const first = transferService.claimTransfer(transfer.id, 'req-1', ctx);
  const duplicate = transferService.claimTransfer(transfer.id, 'req-2', ctx);

  assert.deepEqual(duplicate, first);
  assert.equal(duplicate.claimableBalanceId, first.claimableBalanceId);
  assert.equal(store.transfers.get(transfer.id).version, 2);
  assert.equal(settleCalls, 1);
});

test('a new claim key after terminal success cannot settle twice', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const first = transferService.claimTransfer(
    transfer.id,
    'req-1',
    lifecycle('claim-once', 1)
  );

  assert.throws(
    () =>
      transferService.claimTransfer(
        transfer.id,
        'req-2',
        lifecycle('claim-again', 2)
      ),
    (err) =>
      err instanceof ApiError
      && err.statusCode === 409
      && /Cannot change transfer from claimed/.test(err.message)
  );

  assert.equal(settleCalls, 1);
  assert.equal(store.transfers.get(transfer.id).claimableBalanceId, first.claimableBalanceId);
});

// ============================================================================
// Worker restart
// ============================================================================

test('settlement worker reload keeps shared receipts and lifecycle replay', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const ctx = lifecycle('worker-restart', transfer.version);
  const first = transferService.claimTransfer(transfer.id, 'req-1', ctx);
  const operationId = first.settlementOperationId;

  delete require.cache[require.resolve('../src/services/settlementWorker')];
  delete require.cache[require.resolve('../src/services/transferService')];
  const restartedWorker = require('../src/services/settlementWorker');
  const restartedService = require('../src/services/transferService');

  const receipt = restartedWorker.settleClaim(operationId);
  assert.equal(receipt.claimableBalanceId, first.claimableBalanceId);

  const retry = restartedService.claimTransfer(transfer.id, 'req-2', ctx);
  assert.deepEqual(retry, first);
  assert.equal(store.transfers.get(transfer.id).version, 2);
});

// ============================================================================
// Rollback / provider failure
// ============================================================================

test('provider failure rolls back before terminal commit and releases retry reservation', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const ctx = lifecycle('provider-failure', transfer.version);

  settlementWorker.settleClaim = () => {
    settleCalls += 1;
    throw new Error('provider unavailable');
  };

  assert.throws(
    () => transferService.claimTransfer(transfer.id, 'req-1', ctx),
    /provider unavailable/
  );

  const afterFailure = store.transfers.get(transfer.id);
  assert.equal(afterFailure.status, 'pending');
  assert.equal(afterFailure.version, 1);
  assert.equal(store.lifecycleIdempotency.size, 0);
  assert.equal(store.lifecycleLeases.size, 0);
  assert.equal(store.settlementReceipts.size, 0);

  settlementWorker.settleClaim = (operationId) => {
    settleCalls += 1;
    return realSettleClaim(operationId);
  };
  const recovered = transferService.claimTransfer(transfer.id, 'req-2', ctx);
  assert.equal(recovered.status, 'claimed');
  assert.equal(recovered.version, 2);
});

test('provider operation ids are opaque and collision-safe for actor/key delimiters', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const observed = [];

  settlementWorker.settleClaim = (operationId) => {
    settleCalls += 1;
    observed.push(operationId);
    throw new Error('provider unavailable');
  };

  const attempts = [
    lifecycle('c', transfer.version, 'a:b'),
    lifecycle('b:c', transfer.version, 'a'),
    lifecycle('c', transfer.version, 'a:b'),
  ];
  for (const ctx of attempts) {
    assert.throws(
      () => transferService.claimTransfer(transfer.id, 'provider-failure', ctx),
      /provider unavailable/
    );
  }

  assert.equal(observed.length, 3);
  assert.notEqual(observed[0], observed[1], 'distinct actor/key tuples must not collide');
  assert.equal(observed[0], observed[2], 'an exact retry must reuse the provider key');
  for (const operationId of observed) {
    assert.match(operationId, /^settlement_[0-9a-f]{64}$/);
    assert.ok(!operationId.includes('a:b'));
    assert.ok(!operationId.includes('b:c'));
  }
  assert.equal(store.transfers.get(transfer.id).status, 'pending');
  assert.equal(store.transfers.get(transfer.id).version, 1);
  assert.equal(store.lifecycleIdempotency.size, 0);
  assert.equal(store.lifecycleLeases.size, 0);
});

test('successful claim does not expose bearer token or idempotency key in settlementOperationId', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const actor = 'secret:bearer-token';
  const key = 'client:retry:key';

  const claimed = transferService.claimTransfer(
    transfer.id,
    'opaque-operation-id',
    lifecycle(key, transfer.version, actor)
  );

  assert.match(claimed.settlementOperationId, /^settlement_[0-9a-f]{64}$/);
  assert.ok(!claimed.settlementOperationId.includes(actor));
  assert.ok(!claimed.settlementOperationId.includes(key));
  assert.equal(settleCalls, 1);
});

test('completed cancellation is idempotent and cannot be overwritten', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const ctx = lifecycle('cancel-once', transfer.version);
  const first = transferService.cancelTransfer(transfer.id, 'req-1', ctx);
  const retry = transferService.cancelTransfer(transfer.id, 'req-2', ctx);

  assert.deepEqual(retry, first);
  assert.equal(first.status, 'cancelled');

  assert.throws(
    () =>
      transferService.claimTransfer(
        transfer.id,
        'req-3',
        lifecycle('claim-after-cancel', 1)
      ),
    (err) => err instanceof ApiError && err.statusCode === 409
  );
});

// ============================================================================
// Archive version bump vs stale lifecycle
// ============================================================================

test('archive advances version so a stale claim cannot silently commit', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  transferService.archiveTransfer(transfer.id);
  assert.equal(store.transfers.get(transfer.id).version, 2);

  assert.throws(
    () =>
      transferService.claimTransfer(
        transfer.id,
        'req-stale',
        lifecycle('stale-after-archive', 1)
      ),
    (err) =>
      err instanceof ApiError
      && err.statusCode === 409
      && err.details.actualVersion === 2
  );

  assert.equal(store.transfers.get(transfer.id).status, 'pending');
  assert.equal(settleCalls, 0);
});

// ============================================================================
// Backwards compatibility for internal callers
// ============================================================================

test('claimTransfer without lifecycle context still works for internal callers', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const claimed = transferService.claimTransfer(transfer.id, 'internal-req');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.version, 2);
  assert.equal(transfer.status, 'claimed');
});
