'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  GENESIS_HASH,
  REDACTED,
  computeEntryHash,
  redact,
} = require('../src/utils/auditCrypto');

function entryWith(changes) {
  return {
    id: 'audit-json-fixture',
    chainSeq: 0,
    action: 'admin.config_changed',
    scope: 'admin',
    target: 'cfg-json',
    actor: 'system',
    correlationId: 'corr-json',
    outcome: 'success',
    changes,
    at: '2026-10-04T00:00:00.000Z',
  };
}

test('redaction retains every own JSON key without changing object prototypes', () => {
  const input = JSON.parse('{"__proto__":{"amount":100,"token":"top-secret"},"constructor":{"prototype":{"safe":true,"password":"nested-secret"}},"items":[{"__proto__":{"label":"nested","api-key":"array-secret"}}]}');
  const result = redact(input);

  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.amount, undefined, 'payload fields must not become inherited properties');
  assert.deepEqual(result.__proto__, { amount: 100, token: REDACTED });
  assert.deepEqual(result.constructor, { prototype: { safe: true, password: REDACTED } });
  assert.equal(Object.getPrototypeOf(result.items[0]), Object.prototype);
  assert.equal(Object.hasOwn(result.items[0], '__proto__'), true);
  assert.deepEqual(result.items[0].__proto__, { label: 'nested', 'api-key': REDACTED });
  assert.equal(Object.getPrototypeOf(result.__proto__), Object.prototype);

  const roundTrip = JSON.parse(JSON.stringify(result));
  assert.deepEqual(roundTrip, result, 'the stored view must survive the JSON response boundary');
  for (const secret of ['top-secret', 'nested-secret', 'array-secret']) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(input.__proto__.token, 'top-secret', 'redaction must not mutate the caller');
  assert.equal(input.items[0].__proto__['api-key'], 'array-secret');
});

test('integrity hashes bind preserved JSON __proto__ evidence and detect its mutation', () => {
  const changes = redact(JSON.parse('{"__proto__":{"amount":100,"token":"private"},"reason":"corrected fee"}'));
  const entry = entryWith(changes);
  const originalHash = computeEntryHash(entry, GENESIS_HASH);
  const omittedHash = computeEntryHash(entryWith({ reason: 'corrected fee' }), GENESIS_HASH);
  assert.notEqual(originalHash, omittedHash, 'an own JSON key must participate in the event hash');

  changes.__proto__.amount = 999;
  assert.notEqual(computeEntryHash(entry, GENESIS_HASH), originalHash, 'editing evidence must change the hash');
  assert.equal(changes.__proto__.token, REDACTED);
});

test('ordinary JSON redaction retains the previous canonical event hash', () => {
  const input = { nested: { z: [1, true, 'text'], token: 'private', a: null }, amount: 100 };
  const changes = redact(input);
  assert.deepEqual(changes, {
    nested: { z: [1, true, 'text'], token: REDACTED, a: null },
    amount: 100,
  });
  assert.equal(
    computeEntryHash(entryWith(changes), GENESIS_HASH),
    'c4ffe45ff0cd8bb84ea96f32162fce02114de42f358ec6fa1180fca0914ba97b',
  );
  assert.equal(input.nested.token, 'private');
});
