'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.NODE_ENV = 'test';

const rateLimit = require('../src/middleware/rateLimit');
const requestId = require('../src/middleware/requestId');
const {
  fingerprint,
  resolveClientIp,
  resolveActorKey,
} = require('../src/utils/clientIdentity');
const { sanitizeCorrelationId } = require('../src/middleware/requestId');
const errorHandler = require('../src/middleware/errorHandler');
const ApiError = require('../src/utils/ApiError');

function mockReq(overrides = {}) {
  const headers = { ...(overrides.headers || {}) };
  return {
    ip: overrides.ip || '127.0.0.1',
    socket: { remoteAddress: overrides.remoteAddress || '127.0.0.1' },
    token: overrides.token,
    adminToken: overrides.adminToken,
    get(name) {
      const key = Object.keys(headers).find(
        (k) => k.toLowerCase() === String(name).toLowerCase()
      );
      return key ? headers[key] : undefined;
    },
    ...overrides,
  };
}

function mockRes() {
  const headers = {};
  return {
    headers,
    set(name, value) {
      headers[name] = String(value);
    },
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function run(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => {
      if (err) {
        resolve({ err, res });
      } else {
        resolve({ err: null, res });
      }
    });
  });
}

test('fingerprint is stable, truncated, and never echoes the secret', () => {
  const a = fingerprint('test-token-admin');
  const b = fingerprint('test-token-admin');
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.ok(!a.includes('test-token'));
  assert.equal(fingerprint(''), 'anon');
});

