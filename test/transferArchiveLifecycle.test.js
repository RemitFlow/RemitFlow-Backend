'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.NODE_ENV = 'test';

const { reset } = require('../src/store');
const transferService = require('../src/services/transferService');
const auditService = require('../src/services/auditService');
const ApiError = require('../src/utils/ApiError');
const config = require('../src/config');
const createApp = require('../src/app');

beforeEach(() => {
  reset();
});

function createSample() {
  return transferService.createTransfer({
    senderName: 'Alice',
    recipientName: 'Bob',
    amount: 100,
    from: 'USD',
    to: 'EUR',
  });
}

function assertStrictlyIncreasing(timestamps) {
  for (let i = 1; i < timestamps.length; i += 1) {
    assert.ok(
      timestamps[i] > timestamps[i - 1],
      `expected ${timestamps[i]} > ${timestamps[i - 1]} at index ${i}`
    );
  }
}

const archiveWriterA = 'archive-lifecycle-invented-local-writer-a';
const archiveWriterB = 'archive-lifecycle-invented-local-writer-b';
const archiveReader = 'archive-lifecycle-invented-local-reader';

async function startArchiveHttp(t) {
  const originalTokens = config.apiTokens;
  config.apiTokens = {
    [archiveWriterA]: ['transfers:write'],
    [archiveWriterB]: ['transfers:write'],
    [archiveReader]: ['transfers:read', 'audit:read'],
  };
  const server = createApp().listen(0, '127.0.0.1');
  t.after(async () => {
    config.apiTokens = originalTokens;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  return async (path, { token, method = 'GET', body, requestId, ifMatch } = {}) => {
    const headers = { Authorization: `Bearer ${token}`, Connection: 'close' };
    if (body) headers['Content-Type'] = 'application/json';
    if (requestId) headers['X-Request-Id'] = requestId;
    if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
}

function assertNoArchiveCredentials(value) {
  const serialized = JSON.stringify(value);
  for (const token of [archiveWriterA, archiveWriterB, archiveReader]) {
    assert.equal(serialized.includes(token), false, 'stored and readable records must omit bearer credentials');
  }
}

// ============================================================================
// State machine
// ============================================================================

test('state-machine: active → archived → active is the only archive cycle', () => {
  const transfer = createSample();
  assert.equal(transfer.archivedAt, null);
  assert.deepEqual(transfer.archiveHistory, []);

  const archived = transferService.archiveTransfer(transfer.id, {
    actor: 'ops-token',
    reason: 'retention-hold',
    requestId: 'req-1',
  });
  assert.ok(archived.archivedAt);
  assert.equal(archived.archiveHistory.length, 1);
  assert.equal(archived.archiveHistory[0].action, 'archive');

  const active = transferService.unarchiveTransfer(transfer.id, {
    actor: 'ops-token',
    reason: 'hold-lifted',
    requestId: 'req-2',
  });
  assert.equal(active.archivedAt, null);
  assert.equal(active.archiveHistory.length, 2);
  assert.equal(active.archiveHistory[1].action, 'unarchive');

  assert.throws(
    () => transferService.unarchiveTransfer(transfer.id),
    (err) => err instanceof ApiError && err.statusCode === 409
  );
});

test('state-machine: archive is orthogonal to claim/cancel status', () => {
  const claimed = createSample();
  transferService.claimTransfer(claimed.id);
  transferService.archiveTransfer(claimed.id, { actor: 'a', reason: 'cleanup' });
  assert.equal(claimed.status, 'claimed');
  assert.ok(claimed.archivedAt);

  const cancelled = createSample();
  transferService.cancelTransfer(cancelled.id);
  transferService.archiveTransfer(cancelled.id, { actor: 'a', reason: 'cleanup' });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.archivedAt);
});

// ============================================================================
// Stale-command rejection
// ============================================================================

test('stale-command: archive rejects mismatched expectedUpdatedAt', () => {
  const transfer = createSample();
  const stale = transfer.updatedAt;

  // Advance updatedAt via an intervening claim so the original token is stale.
  transferService.claimTransfer(transfer.id);
  assert.notEqual(transfer.updatedAt, stale);

  assert.throws(
    () => transferService.archiveTransfer(transfer.id, {
      expectedUpdatedAt: stale,
      actor: 'ops',
      reason: 'stale-try',
    }),
    (err) => (
      err instanceof ApiError &&
      err.statusCode === 409 &&
      err.details &&
      err.details.code === 'STALE_ARCHIVE_COMMAND' &&
      err.details.expectedUpdatedAt === stale &&
      err.details.actualUpdatedAt === transfer.updatedAt
    )
  );

  assert.equal(transfer.archivedAt, null);
  assert.equal(transfer.archiveHistory.length, 0);
});

test('stale-command: unarchive rejects mismatched expectedUpdatedAt', () => {
  const transfer = createSample();
  transferService.archiveTransfer(transfer.id, { actor: 'ops', reason: 'park' });
  const fresh = transfer.updatedAt;

  assert.throws(
    () => transferService.unarchiveTransfer(transfer.id, {
      expectedUpdatedAt: '1999-01-01T00:00:00.000Z',
      actor: 'ops',
      reason: 'stale-unarchive',
    }),
    (err) => (
      err instanceof ApiError &&
      err.statusCode === 409 &&
      err.details.code === 'STALE_ARCHIVE_COMMAND'
    )
  );

  // Matching token still succeeds.
  const result = transferService.unarchiveTransfer(transfer.id, {
    expectedUpdatedAt: fresh,
    actor: 'ops',
    reason: 'release',
  });
  assert.equal(result.archivedAt, null);
});

// ============================================================================
// Race / optimistic concurrency
// ============================================================================

test('race: second concurrent archive with the same expectedUpdatedAt loses', () => {
  const transfer = createSample();
  const observed = transfer.updatedAt;

  const winner = transferService.archiveTransfer(transfer.id, {
    expectedUpdatedAt: observed,
    actor: 'worker-a',
    reason: 'race-win',
    requestId: 'r-a',
  });
  assert.ok(winner.archivedAt);

  assert.throws(
    () => transferService.archiveTransfer(transfer.id, {
      expectedUpdatedAt: observed,
      actor: 'worker-b',
      reason: 'race-lose',
      requestId: 'r-b',
    }),
    (err) => (
      err instanceof ApiError &&
      err.statusCode === 409 &&
      err.details.code === 'STALE_ARCHIVE_COMMAND'
    )
  );

  // Winner's timestamp and single history event survive the loser.
  assert.equal(transfer.archivedAt, winner.archivedAt);
  assert.equal(transfer.archiveHistory.length, 1);
  assert.equal(transfer.archiveHistory[0].actor, 'worker-a');
});

test('race: archive then unarchive with stale token cannot reorder history', () => {
  const transfer = createSample();
  const beforeArchive = transfer.updatedAt;

  transferService.archiveTransfer(transfer.id, {
    expectedUpdatedAt: beforeArchive,
    actor: 'a',
    reason: 'first',
  });
  const afterArchive = transfer.updatedAt;

  transferService.unarchiveTransfer(transfer.id, {
    expectedUpdatedAt: afterArchive,
    actor: 'a',
    reason: 'second',
  });

  assert.throws(
    () => transferService.archiveTransfer(transfer.id, {
      expectedUpdatedAt: beforeArchive,
      actor: 'b',
      reason: 'stale-reorder',
    }),
    (err) => err instanceof ApiError && err.details.code === 'STALE_ARCHIVE_COMMAND'
  );

  assert.equal(transfer.archiveHistory.length, 2);
  assert.equal(transfer.archivedAt, null);
});

// ============================================================================
// Retry / idempotency
// ============================================================================

test('retry: re-archive without expectedUpdatedAt does not overwrite archivedAt', () => {
  const transfer = createSample();
  const first = transferService.archiveTransfer(transfer.id, {
    actor: 'ops',
    reason: 'initial',
    requestId: 'req-1',
  });
  const archivedAt = first.archivedAt;
  const updatedAt = first.updatedAt;
  const historyLen = first.archiveHistory.length;

  const retry = transferService.archiveTransfer(transfer.id, {
    actor: 'ops',
    reason: 'retry',
    requestId: 'req-1-retry',
  });

  assert.equal(retry.archivedAt, archivedAt);
  assert.equal(retry.updatedAt, updatedAt);
  assert.equal(retry.archiveHistory.length, historyLen);
});

test('retry: matching expectedUpdatedAt on already-archived transfer is a no-op', () => {
  const transfer = createSample();
  transferService.archiveTransfer(transfer.id, { actor: 'ops', reason: 'park' });
  const token = transfer.updatedAt;
  const archivedAt = transfer.archivedAt;

  const retry = transferService.archiveTransfer(transfer.id, {
    expectedUpdatedAt: token,
    actor: 'ops',
    reason: 'retry-same',
  });

  assert.equal(retry.archivedAt, archivedAt);
  assert.equal(retry.updatedAt, token);
  assert.equal(retry.archiveHistory.length, 1);
});

// ============================================================================
// Event order / monotonic timestamps
// ============================================================================

test('event-order: archive → unarchive → archive keeps strictly increasing timestamps', () => {
  const transfer = createSample();

  transferService.archiveTransfer(transfer.id, {
    actor: 'ops',
    reason: 'cycle-1',
    requestId: 'e1',
  });
  const firstArchivedAt = transfer.archivedAt;

  transferService.unarchiveTransfer(transfer.id, {
    actor: 'ops',
    reason: 'cycle-1-lift',
    requestId: 'e2',
  });
  assert.equal(transfer.lastArchivedAt, firstArchivedAt);

  transferService.archiveTransfer(transfer.id, {
    actor: 'ops',
    reason: 'cycle-2',
    requestId: 'e3',
  });

  assert.equal(transfer.archiveHistory.length, 3);
  const ats = transfer.archiveHistory.map((e) => e.at);
  assertStrictlyIncreasing(ats);
  assert.ok(transfer.archivedAt > firstArchivedAt);
  assert.equal(transfer.archiveHistory[0].at, firstArchivedAt);
  // Original archive timestamp is preserved in history (not overwritten).
  assert.equal(transfer.archiveHistory[0].action, 'archive');
  assert.equal(transfer.archiveHistory[1].action, 'unarchive');
  assert.equal(transfer.archiveHistory[2].action, 'archive');
});

test('event-order: history event timestamps are immutable after write', () => {
  const transfer = createSample();
  transferService.archiveTransfer(transfer.id, { actor: 'ops', reason: 'lock' });
  const event = transfer.archiveHistory[0];
  const originalAt = event.at;

  assert.throws(() => {
    event.at = '1999-01-01T00:00:00.000Z';
  }, TypeError);

  assert.equal(event.at, originalAt);
});

test('event-order: updatedAt never moves backward across archive lifecycle', () => {
  const transfer = createSample();
  const stamps = [transfer.createdAt, transfer.updatedAt];

  transferService.archiveTransfer(transfer.id, { actor: 'a', reason: 'r1' });
  stamps.push(transfer.updatedAt);
  transferService.unarchiveTransfer(transfer.id, { actor: 'a', reason: 'r2' });
  stamps.push(transfer.updatedAt);
  transferService.archiveTransfer(transfer.id, { actor: 'a', reason: 'r3' });
  stamps.push(transfer.updatedAt);

  assertStrictlyIncreasing(stamps);
});

// ============================================================================
// Auditability (actor + reason)
// ============================================================================

test('audit: archive and unarchive record actor and reason', () => {
  const transfer = createSample();

  transferService.archiveTransfer(transfer.id, {
    actor: 'auditor-token',
    reason: 'compliance-review',
    requestId: 'req-arch',
  });
  transferService.unarchiveTransfer(transfer.id, {
    actor: 'auditor-token',
    reason: 'review-complete',
    requestId: 'req-unarch',
  });

  const entries = auditService.getEntriesForResource(transfer.id);
  const archived = entries.find((e) => e.action === 'transfer.archived');
  const unarchived = entries.find((e) => e.action === 'transfer.unarchived');

  assert.ok(archived);
  assert.equal(archived.payload.actor, 'auditor-token');
  assert.equal(archived.payload.reason, 'compliance-review');
  assert.equal(archived.requestId, 'req-arch');

  assert.ok(unarchived);
  assert.equal(unarchived.payload.actor, 'auditor-token');
  assert.equal(unarchived.payload.reason, 'review-complete');
  assert.ok(unarchived.payload.previousArchivedAt);

  assert.equal(transfer.archiveHistory[0].actor, 'auditor-token');
  assert.equal(transfer.archiveHistory[0].reason, 'compliance-review');
  assert.equal(transfer.archiveHistory[1].reason, 'review-complete');
});

test('HTTP archive cycles retain distinct, stable actors without exposing writer credentials', async (t) => {
  const request = await startArchiveHttp(t);
  const transfer = createSample();
  let version = transfer.updatedAt;
  const commands = [
    { action: 'archive', token: archiveWriterA, reason: 'review' },
    { action: 'unarchive', token: archiveWriterA, reason: 'review-complete' },
    { action: 'archive', token: archiveWriterB, reason: 'second-review' },
  ];

  for (const [index, command] of commands.entries()) {
    const requestId = `archive-http-${index}`;
    const response = await request(`/transfers/${transfer.id}/${command.action}`, {
      token: command.token,
      method: 'POST',
      body: { reason: command.reason, expectedUpdatedAt: version },
      requestId,
    });
    assert.equal(response.status, 200);
    const event = response.body.archiveHistory[index];
    assert.match(event.actor, /^[a-f0-9]{16}$/);
    assert.equal(event.reason, command.reason);
    assert.equal(event.requestId, requestId);
    assert.equal(event.at, response.body.updatedAt);
    assert.ok(response.body.updatedAt > version);
    assertNoArchiveCredentials(response.body);
    version = response.body.updatedAt;
  }

  const actors = transfer.archiveHistory.map((event) => event.actor);
  assert.equal(actors[0], actors[1], 'the same writer retains one actor across both endpoints');
  assert.notEqual(actors[0], actors[2], 'different writers remain distinguishable');
  const entries = auditService.getEntriesForResource(transfer.id)
    .filter((entry) => entry.action !== 'transfer.created').reverse();
  assert.deepEqual(entries.map((entry) => entry.payload.actor), actors);
  assert.deepEqual(entries.map((entry) => entry.payload.reason), commands.map((command) => command.reason));
  assert.deepEqual(entries.map((entry) => entry.requestId), ['archive-http-0', 'archive-http-1', 'archive-http-2']);
  assertNoArchiveCredentials(transfer);
  assertNoArchiveCredentials(entries);

  for (const path of [
    `/transfers/${transfer.id}`,
    '/transfers?archived=all',
    `/audit?resourceId=${transfer.id}`,
  ]) {
    const response = await request(path, { token: archiveReader });
    assert.equal(response.status, 200);
    assertNoArchiveCredentials(response.body);
  }
});

test('HTTP unarchive fingerprints its writer and preserves legacy service actor labels', async (t) => {
  const request = await startArchiveHttp(t);
  const transfer = createSample();
  transferService.archiveTransfer(transfer.id, {
    actor: 'backoffice-job',
    reason: 'legacy-review',
    requestId: 'legacy-request',
  });
  const originalEvent = { ...transfer.archiveHistory[0] };

  const response = await request(`/transfers/${transfer.id}/unarchive`, {
    token: archiveWriterB,
    method: 'POST',
    body: { reason: 'restored-over-http', expectedUpdatedAt: transfer.updatedAt },
    requestId: 'http-restore',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.archivedAt, null);
  assert.deepEqual(response.body.archiveHistory[0], originalEvent);
  const event = response.body.archiveHistory[1];
  assert.match(event.actor, /^[a-f0-9]{16}$/);
  assert.equal(event.reason, 'restored-over-http');
  assert.equal(event.requestId, 'http-restore');
  assertNoArchiveCredentials(response.body);

  const entries = auditService.getEntriesForResource(transfer.id);
  assert.equal(entries.find((entry) => entry.action === 'transfer.archived').payload.actor, 'backoffice-job');
  assert.equal(entries.find((entry) => entry.action === 'transfer.unarchived').payload.actor, event.actor);
  assertNoArchiveCredentials(transfer);
  assertNoArchiveCredentials(entries);
});

// ============================================================================
// Regression: original failure mode
// ============================================================================

test('regression: interleaved status and archive commands cannot reuse a version token', (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);

  for (const changeStatus of ['claimTransfer', 'cancelTransfer']) {
    for (const initiallyArchived of [true, false]) {
      const transfer = createSample();
      transferService.archiveTransfer(transfer.id);
      if (!initiallyArchived) transferService.unarchiveTransfer(transfer.id);

      transferService[changeStatus](transfer.id);
      const observed = transfer.updatedAt;
      const action = initiallyArchived ? 'unarchiveTransfer' : 'archiveTransfer';
      const staleAction = initiallyArchived ? 'archiveTransfer' : 'unarchiveTransfer';

      transferService[action](transfer.id, { expectedUpdatedAt: observed });
      assert.ok(
        transfer.updatedAt > observed,
        `${changeStatus} followed by ${action} must advance updatedAt`
      );
      const historyLength = transfer.archiveHistory.length;
      const updatedAt = transfer.updatedAt;

      assert.throws(
        () => transferService[staleAction](transfer.id, { expectedUpdatedAt: observed }),
        (err) => err instanceof ApiError && err.details.code === 'STALE_ARCHIVE_COMMAND'
      );
      assert.equal(transfer.updatedAt, updatedAt);
      assert.equal(transfer.archiveHistory.length, historyLength);
    }
  }
});

test('regression: archive transitions respect history and legacy archive timestamp floors', (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now - 60_000);

  const transfer = createSample();
  transferService.archiveTransfer(transfer.id);
  transferService.unarchiveTransfer(transfer.id);
  const historyAt = transfer.archiveHistory.at(-1).at;
  transfer.updatedAt = transfer.createdAt;
  transferService.archiveTransfer(transfer.id);
  assert.ok(transfer.updatedAt > historyAt);

  const legacy = createSample();
  legacy.archivedAt = new Date(now + 60_000).toISOString();
  const previousArchivedAt = legacy.archivedAt;
  transferService.unarchiveTransfer(legacy.id);
  assert.ok(legacy.updatedAt > previousArchivedAt);
  assert.equal(legacy.lastArchivedAt, previousArchivedAt);
  assert.equal(legacy.archiveHistory[0].at, legacy.updatedAt);
});

test('regression: repeated archive/unarchive does not hide earlier lifecycle timestamps', () => {
  const transfer = createSample();

  transferService.archiveTransfer(transfer.id, {
    actor: 'ops',
    reason: 'first-archive',
  });
  const firstAt = transfer.archivedAt;

  transferService.unarchiveTransfer(transfer.id, {
    actor: 'ops',
    reason: 'temporary-restore',
  });
  // Current flag is cleared, but lastArchivedAt and history retain the order.
  assert.equal(transfer.archivedAt, null);
  assert.equal(transfer.lastArchivedAt, firstAt);
  assert.equal(transfer.archiveHistory[0].at, firstAt);

  transferService.archiveTransfer(transfer.id, {
    actor: 'ops',
    reason: 'second-archive',
  });
  const secondAt = transfer.archivedAt;

  assert.ok(secondAt > firstAt);
  // History still starts with the first archive — not overwritten.
  assert.equal(transfer.archiveHistory[0].at, firstAt);
  assert.equal(transfer.archiveHistory[0].reason, 'first-archive');
  assert.equal(transfer.archiveHistory[2].at, secondAt);
  assert.equal(transfer.archiveHistory[2].reason, 'second-archive');
  assertStrictlyIncreasing(transfer.archiveHistory.map((e) => e.at));
});

// ============================================================================
// HTTP optimistic-concurrency token preservation
// ============================================================================

for (const action of ['archive', 'unarchive']) {
  for (const [kind, value] of [
    ['number', 0],
    ['boolean', false],
    ['array', []],
    ['object', {}],
  ]) {
    test(`HTTP concurrency token: ${action} rejects a supplied ${kind} without changing history`, async (t) => {
      const request = await startArchiveHttp(t);
      const transfer = createSample();
      if (action === 'unarchive') transferService.archiveTransfer(transfer.id);
      const before = JSON.parse(JSON.stringify(transfer));
      const beforeAudit = JSON.parse(JSON.stringify(auditService.getEntriesForResource(transfer.id)));

      const response = await request(`/transfers/${transfer.id}/${action}`, {
        token: archiveWriterA,
        method: 'POST',
        body: { expectedUpdatedAt: value, reason: 'stale-type-should-not-write' },
      });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.details.code, 'STALE_ARCHIVE_COMMAND');
      assert.deepEqual(response.body.error.details.expectedUpdatedAt, value);
      assert.deepEqual(JSON.parse(JSON.stringify(transferService.getTransferOrThrow(transfer.id))), before);
      assert.deepEqual(JSON.parse(JSON.stringify(auditService.getEntriesForResource(transfer.id))), beforeAudit);
      const readback = await request(`/transfers/${transfer.id}`, { token: archiveReader });
      assert.equal(readback.status, 200);
      assert.deepEqual(readback.body, before);
    });
  }

  test(`HTTP concurrency token: ${action} preserves optional values and body/header selection`, async (t) => {
    const request = await startArchiveHttp(t);
    const stale = '1999-01-01T00:00:00.000Z';
    const cases = [
      { name: 'omitted', options: () => ({ body: { reason: 'optional-token' } }) },
      { name: 'null', options: () => ({ body: { expectedUpdatedAt: null } }) },
      { name: 'empty', options: () => ({ body: { expectedUpdatedAt: '' } }) },
      { name: 'whitespace', options: () => ({ body: { expectedUpdatedAt: '  ' } }) },
      { name: 'trimmed body wins', options: version => ({
        body: { expectedUpdatedAt: `  ${version}  ` }, ifMatch: stale,
      }) },
      { name: 'bare header', options: version => ({ ifMatch: version }) },
      { name: 'weak quoted header', options: version => ({ ifMatch: `W/"${version}"` }) },
      { name: 'header fallback with non-string body', options: version => ({
        body: { expectedUpdatedAt: false }, ifMatch: version,
      }) },
    ];

    for (const scenario of cases) {
      const transfer = createSample();
      if (action === 'unarchive') transferService.archiveTransfer(transfer.id);
      const historyLength = transfer.archiveHistory.length;
      const response = await request(`/transfers/${transfer.id}/${action}`, {
        token: archiveWriterA,
        method: 'POST',
        ...scenario.options(transfer.updatedAt),
      });
      assert.equal(response.status, 200, scenario.name);
      assert.equal(response.body.archiveHistory.length, historyLength + 1, scenario.name);
      assert.equal(response.body.archiveHistory.at(-1).action, action, scenario.name);
    }

    const transfer = createSample();
    if (action === 'unarchive') transferService.archiveTransfer(transfer.id);
    const before = JSON.parse(JSON.stringify(transfer));
    const beforeAudit = JSON.parse(JSON.stringify(auditService.getEntriesForResource(transfer.id)));
    const response = await request(`/transfers/${transfer.id}/${action}`, {
      token: archiveWriterA,
      method: 'POST',
      body: { expectedUpdatedAt: 0 },
      ifMatch: stale,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.details.code, 'STALE_ARCHIVE_COMMAND');
    assert.equal(response.body.error.details.expectedUpdatedAt, stale);
    assert.deepEqual(JSON.parse(JSON.stringify(transferService.getTransferOrThrow(transfer.id))), before);
    assert.deepEqual(JSON.parse(JSON.stringify(auditService.getEntriesForResource(transfer.id))), beforeAudit);
  });
}
