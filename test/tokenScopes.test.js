'use strict';

/**
 * Scope enforcement regressions for issue #125.
 *
 * Covers:
 *   - Scope matrix (documented route → required scopes)
 *   - Cross-account / cross-surface isolation (transfers token cannot touch admin/audit/users writes)
 *   - Bulk-route authorization and non-enumerating per-id results
 *   - Malformed-ID handling (identical 404 to missing ids)
 *   - Audit authorization
 *   - Service-boundary enforcement (direct service calls with under-scoped auth)
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const createApp = require('../src/app');
const { reset } = require('../src/store');
const config = require('../src/config');
const { SCOPES, ALL_SCOPES, SCOPE_MATRIX } = require('../src/config/scopes');
const transferService = require('../src/services/transferService');
const auditService = require('../src/services/auditService');
const { TRANSFER_NOT_FOUND_MESSAGE } = require('../src/utils/authz');

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
  if (server) server.close();
});

beforeEach(() => {
  reset();
});

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function createTransfer(token, suffix) {
  const { status, body } = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: {
      ...authHeader(token),
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-scopes-${suffix}`,
    },
    body: JSON.stringify({
      senderName: 'Alice',
      recipientName: 'Bob',
      amount: 100,
      from: 'USD',
      to: 'EUR',
    }),
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body;
}

// ─── Scope matrix ─────────────────────────────────────────────────────────────

test('scope catalog only contains documented resource:action values', () => {
  for (const scope of ALL_SCOPES) {
    assert.match(scope, /^[a-z]+:[a-z]+$/);
  }
  assert.ok(ALL_SCOPES.includes(SCOPES.ADMIN_READ));
  assert.ok(ALL_SCOPES.includes(SCOPES.TRANSFERS_WRITE));
});

test('scope matrix lists every secured surface exactly once per route', () => {
  const keys = SCOPE_MATRIX.map((row) => `${row.method} ${row.path}`);
  assert.equal(keys.length, new Set(keys).size);
  const surfaces = new Set(SCOPE_MATRIX.map((row) => row.surface));
  for (const needed of ['direct', 'list', 'bulk', 'admin']) {
    assert.ok(surfaces.has(needed), `missing surface ${needed}`);
  }
  for (const row of SCOPE_MATRIX) {
    for (const scope of row.scopes) {
      assert.ok(ALL_SCOPES.includes(scope), `unknown scope ${scope} on ${row.path}`);
    }
  }
});

test('demo admin token holds every catalogued scope including admin:read', () => {
  const scopes = config.apiTokens['test-token-admin'];
  for (const scope of ALL_SCOPES) {
    assert.ok(scopes.includes(scope), `admin demo token missing ${scope}`);
  }
});

test('scope matrix: readonly token is rejected on every write and admin row', async () => {
  const created = await createTransfer('test-token-admin', 'matrix-setup');

  const cases = [
    { method: 'POST', path: '/api/transfers', body: { senderName: 'A', recipientName: 'B', amount: 1, from: 'USD', to: 'EUR' }, key: 'm1' },
    { method: 'POST', path: `/api/transfers/${created.id}/claim`, body: null, key: null },
    { method: 'POST', path: `/api/transfers/${created.id}/cancel`, body: null, key: null },
    { method: 'POST', path: '/api/transfers/bulk', body: { action: 'claim', ids: [created.id] }, key: null },
    { method: 'POST', path: '/api/users', body: { name: 'X', email: 'x@example.com' }, key: null },
    { method: 'GET', path: '/api/admin/diagnostics', body: null, key: null },
  ];

  for (const item of cases) {
    const headers = { ...authHeader('test-token-readonly') };
    if (item.body) headers['Content-Type'] = 'application/json';
    if (item.key) headers['Idempotency-Key'] = `idem-matrix-${item.key}`;
    const { status, body } = await fetchJson(item.path, {
      method: item.method,
      headers,
      body: item.body ? JSON.stringify(item.body) : undefined,
    });
    assert.equal(status, 403, `${item.method} ${item.path} => ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error.message, 'Insufficient token scopes');
  }
});

// ─── Cross-account / cross-surface ────────────────────────────────────────────

test('cross-account: transfers-only token cannot read audit or users or admin', async () => {
  const token = 'test-token-transfers';

  for (const path of ['/api/audit', '/api/users', '/api/admin/diagnostics']) {
    const { status, body } = await fetchJson(path, { headers: authHeader(token) });
    if (path === '/api/admin/diagnostics') {
      // adminAuth returns 401 for an API token that lacks admin:read (token is
      // recognised but under-scoped → 403).
      assert.ok([401, 403].includes(status), `${path} => ${status}`);
      if (status === 403) {
        assert.equal(body.error.message, 'Insufficient token scopes');
      }
    } else {
      assert.equal(status, 403, `${path} => ${status}`);
      assert.equal(body.error.message, 'Insufficient token scopes');
    }
  }
});

test('cross-account: transfers-only token cannot create users', async () => {
  const { status, body } = await fetchJson('/api/users', {
    method: 'POST',
    headers: { ...authHeader('test-token-transfers'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Eve', email: 'eve@example.com' }),
  });
  assert.equal(status, 403);
  assert.equal(body.error.message, 'Insufficient token scopes');
});

test('cross-account: admin diagnostics rejects a foreign bearer that is not the admin key and lacks admin:read', async () => {
  const { status, body } = await fetchJson('/api/admin/diagnostics', {
    headers: authHeader('test-token-readonly'),
  });
  assert.equal(status, 403);
  assert.equal(body.error.message, 'Insufficient token scopes');
});

test('admin path accepts scoped API token with admin:read', async () => {
  const { status, body } = await fetchJson('/api/admin/diagnostics', {
    headers: authHeader('test-token-admin'),
  });
  assert.equal(status, 200);
  assert.ok(body.system);
  assert.ok(body.stats);
});

test('admin path still accepts legacy X-Admin-Token and maps it to admin:read', async () => {
  const { status, body } = await fetchJson('/api/admin/diagnostics', {
    headers: { 'X-Admin-Token': config.adminApiKey },
  });
  assert.equal(status, 200);
  assert.ok(body.system);
});

// ─── Bulk route ───────────────────────────────────────────────────────────────

test('bulk route requires transfers:write', async () => {
  const { status } = await fetchJson('/api/transfers/bulk', {
    method: 'POST',
    headers: { ...authHeader('test-token-readonly'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'claim', ids: ['txn_00000000-0000-4000-8000-000000000001'] }),
  });
  assert.equal(status, 403);
});

for (const [index, action] of [
  'constructor',
  'toString',
  '__proto__',
  ['cancel'],
  { toString: null },
].entries()) {
  test(`bulk route rejects action ${JSON.stringify(action)} without mutation`, async () => {
    const transfer = await createTransfer('test-token-transfers', `bulk-invalid-${index}`);
    const { status, body } = await fetchJson('/api/transfers/bulk', {
      method: 'POST',
      headers: { ...authHeader('test-token-transfers'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ids: [transfer.id] }),
    });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.error.status, 400);

    const current = await fetchJson(`/api/transfers/${transfer.id}`, {
      headers: authHeader('test-token-transfers'),
    });
    assert.equal(current.status, 200);
    assert.deepEqual(current.body, transfer);
  });
}

test('bulk route preserves documented archive, unarchive and cancel actions', async () => {
  const transfer = await createTransfer('test-token-transfers', 'bulk-valid-actions');
  for (const action of ['archive', 'unarchive', 'cancel']) {
    const { status, body } = await fetchJson('/api/transfers/bulk', {
      method: 'POST',
      headers: { ...authHeader('test-token-transfers'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ids: [transfer.id] }),
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].transfer.id, transfer.id);
    assert.equal(body.results[0].transfer.status, action === 'cancel' ? 'cancelled' : 'pending');
    assert.equal(Boolean(body.results[0].transfer.archivedAt), action === 'archive');
  }
});

test('bulk route claims and cancels with non-enumerating per-id errors', async () => {
  const a = await createTransfer('test-token-transfers', 'bulk-a');
  const b = await createTransfer('test-token-transfers', 'bulk-b');

  const { status, body } = await fetchJson('/api/transfers/bulk', {
    method: 'POST',
    headers: { ...authHeader('test-token-transfers'), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'claim',
      ids: [a.id, 'txn_not-a-uuid', 'totally-wrong', b.id],
    }),
  });
  assert.equal(status, 200);
  assert.equal(body.results.length, 4);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].transfer.status, 'claimed');
  assert.equal(body.results[1].ok, false);
  assert.equal(body.results[1].error.code, 'not_found');
  assert.equal(body.results[1].error.status, 404);
  assert.equal(body.results[1].error.message, TRANSFER_NOT_FOUND_MESSAGE);
  assert.equal(body.results[2].ok, false);
  assert.equal(body.results[2].error.code, 'not_found');
  assert.equal(body.results[2].error.message, TRANSFER_NOT_FOUND_MESSAGE);
  assert.equal(body.results[3].ok, true);

  // Identical error shape for malformed vs missing: no enumeration signal.
  assert.deepEqual(
    { ...body.results[1].error, message: body.results[1].error.message },
    { ...body.results[2].error, message: body.results[2].error.message }
  );
});

test('bulk cancel returns conflict code without leaking sibling outcomes', async () => {
  const transfer = await createTransfer('test-token-transfers', 'bulk-cancel');
  await fetchJson(`/api/transfers/${transfer.id}/claim`, {
    method: 'POST',
    headers: authHeader('test-token-transfers'),
  });

  const { status, body } = await fetchJson('/api/transfers/bulk', {
    method: 'POST',
    headers: { ...authHeader('test-token-transfers'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cancel', ids: [transfer.id] }),
  });
  assert.equal(status, 200);
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].error.code, 'conflict');
  assert.equal(body.results[0].error.status, 409);
});

// ─── Malformed ID ─────────────────────────────────────────────────────────────

test('malformed and missing transfer ids both return identical 404 bodies', async () => {
  const probes = [
    'not-an-id',
    'txn_short',
    'txn_00000000-0000-4000-8000-000000000099', // well-formed but absent
    'txn_../etc/passwd',
  ];

  const shapes = [];
  for (const id of probes) {
    const path = `/api/transfers/${encodeURIComponent(id)}`;
    const { status, body } = await fetchJson(path, {
      headers: authHeader('test-token-readonly'),
    });
    assert.equal(status, 404, `id=${id}`);
    assert.equal(body.error.status, 404);
    assert.equal(body.error.message, TRANSFER_NOT_FOUND_MESSAGE);
    shapes.push(body.error.message);
  }
  assert.ok(shapes.every((m) => m === shapes[0]));
});

test('malformed id on claim matches missing-id 404 (non-enumerating)', async () => {
  const malformed = await fetchJson('/api/transfers/txn_nope/claim', {
    method: 'POST',
    headers: authHeader('test-token-transfers'),
  });
  const missing = await fetchJson(
    '/api/transfers/txn_00000000-0000-4000-8000-000000000042/claim',
    {
      method: 'POST',
      headers: authHeader('test-token-transfers'),
    }
  );
  assert.equal(malformed.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(malformed.body.error.message, missing.body.error.message);
  assert.equal(malformed.body.error.message, TRANSFER_NOT_FOUND_MESSAGE);
});

// ─── Audit authorization ──────────────────────────────────────────────────────

test('audit authorization: missing token → 401, wrong scope → 403, ok → 200', async () => {
  const noToken = await fetchJson('/api/audit');
  assert.equal(noToken.status, 401);

  const wrong = await fetchJson('/api/audit', {
    headers: authHeader('test-token-transfers'),
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.message, 'Insufficient token scopes');

  const ok = await fetchJson('/api/audit', {
    headers: authHeader('test-token-readonly'),
  });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.entries));
});

test('audit service boundary rejects under-scoped auth context', () => {
  assert.throws(
    () => auditService.getEntries({ actor: 'x', scopes: [SCOPES.TRANSFERS_READ] }),
    (err) => err.statusCode === 403
  );
  assert.doesNotThrow(() =>
    auditService.getEntries({ actor: 'x', scopes: [SCOPES.AUDIT_READ] })
  );
  // Internal callers without auth still work.
  assert.doesNotThrow(() => auditService.getEntries());
});

// ─── Service-boundary enforcement ─────────────────────────────────────────────

test('transfer service boundary rejects under-scoped auth on write and read', () => {
  const transfer = transferService.createTransfer({
    senderName: 'A',
    recipientName: 'B',
    amount: 10,
    from: 'USD',
    to: 'EUR',
  });

  assert.throws(
    () =>
      transferService.claimTransfer(transfer.id, 'req', {
        actor: 'ro',
        scopes: [SCOPES.TRANSFERS_READ],
      }),
    (err) => err.statusCode === 403 && /Insufficient token scopes/.test(err.message)
  );

  assert.throws(
    () =>
      transferService.getTransferOrThrow(transfer.id, {
        actor: 'w',
        scopes: [SCOPES.TRANSFERS_WRITE],
      }),
    (err) => err.statusCode === 403
  );

  assert.doesNotThrow(() =>
    transferService.getTransferOrThrow(transfer.id, {
      actor: 'r',
      scopes: [SCOPES.TRANSFERS_READ],
    })
  );
});

test('cursor position helpers reject explicitly under-scoped service callers', () => {
  assert.throws(
    () => transferService.positionKeyAt(0, {
      actor: 'w',
      scopes: [SCOPES.TRANSFERS_WRITE],
    }),
    (err) => err.statusCode === 403
  );
  assert.throws(
    () => auditService.positionKeyAt(0, null, {
      actor: 't',
      scopes: [SCOPES.TRANSFERS_READ],
    }),
    (err) => err.statusCode === 403
  );

  assert.doesNotThrow(() =>
    transferService.positionKeyAt(0, {
      actor: 'r',
      scopes: [SCOPES.TRANSFERS_READ],
    })
  );
  assert.doesNotThrow(() =>
    auditService.positionKeyAt(0, null, {
      actor: 'a',
      scopes: [SCOPES.AUDIT_READ],
    })
  );
  // Trusted internal callers without auth remain compatible.
  assert.doesNotThrow(() => transferService.positionKeyAt(0));
  assert.doesNotThrow(() => auditService.positionKeyAt(0));
});

test('service boundary: malformed id throws the same not-found error as a miss', () => {
  const malformed = () => transferService.getTransferOrThrow('txn_bad', {
    actor: 'r',
    scopes: [SCOPES.TRANSFERS_READ],
  });
  const missing = () =>
    transferService.getTransferOrThrow('txn_00000000-0000-4000-8000-000000000077', {
      actor: 'r',
      scopes: [SCOPES.TRANSFERS_READ],
    });

  for (const fn of [malformed, missing]) {
    assert.throws(fn, (err) => {
      return err.statusCode === 404 && err.message === TRANSFER_NOT_FOUND_MESSAGE;
    });
  }
});

test('regression: a transfers:write token still cannot hit admin diagnostics', async () => {
  const { status, body } = await fetchJson('/api/admin/diagnostics', {
    headers: authHeader('test-token-transfers'),
  });
  assert.equal(status, 403);
  assert.equal(body.error.message, 'Insufficient token scopes');
});
