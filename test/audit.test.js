'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Tests for the audit log service (issue #40).
 */

const auditService = require('../src/services/auditService');

// Start each test with a clean audit log.
beforeEach(() => {
  auditService.reset();
});

// ─── addEntry ─────────────────────────────────────────────────────────────────

test('addEntry creates an entry with the expected fields', () => {
  const entry = auditService.addEntry({
    action: 'transfer.created',
    resourceId: 'txn-001',
    payload: { amount: 100 },
    requestId: 'req-abc',
  });

  assert.ok(entry.id, 'entry should have an id');
  assert.equal(entry.action, 'transfer.created');
  assert.equal(entry.resourceId, 'txn-001');
  assert.deepEqual(entry.payload, { amount: 100 });
  assert.equal(entry.requestId, 'req-abc');
  assert.ok(entry.at, 'entry should have a timestamp');
});

test('addEntry works without an optional requestId', () => {
  const entry = auditService.addEntry({
    action: 'user.created',
    resourceId: 'usr-001',
  });

  assert.equal(entry.requestId, null);
});

test('addEntry throws when action is missing', () => {
  assert.throws(
    () => auditService.addEntry({ resourceId: 'txn-001' }),
    /action is required/
  );
});

test('addEntry throws when resourceId is missing', () => {
  assert.throws(
    () => auditService.addEntry({ action: 'transfer.created' }),
    /resourceId is required/
  );
});

// ─── getEntries ───────────────────────────────────────────────────────────────

test('getEntries returns all entries, newest first', () => {
  auditService.addEntry({ action: 'transfer.created', resourceId: 'txn-1' });
  auditService.addEntry({ action: 'transfer.claimed', resourceId: 'txn-2' });

  const entries = auditService.getEntries();

  assert.equal(entries.length, 2);
  // newest first means the second-added entry appears at index 0
  assert.equal(entries[0].resourceId, 'txn-2');
  assert.equal(entries[1].resourceId, 'txn-1');
});

test('getEntries returns an empty array when the log is empty', () => {
  assert.deepEqual(auditService.getEntries(), []);
});

// ─── getEntriesForResource ────────────────────────────────────────────────────

test('getEntriesForResource returns only entries for the given resource', () => {
  auditService.addEntry({ action: 'transfer.created', resourceId: 'txn-A' });
  auditService.addEntry({ action: 'user.created', resourceId: 'usr-B' });
  auditService.addEntry({ action: 'transfer.claimed', resourceId: 'txn-A' });

  const entries = auditService.getEntriesForResource('txn-A');

  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.resourceId === 'txn-A'));
});

test('getEntriesForResource returns an empty array for unknown resource', () => {
  auditService.addEntry({ action: 'transfer.created', resourceId: 'txn-X' });

  const entries = auditService.getEntriesForResource('does-not-exist');
  assert.deepEqual(entries, []);
});

test('getEntriesForResource enforces explicit scopes and preserves trusted access', () => {
  const ApiError = require('../src/utils/ApiError');
  const first = auditService.addEntry({ action: 'transfer.created', resourceId: 'txn-A' });
  auditService.addEntry({ action: 'user.created', resourceId: 'usr-B' });
  const last = auditService.addEntry({ action: 'transfer.claimed', resourceId: 'txn-A' });

  for (const auth of [{ scopes: ['transfers:read'] }, {}]) {
    for (const resourceId of ['txn-A', 'missing', '', null]) {
      assert.throws(
        () => auditService.getEntriesForResource(resourceId, auth),
        (err) => err instanceof ApiError && err.statusCode === 403 &&
          err.message === 'Insufficient token scopes'
      );
    }
  }

  const allowed = { scopes: ['audit:read'] };
  assert.deepEqual(auditService.getEntriesForResource('txn-A', allowed), [last, first]);
  assert.deepEqual(auditService.getEntriesForResource('txn-A'), [last, first]);
  assert.deepEqual(auditService.getEntriesForResource('txn-A', null), [last, first]);
  assert.deepEqual(auditService.getEntriesForResource('missing', allowed), []);
  assert.deepEqual(auditService.getEntriesForResource('', allowed), []);
  assert.deepEqual(auditService.getEntriesForResource(null), []);
});

// ─── reset ────────────────────────────────────────────────────────────────────

test('reset clears all entries', () => {
  auditService.addEntry({ action: 'transfer.created', resourceId: 'txn-1' });
  auditService.reset();

  assert.deepEqual(auditService.getEntries(), []);
});

// ─── Integration: service-level instrumentation ───────────────────────────────

test('transferService.createTransfer records a transfer.created audit entry', () => {
  // Use a fresh require to pick up the current module state.
  const { reset: resetStore } = require('../src/store');
  resetStore();

  const transferService = require('../src/services/transferService');

  const transfer = transferService.createTransfer({
    senderName: 'Alice',
    recipientName: 'Bob',
    amount: 50,
    from: 'USD',
    to: 'INR',
  }, 'test-req-1');

  const entries = auditService.getEntries();
  const entry = entries.find((e) => e.resourceId === transfer.id);

  assert.ok(entry, 'expected an audit entry for the transfer');
  assert.equal(entry.action, 'transfer.created');
  assert.equal(entry.requestId, 'test-req-1');
});

test('transferService.claimTransfer records a transfer.claimed audit entry', () => {
  const { reset: resetStore } = require('../src/store');
  resetStore();

  const transferService = require('../src/services/transferService');

  const transfer = transferService.createTransfer({
    senderName: 'Alice',
    recipientName: 'Bob',
    amount: 50,
    from: 'USD',
    to: 'INR',
  });

  auditService.reset();
  transferService.claimTransfer(transfer.id, 'test-req-claim');

  const entries = auditService.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'transfer.claimed');
  assert.equal(entries[0].resourceId, transfer.id);
  assert.equal(entries[0].requestId, 'test-req-claim');
});

test('transferService.cancelTransfer records a transfer.cancelled audit entry', () => {
  const { reset: resetStore } = require('../src/store');
  resetStore();

  const transferService = require('../src/services/transferService');

  const transfer = transferService.createTransfer({
    senderName: 'Alice',
    recipientName: 'Bob',
    amount: 50,
    from: 'USD',
    to: 'INR',
  });

  auditService.reset();
  transferService.cancelTransfer(transfer.id, 'test-req-cancel');

  const entries = auditService.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'transfer.cancelled');
  assert.equal(entries[0].resourceId, transfer.id);
});

test('userService.createUser records a user.created audit entry', () => {
  const { reset: resetStore } = require('../src/store');
  resetStore();

  const userService = require('../src/services/userService');

  const user = userService.createUser({
    name: 'Test User',
    email: 'test@example.com',
  }, 'test-req-user');

  const entries = auditService.getEntries();
  const entry = entries.find((e) => e.resourceId === user.id);

  assert.ok(entry, 'expected an audit entry for the user');
  assert.equal(entry.action, 'user.created');
  assert.equal(entry.requestId, 'test-req-user');
});
