'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const createApp = require('../src/app');
const config = require('../src/config');
const { RATES_TO_USD } = require('../src/config/rates');
const dependencyHealth = require('../src/services/dependencyHealthService');

let server;
let baseUrl;
let originalTimeout;

before(() => {
  originalTimeout = config.health.checkTimeoutMs;
  // Keep probe budgets tight so timeout tests stay fast.
  config.health.checkTimeoutMs = 50;

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
  config.health.checkTimeoutMs = originalTimeout;
  dependencyHealth.resetForTests();
  if (server) {
    server.close();
  }
});

beforeEach(() => {
  dependencyHealth.resetForTests();
  config.health.checkTimeoutMs = 50;
});

afterEach(() => {
  dependencyHealth.resetForTests();
});

async function fetchJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

async function withSmallApiBudget(run) {
  const originalMax = config.rateLimit.max;
  const originalWindowMs = config.rateLimit.windowMs;
  let budgetServer;
  try {
    config.rateLimit.max = 2;
    config.rateLimit.windowMs = 60000;
    budgetServer = createApp().listen(0, '127.0.0.1');
  } finally {
    config.rateLimit.max = originalMax;
    config.rateLimit.windowMs = originalWindowMs;
  }

  try {
    await new Promise((resolve, reject) => {
      budgetServer.once('listening', resolve);
      budgetServer.once('error', reject);
    });
    await run(`http://127.0.0.1:${budgetServer.address().port}`);
  } finally {
    budgetServer.closeAllConnections();
    await new Promise((resolve) => budgetServer.close(resolve));
  }
}

test('liveness GET and HEAD stay available after the business API quota is exhausted', async () => {
  await withSmallApiBudget(async (url) => {
    for (const status of [200, 200, 429]) {
      const response = await fetch(`${url}/api/version`);
      assert.equal(response.status, status);
      await response.text();
    }

    for (const [method, path] of [
      ['GET', '/api/health/live'],
      ['HEAD', '/api/health/live'],
      ['GET', '/api/health/live/'],
      ['GET', '/api/health/live?probe=quota'],
    ]) {
      const response = await fetch(url + path, {
        method,
        headers: { 'X-Request-Id': 'liveness-quota-test' },
      });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(response.headers.get('x-request-id'), 'liveness-quota-test');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.equal(response.headers.get('x-ratelimit-limit'), null);
      if (method === 'HEAD') {
        assert.equal(await response.text(), '');
      } else {
        assert.equal((await response.json()).status, 'alive');
      }
    }

    for (const [method, path] of [
      ['GET', '/api/health/ready'],
      ['GET', '/api/health'],
      ['POST', '/api/health/live'],
      ['GET', '/api/health/live/extra'],
    ]) {
      const response = await fetch(url + path, { method });
      assert.equal(response.status, 429, `${method} ${path} remains limited`);
      assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
      await response.text();
    }
  });
});

test('liveness polling during an FX outage does not consume the business API quota', async () => {
  const originalRates = { ...RATES_TO_USD };
  try {
    for (const currency of Object.keys(RATES_TO_USD)) delete RATES_TO_USD[currency];
    await withSmallApiBudget(async (url) => {
      for (const method of ['GET', 'HEAD', 'GET']) {
        const response = await fetch(`${url}/api/health/live`, { method });
        assert.equal(response.status, 200);
        await response.text();
      }

      const ready = await fetch(`${url}/api/health/ready`);
      assert.equal(ready.status, 503);
      assert.equal((await ready.json()).checks.fx.reason, 'FX_UNAVAILABLE');

      for (const status of [200, 429]) {
        const response = await fetch(`${url}/api/version`);
        assert.equal(response.status, status);
        await response.text();
      }
    });
  } finally {
    Object.assign(RATES_TO_USD, originalRates);
  }
});

// ─── Happy path ──────────────────────────────────────────────────────────────

test('readiness is ready when store, payments, and fx are healthy', async () => {
  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 200);
  assert.equal(body.status, 'ready');
  for (const name of dependencyHealth.DEPENDENCIES) {
    assert.equal(body.checks[name].status, 'ok');
    assert.equal(body.checks[name].reason, undefined);
    assert.ok(typeof body.checks[name].latencyMs === 'number');
  }
});

