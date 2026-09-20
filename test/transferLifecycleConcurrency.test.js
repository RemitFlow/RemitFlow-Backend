'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { store, reset } = require('../src/store');
const transferService = require('../src/services/transferService');
const stellarService = require('../src/services/stellarService');
const ApiError = require('../src/utils/ApiError');

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

beforeEach(() => {
  reset();
});

const realCreateClaimableBalanceId = stellarService.createClaimableBalanceId;
afterEach(() => {
  stellarService.createClaimableBalanceId = realCreateClaimableBalanceId;
});

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
    () => transferService.cancelTransfer(
      transfer.id,
      'req-cancel',
      lifecycle('race-cancel', 1)
    ),
    (err) => err instanceof ApiError
      && err.statusCode === 409
      && err.details.actualVersion === 2
  );

  assert.equal(store.transfers.get(transfer.id).status, 'claimed');
  assert.equal(store.transfers.get(transfer.id).version, 2);
});

test('duplicate claim callback replays the first provider artifact', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const ctx = lifecycle('provider-callback-42', transfer.version);

  const first = transferService.claimTransfer(transfer.id, 'req-1', ctx);
  const duplicate = transferService.claimTransfer(transfer.id, 'req-2', ctx);

  assert.deepEqual(duplicate, first);
  assert.equal(duplicate.claimableBalanceId, first.claimableBalanceId);
  assert.equal(store.transfers.get(transfer.id).version, 2);
});

test('service-worker reload keeps the shared operation receipt replayable', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const ctx = lifecycle('worker-restart', transfer.version);
  const first = transferService.claimTransfer(transfer.id, 'req-1', ctx);

  delete require.cache[require.resolve('../src/services/transferService')];
  const restartedService = require('../src/services/transferService');
  const retry = restartedService.claimTransfer(transfer.id, 'req-2', ctx);

  assert.deepEqual(retry, first);
  assert.equal(store.transfers.get(transfer.id).version, 2);
});

test('provider failure rolls back before terminal commit and releases retry reservation', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const ctx = lifecycle('provider-failure', transfer.version);

  stellarService.createClaimableBalanceId = () => {
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

  stellarService.createClaimableBalanceId = realCreateClaimableBalanceId;
  const recovered = transferService.claimTransfer(transfer.id, 'req-2', ctx);
  assert.equal(recovered.status, 'claimed');
  assert.equal(recovered.version, 2);
});

test('completed cancellation is idempotent and cannot be overwritten', () => {
  const transfer = transferService.createTransfer(PAYLOAD);
  const ctx = lifecycle('cancel-once', transfer.version);
  const first = transferService.cancelTransfer(transfer.id, 'req-1', ctx);
  const retry = transferService.cancelTransfer(transfer.id, 'req-2', ctx);

  assert.deepEqual(retry, first);
  assert.equal(first.status, 'cancelled');

  assert.throws(
    () => transferService.claimTransfer(
      transfer.id,
      'req-3',
      lifecycle('claim-after-cancel', 1)
    ),
    (err) => err instanceof ApiError && err.statusCode === 409
  );
});
