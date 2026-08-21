'use strict';

/**
 * Tests for scope-based API token validation (requireScope middleware).
 *
 * Covers:
 *   - Unit behaviour of the middleware (missing header, invalid token, insufficient scopes, success)
 *   - HTTP integration against the real Express app for all secured routes
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const createApp = require('../src/app');
const { reset } = require('../src/store');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  if (server) server.close();
});

beforeEach(() => {
  reset();
});

/**
 * Fetch helper. Returns { status, headers, body }.
 * @param {string} path
 * @param {RequestInit} [options]
 */
async function fetchJson(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

/**
 * Helper to build Authorization header.
 * @param {string} token
 */
function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Unit-style tests via HTTP ─────────────────────────────────────────────────

// --- Missing Authorization header ---

test('GET /api/users returns 401 when Authorization header is absent', async () => {
  const { status, body } = await fetchJson('/api/users');
  assert.equal(status, 401);
  assert.ok(body.error);
  assert.equal(body.error.status, 401);
  assert.match(body.error.message, /Authorization/i);
});

test('GET /api/transfers returns 401 when Authorization header is absent', async () => {
  const { status, body } = await fetchJson('/api/transfers');
  assert.equal(status, 401);
  assert.ok(body.error);
  assert.equal(body.error.status, 401);
});

test('GET /api/audit returns 401 when Authorization header is absent', async () => {
  const { status, body } = await fetchJson('/api/audit');
  assert.equal(status, 401);
  assert.ok(body.error);
  assert.equal(body.error.status, 401);
});

// --- Malformed Authorization header (no Bearer prefix) ---

test('GET /api/users returns 401 when Authorization header is malformed (no Bearer prefix)', async () => {
  const { status, body } = await fetchJson('/api/users', {
    headers: { Authorization: 'test-token-admin' },
  });
  assert.equal(status, 401);
  assert.ok(body.error);
  assert.equal(body.error.status, 401);
});

// --- Invalid (unknown) token ---

test('GET /api/users returns 401 when token is unknown', async () => {
  const { status, body } = await fetchJson('/api/users', {
    headers: authHeader('not-a-valid-token'),
  });
  assert.equal(status, 401);
  assert.ok(body.error);
  assert.equal(body.error.status, 401);
  assert.match(body.error.message, /Invalid API token/i);
});

test('POST /api/transfers returns 401 when token is unknown', async () => {
  const { status, body } = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: { ...authHeader('bad-token'), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-requireScope-118' },
    body: JSON.stringify({ senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' }),
  });
  assert.equal(status, 401);
  assert.ok(body.error);
});

// --- Insufficient scopes (valid token, wrong permissions) ---

test('POST /api/transfers returns 403 when token only has transfers:read scope', async () => {
  // test-token-readonly has: transfers:read, users:read, audit:read — no :write scopes
  const { status, body } = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: { ...authHeader('test-token-readonly'), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-requireScope-131' },
    body: JSON.stringify({ senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' }),
  });
  assert.equal(status, 403);
  assert.ok(body.error);
  assert.equal(body.error.status, 403);
  assert.match(body.error.message, /Insufficient token scopes/i);
});

test('POST /api/users returns 403 when token only has users:read scope', async () => {
  const { status, body } = await fetchJson('/api/users', {
    method: 'POST',
    headers: { ...authHeader('test-token-readonly'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
  });
  assert.equal(status, 403);
  assert.ok(body.error);
  assert.equal(body.error.status, 403);
});

test('POST /api/transfers/:id/claim returns 403 when token only has transfers:read scope', async () => {
  // Create a transfer first using the admin token, then try to claim with read-only
  const createRes = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: { ...authHeader('test-token-admin'), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-requireScope-155' },
    body: JSON.stringify({ senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' }),
  });
  assert.equal(createRes.status, 201);
  const transferId = createRes.body.id;

  const { status, body } = await fetchJson(`/api/transfers/${transferId}/claim`, {
    method: 'POST',
    headers: authHeader('test-token-readonly'),
  });
  assert.equal(status, 403);
  assert.ok(body.error);
  assert.equal(body.error.status, 403);
});

test('GET /api/audit returns 403 when token only has transfers scope (no audit:read)', async () => {
  // test-token-transfers: ['transfers:read', 'transfers:write'] – no audit:read
  const { status, body } = await fetchJson('/api/audit', {
    headers: authHeader('test-token-transfers'),
  });
  assert.equal(status, 403);
  assert.ok(body.error);
  assert.equal(body.error.status, 403);
});

// ─── Success cases (authorised requests pass through) ──────────────────────────

test('GET /api/users returns 200 with admin token', async () => {
  const { status, body } = await fetchJson('/api/users', {
    headers: authHeader('test-token-admin'),
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.users));
});

test('GET /api/users returns 200 with readonly token', async () => {
  const { status, body } = await fetchJson('/api/users', {
    headers: authHeader('test-token-readonly'),
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.users));
});

test('POST /api/users returns 201 with admin token', async () => {
  const { status, body } = await fetchJson('/api/users', {
    method: 'POST',
    headers: { ...authHeader('test-token-admin'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Charlie', email: 'charlie@example.com', country: 'US' }),
  });
  assert.equal(status, 201);
  assert.ok(body.id);
  assert.equal(body.name, 'Charlie');
});

test('GET /api/transfers returns 200 with admin token', async () => {
  const { status, body } = await fetchJson('/api/transfers', {
    headers: authHeader('test-token-admin'),
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.transfers));
});

test('GET /api/transfers returns 200 with readonly token', async () => {
  const { status, body } = await fetchJson('/api/transfers', {
    headers: authHeader('test-token-readonly'),
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.transfers));
});

test('POST /api/transfers returns 201 with admin token', async () => {
  const { status, body } = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: { ...authHeader('test-token-admin'), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-requireScope-228' },
    body: JSON.stringify({ senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' }),
  });
  assert.equal(status, 201);
  assert.ok(body.id);
});

test('POST /api/transfers returns 201 with transfers-scoped token', async () => {
  const { status, body } = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: { ...authHeader('test-token-transfers'), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-requireScope-238' },
    body: JSON.stringify({ senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' }),
  });
  assert.equal(status, 201);
  assert.ok(body.id);
});

test('GET /api/transfers/stats returns 200 with readonly token', async () => {
  const { status, body } = await fetchJson('/api/transfers/stats', {
    headers: authHeader('test-token-readonly'),
  });
  assert.equal(status, 200);
  // getStats() returns its shape directly (no 'stats' wrapper key)
  assert.ok(typeof body === 'object' && body !== null);
});

test('GET /api/audit returns 200 with admin token', async () => {
  const { status, body } = await fetchJson('/api/audit', {
    headers: authHeader('test-token-admin'),
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.entries));
});

test('GET /api/audit returns 200 with readonly token', async () => {
  const { status, body } = await fetchJson('/api/audit', {
    headers: authHeader('test-token-readonly'),
  });
  assert.equal(status, 200);
});

// ─── Public routes are still accessible without a token ───────────────────────

test('GET /api/health is public and returns 200 without token', async () => {
  const { status } = await fetchJson('/api/health');
  assert.equal(status, 200);
});

test('GET /api/rates is public and returns 200 without token', async () => {
  const { status, body } = await fetchJson('/api/rates');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.rates));
});

test('GET /api/version is public and returns 200 without token', async () => {
  const { status } = await fetchJson('/api/version');
  assert.equal(status, 200);
});

// ─── Full transfer lifecycle with scoped tokens ───────────────────────────────

test('full transfer lifecycle: create → claim with correct scopes', async () => {
  // Create
  const createRes = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: { ...authHeader('test-token-admin'), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-requireScope-293' },
    body: JSON.stringify({ senderName: 'Alice', recipientName: 'Bob', amount: 200, from: 'USD', to: 'INR' }),
  });
  assert.equal(createRes.status, 201);
  const id = createRes.body.id;
  assert.equal(createRes.body.status, 'pending');

  // Read with readonly token
  const readRes = await fetchJson(`/api/transfers/${id}`, {
    headers: authHeader('test-token-readonly'),
  });
  assert.equal(readRes.status, 200);
  assert.equal(readRes.body.id, id);

  // Claim with write token
  const claimRes = await fetchJson(`/api/transfers/${id}/claim`, {
    method: 'POST',
    headers: authHeader('test-token-admin'),
  });
  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.body.status, 'claimed');
});

test('full transfer lifecycle: create → cancel with correct scopes', async () => {
  const createRes = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: { ...authHeader('test-token-transfers'), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-requireScope-319' },
    body: JSON.stringify({ senderName: 'Carlos', recipientName: 'Diaz', amount: 500, from: 'EUR', to: 'MXN' }),
  });
  assert.equal(createRes.status, 201);
  const id = createRes.body.id;

  const cancelRes = await fetchJson(`/api/transfers/${id}/cancel`, {
    method: 'POST',
    headers: authHeader('test-token-transfers'),
  });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.status, 'cancelled');
});