test('evaluateReadiness reports ready=true with all ok checks', async () => {
  const result = await dependencyHealth.evaluateReadiness({ timeoutMs: 50 });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    Object.keys(result.checks).sort(),
    [...dependencyHealth.DEPENDENCIES].sort()
  );
});

// ─── Dependency failure (original failure mode regression) ───────────────────

test('readiness returns 503 when the payment provider is unavailable', async () => {
  dependencyHealth.forceDependencyState('payments', {
    mode: 'fail',
    reason: dependencyHealth.REASON.PAYMENTS_UNAVAILABLE,
  });

  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 503);
  assert.equal(body.status, 'not_ready');
  assert.equal(body.checks.payments.status, 'error');
  assert.equal(body.checks.payments.reason, 'PAYMENTS_UNAVAILABLE');
  assert.equal(body.checks.store.status, 'ok');
  assert.equal(body.checks.fx.status, 'ok');
});

test('readiness returns 503 when the store dependency fails', async () => {
  dependencyHealth.forceDependencyState('store', {
    mode: 'fail',
    reason: dependencyHealth.REASON.STORE_UNAVAILABLE,
  });

  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 503);
  assert.equal(body.status, 'not_ready');
  assert.equal(body.checks.store.reason, 'STORE_UNAVAILABLE');
});

test('readiness returns 503 when the FX dependency fails', async () => {
  dependencyHealth.forceDependencyState('fx', {
    mode: 'fail',
    reason: dependencyHealth.REASON.FX_UNAVAILABLE,
  });

  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 503);
  assert.equal(body.checks.fx.reason, 'FX_UNAVAILABLE');
});

test('readiness detects missing FX data and recovers when the table is restored', async () => {
  const originalRates = { ...RATES_TO_USD };
  const originalPair = await fetchJson('/api/rates/USD-NGN');
  assert.equal(originalPair.status, 200);

  try {
    for (const currency of Object.keys(RATES_TO_USD)) {
      delete RATES_TO_USD[currency];
    }

    const unavailablePair = await fetchJson('/api/rates/USD-NGN');
    assert.equal(unavailablePair.status, 400);

    const down = await fetchJson('/api/health/ready');
    assert.equal(down.status, 503);
    assert.equal(down.body.status, 'not_ready');
    assert.equal(down.body.checks.fx.status, 'error');
    assert.equal(down.body.checks.fx.reason, 'FX_UNAVAILABLE');
    assert.equal(down.body.checks.store.status, 'ok');
    assert.equal(down.body.checks.payments.status, 'ok');

    const live = await fetchJson('/api/health/live');
    assert.equal(live.status, 200);
    assert.equal(live.body.status, 'alive');
  } finally {
    Object.assign(RATES_TO_USD, originalRates);
  }

  const recovered = await fetchJson('/api/health/ready');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.checks.fx.status, 'ok');
  assert.equal(recovered.body.checks.fx.reason, undefined);
  assert.deepEqual(await fetchJson('/api/rates/USD-NGN'), originalPair);
});

test('readiness rejects unusable rates in an advertised FX corridor', async () => {
  const originalRate = RATES_TO_USD.NGN;
  try {
    for (const rate of [undefined, 0, -1, NaN, Infinity]) {
      RATES_TO_USD.NGN = rate;
      const down = await fetchJson('/api/health/ready');
      assert.equal(down.status, 503, `NGN rate ${String(rate)} must not be ready`);
      assert.equal(down.body.checks.fx.reason, 'FX_UNAVAILABLE');
    }
  } finally {
    RATES_TO_USD.NGN = originalRate;
  }

  const recovered = await fetchJson('/api/health/ready');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.checks.fx.status, 'ok');
});

// ─── Liveness stays responsive during outages ────────────────────────────────

test('liveness remains 200 while readiness is not_ready', async () => {
  dependencyHealth.forceDependencyState('payments', { mode: 'fail' });
  dependencyHealth.forceDependencyState('fx', { mode: 'fail' });
  dependencyHealth.forceDependencyState('store', { mode: 'fail' });

  const live = await fetchJson('/api/health/live');
  assert.equal(live.status, 200);
  assert.equal(live.body.status, 'alive');

  const ready = await fetchJson('/api/health/ready');
  assert.equal(ready.status, 503);
  assert.equal(ready.body.status, 'not_ready');
});

