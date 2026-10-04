'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const config = require('../src/config');
const health = require('../src/services/dependencyHealthService');
const originalTimeout = config.health.checkTimeoutMs;

afterEach(() => {
  config.health.checkTimeoutMs = originalTimeout;
  health.resetForTests();
});

function healthyAfter(ms) {
  for (const name of health.DEPENDENCIES) {
    health.setProbeForTests(name, async () => {
      await delay(ms);
      return { ok: true };
    });
  }
}

test('overflowing configured budget does not become a one-millisecond deadline', async () => {
  config.health.checkTimeoutMs = 2147483648;
  healthyAfter(20);
  const result = await health.evaluateReadiness();
  assert.equal(result.ready, true);
  assert.equal(result.timeoutMs, 1000);
  assert.equal(health.checkTimeoutMs(), 1000);
});

test('invalid overrides use the configured budget; valid fractional budgets report the actual timer delay', async () => {
  config.health.checkTimeoutMs = 200;
  healthyAfter(20);
  for (const timeoutMs of [Infinity, 2147483648, NaN, 0, -1]) {
    const result = await health.evaluateReadiness({ timeoutMs });
    assert.equal(result.ready, true, String(timeoutMs));
    assert.equal(result.timeoutMs, 200, String(timeoutMs));
  }
  const fractional = await health.evaluateReadiness({ timeoutMs: '100.9' });
  assert.equal(fractional.ready, true);
  assert.equal(fractional.timeoutMs, 100);
  const largest = await health.evaluateReadiness({ timeoutMs: 2147483647 });
  assert.equal(largest.ready, true);
  assert.equal(largest.timeoutMs, 2147483647);
});

test('direct checks normalize invalid deadlines without disabling valid timeouts or recovery', async () => {
  config.health.checkTimeoutMs = 200;
  healthyAfter(20);
  const normalized = await health.runCheck('payments', Infinity);
  assert.equal(normalized.status, 'ok');

  let complete;
  health.setProbeForTests('payments', () => new Promise((resolve) => { complete = resolve; }));
  // The production deadline is unreferenced, so keep this isolated test alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const timedOut = await health.runCheck('payments', 2);
    assert.equal(timedOut.status, 'error');
    assert.equal(timedOut.reason, health.REASON.PAYMENTS_TIMEOUT);
    complete({ ok: true });
    await delay(0);
    health.setProbeForTests('payments', async () => ({ ok: true }));
    assert.equal((await health.runCheck('payments', 200)).status, 'ok');
  } finally {
    clearInterval(keepAlive);
  }
});
