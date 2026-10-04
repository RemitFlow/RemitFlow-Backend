'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const createApp = require('../src/app');
const { store, reset } = require('../src/store');

let server;
let baseUrl;

before(() => {
  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) {
    server.close();
  }
});

beforeEach(() => {
  reset();
});

const BODY = {
  senderName: 'Alice',
  recipientName: 'Bob',
  amount: 100,
  from: 'USD',
  to: 'EUR',
};

async function createTransfer(key = 'create-1') {
  const res = await fetch(`${baseUrl}/api/transfers`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(BODY),
  });
  const etag = res.headers.get('etag');
  return { status: res.status, body: await res.json(), etag };
}

async function lifecyclePost(path, { ifMatch, idempotencyKey }) {
  const headers = {
    Authorization: 'Bearer test-token-admin',
    'Content-Type': 'application/json',
  };
  if (ifMatch !== null && ifMatch !== undefined) {
    headers['If-Match'] = ifMatch;
  }
  if (idempotencyKey !== null && idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
  });
  const etag = res.headers.get('etag');
  return { status: res.status, body: await res.json(), etag };
}

test('GET transfer exposes version as a strong ETag', async () => {
  const created = await createTransfer('etag-create');
  assert.equal(created.status, 201);
  assert.equal(created.etag, '"1"');
  assert.equal(created.body.version, 1);

  const res = await fetch(`${baseUrl}/api/transfers/${created.body.id}`, {
    headers: { Authorization: 'Bearer test-token-admin' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('etag'), '"1"');
});

test('claim without If-Match returns 428', async () => {
  const created = await createTransfer('no-if-match');
  const { status, body } = await lifecyclePost(
    `/api/transfers/${created.body.id}/claim`,
    { ifMatch: null, idempotencyKey: 'claim-1' }
  );
  assert.equal(status, 428);
  assert.match(body.error.message, /If-Match/i);
  assert.equal(store.transfers.get(created.body.id).status, 'pending');
});

test('claim without Idempotency-Key returns 400', async () => {
  const created = await createTransfer('no-idem');
  const { status, body } = await lifecyclePost(
    `/api/transfers/${created.body.id}/claim`,
    { ifMatch: '"1"', idempotencyKey: null }
  );
  assert.equal(status, 400);
  assert.match(body.error.message, /Idempotency-Key/i);
});

test('claim with stale If-Match returns 409 conflict details', async () => {
  const created = await createTransfer('stale-claim');
  const first = await lifecyclePost(`/api/transfers/${created.body.id}/claim`, {
    ifMatch: '"1"',
    idempotencyKey: 'claim-ok',
  });
  assert.equal(first.status, 200);
  assert.equal(first.etag, '"2"');

  const stale = await lifecyclePost(`/api/transfers/${created.body.id}/cancel`, {
    ifMatch: '"1"',
    idempotencyKey: 'cancel-stale',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.actualVersion, 2);
  assert.equal(stale.body.error.details.currentStatus, 'claimed');
  assert.equal(store.transfers.get(created.body.id).status, 'claimed');
});

test('retried claim with the same Idempotency-Key replays the first result', async () => {
  const created = await createTransfer('replay-claim');
  const first = await lifecyclePost(`/api/transfers/${created.body.id}/claim`, {
    ifMatch: '"1"',
    idempotencyKey: 'stable-claim',
  });
  const second = await lifecyclePost(`/api/transfers/${created.body.id}/claim`, {
    ifMatch: '"1"',
    idempotencyKey: 'stable-claim',
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.claimableBalanceId, first.body.claimableBalanceId);
  assert.equal(second.body.version, 2);
  assert.equal(store.transfers.size, 1);
});

test('cancel then claim from the cancelled version is rejected', async () => {
  const created = await createTransfer('cancel-then-claim');
  const cancelled = await lifecyclePost(
    `/api/transfers/${created.body.id}/cancel`,
    { ifMatch: '"1"', idempotencyKey: 'cancel-ok' }
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');

  const claim = await lifecyclePost(`/api/transfers/${created.body.id}/claim`, {
    ifMatch: '"2"',
    idempotencyKey: 'claim-after',
  });
  assert.equal(claim.status, 409);
  assert.match(claim.body.error.message, /Cannot change transfer from cancelled/);
});
