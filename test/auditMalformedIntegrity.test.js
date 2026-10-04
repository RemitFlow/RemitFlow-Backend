'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const auditService = require('../src/services/auditService');

beforeEach(() => auditService.reset());
afterEach(() => auditService.reset());

function validChain() {
  auditService.addEntry({ action: 'transfer.created', target: 'first', changes: { amount: 10 } });
  const entry = auditService.addEntry({ action: 'transfer.created', target: 'second', changes: { amount: 20 } });
  const original = auditService.verifyIntegrity();
  assert.equal(original.valid, true);
  return { entry, original };
}

function assertUnverifiable(original) {
  assert.deepEqual(auditService.verifyIntegrity(), {
    valid: false,
    checked: 1,
    tipHash: original.tipHash,
    brokenAt: 1,
    reason: 'entry contents cannot be verified',
  });
}

test('a cyclic tampered changes object returns the broken index without changing hashes', () => {
  const { entry, original } = validChain();
  const originalHash = entry.entryHash;
  entry.changes.self = entry.changes;

  assertUnverifiable(original);
  assert.equal(entry.entryHash, originalHash);

  delete entry.changes.self;
  assert.deepEqual(auditService.verifyIntegrity(), original);
});

test('a throwing compatibility payload returns a fixed reason without leaking the error', () => {
  const { entry, original } = validChain();
  entry.payload = Object.defineProperty({}, 'privateField', {
    enumerable: true,
    get() { throw new Error('SYNTHETIC_PRIVATE_PAYLOAD_MARKER'); },
  });

  assertUnverifiable(original);

  entry.payload = entry.changes;
  assert.deepEqual(auditService.verifyIntegrity(), original);
});