test('resolveClientIp ignores X-Forwarded-For unless trustProxy is on', () => {
  const req = mockReq({
    remoteAddress: '10.0.0.5',
    // Express trust proxy 1 resolves the nearest untrusted hop.
    ip: '10.0.0.1',
    headers: { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' },
  });
  assert.equal(resolveClientIp(req, { trustProxy: false }), '10.0.0.5');
  assert.equal(resolveClientIp(req, { trustProxy: true }), '10.0.0.1');
});

test('resolveActorKey prefers token fingerprint over IP', () => {
  const req = mockReq({
    token: 'test-token-admin',
    remoteAddress: '10.0.0.5',
  });
  const key = resolveActorKey(req);
  assert.match(key, /^actor:/);
  assert.ok(!key.includes('test-token-admin'));
  assert.ok(!key.includes('10.0.0.5'));
});

test('sanitizeCorrelationId rejects oversized or unsafe values', () => {
  assert.equal(sanitizeCorrelationId('abc-123'), 'abc-123');
  assert.equal(sanitizeCorrelationId('  ok_id  '), 'ok_id');
  assert.equal(sanitizeCorrelationId('has space'), null);
  assert.equal(sanitizeCorrelationId('bad"quote'), null);
  assert.equal(sanitizeCorrelationId('x'.repeat(200)), null);
  assert.equal(sanitizeCorrelationId(''), null);
});

test('burst over max returns 429 with Retry-After and policy details', async () => {
  const limiter = rateLimit({
    name: 'mutation:transfers',
    windowMs: 60_000,
    max: 3,
    forceInTest: true,
    keyGenerator: () => 'actor:one',
  });

  for (let i = 0; i < 3; i += 1) {
    const { err } = await run(limiter, mockReq(), mockRes());
    assert.equal(err, null);
  }

  const { err, res } = await run(limiter, mockReq(), mockRes());
  assert.ok(err instanceof ApiError);
  assert.equal(err.statusCode, 429);
  assert.equal(err.details.policy, 'mutation:transfers');
  assert.equal(err.details.limit, 3);
  assert.ok(err.details.retryAfter >= 1);
  assert.equal(res.headers['Retry-After'], String(err.details.retryAfter));
  assert.equal(res.headers['X-RateLimit-Remaining'], '0');
});

test('identity isolation: one actor bursting does not block another', async () => {
  const limiter = rateLimit({
    name: 'mutation:transfers',
    windowMs: 60_000,
    max: 2,
    forceInTest: true,
    keyGenerator: (req) => resolveActorKey(req),
  });

  const actorA = mockReq({ token: 'token-a' });
  const actorB = mockReq({ token: 'token-b' });

  assert.equal((await run(limiter, actorA, mockRes())).err, null);
  assert.equal((await run(limiter, actorA, mockRes())).err, null);
  const blocked = await run(limiter, actorA, mockRes());
  assert.equal(blocked.err.statusCode, 429);

  const other = await run(limiter, actorB, mockRes());
  assert.equal(other.err, null);
});

test('proxy trust: forged X-Forwarded-For cannot rotate identity when trustProxy is false', async () => {
  const limiter = rateLimit({
    name: 'global',
    windowMs: 60_000,
    max: 2,
    forceInTest: true,
    trustProxy: false,
  });

  const first = mockReq({
    remoteAddress: '10.0.0.5',
    headers: { 'X-Forwarded-For': '198.51.100.1' },
  });
  const second = mockReq({
    remoteAddress: '10.0.0.5',
    headers: { 'X-Forwarded-For': '198.51.100.2' },
  });

  assert.equal((await run(limiter, first, mockRes())).err, null);
  assert.equal((await run(limiter, first, mockRes())).err, null);
  const blocked = await run(limiter, second, mockRes());
  assert.equal(blocked.err.statusCode, 429);
});

test('proxy trust: forged left-most X-Forwarded-For cannot rotate a one-hop identity', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(rateLimit({
    name: 'global',
    windowMs: 60_000,
    max: 1,
    forceInTest: true,
    trustProxy: true,
  }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    async function ping(forwarded) {
      return fetch(`http://127.0.0.1:${port}/ping`, {
        headers: { 'X-Forwarded-For': forwarded },
      });
    }
    const first = await ping('198.51.100.1, 203.0.113.9');
    assert.equal(first.status, 200);
    const forged = await ping('198.51.100.2, 203.0.113.9');
    assert.equal(forged.status, 429);
    const other = await ping('198.51.100.2, 203.0.113.10');
    assert.equal(other.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('maxKeys capacity preserves active budgets under identity flood', async () => {
  const limiter = rateLimit({
    name: 'global',
    windowMs: 60_000,
    max: 1,
    maxKeys: 5,
    forceInTest: true,
    keyGenerator: (req) => req.actor,
  });

  for (let i = 0; i < 5; i += 1) {
    const req = mockReq();
    req.actor = `actor-${i}`;
    assert.equal((await run(limiter, req, mockRes())).err, null);
  }

  const newcomer = mockReq();
  newcomer.actor = 'actor-new';
  const full = await run(limiter, newcomer, mockRes());
  assert.equal(full.err.statusCode, 429);
  assert.ok(Number(full.res.headers['Retry-After']) >= 1);
  assert.equal(limiter.size(), 5);

  const original = mockReq();
  original.actor = 'actor-0';
  assert.equal((await run(limiter, original, mockRes())).err.statusCode, 429);
});

test('an unchanged full table has bounded traversal work during a rejection burst', async (t) => {
  t.mock.method(Date, 'now', () => 1_000);
  const NativeMap = global.Map;
  let visited = 0;
  function* countEntries(iterator) {
    for (const entry of iterator) {
      visited += 1;
      yield entry;
    }
  }
  class CountingMap extends NativeMap {
    [Symbol.iterator]() { return countEntries(super[Symbol.iterator]()); }
    entries() { return countEntries(super.entries()); }
    values() { return countEntries(super.values()); }
    keys() { return countEntries(super.keys()); }
    forEach(callback, thisArg) {
      return super.forEach((value, key) => {
        visited += 1;
        callback.call(thisArg, value, key, this);
      });
    }
  }

  const maxKeys = 256;
  let limiter;
  // Observe collection work only in this limiter. Restore the constructor
  // before any asynchronous request so unrelated code keeps the native Map.
  try {
    global.Map = CountingMap;
    limiter = rateLimit({
      windowMs: 60_000,
      max: 1,
      maxKeys,
      forceInTest: true,
      keyGenerator: (req) => req.actor,
    });
  } finally {
    global.Map = NativeMap;
  }

  for (let i = 0; i < maxKeys; i += 1) {
    assert.equal((await run(limiter, { actor: `known-${i}` }, mockRes())).err, null);
  }
  visited = 0;
  for (let i = 0; i < 128; i += 1) {
    const { err, res } = await run(limiter, { actor: `new-${i}` }, mockRes());
    assert.equal(err.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '60');
  }
  assert.equal(limiter.size(), maxKeys);
  assert.equal((await run(limiter, { actor: 'known-0' }, mockRes())).err.statusCode, 429);
  // Permit one lazy scan, but reject repeated work proportional to the table
  // size for a burst that cannot release or consume any slot.
  assert.ok(visited <= maxKeys, `${visited} entries visited during unchanged-table rejection`);
});

test('staggered expiry avoids rescanning live budgets at steady-state capacity', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const NativeMap = global.Map;
  let visited = 0;
  class CountingMap extends NativeMap {
    *[Symbol.iterator]() {
      for (const entry of super[Symbol.iterator]()) {
        visited += 1;
        yield entry;
      }
    }
  }

  const maxKeys = 256;
  let limiter;
  try {
    global.Map = CountingMap;
    limiter = rateLimit({
      windowMs: maxKeys * 1000, max: 1, maxKeys, forceInTest: true,
      keyGenerator: (req) => req.actor,
    });
  } finally {
    global.Map = NativeMap;
  }
  const request = (actor) => run(limiter, { actor }, mockRes());
  for (let i = 0; i < maxKeys; i += 1) {
    now = i * 1000;
    assert.equal((await request(`known-${i}`)).err, null);
  }

  visited = 0;
  for (let i = 0; i < 128; i += 1) {
    now = (maxKeys + i) * 1000;
    assert.equal((await request(`new-${i}`)).err, null);
    assert.equal(limiter.size(), maxKeys);
  }
  const survivor = await request(`known-${maxKeys - 1}`);
  assert.equal(survivor.err.statusCode, 429);
  assert.equal(survivor.res.headers['Retry-After'], '128');
  // Allow work proportional to the released identities, not a complete
  // live-table traversal for each individual expiry.
  assert.ok(visited <= maxKeys, `${visited} entries visited for 128 staggered expiries`);
});

test('capacity retry deadlines round up and release only expired budgets', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const limiter = rateLimit({
    windowMs: 10_000, max: 1, maxKeys: 2, forceInTest: true,
    keyGenerator: (req) => req.actor,
  });
  const request = (actor) => run(limiter, { actor }, mockRes());
  assert.equal((await request('a')).err, null);
  now = 5_000;
  assert.equal((await request('b')).err, null);

  now = 9_500;
  let blocked = await request('c');
  assert.equal(blocked.err.statusCode, 429);
  assert.equal(blocked.res.headers['Retry-After'], '2');
  now = 10_001;
  blocked = await request('c');
  assert.equal(blocked.res.headers['Retry-After'], '1');

  now = 11_000;
  assert.equal((await request('a')).err, null);
  assert.equal(limiter.size(), 2);
  blocked = await request('b');
  assert.equal(blocked.err.statusCode, 429);
  assert.equal(blocked.res.headers['Retry-After'], '4');
  now = 15_000;
  assert.equal((await request('c')).err, null);
  assert.equal((await request('a')).err.statusCode, 429);
  assert.equal(limiter.size(), 2);
});

test('renewal below capacity and reset keep retry deadlines correct after clock rollback', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const limiter = rateLimit({
    windowMs: 10_000, max: 1, maxKeys: 2, forceInTest: true,
    keyGenerator: (req) => req.actor,
  });
  const request = (actor) => run(limiter, { actor }, mockRes());
  assert.equal((await request('a')).err, null);
  now = 11_000;
  assert.equal((await request('a')).err, null);
  assert.equal((await request('b')).err, null);
  now = 10_000;
  let blocked = await request('c');
  assert.equal(blocked.err.statusCode, 429);
  assert.equal(blocked.res.headers['Retry-After'], '11');

  now = 20_000;
  limiter.reset();
  assert.equal(limiter.size(), 0);
  assert.equal((await request('a')).err, null);
  assert.equal((await request('b')).err, null);
  blocked = await request('c');
  assert.equal(blocked.err.statusCode, 429);
  assert.equal(blocked.res.headers['Retry-After'], '10');
});

test('a newly admitted earlier window becomes the capacity deadline after clock rollback', async (t) => {
  let now = 11_000;
  t.mock.method(Date, 'now', () => now);
  const limiter = rateLimit({
    windowMs: 10_000, max: 1, maxKeys: 2, forceInTest: true,
    keyGenerator: (req) => req.actor,
  });
  const request = (actor) => run(limiter, { actor }, mockRes());
  assert.equal((await request('a')).err, null);
  now = 1_000;
  assert.equal((await request('b')).err, null);
  const blocked = await request('c');
  assert.equal(blocked.err.statusCode, 429);
  assert.equal(blocked.res.headers['Retry-After'], '10');
  now = 11_000;
  assert.equal((await request('c')).err, null);
  assert.equal((await request('a')).err.statusCode, 429);
});

test('whole-table expiry clears only after the latest deadline and resets cleanly', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const limiter = rateLimit({
    windowMs: 10_000, max: 1, maxKeys: 3, forceInTest: true,
    keyGenerator: (req) => req.actor,
  });
  const request = (actor) => run(limiter, { actor }, mockRes());
  for (const key of ['a', 'b', 'c']) assert.equal((await request(key)).err, null);
  now = 10_999;
  assert.equal((await request('d')).err.statusCode, 429);
  now = 11_000;
  assert.equal((await request('d')).err, null);
  assert.equal(limiter.size(), 1);

  // A newer insertion after a clock rollback must not erase d's live budget.
  now = 1_000;
  for (const key of ['e', 'f']) assert.equal((await request(key)).err, null);
  now = 11_000;
  assert.equal((await request('g')).err, null);
  assert.equal(limiter.size(), 2);
  assert.equal((await request('d')).err.statusCode, 429);
  now = 21_000;
  assert.equal((await request('h')).err, null);
  assert.equal(limiter.size(), 1);

  limiter.reset();
  now = 0;
  assert.equal((await request('i')).err, null);
  now = 10_000;
  assert.equal((await request('j')).err, null);
  assert.equal(limiter.size(), 1);
});

test('correlation id is echoed on success and on 429 without leaking tokens', async () => {
  const app = express();
  app.use(requestId);
  app.use(
    rateLimit({
      name: 'mutation:quote',
      windowMs: 60_000,
      max: 1,
      forceInTest: true,
      keyGenerator: () => 'ip:test',
    })
  );
  app.get('/quote', (req, res) => {
    res.json({ ok: true, correlationId: req.correlationId });
  });
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const first = await fetch(`${base}/quote`, {
      headers: { 'X-Correlation-Id': 'client-corr-1' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-correlation-id'), 'client-corr-1');
    assert.equal(first.headers.get('x-request-id'), 'client-corr-1');
    const firstBody = await first.json();
    assert.equal(firstBody.correlationId, 'client-corr-1');

    const second = await fetch(`${base}/quote`, {
      headers: {
        'X-Correlation-Id': 'client-corr-2',
        Authorization: 'Bearer test-token-admin',
      },
    });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('x-correlation-id'), 'client-corr-2');
    assert.ok(second.headers.get('retry-after'));
    const body = await second.json();
    assert.equal(body.error.status, 429);
    assert.equal(body.error.requestId, 'client-corr-2');
    assert.equal(body.error.details.policy, 'mutation:quote');
    const dumped = JSON.stringify(body);
    assert.ok(!dumped.includes('test-token-admin'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unsafe inbound correlation id is replaced, not echoed', async () => {
  const app = express();
  app.use(requestId);
  app.get('/ping', (req, res) => res.json({ id: req.id }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: { 'X-Request-Id': 'not a safe id' },
    });
    const body = await res.json();
    assert.notEqual(body.id, 'not a safe id');
    assert.equal(res.headers.get('x-request-id'), body.id);
    assert.equal(res.headers.get('x-correlation-id'), body.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('actual app counts parser failures in the global budget and correlates errors', async () => {
  const config = require('../src/config');
  const createApp = require('../src/app');
  const originalMax = config.rateLimit.max;
  const originalBodyLimit = config.bodyLimit;
  const originalEnableInTest = process.env.ENABLE_RATE_LIMIT_IN_TEST;
  let server;

  try {
    config.rateLimit.max = 2;
    config.bodyLimit = '32b';
    process.env.ENABLE_RATE_LIMIT_IN_TEST = '1';
    server = http.createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const malformed = '{"amount":';
    const oversized = JSON.stringify({ note: 'x'.repeat(64) });
    const responses = [];

    for (const [index, payload] of [malformed, oversized, malformed, oversized].entries()) {
      const id = `parser-budget-${index}`;
      const response = await fetch(`${base}/api/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': id },
        body: payload,
      });
      responses.push({ id, response, body: await response.json() });
    }

    assert.deepEqual(responses.map(({ response }) => response.status), [400, 413, 429, 429]);
    for (const { id, response, body } of responses) {
      assert.equal(response.headers.get('x-request-id'), id);
      assert.equal(response.headers.get('x-correlation-id'), id);
      assert.equal(body.error.requestId, id);
      assert.equal(response.headers.get('x-ratelimit-policy'), 'global');
      if (response.status === 429) {
        assert.ok(Number(response.headers.get('retry-after')) >= 1);
        assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
        assert.equal(body.error.details.policy, 'global');
      }
    }
  } finally {
    config.rateLimit.max = originalMax;
    config.bodyLimit = originalBodyLimit;
    if (originalEnableInTest === undefined) delete process.env.ENABLE_RATE_LIMIT_IN_TEST;
    else process.env.ENABLE_RATE_LIMIT_IN_TEST = originalEnableInTest;
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
