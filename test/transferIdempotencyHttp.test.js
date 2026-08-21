'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Set NODE_ENV before requiring the app so config reads the right value at
// require-time, matching the convention in smoke.test.js.
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

/**
 * POST a transfer, optionally with an Idempotency-Key.
 * @param {string|null} key
 * @param {object} [body]
 * @returns {Promise<{status: number, body: object}>}
 */
async function post(key, body = BODY) {
  const headers = {
    Authorization: 'Bearer test-token-admin',
    'Content-Type': 'application/json',
  };
  if (key !== null) {
    headers['Idempotency-Key'] = key;
  }
  const res = await fetch(`${baseUrl}/api/transfers`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('POST /api/transfers refuses a request with no Idempotency-Key', async () => {
  const { status, body } = await post(null);

  // Failing is the only outcome that cannot silently duplicate a transfer: a
  // client that omits the header is not opting out of protection, it is
  // unaware it needs it.
  assert.equal(status, 400);
  assert.match(body.error.message, /Idempotency-Key header is required/i);
  assert.equal(store.transfers.size, 0);
});

test('POST /api/transfers refuses a blank Idempotency-Key', async () => {
  const { status } = await post('   ');
  assert.equal(status, 400);
  assert.equal(store.transfers.size, 0);
});

test('POST /api/transfers refuses an oversized Idempotency-Key', async () => {
  // Keys are client-supplied and land in a map, so the length has to be bounded
  // or the store can be grown without limit by a caller that never retries.
  const { status, body } = await post('x'.repeat(256));
  assert.equal(status, 400);
  assert.match(body.error.message, /at most 255 characters/i);
});

test('a retried POST returns the original transfer with the original status', async () => {
  const first = await post('http-retry');
  assert.equal(first.status, 201);

  const second = await post('http-retry');

  // 201 again, not 200: replaying the stored result means replaying all of it,
  // so a successful retry is indistinguishable from the response it stands in
  // for.
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(store.transfers.size, 1);
});

test('a retried POST with a changed amount answers 409', async () => {
  await post('http-conflict');
  const { status, body } = await post('http-conflict', { ...BODY, amount: 500 });

  assert.equal(status, 409);
  assert.match(body.error.message, /different request payload/i);
  assert.equal(store.transfers.size, 1);
});

test('a key is trimmed, so surrounding whitespace does not fork the operation', async () => {
  const first = await post('padded-key');
  const second = await post('  padded-key  ');

  assert.equal(second.body.id, first.body.id);
  assert.equal(store.transfers.size, 1);
});

test('an amount sent as a string still replays rather than conflicting', async () => {
  // "100" and 100 both validate and produce the same transfer, so treating them
  // as different requests would reject a client that re-serialized its payload.
  const first = await post('http-coerce', BODY);
  const second = await post('http-coerce', { ...BODY, amount: '100' });

  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(store.transfers.size, 1);
});

test('an unrelated extra field does not read as a conflicting retry', async () => {
  const first = await post('http-extra', BODY);
  const second = await post('http-extra', { ...BODY, clientNote: 'sent from mobile' });

  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
});

test('validation still runs before the key is reserved', async () => {
  const { status } = await post('http-invalid', { ...BODY, amount: -5 });
  assert.equal(status, 400);

  // A rejected payload must not burn the key, otherwise a client that fixes its
  // request and retries with the same key would be locked out of it.
  const retry = await post('http-invalid', BODY);
  assert.equal(retry.status, 201);
});
