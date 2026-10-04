'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { reset } = require('../src/store');
const transfers = require('../src/services/transferService');
const audit = require('../src/services/auditService');
const stellar = require('../src/services/stellarService');

const payload = { senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' };
const writeAuth = { scopes: ['transfers:write'] };
const readAuth = { scopes: ['transfers:read'] };
const originalClaim = stellar.createClaimableBalanceId;

beforeEach(() => reset());
afterEach(() => { stellar.createClaimableBalanceId = originalClaim; });

test('direct failed claim preserves the pending record and can be retried with write scope', () => {
  const transfer = transfers.createTransfer(payload, undefined, undefined, writeAuth);
  const before = structuredClone(transfer);
  const failure = new Error('controlled adapter failure');
  let calls = 0;
  stellar.createClaimableBalanceId = () => { calls += 1; throw failure; };

  assert.throws(() => transfers.claimTransfer(transfer.id, 'failed-claim', writeAuth), error => error === failure);
  assert.deepEqual(transfer, before);
  assert.equal(audit.getEntriesForResource(transfer.id).filter(entry => entry.action === 'transfer.claimed').length, 0);

  stellar.createClaimableBalanceId = (...args) => { calls += 1; return originalClaim(...args); };
  const recovered = transfers.claimTransfer(transfer.id, 'retry-claim', writeAuth);
  assert.equal(recovered, transfer);
  assert.equal(recovered.status, 'claimed');
  assert.equal(typeof recovered.claimableBalanceId, 'string');
  assert.ok(recovered.updatedAt > before.updatedAt);
  assert.equal(audit.getEntriesForResource(transfer.id).filter(entry => entry.action === 'transfer.claimed').length, 1);
  assert.equal(calls, 2);

  assert.throws(() => transfers.claimTransfer(transfer.id, 'already-claimed', writeAuth), error => error.statusCode === 409);
  assert.throws(() => transfers.claimTransfer(transfer.id, 'under-scoped', readAuth), error => error.statusCode === 403);
  assert.equal(calls, 2);
});

test('bulk failed claim stays retryable while successful independent rows remain committed', () => {
  const first = transfers.createTransfer(payload, undefined, undefined, writeAuth);
  const second = transfers.createTransfer(payload, undefined, undefined, writeAuth);
  const before = structuredClone(first);
  let calls = 0;
  stellar.createClaimableBalanceId = (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('private adapter detail');
    return originalClaim(...args);
  };

  const batch = transfers.bulkMutate('claim', [first.id, second.id], 'bulk-claim', writeAuth);
  assert.deepEqual(batch.results[0].error, { code: 'error', status: 500, message: 'Internal server error' });
  assert.equal(batch.results[0].ok, false);
  assert.equal(batch.results[1].ok, true);
  assert.equal(second.status, 'claimed');
  assert.deepEqual(first, before);
  assert.equal(calls, 2);

  const retried = transfers.bulkMutate('claim', [first.id], 'bulk-retry', writeAuth);
  assert.equal(retried.results[0].ok, true);
  assert.equal(first.status, 'claimed');
  assert.equal(calls, 3);
  const terminal = transfers.bulkMutate('claim', [first.id, second.id], 'bulk-terminal', writeAuth);
  assert.ok(terminal.results.every(row => !row.ok && row.error.status === 409));
  assert.throws(() => transfers.bulkMutate('claim', [first.id], 'bulk-under-scoped', readAuth), error => error.statusCode === 403);
  assert.equal(calls, 3);
});