test('base /api/health stays ok during dependency outages', async () => {
  dependencyHealth.forceDependencyState('payments', { mode: 'fail' });
  const { status, body } = await fetchJson('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

// ─── Timeout: dependency checks cannot hang ──────────────────────────────────

test('readiness returns 503 with *_TIMEOUT when a dependency hangs', async () => {
  dependencyHealth.forceDependencyState('fx', {
    mode: 'timeout',
    delayMs: 5000,
  });

  const started = Date.now();
  const { status, body } = await fetchJson('/api/health/ready');
  const elapsed = Date.now() - started;

  assert.equal(status, 503);
  assert.equal(body.checks.fx.status, 'error');
  assert.equal(body.checks.fx.reason, 'FX_TIMEOUT');
  // Must finish near the 50ms budget, not the 5s hang.
  assert.ok(elapsed < 1000, `readiness hung for ${elapsed}ms`);
});

test('runCheck maps a hanging probe to a timeout reason within budget', async () => {
  dependencyHealth.setProbeForTests('store', () => new Promise(() => {}));
  const started = Date.now();
  const result = await dependencyHealth.runCheck('store', 40);
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'STORE_TIMEOUT');
  assert.ok(elapsed < 500, `check hung for ${elapsed}ms`);
});

// ─── Recovery without restart ────────────────────────────────────────────────

test('readiness recovers after a failed dependency becomes healthy again', async () => {
  dependencyHealth.forceDependencyState('payments', {
    mode: 'fail',
    reason: dependencyHealth.REASON.PAYMENTS_UNAVAILABLE,
  });

  const down = await fetchJson('/api/health/ready');
  assert.equal(down.status, 503);
  assert.equal(down.body.checks.payments.reason, 'PAYMENTS_UNAVAILABLE');

  // Clear the forced failure — no process restart, no module reload.
  dependencyHealth.clearForcedStates();

  const up = await fetchJson('/api/health/ready');
  assert.equal(up.status, 200);
  assert.equal(up.body.status, 'ready');
  assert.equal(up.body.checks.payments.status, 'ok');
  assert.equal(up.body.checks.payments.reason, undefined);
});

// ─── Status codes ────────────────────────────────────────────────────────────

test('status codes: 200 when ready, 503 when any dependency fails', async () => {
  const ok = await fetchJson('/api/health/ready');
  assert.equal(ok.status, 200);

  dependencyHealth.forceDependencyState('store', { mode: 'fail' });
  const bad = await fetchJson('/api/health/ready');
  assert.equal(bad.status, 503);

  dependencyHealth.clearForcedStates();
  const recovered = await fetchJson('/api/health/ready');
  assert.equal(recovered.status, 200);
});

// ─── Redaction ───────────────────────────────────────────────────────────────

test('readiness redacts raw error messages and secrets from responses', async () => {
  const secret = 'postgres://user:super-secret@db.internal:5432/remitflow';
  dependencyHealth.forceDependencyState('store', {
    mode: 'throw',
    message: `${secret} password=hunter2 apiKey=sk_live_abc`,
  });

  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 503);
  assert.equal(body.checks.store.status, 'error');
  assert.equal(body.checks.store.reason, 'STORE_UNAVAILABLE');

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(serialized.includes('hunter2'), false);
  assert.equal(serialized.includes('sk_live_abc'), false);
  assert.equal(serialized.includes('postgres://'), false);
  assert.equal(serialized.includes('password='), false);
  // Only the stable reason code is present — no free-form message field.
  assert.equal(body.checks.store.message, undefined);
  assert.equal(body.checks.store.stack, undefined);
});

test('readiness keeps reason codes scoped to their dependency', async () => {
  dependencyHealth.forceDependencyState('payments', {
    mode: 'fail',
    reason: dependencyHealth.REASON.STORE_UNAVAILABLE,
  });

  const result = await dependencyHealth.runCheck('payments', 50);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, dependencyHealth.REASON.PAYMENTS_UNAVAILABLE);
});

