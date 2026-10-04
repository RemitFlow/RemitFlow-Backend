'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const createApp = require('../src/app');
const config = require('../src/config');
const { reset } = require('../src/store');
const transferService = require('../src/services/transferService');
const auditService = require('../src/services/auditService');

for (const action of ['archive', 'unarchive']) {
  test(`HTTP ${action} preserves state and token after audit failure, then retries once`, async (t) => {
    reset();
    const transfer = transferService.createTransfer({
      senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR',
    });
    if (action === 'unarchive') transferService.archiveTransfer(transfer.id);
    const before = JSON.parse(JSON.stringify(transfer));
    const beforeAudit = JSON.parse(JSON.stringify(auditService.getEntriesForResource(transfer.id)));
    const originalTokens = config.apiTokens;
    const token = 'archive-audit-invented-regression-token';
    config.apiTokens = { [token]: ['transfers:read', 'transfers:write'] };
    const server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/transfers/${transfer.id}`;
    const reason = `retry ${action} after audit recovery`;
    const requestId = `audit-retry-${action}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      Connection: 'close',
    };
    const command = () => fetch(`${url}/${action}`, {
      method: 'POST', headers,
      body: JSON.stringify({ expectedUpdatedAt: before.updatedAt, reason }),
    });
    const auditAction = action === 'archive' ? 'transfer.archived' : 'transfer.unarchived';
    let rejectedWrites = 0;
    let rejectAudit = t.mock.method(auditService, 'addEntry', () => {
      rejectedWrites += 1;
      throw new Error('synthetic audit append unavailable');
    });
    try {
      const rejected = await command();
      await rejected.json();
      assert.equal(rejected.status, 500);
      assert.equal(rejectedWrites, 1);
      const readback = await fetch(url, { headers });
      assert.equal(readback.status, 200);
      assert.deepEqual(await readback.json(), before,
        'failed audit append must leave transfer state and history unchanged');
      assert.deepEqual(auditService.getEntriesForResource(transfer.id), beforeAudit);

      rejectAudit.mock.restore();
      rejectAudit = null;
      const retried = await command();
      const after = await retried.json();
      assert.equal(retried.status, 200, 'the unchanged concurrency token must remain retryable');
      assert.ok(after.updatedAt > before.updatedAt);
      assert.deepEqual(after.archiveHistory.slice(0, -1), before.archiveHistory);
      assert.equal(after.archiveHistory.length, before.archiveHistory.length + 1);
      const event = after.archiveHistory.at(-1);
      assert.equal(event.action, action);
      assert.equal(event.at, after.updatedAt);
      assert.equal(event.reason, reason);
      assert.equal(event.requestId, requestId);
      if (action === 'archive') {
        assert.equal(after.archivedAt, after.updatedAt);
        assert.equal(after.lastArchivedAt, after.updatedAt);
      } else {
        assert.equal(after.archivedAt, null);
        assert.equal(after.lastArchivedAt, before.archivedAt);
      }
      const entries = auditService.getEntriesForResource(transfer.id);
      assert.equal(entries.length, beforeAudit.length + 1);
      const matching = entries.filter((entry) => entry.action === auditAction);
      assert.equal(matching.length, 1, 'successful retry must append exactly one audit entry');
      assert.equal(matching[0].requestId, requestId);
      assert.equal(matching[0].payload.reason, reason);
      assert.equal(matching[0].payload.actor, event.actor);
      assert.equal(matching[0].payload[action === 'archive' ? 'archivedAt' : 'unarchivedAt'], after.updatedAt);
    } finally {
      if (rejectAudit) rejectAudit.mock.restore();
      config.apiTokens = originalTokens;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      reset();
    }
  });
}
