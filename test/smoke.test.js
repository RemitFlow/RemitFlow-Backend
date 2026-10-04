'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Set NODE_ENV before any module imports so config reads the right value
// at require-time. Morgan and rate-limit are skipped when env === 'test'.
process.env.NODE_ENV = 'test';

const createApp = require('../src/app');

let server;
let baseUrl;

before(() => {
  // Bind to port 0 so the OS picks a free port.
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

/**
 * Helper: fetch with string response.
 */
async function fetchJson(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const body = await res.json();
  return { status: res.status, headers: res.headers, body };
}

test('app boots and responds on health endpoint', async () => {
  const { status, body } = await fetchJson('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'remitflow-backend');
  assert.equal(body.env, 'test');
  assert.ok(typeof body.version === 'string');
  assert.ok(typeof body.uptime === 'number');
  assert.ok(typeof body.timestamp === 'string');
});

test('health liveness probe returns alive', async () => {
  const { status, body } = await fetchJson('/api/health/live');
  assert.equal(status, 200);
  assert.equal(body.status, 'alive');
});

test('health readiness probe returns ready with dependency checks', async () => {
  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 200);
  assert.equal(body.status, 'ready');
  assert.equal(body.checks.store.status, 'ok');
  assert.equal(body.checks.payments.status, 'ok');
  assert.equal(body.checks.fx.status, 'ok');
  assert.ok(typeof body.timeoutMs === 'number');
});

test('version endpoint returns name and version', async () => {
  const { status, body } = await fetchJson('/api/version');
  assert.equal(status, 200);
  assert.equal(body.name, 'remitflow-backend');
  assert.equal(typeof body.version, 'string');
  assert.equal(body.env, 'test');
});

test('rates endpoint returns base and rates', async () => {
  const { status, body } = await fetchJson('/api/rates');
  assert.equal(status, 200);
  assert.equal(body.base, 'USD');
  assert.ok(Array.isArray(body.rates));
  assert.ok(body.rates.length > 0);
});

test('root route returns API name', async () => {
  const { status, body } = await fetchJson('/');
  assert.equal(status, 200);
  assert.equal(body.name, 'RemitFlow API');
  assert.ok(body.docs);
});

test('unknown route returns 404', async () => {
  const { status, body } = await fetchJson('/api/nonexistent');
  assert.equal(status, 404);
  assert.ok(body.error);
  assert.equal(body.error.status, 404);
  assert.ok(typeof body.error.message === 'string');
  assert.ok(body.error.requestId);
});

test('server responds with CORS headers', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