test('unit redact path never leaks custom throw messages', async () => {
  dependencyHealth.forceDependencyState('payments', {
    mode: 'throw',
    message: 'Authorization: Bearer sk_live_should_not_leak',
  });
  const result = await dependencyHealth.runCheck('payments', 50);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'PAYMENTS_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('sk_live'), false);
});

// Exercise the default wrappers by replacing adapter methods, not health probes.
const { execFile: execHealthChild } = require('node:child_process');
const healthTestRepoRoot = require('node:path').resolve(__dirname, '..');
const asyncHealthAdapters = [
  { name: 'payments', reasonPrefix: 'PAYMENTS', service: require('../src/services/stellarService') },
  { name: 'fx', reasonPrefix: 'FX', service: require('../src/services/rateService') },
];

// Detached provider rejections must fail only this child on an unrepaired head.
// No unhandledRejection listener is installed in either process.
const healthRejectionChildSource = '(' + (async function healthRejectionChild() {
  process.env.NODE_ENV = 'test';
  const createChildApp = require('./src/app');
  const childConfig = require('./src/config');
  const name = process.argv[1];
  const mode = process.argv[2];
  const provider = name === 'payments'
    ? require('./src/services/stellarService')
    : require('./src/services/rateService');
  const originalPing = provider.ping;
  const secret = 'RF140_SYNTHETIC_ASYNC_PROVIDER_SECRET';
  const timeoutMs = 40;
  childConfig.health.checkTimeoutMs = timeoutMs;

  let childServer;
  let rejectionTimer;
  let result;
  let markRejectionDelivered;
  const rejectionDelivered = new Promise((resolve) => {
    markRejectionDelivered = resolve;
  });

  try {
    childServer = createChildApp().listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      childServer.once('listening', resolve);
      childServer.once('error', reject);
    });
    const url = 'http://127.0.0.1:' + childServer.address().port;
    async function requestJson(route) {
      const response = await fetch(url + route, { signal: AbortSignal.timeout(2000) });
      return { status: response.status, body: await response.json() };
    }

    provider.ping = () => new Promise((resolve, reject) => {
      const fail = () => {
        reject(new Error(secret));
        markRejectionDelivered();
      };
      if (mode === 'late') {
        rejectionTimer = setTimeout(fail, timeoutMs * 3);
      } else {
        fail();
      }
    });

    const started = Date.now();
    const down = await requestJson('/api/health/ready');
    const elapsedMs = Date.now() - started;
    const live = await requestJson('/api/health/live');
    await rejectionDelivered;
    // Let a detached rejection take its normal fatal path before reporting.
    await new Promise((resolve) => setImmediate(resolve));

    provider.ping = originalPing;
    const recovered = await requestJson('/api/health/ready');
    result = { name, mode, timeoutMs, elapsedMs, down, live, recovered };
  } finally {
    provider.ping = originalPing;
    clearTimeout(rejectionTimer);
    if (childServer) {
      childServer.closeAllConnections();
      await new Promise((resolve) => childServer.close(resolve));
    }
  }

  process.stdout.write('RF140_CHILD_RESULT ' + JSON.stringify(result) + '\n');
}).toString() + ')().catch((error) => { console.error(error); process.exitCode = 1; });';

async function observeHealthRejectionChild(name, mode) {
  const child = await new Promise((resolve) => {
    execHealthChild(
      process.execPath,
      ['--max-old-space-size=64', '--unhandled-rejections=strict', '-e', healthRejectionChildSource, name, mode],
      {
        cwd: healthTestRepoRoot,
        env: { ...process.env, NODE_ENV: 'test' },
        timeout: 10000,
        maxBuffer: 128 * 1024,
      },
      (error, stdout, stderr) => resolve({
        exitCode: error ? (error.code ?? 'PROCESS_ERROR') : 0,
        signal: error ? error.signal : null,
        stdout,
        stderr,
      })
    );
  });

  assert.equal(
    child.exitCode,
    0,
    name + ' ' + mode + ' child exit=' + child.exitCode +
      ' signal=' + child.signal + '\n' + child.stderr
  );
  const marker = 'RF140_CHILD_RESULT ';
  const resultLine = child.stdout.split('\n').find((line) => line.startsWith(marker));
  assert.ok(resultLine, 'child did not report completed HTTP observations:\n' + child.stdout);
  return JSON.parse(resultLine.slice(marker.length));
}

