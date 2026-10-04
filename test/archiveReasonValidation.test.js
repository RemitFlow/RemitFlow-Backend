'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const transferService = require('../src/services/transferService');
const errorHandler = require('../src/middleware/errorHandler');
const ApiError = require('../src/utils/ApiError');

const absentTransferId = 'archive-reason-validation-absent-transfer';
const actions = ['archiveTransfer', 'unarchiveTransfer'];

test('archive and unarchive reject structured reasons before transfer lookup', () => {
  for (const action of actions) {
    for (const reason of [{}, [], ['retention'], { toString: null }, { toString: [], valueOf: false }]) {
      assert.throws(
        () => transferService[action](absentTransferId, { reason }),
        error => error instanceof ApiError && error.statusCode === 400 && /reason/.test(error.message),
        action + ': structured reason must be an input error',
      );
    }
  }
});

test('existing scalar reasons continue through normalization to transfer lookup', () => {
  for (const action of actions) {
    for (const reason of [undefined, null, '', 'retention review', 0, 7, false, true]) {
      assert.throws(
        () => transferService[action](absentTransferId, { reason }),
        error => error instanceof ApiError && error.statusCode === 404,
        action + ': scalar reason must retain the missing-transfer result',
      );
    }
  }
});

test('malformed JSON reason renders a validation envelope instead of an internal error', () => {
  for (const action of actions) {
    let error;
    try {
      transferService[action](absentTransferId, { reason: JSON.parse('{"toString":null}') });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    let status;
    let body;
    const response = {
      status(value) { status = value; return this; },
      json(value) { body = value; return this; },
    };
    errorHandler(error, {
      id: 'archive-reason-regression',
      method: 'POST',
      originalUrl: '/api/transfers/' + absentTransferId + '/' + action,
    }, response, () => assert.fail('error handler must finish the response'));
    assert.equal(status, 400);
    assert.equal(body.error.status, 400);
    assert.equal(body.error.requestId, 'archive-reason-regression');
    assert.match(body.error.message, /reason/);
  }
});
