'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const createApp = require('../src/app');
const { reset } = require('../src/store');
const transfers = require('../src/services/transferService');
const stellar = require('../src/services/stellarService');
const ApiError = require('../src/utils/ApiError');
const payload = { senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' };
const original = stellar.createClaimableBalanceId;
const secret = 'synthetic-provider-secret@db.invalid';
let server;
let origin;

before(() => new Promise(resolve => {
  server = createApp().listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
beforeEach(() => reset());
afterEach(() => { stellar.createClaimableBalanceId = original; });

async function request(path, body, token = 'test-token-admin') {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const failures = [
  ['ordinary provider error', () => new Error(secret)],
  ['provider object claiming forbidden status', () => Object.assign(new Error(secret), { statusCode: 403 })],
  ['provider object claiming successful status', () => Object.assign(new Error(secret), { statusCode: 200 })],
  ['null rejection', () => null],
  ['string rejection', () => secret],
];

for (const [name, failure] of failures) {
  test(`bulk hides ${name} and continues independent rows`, async () => {
    const first = transfers.createTransfer(payload);
    const second = transfers.createTransfer(payload);
    let calls = 0;
    stellar.createClaimableBalanceId = (...args) => {
      calls += 1;
      if (calls === 1) throw failure();
      return original(...args);
    };
    const result = await request('/api/transfers/bulk', { action: 'claim', ids: [first.id, second.id] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.results.length, 2);
    assert.deepEqual(result.body.results[0].error, {
      code: 'error', status: 500, message: 'Internal server error',
    });
    assert.equal(result.body.results[0].ok, false);
    assert.equal(result.body.results[1].ok, true);
    assert.equal(result.body.results[1].transfer.status, 'claimed');
    assert.equal(calls, 2);
    assert.equal(JSON.stringify(result.body).includes(secret), false);
  });
}

test('expected ApiError conflict keeps its intentional public message', async () => {
  const transfer = transfers.createTransfer(payload);
  stellar.createClaimableBalanceId = () => { throw ApiError.conflict('Settlement is already pending'); };
  const result = await request('/api/transfers/bulk', { action: 'claim', ids: [transfer.id] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.results[0].error, {
    code: 'conflict', status: 409, message: 'Settlement is already pending',
  });
});

test('scope denial happens before any provider invocation', async () => {
  const transfer = transfers.createTransfer(payload);
  let calls = 0;
  stellar.createClaimableBalanceId = () => { calls += 1; throw new Error(secret); };
  const result = await request('/api/transfers/bulk', { action: 'claim', ids: [transfer.id] }, 'test-token-readonly');
  assert.equal(result.status, 403);
  assert.equal(result.body.error.message, 'Insufficient token scopes');
  assert.equal(calls, 0);
  assert.equal(transfer.status, 'pending');
});

test('bulk uses the same unexpected-error message as the single-item route', async () => {
  const direct = transfers.createTransfer(payload);
  const bulk = transfers.createTransfer(payload);
  stellar.createClaimableBalanceId = () => { throw new Error(secret); };
  const one = await request(`/api/transfers/${direct.id}/claim`);
  const many = await request('/api/transfers/bulk', { action: 'claim', ids: [bulk.id] });
  assert.equal(one.status, 500);
  assert.equal(many.status, 200);
  assert.equal(many.body.results[0].error.status, one.body.error.status);
  assert.equal(many.body.results[0].error.message, one.body.error.message);
  assert.equal(one.body.error.message, 'Internal server error');
});