for (const { name, reasonPrefix, service } of asyncHealthAdapters) {
  test(name + ' default adapter awaits async healthy and negative results and recovers', async () => {
    const originalPing = service.ping;
    try {
      service.ping = async () => ({ ok: true });
      const healthy = await fetchJson('/api/health/ready');
      assert.equal(healthy.status, 200);
      assert.equal(healthy.body.checks[name].status, 'ok');

      service.ping = async () => ({ ok: false });
      const down = await fetchJson('/api/health/ready');
      assert.equal(down.status, 503);
      assert.equal(down.body.checks[name].status, 'error');
      assert.equal(down.body.checks[name].reason, reasonPrefix + '_UNAVAILABLE');

      service.ping = async () => ({ ok: true });
      const recovered = await fetchJson('/api/health/ready');
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.checks[name].status, 'ok');
      assert.equal(recovered.body.checks[name].reason, undefined);
    } finally {
      service.ping = originalPing;
    }
  });

  test(name + ' default adapter bounds a pending ping while liveness and recovery remain available', async () => {
    const originalPing = service.ping;
    try {
      service.ping = () => new Promise(() => {});
      const started = Date.now();
      const [down, live] = await Promise.all([
        fetchJson('/api/health/ready'),
        fetchJson('/api/health/live'),
      ]);
      const elapsedMs = Date.now() - started;

      assert.equal(down.status, 503);
      assert.equal(down.body.checks[name].status, 'error');
      assert.equal(down.body.checks[name].reason, reasonPrefix + '_TIMEOUT');
      assert.ok(elapsedMs < 1000, 'pending ' + name + ' check took ' + elapsedMs + 'ms');
      assert.equal(live.status, 200);
      assert.equal(live.body.status, 'alive');

      service.ping = originalPing;
      const recovered = await fetchJson('/api/health/ready');
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.checks[name].status, 'ok');
      assert.equal(recovered.body.checks[name].reason, undefined);
    } finally {
      service.ping = originalPing;
    }
  });

  test(name + ' default adapter catches and redacts an immediate rejection without killing the process', async () => {
    const observed = await observeHealthRejectionChild(name, 'immediate');
    assert.equal(observed.down.status, 503);
    assert.equal(observed.down.body.checks[name].status, 'error');
    assert.equal(observed.down.body.checks[name].reason, reasonPrefix + '_UNAVAILABLE');
    assert.equal(JSON.stringify(observed.down.body).includes('RF140_SYNTHETIC_ASYNC_PROVIDER_SECRET'), false);
    assert.equal(observed.down.body.checks[name].message, undefined);
    assert.equal(observed.down.body.checks[name].stack, undefined);
    assert.equal(observed.live.status, 200);
    assert.equal(observed.live.body.status, 'alive');
    assert.equal(observed.recovered.status, 200);
    assert.equal(observed.recovered.body.checks[name].status, 'ok');
    assert.equal(observed.recovered.body.checks[name].reason, undefined);
  });

  test(name + ' default adapter survives a rejection after its deadline and recovers', async () => {
    const observed = await observeHealthRejectionChild(name, 'late');
    assert.equal(observed.down.status, 503);
    assert.equal(observed.down.body.checks[name].status, 'error');
    assert.equal(observed.down.body.checks[name].reason, reasonPrefix + '_TIMEOUT');
    assert.ok(observed.elapsedMs < 1000, 'late ' + name + ' check took ' + observed.elapsedMs + 'ms');
    assert.equal(JSON.stringify(observed.down.body).includes('RF140_SYNTHETIC_ASYNC_PROVIDER_SECRET'), false);
    assert.equal(observed.live.status, 200);
    assert.equal(observed.live.body.status, 'alive');
    assert.equal(observed.recovered.status, 200);
    assert.equal(observed.recovered.body.checks[name].status, 'ok');
    assert.equal(observed.recovered.body.checks[name].reason, undefined);
  });
}
