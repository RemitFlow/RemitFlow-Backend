'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute the actual worker with isolated in-memory provider/store boundaries.
// No live Stellar service, HTTP deployment, or process-durability claim.
function loadWorker(store, provider) {
  const filename = path.resolve(__dirname, '../src/services/settlementWorker.js');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const requireDependency = (name) => {
    if (name === '../store') return { store };
    if (name === './stellarService') return provider;
    return localRequire(name);
  };
  vm.runInThisContext(`(function(require, module, exports) {\n${source}\n})`, { filename })(
    requireDependency, module, module.exports
  );
  return module.exports;
}

test('malformed provider IDs cannot become successful cached receipts', async (t) => {
  for (const [label, value] of [
    ['missing', undefined], ['null', null], ['empty', ''], ['whitespace', ' \r\n\t '],
    ['number', 42], ['boolean', true], ['array', ['cb_value']],
    ['object', { id: 'cb_value', token: 'provider-secret' }],
  ]) {
    await t.test(label, () => {
      const store = { settlementReceipts: new Map() };
      const worker = loadWorker(store, { createClaimableBalanceId: () => value });
      assert.throws(() => worker.settleClaim('operation-1'), (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.details.code, 'SETTLEMENT_RECEIPT_INVALID');
        assert.ok(!JSON.stringify(error).includes('provider-secret'));
        return true;
      });
      assert.equal(store.settlementReceipts.size, 0);
      assert.equal(worker.getReceipt('operation-1'), null);
    });
  }
});

test('a malformed response leaves the stable operation reusable after recovery', () => {
  const store = { settlementReceipts: new Map() };
  const attempted = [];
  let value = undefined;
  const worker = loadWorker(store, { createClaimableBalanceId(operationId) {
    attempted.push(operationId);
    return value;
  } });
  assert.throws(() => worker.settleClaim('same-operation'), { statusCode: 503 });
  value = 'cb_recovered';
  const recovered = worker.settleClaim('same-operation');
  assert.equal(recovered.claimableBalanceId, 'cb_recovered');
  assert.equal(recovered.operationId, 'same-operation');
  assert.equal(store.settlementReceipts.size, 1);
  assert.strictEqual(worker.settleClaim('same-operation'), recovered);
  assert.deepEqual(attempted, ['same-operation', 'same-operation']);
});

test('valid opaque IDs remain unchanged and receipts survive a worker reload', () => {
  const store = { settlementReceipts: new Map() };
  let calls = 0;
  const provider = { createClaimableBalanceId() { calls += 1; return 'cb_CASE-sensitive'; } };
  const first = loadWorker(store, provider).settleClaim('stable-operation');
  assert.equal(first.claimableBalanceId, 'cb_CASE-sensitive');
  assert.ok(Number.isFinite(Date.parse(first.settledAt)));
  const reloaded = loadWorker(store, provider);
  assert.strictEqual(reloaded.settleClaim('stable-operation'), first);
  assert.strictEqual(reloaded.getReceipt('stable-operation'), first);
  assert.equal(calls, 1);
});

test('provider exceptions remain errors and do not consume the operation', () => {
  const store = { settlementReceipts: new Map() };
  const failure = new Error('provider unavailable');
  const worker = loadWorker(store, { createClaimableBalanceId() { throw failure; } });
  assert.throws(() => worker.settleClaim('operation-error'), (error) => error === failure);
  assert.equal(store.settlementReceipts.size, 0);
});
