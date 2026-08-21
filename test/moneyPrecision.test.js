'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const createApp = require('../src/app');

let server;
let baseUrl;

before(() => {
  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) {
    server.close();
  }
});

async function fetchJson(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

test('GET /api/quote rejects an amount with sub-cent precision', async () => {
  const { status, body } = await fetchJson(
    '/api/quote?amount=100.129&from=USD&to=EUR'
  );
  assert.equal(status, 400);
  assert.ok(
    body.error.details.errors.some((e) => e.includes('decimal places'))
  );
});

test('GET /api/quote rejects an amount outside the safe numeric range', async () => {
  const { status, body } = await fetchJson(
    '/api/quote?amount=1e21&from=USD&to=EUR'
  );
  assert.equal(status, 400);
  assert.ok(
    body.error.details.errors.some((e) => e.includes('numeric range'))
  );
});

test('GET /api/quote accepts a well-formed two-decimal amount', async () => {
  const { status, body } = await fetchJson(
    '/api/quote?amount=100.50&from=USD&to=EUR'
  );
  assert.equal(status, 200);
  assert.equal(body.sendAmount, 100.5);
});

test('POST /api/transfers rejects an amount with sub-cent precision', async () => {
  const { status, body } = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-precision-1',
    },
    body: JSON.stringify({
      senderName: 'Alice',
      recipientName: 'Bob',
      amount: 99.999,
      from: 'USD',
      to: 'EUR',
    }),
  });
  assert.equal(status, 400);
  assert.ok(
    body.error.details.errors.some((e) => e.includes('decimal places'))
  );
});

test('POST /api/transfers accepts a well-formed two-decimal amount', async () => {
  const { status, body } = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-precision-2',
    },
    body: JSON.stringify({
      senderName: 'Alice',
      recipientName: 'Bob',
      amount: 250.25,
      from: 'USD',
      to: 'EUR',
    }),
  });
  assert.equal(status, 201);
  assert.equal(body.sendAmount, 250.25);
});
