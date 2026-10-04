'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { store, reset } = require('../src/store');
const transfers = require('../src/services/transferService');
const worker = require('../src/services/settlementWorker');
const ApiError = require('../src/utils/ApiError');

const payload = { senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' };
const realSettle = worker.settleClaim;
const context = (key, expectedVersion) => ({ actor: 'archive-race-test', key, expectedVersion });

beforeEach(() => reset());
afterEach(() => { worker.settleClaim = realSettle; });

for (const action of ['archive', 'unarchive']) {
  test(`${action} cannot invalidate a prepared settlement or allow a second claim key`, () => {
    const transfer = transfers.createTransfer(payload);
    if (action === 'unarchive') transfers.archiveTransfer(transfer.id);
    const originalArchive = transfer.archivedAt;
    const version = transfer.version;
    let competingError;
    let providerCalls = 0;
    worker.settleClaim = (operationId) => {
      providerCalls += 1;
      const receipt = realSettle(operationId);
      try {
        transfers[`${action}Transfer`](transfer.id);
      } catch (error) {
        competingError = error;
      }
      return receipt;
    };

    const ctx = context(`claim-${action}`, version);
    const claimed = transfers.claimTransfer(transfer.id, 'claim', ctx);
    assert.ok(competingError instanceof ApiError);
    assert.equal(competingError.statusCode, 409);
    assert.equal(competingError.details.heldAction, 'claim');
    assert.equal(competingError.details.requestedAction, action);
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.version, version + 1);
    assert.equal(claimed.archivedAt, originalArchive);
    assert.deepEqual(transfers.claimTransfer(transfer.id, 'retry', ctx), claimed);
    assert.throws(
      () => transfers.claimTransfer(transfer.id, 'other', context('different-key', claimed.version)),
      error => error instanceof ApiError && error.statusCode === 409
    );
    assert.equal(providerCalls, 1);
    assert.equal(store.settlementReceipts.size, 1);
    assert.equal(store.lifecycleLeases.size, 0);
    assert.equal(store.lifecycleIdempotency.size, 1);
    // The archive operation is available again after settlement releases its lease.
    transfers[`${action}Transfer`](transfer.id);
    assert.equal(transfer.version, version + 2);
    assert.equal(transfer.status, 'claimed');
  });
}

test('idempotent re-archive remains a no-op during settlement', () => {
  const transfer = transfers.createTransfer(payload);
  transfers.archiveTransfer(transfer.id);
  const archivedAt = transfer.archivedAt;
  worker.settleClaim = operationId => {
    assert.equal(transfers.archiveTransfer(transfer.id), transfer);
    assert.equal(transfer.version, 2);
    return realSettle(operationId);
  };
  const result = transfers.claimTransfer(transfer.id, 'claim', context('archived-noop', 2));
  assert.equal(result.status, 'claimed');
  assert.equal(result.version, 3);
  assert.equal(result.archivedAt, archivedAt);
});

test('a lease on one transfer does not block another transfer archive', () => {
  const transfer = transfers.createTransfer(payload);
  const other = transfers.createTransfer(payload);
  worker.settleClaim = operationId => {
    transfers.archiveTransfer(other.id);
    return realSettle(operationId);
  };
  const result = transfers.claimTransfer(transfer.id, 'claim', context('independent-transfer', 1));
  assert.equal(result.status, 'claimed');
  assert.equal(other.status, 'pending');
  assert.equal(other.version, 2);
  assert.ok(other.archivedAt);
});

test('failed settlement releases the lease for archive and unarchive', () => {
  const transfer = transfers.createTransfer(payload);
  worker.settleClaim = () => { throw new Error('provider unavailable'); };
  assert.throws(
    () => transfers.claimTransfer(transfer.id, 'claim', context('failed-provider', 1)),
    /provider unavailable/
  );
  assert.equal(store.lifecycleLeases.size, 0);
  assert.equal(store.lifecycleIdempotency.size, 0);
  assert.equal(store.settlementReceipts.size, 0);
  transfers.archiveTransfer(transfer.id);
  transfers.unarchiveTransfer(transfer.id);
  assert.equal(transfer.status, 'pending');
  assert.equal(transfer.version, 3);
  assert.equal(transfer.archivedAt, null);
});
