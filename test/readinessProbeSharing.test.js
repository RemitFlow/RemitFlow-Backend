'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');

process.env.NODE_ENV = 'test';
const createApp = require('../src/app');
const config = require('../src/config');
const health = require('../src/services/dependencyHealthService');

let server;
let base;
let originalTimeout;

before(async () => {
  originalTimeout = config.health.checkTimeoutMs;
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { health.resetForTests(); config.health.checkTimeoutMs = 5; });
afterEach(() => health.resetForTests());
after(async () => {
  config.health.checkTimeoutMs = originalTimeout;
  health.resetForTests();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('repeated readiness timeouts do not multiply unfinished provider work', async () => {
  let calls = 0;
  let finish;
  const hung = new Promise((resolve) => { finish = resolve; });
  health.setProbeForTests('payments', () => { calls++; return hung; });
  try {
    for (let i = 0; i < 40; i++) {
      const response = await fetch(`${base}/api/health/ready`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).checks.payments.reason, 'PAYMENTS_TIMEOUT');
    }
    const live = await fetch(`${base}/api/health/live`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).status, 'alive');
    assert.equal(calls, 1, '40 timed-out requests must share one unfinished provider call');
  } finally {
    finish({ ok: true });
    await tick();
  }
  // The settled result is not a health cache: the next request calls again.
  const response = await fetch(`${base}/api/health/ready`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checks.payments.status, 'ok');
  assert.equal(calls, 2);
});

test('each waiter retains its own deadline and a longer waiter can recover', async () => {
  let calls = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  health.setProbeForTests('fx', () => { calls++; return pending; });
  const short = health.runCheck('fx', 10);
  const long = health.runCheck('fx', 1000);
  try {
    assert.equal((await short).reason, 'FX_TIMEOUT');
    finish({ ok: true });
    assert.equal((await long).status, 'ok');
    assert.equal(calls, 1);
    assert.equal((await health.runCheck('fx', 1000)).status, 'ok');
    assert.equal(calls, 2, 'completed checks must be probed anew');
  } finally { finish({ ok: true }); await long; }
});

test('shared rejection is redacted for every waiter and does not stick', async () => {
  let calls = 0;
  let fail;
  const pending = new Promise((_, reject) => { fail = reject; });
  health.setProbeForTests('payments', () => { calls++; return pending; });
  const first = health.runCheck('payments', 1000);
  const second = health.runCheck('payments', 1000);
  await tick();
  fail(new Error('Authorization: Bearer private-test-secret'));
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.reason, 'PAYMENTS_UNAVAILABLE');
    assert.equal(JSON.stringify(result).includes('private-test-secret'), false);
  }
  health.setProbeForTests('payments', async () => ({ ok: true }));
  assert.equal((await health.runCheck('payments', 1000)).status, 'ok');
});

test('an old completion cannot remove a replacement adapter operation', async () => {
  let finishOld;
  let finishNew;
  let newCalls = 0;
  const oldPending = new Promise((resolve) => { finishOld = resolve; });
  const newPending = new Promise((resolve) => { finishNew = resolve; });
  health.setProbeForTests('store', () => oldPending);
  const old = health.runCheck('store', 1000);
  await tick();
  health.setProbeForTests('store', () => { newCalls++; return newPending; });
  const replacement = health.runCheck('store', 1000);
  try {
    await tick();
    finishOld({ ok: true });
    assert.equal((await old).status, 'ok');
    const joined = health.runCheck('store', 1000);
    await tick();
    finishNew({ ok: true });
    assert.equal((await replacement).status, 'ok');
    assert.equal((await joined).status, 'ok');
    assert.equal(newCalls, 1);
  } finally { finishOld({ ok: true }); finishNew({ ok: true }); }
});
