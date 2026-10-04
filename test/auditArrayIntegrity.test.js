'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
const createApp = require('../src/app');
const audit = require('../src/services/auditService');
const { canonicalize, sha256 } = require('../src/utils/auditCrypto');
let server;
let origin;

before(() => new Promise(resolve => {
  server = createApp().listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
beforeEach(() => audit.reset());

function record(changes) {
  return audit.addEntry({ action: 'transfer.updated', target: 'test-transfer', changes });
}

test('sparse array slots retain their JSON null positions', () => {
  const sparse = new Array(3);
  sparse[1] = 7;
  assert.equal(canonicalize(sparse), '[null,7,null]');
  assert.equal(canonicalize(new Array(1)), '[null]');
  assert.notEqual(sha256([]), sha256(new Array(1)));
  assert.deepEqual(JSON.parse(canonicalize(sparse)), JSON.parse(JSON.stringify(sparse)));
});

test('extending an empty stored array cannot keep a valid audit hash', () => {
  const entry = record({ recipients: [] });
  assert.equal(audit.verifyIntegrity().valid, true);
  entry.changes.recipients.length = 1;
  assert.equal(JSON.stringify(entry.changes), '{"recipients":[null]}');
  const result = audit.verifyIntegrity();
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 0);
  assert.match(result.reason, /entryHash mismatch/);
});

test('a sparse stored array and its JSON round trip have the same digest', () => {
  const entry = record({ recipients: new Array(2) });
  assert.equal(audit.verifyIntegrity().valid, true);
  const originalHash = entry.entryHash;
  entry.changes.recipients = JSON.parse(JSON.stringify(entry.changes.recipients));
  assert.deepEqual(entry.changes.recipients, [null, null]);
  assert.equal(audit.verifyIntegrity().valid, true);
  assert.equal(entry.entryHash, originalHash);
});

test('ordinary dense JSON keeps the existing canonical bytes and digest', () => {
  const value = { z: [1, null, undefined, { y: 2, x: 1 }], a: 'dense' };
  const expected = '{"a":"dense","z":[1,null,null,{"x":1,"y":2}]}';
  assert.equal(canonicalize(value), expected);
  assert.equal(sha256(value), crypto.createHash('sha256').update(expected).digest('hex'));
});

test('authenticated integrity endpoint reports array-length tampering', async () => {
  const entry = record({ amounts: [] });
  entry.changes.amounts.length = 1;
  const response = await fetch(origin + '/api/audit/integrity', {
    headers: { Authorization: 'Bearer test-token-admin' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.valid, false);
  assert.equal(body.brokenAt, 0);
  assert.match(body.reason, /entryHash mismatch/);
});
