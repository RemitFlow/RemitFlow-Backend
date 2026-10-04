'use strict';

/**
 * Tamper-evident, queryable audit storage (issue #127).
 *
 * Covers:
 *   - integrity-chain verification and tamper detection (original failure mode)
 *   - redaction of secrets from stored / returned changes
 *   - duplicate-event suppression for the same privileged mutation
 *   - query authorization (audit:read scope)
 *   - correlation / attribution filters without exposing secrets
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const createApp = require('../src/app');
const config = require('../src/config');
const { reset } = require('../src/store');
const auditService = require('../src/services/auditService');
const transferService = require('../src/services/transferService');
const { REDACTED, computeEntryHash, GENESIS_HASH } = require('../src/utils/auditCrypto');

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

function auth(token) {
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

const TRANSFER = {
  senderName: 'Alice',
  recipientName: 'Bob',
  amount: 50,
  from: 'USD',
  to: 'INR',
};

// ─── Integrity chain ──────────────────────────────────────────────────────────

test('integrity-chain: successive entries link via prevHash and verify clean', () => {
  const a = auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-1',
    requestId: 'req-1',
    actor: 'test-token-admin',
  });
  const b = auditService.addEntry({
    action: 'transfer.claimed',
    resourceId: 'txn-1',
    requestId: 'req-2',
    actor: 'test-token-admin',
  });

  assert.equal(a.chainSeq, 0);
  assert.equal(a.prevHash, GENESIS_HASH);
  assert.equal(b.chainSeq, 1);
  assert.equal(b.prevHash, a.entryHash);
  assert.notEqual(a.entryHash, b.entryHash);
  assert.equal(a.entryHash, computeEntryHash(a, GENESIS_HASH));

  const report = auditService.verifyIntegrity();
  assert.equal(report.valid, true);
  assert.equal(report.checked, 2);
  assert.equal(report.tipHash, b.entryHash);
  assert.equal(report.brokenAt, null);
});

test('REGRESSION: silent field edit on an audit record is detectable', () => {
  // Original failure mode: an investigator cannot trust an audit trail if a
  // record can be changed without leaving evidence. Mutating a stored field
  // must break the hash chain.
  auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-tamper',
    payload: { sendAmount: 10 },
    requestId: 'req-tamper',
    actor: 'test-token-admin',
  });
  auditService.addEntry({
    action: 'transfer.cancelled',
    resourceId: 'txn-tamper',
    requestId: 'req-tamper-2',
    actor: 'test-token-admin',
  });

  assert.equal(auditService.verifyIntegrity().valid, true);

  const [newest] = auditService.getEntries();
  newest.action = 'transfer.claimed'; // silent rewrite

  const report = auditService.verifyIntegrity();
  assert.equal(report.valid, false);
  assert.equal(report.brokenAt, newest.chainSeq);
  assert.match(report.reason, /entryHash mismatch/);
});

for (const [field, value] of [
  ['resourceId', 'txn-reassigned'],
  ['requestId', 'req-reassigned'],
  ['payload', { sendAmount: 999999 }],
]) {
  test(`integrity endpoint detects a reassigned ${field} compatibility alias`, async () => {
    const entry = auditService.addEntry({
      action: 'transfer.created',
      resourceId: 'txn-alias',
      requestId: 'req-alias',
      payload: { sendAmount: 10 },
    });
    const originalHash = entry.entryHash;
    entry[field] = value;

    const listing = await fetchJson('/api/audit', { headers: auth('test-token-admin') });
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.entries[0][field], value);

    const report = await fetchJson('/api/audit/integrity', { headers: auth('test-token-admin') });
    assert.equal(report.status, 200);
    assert.equal(report.body.valid, false);
    assert.equal(report.body.brokenAt, entry.chainSeq);
    assert.match(report.body.reason, /compatibility alias mismatch/);
    assert.equal(entry.entryHash, originalHash);
  });
}

test('equivalent payload copies retain the existing hash and valid integrity', () => {
  const entry = auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-alias-copy',
    payload: { sendAmount: 10, currency: 'USD' },
  });
  const originalHash = entry.entryHash;
  entry.payload = { currency: 'USD', sendAmount: 10 };

  assert.notEqual(entry.payload, entry.changes);
  assert.equal(computeEntryHash(entry, entry.prevHash), originalHash);
  assert.equal(auditService.verifyIntegrity().valid, true);
});

test('REGRESSION: broken predecessor link is detectable', () => {
  auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-a',
    requestId: 'req-a',
  });
  const second = auditService.addEntry({
    action: 'transfer.claimed',
    resourceId: 'txn-a',
    requestId: 'req-b',
  });

  second.prevHash = GENESIS_HASH; // pretend the first entry never happened

  const report = auditService.verifyIntegrity();
  assert.equal(report.valid, false);
  assert.match(report.reason, /prevHash mismatch/);
});

// ─── Redaction ────────────────────────────────────────────────────────────────

test('redaction: sensitive keys are stripped from stored changes', () => {
  const entry = auditService.addEntry({
    action: 'admin.config_changed',
    resourceId: 'cfg-1',
    requestId: 'req-redact',
    actor: 'test-token-admin',
    changes: {
      feePercent: 1.5,
      apiKey: 'super-secret-key',
      nested: { token: 'abc', safe: true },
      authorization: 'Bearer leaked',
    },
  });

  assert.equal(entry.changes.feePercent, 1.5);
  assert.equal(entry.changes.apiKey, REDACTED);
  assert.equal(entry.changes.nested.token, REDACTED);
  assert.equal(entry.changes.nested.safe, true);
  assert.equal(entry.changes.authorization, REDACTED);
  // Compat alias stays in sync with the redacted view.
  assert.deepEqual(entry.payload, entry.changes);
  // Raw secret must not survive anywhere on the entry.
  assert.equal(JSON.stringify(entry).includes('super-secret-key'), false);
});

test('redaction: HTTP list responses never expose secrets', async () => {
  auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-secret',
    requestId: 'req-secret',
    actor: 'test-token-admin',
    changes: { sendAmount: 42, secret: 'should-not-leak', password: 'nope' },
  });

  const { status, body } = await fetchJson('/api/audit?resourceId=txn-secret', {
    headers: auth('test-token-admin'),
  });

  assert.equal(status, 200);
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].changes.secret, REDACTED);
  assert.equal(body.entries[0].changes.password, REDACTED);
  assert.equal(body.entries[0].changes.sendAmount, 42);
  assert.equal(JSON.stringify(body).includes('should-not-leak'), false);
});

// ─── Duplicate-event suppression ──────────────────────────────────────────────

test('duplicate-event: same action/target/correlation/outcome records once', () => {
  const first = auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-dup',
    requestId: 'corr-dup',
    actor: 'test-token-admin',
    outcome: 'success',
    payload: { sendAmount: 1 },
  });
  const second = auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-dup',
    requestId: 'corr-dup',
    actor: 'test-token-admin',
    outcome: 'success',
    payload: { sendAmount: 99 },
  });

  assert.equal(second.id, first.id);
  assert.equal(auditService.getEntries().length, 1);
  assert.equal(first.changes.sendAmount, 1, 'first-write wins; retry must not rewrite');
  assert.equal(auditService.verifyIntegrity().valid, true);
});

test('duplicate-event: a different correlation id still appends', () => {
  auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-dup-2',
    requestId: 'corr-1',
    outcome: 'success',
  });
  auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-dup-2',
    requestId: 'corr-2',
    outcome: 'success',
  });
  assert.equal(auditService.getEntries().length, 2);
});

test('duplicate-event: privileged transfer create emits one outcome under retry', () => {
  const first = transferService.createTransfer(TRANSFER, 'corr-idem', {
    actor: 'test-token-admin',
    key: 'idem-audit-1',
    fingerprint: 'fp-audit-1',
  });
  // Force a second audit attempt with the same correlation id (simulates a
  // client that retried past the idempotency layer and hit addEntry again).
  const replayed = auditService.addEntry({
    action: 'transfer.created',
    resourceId: first.id,
    requestId: 'corr-idem',
    actor: 'test-token-admin',
    outcome: 'success',
  });

  const created = auditService.getEntries().filter((e) => e.action === 'transfer.created');
  assert.equal(created.length, 1);
  assert.equal(replayed.id, created[0].id);
});

test('duplicate-event: repeated archive cycles retain every outcome under one correlation id', async () => {
  const created = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: {
      ...auth('test-token-admin'),
      'Content-Type': 'application/json',
      'Idempotency-Key': 'archive-cycle-audit',
      'X-Request-Id': 'archive-cycle-create',
    },
    body: JSON.stringify(TRANSFER),
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const correlationId = 'shared-archive-workflow';
  const mutations = [];

  for (const actor of ['test-token-admin', 'test-token-transfers', 'test-token-admin']) {
    for (const action of ['archive', 'unarchive']) {
      const path = `/api/transfers/${id}/${action}`;
      const options = {
        method: 'POST',
        headers: { ...auth(actor), 'X-Request-Id': correlationId },
      };
      const changed = await fetchJson(path, options);
      assert.equal(changed.status, 200);
      mutations.push({
        action: `transfer.${action}d`,
        actor: auditService.actorRef(actor),
        mutationId: changed.body.updatedAt,
      });
      if (action === 'archive') {
        const noop = await fetchJson(path, options);
        assert.equal(noop.status, 200);
        assert.equal(noop.body.updatedAt, changed.body.updatedAt);
      }
    }
  }

  const query = new URLSearchParams({ resourceId: id, correlationId, order: 'asc' });
  const listed = await fetchJson(`/api/audit?${query}`, { headers: auth('test-token-admin') });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.entries.length, 6, 'every state change needs its own outcome');
  assert.deepEqual(listed.body.entries.map(({ action, actor, mutationId }) => ({ action, actor, mutationId })), mutations);
  assert.equal(new Set(listed.body.entries.map((entry) => entry.mutationId)).size, 6);
  assert.ok(listed.body.entries.every((entry) => entry.correlationId === correlationId && entry.requestId === correlationId));
  assert.equal(JSON.stringify(listed.body).includes('test-token-'), false);

  const integrity = await fetchJson('/api/audit/integrity', { headers: auth('test-token-admin') });
  assert.equal(integrity.status, 200);
  assert.equal(integrity.body.valid, true);
  assert.equal(integrity.body.checked, 7, 'one creation and six state changes; archive no-ops add nothing');
});

test('mutation identity preserves first-write wins and isolates actor, scope, and state change', () => {
  const command = {
    action: 'transfer.archived',
    resourceId: 'txn-mutation-identity',
    requestId: 'shared-correlation',
    actor: 'test-token-admin',
    mutationId: 'version-1',
  };
  const first = auditService.addEntry({ ...command, changes: { archivedAt: 'first' } });
  const replay = auditService.addEntry({
    ...command,
    actor: auditService.actorRef(command.actor),
    scope: 'transfers',
    changes: { archivedAt: 'must-not-rewrite' },
  });
  assert.equal(replay.id, first.id);
  assert.equal(replay.changes.archivedAt, 'first');

  const otherActor = auditService.addEntry({ ...command, actor: 'test-token-transfers' });
  const otherScope = auditService.addEntry({ ...command, scope: 'admin' });
  const laterMutation = auditService.addEntry({ ...command, mutationId: 'version-2' });
  assert.equal(new Set([first.id, otherActor.id, otherScope.id, laterMutation.id]).size, 4);
  assert.equal(auditService.countEntries(), 4);
  assert.equal(auditService.verifyIntegrity().valid, true);
});

test('integrity-chain: mutation ID tampering is detected', () => {
  const entry = auditService.addEntry({
    action: 'transfer.unarchived',
    resourceId: 'txn-mutation-tamper',
    requestId: 'corr-mutation-tamper',
    mutationId: 'version-1',
  });
  assert.equal(auditService.verifyIntegrity().valid, true);
  entry.mutationId = 'version-2';
  const report = auditService.verifyIntegrity();
  assert.equal(report.valid, false);
  assert.equal(report.brokenAt, 0);
  assert.match(report.reason, /entryHash mismatch/);
});

// ─── Query authorization ──────────────────────────────────────────────────────

test('query authorization: missing token is 401', async () => {
  const { status, body } = await fetchJson('/api/audit');
  assert.equal(status, 401);
  assert.equal(body.error.status, 401);
});

test('query authorization: token without audit:read is 403', async () => {
  const { status, body } = await fetchJson('/api/audit', {
    headers: auth('test-token-transfers'),
  });
  assert.equal(status, 403);
  assert.equal(body.error.status, 403);
});

test('query authorization: integrity endpoint requires audit:read', async () => {
  const denied = await fetchJson('/api/audit/integrity', {
    headers: auth('test-token-transfers'),
  });
  assert.equal(denied.status, 403);

  const allowed = await fetchJson('/api/audit/integrity', {
    headers: auth('test-token-readonly'),
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.valid, true);
  assert.equal(typeof allowed.body.tipHash, 'string');
});

// ─── Correlation / attribution filters ────────────────────────────────────────

for (const token of ['actor:test-only-secret', 'actor:0123456789abcdef', 'system']) {
  test(`raw credentials resembling actor references are fingerprinted: ${token}`, async (t) => {
    const previous = config.apiTokens[token];
    const hadToken = Object.hasOwn(config.apiTokens, token);
    config.apiTokens[token] = ['transfers:read', 'transfers:write', 'users:read', 'users:write', 'audit:read'];
    t.after(() => {
      if (hadToken) config.apiTokens[token] = previous;
      else delete config.apiTokens[token];
    });

    const request = (path, method = 'GET', body, key) => fetchJson(path, {
      method,
      headers: {
        ...auth(token),
        'Content-Type': 'application/json',
        'X-Request-Id': 'actor-credential-workflow',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const first = await request('/api/transfers', 'POST', TRANSFER, 'actor-first');
    assert.equal(first.status, 201);
    const id = first.body.id;
    for (const action of ['archive', 'unarchive', 'cancel']) {
      const response = await request(`/api/transfers/${id}/${action}`, 'POST');
      assert.equal(response.status, 200);
    }
    const second = await request('/api/transfers', 'POST', TRANSFER, 'actor-second');
    assert.equal(second.status, 201);
    assert.equal((await request(`/api/transfers/${second.body.id}/claim`, 'POST')).status, 200);
    const user = await request('/api/users', 'POST', {
      name: 'Audit Profile', email: 'audit-profile@example.invalid', country: 'US',
    });
    assert.equal(user.status, 201);

    const replay = await request('/api/transfers', 'POST', TRANSFER, 'actor-first');
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, id);

    const expectedActor = auditService.actorRef(token);
    const stored = auditService.getEntries();
    assert.equal(stored.length, 7, 'replay must not append another outcome');
    assert.ok(stored.every((entry) => entry.actor === expectedActor));
    assert.equal(JSON.stringify(stored).includes(token), false);

    const listed = await request('/api/audit?order=asc');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.entries.length, 7);
    assert.ok(listed.body.entries.every((entry) => entry.actor === expectedActor));
    assert.equal(JSON.stringify(listed.body.entries).includes(token), false);
    const filtered = await request(`/api/audit?actor=${encodeURIComponent(expectedActor)}`);
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.entries.length, 7);
    assert.equal((await request('/api/audit/integrity')).body.valid, true);
  });
}

test('correlation: entries carry actor fingerprint, scope, outcome, correlationId', () => {
  const entry = auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-corr',
    requestId: 'corr-xyz',
    actor: 'test-token-admin',
    outcome: 'success',
    payload: { sendAmount: 5 },
  });

  assert.equal(entry.correlationId, 'corr-xyz');
  assert.equal(entry.requestId, 'corr-xyz');
  assert.equal(entry.target, 'txn-corr');
  assert.equal(entry.resourceId, 'txn-corr');
  assert.equal(entry.scope, 'transfers');
  assert.equal(entry.outcome, 'success');
  assert.match(entry.actor, /^actor:[0-9a-f]{16}$/);
  assert.equal(entry.actor.includes('test-token-admin'), false);
});

test('correlation: operators can filter by correlationId and scope', async () => {
  auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-f1',
    requestId: 'corr-filter',
    actor: 'test-token-admin',
  });
  auditService.addEntry({
    action: 'user.created',
    resourceId: 'usr-f1',
    requestId: 'corr-other',
    actor: 'test-token-admin',
  });
  auditService.addEntry({
    action: 'transfer.claimed',
    resourceId: 'txn-f1',
    requestId: 'corr-filter',
    actor: 'test-token-readonly',
  });

  const byCorr = await fetchJson('/api/audit?correlationId=corr-filter', {
    headers: auth('test-token-admin'),
  });
  assert.equal(byCorr.status, 200);
  assert.equal(byCorr.body.entries.length, 2);
  assert.ok(byCorr.body.entries.every((e) => e.correlationId === 'corr-filter'));

  const byScope = await fetchJson('/api/audit?scope=users', {
    headers: auth('test-token-admin'),
  });
  assert.equal(byScope.status, 200);
  assert.equal(byScope.body.entries.length, 1);
  assert.equal(byScope.body.entries[0].action, 'user.created');

  // Actor fingerprints differ across tokens; filtering by one excludes the other.
  const adminActor = auditService.getEntries().find((e) => e.action === 'transfer.created').actor;
  const byActor = await fetchJson(`/api/audit?actor=${encodeURIComponent(adminActor)}`, {
    headers: auth('test-token-admin'),
  });
  assert.equal(byActor.status, 200);
  assert.ok(byActor.body.entries.length >= 1);
  assert.ok(byActor.body.entries.every((e) => e.actor === adminActor));
  assert.equal(JSON.stringify(byActor.body).includes('test-token-admin'), false);
});

test('privileged archive/unarchive mutations each emit one outcome event', () => {
  const transfer = transferService.createTransfer(TRANSFER, 'corr-arch-create', {
    actor: 'test-token-admin',
    key: 'idem-arch',
    fingerprint: 'fp-arch',
  });

  transferService.archiveTransfer(transfer.id, 'corr-arch', 'test-token-admin');
  transferService.archiveTransfer(transfer.id, 'corr-arch', 'test-token-admin'); // idempotent no-op

  const archived = auditService.getEntries().filter((e) => e.action === 'transfer.archived');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].outcome, 'success');
  assert.equal(archived[0].correlationId, 'corr-arch');

  transferService.unarchiveTransfer(transfer.id, 'corr-unarch', 'test-token-admin');
  const unarchived = auditService.getEntries().filter((e) => e.action === 'transfer.unarchived');
  assert.equal(unarchived.length, 1);
  assert.equal(auditService.verifyIntegrity().valid, true);
});

// A failed adapter call must not strand a pending transfer as already claimed.
test('claim failure: preserves state and records a redacted attributable outcome', (t) => {
  const stellar = require('../src/services/stellarService');
  const row = transferService.createTransfer(TRANSFER, 'failure-create');
  const snapshot = JSON.parse(JSON.stringify(row));
  const failure = new Error('private provider token=do-not-retain');
  t.mock.method(stellar, 'createClaimableBalanceId', () => { throw failure; });

  assert.throws(() => transferService.claimTransfer(row.id, 'failed-claim', 'test-token-admin'),
    (err) => err === failure);
  assert.deepEqual(row, snapshot);
  const entries = auditService.getEntries().filter((e) => e.action === 'transfer.claimed');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, 'failure');
  assert.equal(entries[0].correlationId, 'failed-claim');
  assert.equal(entries[0].target, row.id);
  assert.equal(entries[0].scope, 'transfers');
  assert.equal(entries[0].actor, auditService.actorRef('test-token-admin'));
  assert.deepEqual(entries[0].changes, { stage: 'claim', code: 'CLAIM_ADAPTER_FAILED' });
  const encoded = JSON.stringify(entries);
  assert.equal(encoded.includes('test-token-admin'), false);
  assert.equal(encoded.includes('do-not-retain'), false);
  assert.equal(auditService.verifyIntegrity().valid, true);
});

test('claim failure: same-correlation recovery has one failure and one success', (t) => {
  const stellar = require('../src/services/stellarService');
  const row = transferService.createTransfer(TRANSFER, 'retry-create');
  const failure = new Error('temporary adapter failure');
  let fail = true;
  let calls = 0;
  t.mock.method(stellar, 'createClaimableBalanceId', () => {
    calls += 1;
    if (fail) throw failure;
    return 'cb-recovered';
  });
  for (let i = 0; i < 2; i += 1) {
    assert.throws(() => transferService.claimTransfer(row.id, 'retry-claim', 'test-token-admin'),
      (err) => err === failure);
  }
  fail = false;
  const recovered = transferService.claimTransfer(row.id, 'retry-claim', 'test-token-admin');
  assert.equal(recovered.status, 'claimed');
  assert.equal(recovered.claimableBalanceId, 'cb-recovered');
  assert.equal(calls, 3);
  const entries = auditService.getEntries().filter((e) => e.action === 'transfer.claimed');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.outcome), ['success', 'failure']);
  assert.equal(auditService.verifyIntegrity().valid, true);
});

test('claim failure: terminal and missing targets never call the adapter', (t) => {
  const stellar = require('../src/services/stellarService');
  const row = transferService.createTransfer(TRANSFER, 'terminal-create');
  transferService.cancelTransfer(row.id, 'cancel-before-claim', 'test-token-admin');
  const adapter = t.mock.method(stellar, 'createClaimableBalanceId', () => 'unexpected');
  assert.throws(() => transferService.claimTransfer(row.id, 'terminal-claim', 'test-token-admin'));
  assert.throws(() => transferService.claimTransfer('missing', 'missing-claim', 'test-token-admin'));
  assert.equal(adapter.mock.callCount(), 0);
  assert.equal(row.status, 'cancelled');
  assert.equal(auditService.getEntries().filter((e) => e.action === 'transfer.claimed').length, 0);
  assert.equal(auditService.verifyIntegrity().valid, true);
});
