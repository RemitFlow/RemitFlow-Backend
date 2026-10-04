'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.MAX_TRANSFER_AMOUNT = '1000000000000';
process.env.TRANSFER_FEE_PERCENT = '1.5';
process.env.TRANSFER_FEE_FLAT = '0.3';
process.env.ERROR_TRACKING_ENABLED = 'false';

const currencyPolicy = require('../src/utils/currencyPolicy');
const quoteService = require('../src/services/quoteService');
const transferService = require('../src/services/transferService');
const stellarService = require('../src/services/stellarService');
const idempotencyService = require('../src/services/idempotencyService');
const auditService = require('../src/services/auditService');
const errorHandler = require('../src/middleware/errorHandler');
const ApiError = require('../src/utils/ApiError');
const { store, reset } = require('../src/store');

test('destination overflow returns 400 without settlement or a burned idempotency key', (t) => {
  reset();
  t.after(reset);
  // The production settlement adapter is local/mock; retain its real behavior.
  const settlement = t.mock.method(stellarService, 'submitPayment');
  const data = {
    senderName: 'Sender',
    recipientName: 'Recipient',
    amount: 1000000000000,
    from: 'USD',
    to: 'NGN',
  };
  const context = {
    actor: 'overflow-test',
    key: 'retry-after-overflow',
    fingerprint: idempotencyService.fingerprint(data),
  };
  assert.equal(currencyPolicy.canonicalizeAmount(data.amount, data.from, {
    enforceMax: true,
  }).ok, true, 'the send amount is valid; only the converted destination overflows');

  for (const operation of [
    () => quoteService.getQuote(data.amount, data.from, data.to),
    () => transferService.createTransfer(data, 'overflow-request', context),
  ]) {
    assert.throws(operation, (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 400);
      const response = {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      errorHandler(err, { id: 'overflow-request' }, response, () => {});
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error.status, 400);
      assert.equal(response.body.error.message, err.message);
      assert.equal(response.body.error.requestId, 'overflow-request');
      return true;
    });
  }

  assert.equal(settlement.mock.callCount(), 0);
  assert.equal(store.transfers.size, 0);
  assert.equal(store.transferIndex.size, 0);
  assert.equal(store.idempotency.size, 0);
  assert.equal(auditService.countEntries(), 0);

  const corrected = { ...data, amount: 50000 };
  const retryContext = {
    ...context,
    fingerprint: idempotencyService.fingerprint(corrected),
  };
  const transfer = transferService.createTransfer(corrected, 'retry-request', retryContext);
  assert.equal(transfer.receiveAmount, 75768769.23);
  assert.equal(transfer.sendAmount, 50000);
  assert.equal(transfer.status, 'pending');
  assert.equal(settlement.mock.callCount(), 1);
  assert.equal(store.transfers.size, 1);
  assert.equal(store.transferIndex.size, 1);
  assert.equal(store.idempotency.size, 1);
  assert.equal(auditService.countEntries(), 1);
  assert.equal(
    transferService.createTransfer(corrected, 'replay-request', retryContext),
    transfer,
  );
  assert.equal(settlement.mock.callCount(), 1, 'a replay does not settle a second time');
});
