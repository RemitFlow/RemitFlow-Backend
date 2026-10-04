'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const currencyPolicy = require('../src/utils/currencyPolicy');
const quoteService = require('../src/services/quoteService');
const rateService = require('../src/services/rateService');
const stellarService = require('../src/services/stellarService');
const auditService = require('../src/services/auditService');
const { validateCreateTransfer } = require('../src/validators/transferValidator');
const { validateQuoteQuery } = require('../src/validators/quoteValidator');
const createApp = require('../src/app');
const { store, reset } = require('../src/store');
const money = require('../src/utils/money');

// ── Unit: policy table ──────────────────────────────────────────────────────

test('CURRENCY_META covers every rate-listed currency with ISO minor units', () => {
  assert.equal(currencyPolicy.getMeta('USD').minorUnits, 2);
  assert.equal(currencyPolicy.getMeta('jpy').minorUnits, 0);
  assert.equal(currencyPolicy.getMeta('JPY').minAmount, 1);
  assert.equal(currencyPolicy.isSupported('MXN'), true);
  assert.equal(currencyPolicy.isSupported('XYZ'), false);
});

test('canonicalizeAmount accepts a well-formed USD amount and returns canonical form', () => {
  const result = currencyPolicy.canonicalizeAmount('100.50', 'usd');
  assert.equal(result.ok, true);
  assert.equal(result.amount, 100.5);
  assert.equal(result.currency, 'USD');
});

test('canonicalizeAmount rejects unsupported currency before mutation', () => {
  const result = currencyPolicy.canonicalizeAmount(10, 'ZZZ');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Unsupported currency/i.test(e)));
});

test('policy rejects structured amounts without invoking conversion properties', () => {
  for (const amount of [{ toString: null }, { valueOf: false, toString: [] }, [{ toString: 0 }]]) {
    const canonical = currencyPolicy.canonicalizeAmount(amount, 'USD');
    assert.equal(canonical.ok, false);
    assert.deepEqual(canonical.errors, ['amount must be a positive number']);
    for (const from of [undefined, 'ZZZ']) {
      const errors = currencyPolicy.validateTransferPair(amount, from, 'EUR');
      assert.equal(errors.length, 2);
      assert.ok(errors.includes('amount must be a positive number'));
    }
  }
});

test('structured currency codes produce policy errors and service 400s without coercion', () => {
  for (const code of [{ toString: null }, { valueOf: false, toString: [] }, [{ toString: 0 }]]) {
    assert.equal(currencyPolicy.isSupported(code), false);
    assert.throws(() => currencyPolicy.getMeta(code), (err) => err.code === 'UNSUPPORTED_CURRENCY');
    assert.equal(currencyPolicy.canonicalizeAmount(100, code).ok, false);
    assert.deepEqual(currencyPolicy.validateTransferPair(100, code, 'EUR'), [
      'Unsupported source currency: (invalid type)',
    ]);
    assert.deepEqual(currencyPolicy.validateTransferPair(100, 'USD', code), [
      'Unsupported target currency: (invalid type)',
    ]);
    for (const getQuote of [
      () => quoteService.getQuote(100, code, 'EUR'),
      () => quoteService.getQuote(100, 'USD', code),
      () => rateService.getRate(code, 'EUR'),
      () => rateService.getRate('USD', code),
    ]) {
      assert.throws(getQuote, (err) => err.statusCode === 400 && /Unsupported/.test(err.message));
    }
  }
});

test('canonicalizeAmount rejects sub-minor-unit precision for USD', () => {
  const result = currencyPolicy.canonicalizeAmount(10.129, 'USD');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /decimal places/i.test(e)));
});

test('canonicalizeAmount rejects fractional JPY (zero-decimal currency)', () => {
  const result = currencyPolicy.canonicalizeAmount(100.5, 'JPY');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /whole number/i.test(e)));
});

test('canonicalizeAmount accepts whole JPY and rejects below minimum', () => {
  assert.equal(currencyPolicy.canonicalizeAmount(100, 'JPY').ok, true);
  const tooSmall = currencyPolicy.canonicalizeAmount(0.5, 'JPY');
  // 0.5 has a fractional digit so precision fails first; 0 is non-positive.
  const zero = currencyPolicy.canonicalizeAmount(0, 'JPY');
  assert.equal(zero.ok, false);
  assert.ok(tooSmall.ok === false);
});

test('canonicalizeAmount rejects overflow past safe minor-unit magnitude', () => {
  const result = currencyPolicy.canonicalizeAmount(1e21, 'USD');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /numeric range/i.test(e)));
});

test('canonicalizeAmount enforces the transfer max when requested', () => {
  const over = currencyPolicy.canonicalizeAmount(999999, 'USD', { enforceMax: true });
  assert.equal(over.ok, false);
  assert.ok(over.errors.some((e) => /must not exceed/i.test(e)));
  const quoteOk = currencyPolicy.canonicalizeAmount(999999, 'USD', { enforceMax: false });
  assert.equal(quoteOk.ok, true);
});

test('roundToCurrency uses destination minor units', () => {
  assert.equal(currencyPolicy.roundToCurrency(10.129, 'USD'), 10.13);
  assert.equal(currencyPolicy.roundToCurrency(10.6, 'JPY'), 11);
  assert.equal(currencyPolicy.roundToCurrency(10.4, 'JPY'), 10);
});

test('decimal rounding distinguishes exact ties from genuinely lower amounts', () => {
  for (const [amount, code, expected] of [
    ['10.075', 'USD', 10.08],
    ['19.685', 'USD', 19.69],
    ['19.684999999999999', 'USD', 19.68],
    ['19.685000000000001', 'USD', 19.69],
    ['-10.075', 'USD', -10.07],
    ['-10.075000000000001', 'USD', -10.08],
    ['2.5', 'JPY', 3],
    ['-2.5', 'JPY', -2],
    ['-2.500000000000001', 'JPY', -3],
  ]) {
    assert.equal(currencyPolicy.roundToCurrency(amount, code), expected);
  }
  assert.equal(money.percentage(403, 2.5, 'USD'), 10.08);
});

// ── Validators share the policy ─────────────────────────────────────────────

test('validateCreateTransfer rejects unsupported currencies', () => {
  const errors = validateCreateTransfer({
    body: {
      senderName: 'A',
      recipientName: 'B',
      amount: 10,
      from: 'USD',
      to: 'ZZZ',
    },
  });
  assert.ok(errors.some((e) => /Unsupported target currency/i.test(e)));
});

test('validateQuoteQuery rejects unsupported source currency', () => {
  const errors = validateQuoteQuery({
    query: { amount: '10', from: 'AAA', to: 'USD' },
  });
  assert.ok(errors.some((e) => /Unsupported source currency/i.test(e)));
});

test('validateCreateTransfer rejects JPY fractional send amounts', () => {
  const errors = validateCreateTransfer({
    body: {
      senderName: 'A',
      recipientName: 'B',
      amount: 50.5,
      from: 'JPY',
      to: 'USD',
    },
  });
  assert.ok(errors.some((e) => /whole number/i.test(e)));
});

// ── Preview matches execution ───────────────────────────────────────────────

test('quote preview sendAmount matches canonicalizeAmount for the same input', () => {
  const amount = '250.25';
  const from = 'USD';
  const to = 'EUR';
  const canonical = currencyPolicy.canonicalizeAmount(amount, from);
  const quote = quoteService.getQuote(amount, from, to);
  assert.equal(canonical.ok, true);
  assert.equal(quote.sendAmount, canonical.amount);
  assert.equal(quote.from, 'USD');
  assert.equal(quote.to, 'EUR');
});

test('JPY destination receiveAmount is a whole number', () => {
  const quote = quoteService.getQuote(100, 'USD', 'JPY');
  assert.equal(Number.isInteger(quote.receiveAmount), true);
});

for (const [currency, amount, expectedFee] of [
  ['JPY', 13, 0],
  ['JPY', 14, 1],
  ['JPY', 30, 1],
  ['JPY', 80, 2],
  ['JPY', 479, 7],
  ['JPY', 480, 8],
  ['JPY', 481, 8],
  ['USD', 100.50, 1.81],
  ['USD', 116.99, 2.05],
  ['USD', 117, 2.06],
  ['USD', 117.01, 2.06],
  ['USD', 125, 2.18],
]) {
  test(`combined fee for ${amount} ${currency} rounds once to ${expectedFee}`, () => {
    assert.equal(quoteService.calculateFee(amount, currency), expectedFee);
  });
}

test('getQuote rejects unsupported currency before FX math', () => {
  assert.throws(
    () => quoteService.getQuote(10, 'USD', 'ZZZ'),
    (err) => err.status === 400 || err.statusCode === 400 || /Unsupported/i.test(err.message)
  );
});

// ── HTTP contract ───────────────────────────────────────────────────────────

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

async function fetchJson(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

for (const [amount, from, to, fee, afterFee, receiveAmount] of [
  [16.04, 'GBP', 'USD', 0.54, 15.5, 19.69],
  [4.14, 'GBP', 'EUR', 0.36, 3.78, 4.45],
  [384, 'JPY', 'EUR', 6, 378, 2.35],
]) {
  test(`decimal FX rounding agrees for conversion, preview and transfer: ${from}/${to}`, async () => {
    assert.equal(rateService.convert(afterFee, from, to), receiveAmount);
    const quote = await fetchJson(`/api/quote?amount=${amount}&from=${from}&to=${to}`);
    const transfer = await fetchJson('/api/transfers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token-admin',
        'Content-Type': 'application/json',
        'Idempotency-Key': `idem-decimal-fx-${from}-${to}`,
      },
      body: JSON.stringify({
        senderName: 'Alice', recipientName: 'Bob', amount, from, to,
      }),
    });
    assert.equal(quote.status, 200);
    assert.equal(transfer.status, 201);
    assert.equal(quote.body.fee, fee);
    assert.equal(quote.body.amountAfterFee, afterFee);
    assert.equal(quote.body.receiveAmount, receiveAmount);
    assert.equal(transfer.body.fee, fee);
    assert.equal(transfer.body.sendAmount, amount);
    assert.equal(transfer.body.receiveAmount, receiveAmount);
  });
}

for (const field of ['amount', 'from', 'to']) {
  test(`HTTP ${field} objects return 400 before effects and leave the request key reusable`, async (t) => {
    const submitPayment = t.mock.method(stellarService, 'submitPayment');
    const valid = { senderName: 'Alice', recipientName: 'Bob', amount: 100, from: 'USD', to: 'EUR' };
    const post = (body) => fetchJson('/api/transfers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token-admin',
        'Content-Type': 'application/json',
        'Idempotency-Key': `idem-currency-typed-${field}`,
      },
      body: JSON.stringify(body),
    });
    for (const value of [{ toString: null }, { valueOf: false, toString: [] }, [{ toString: 0 }]]) {
      const rejected = await post({ ...valid, [field]: value });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error.message, 'Validation failed');
      assert.ok(rejected.body.error.details.errors.length > 0);
    }
    const query = new URLSearchParams({ amount: '100', from: 'USD', to: 'EUR' });
    query.delete(field);
    query.set(`${field}[toString]`, 'not-callable');
    const quote = await fetchJson(`/api/quote?${query}`);
    assert.equal(quote.status, 400);
    assert.equal(quote.body.error.message, 'Validation failed');
    assert.ok(quote.body.error.details.errors.length > 0);
    assert.equal(submitPayment.mock.callCount(), 0);
    assert.equal(store.transfers.size, 0);
    assert.equal(store.transferIndex.size, 0);
    assert.equal(auditService.countEntries(), 0);
    assert.equal(store.idempotency.size, 0);

    const preview = await fetchJson('/api/quote?amount=100&from=USD&to=EUR');
    const recovered = await post(valid);
    assert.equal(preview.status, 200);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.sendAmount, preview.body.sendAmount);
    assert.equal(recovered.body.receiveAmount, preview.body.receiveAmount);
    assert.equal(submitPayment.mock.callCount(), 1);
    assert.equal(store.transfers.size, 1);
    assert.equal(store.idempotency.size, 1);
  });
}

test('invalid amount with a missing or unsupported source returns both HTTP validation errors', async () => {
  for (const from of [undefined, 'ZZZ']) {
    const response = await fetchJson('/api/transfers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token-admin',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-currency-two-errors',
      },
      body: JSON.stringify({ senderName: 'Alice', recipientName: 'Bob', amount: { toString: null }, from, to: 'EUR' }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.details.errors.length, 2);
    assert.ok(response.body.error.details.errors.includes('amount must be a positive number'));
    assert.equal(store.transfers.size, 0);
    assert.equal(store.idempotency.size, 0);
  }
});

test('GET /api/quote rejects unsupported currency', async () => {
  const { status, body } = await fetchJson('/api/quote?amount=10&from=USD&to=ZZZ');
  assert.equal(status, 400);
  assert.ok(
    body.error.details.errors.some((e) => /Unsupported target currency/i.test(e))
  );
});

test('GET /api/quote rejects a send amount beyond the transfer ceiling', async () => {
  const amount = 999999;
  const quote = await fetchJson(`/api/quote?amount=${amount}&from=USD&to=EUR`);
  assert.equal(quote.status, 400);
  assert.ok(quote.body.error.details.errors.some((e) => /must not exceed/i.test(e)));

  assert.ok(validateCreateTransfer({
    body: {
      senderName: 'Alice',
      recipientName: 'Bob',
      amount,
      from: 'USD',
      to: 'EUR',
    },
  }).some((e) => /must not exceed/i.test(e)));
  assert.throws(
    () => quoteService.getQuote(amount, 'USD', 'EUR'),
    (err) => /must not exceed/i.test(err.message)
  );
});

test('GET /api/quote rejects fractional JPY send amount', async () => {
  const { status, body } = await fetchJson('/api/quote?amount=10.5&from=JPY&to=USD');
  assert.equal(status, 400);
  assert.ok(body.error.details.errors.some((e) => /whole number/i.test(e)));
});

test('POST /api/transfers rejects unsupported currency before mutation', async () => {
  const { status, body } = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-currency-1',
    },
    body: JSON.stringify({
      senderName: 'Alice',
      recipientName: 'Bob',
      amount: 25,
      from: 'USD',
      to: 'ZZZ',
    }),
  });
  assert.equal(status, 400);
  assert.ok(
    body.error.details.errors.some((e) => /Unsupported target currency/i.test(e))
  );
});

test('POST /api/transfers and GET /api/quote agree on canonical sendAmount', async () => {
  const amount = 88.88;
  const quoteRes = await fetchJson(`/api/quote?amount=${amount}&from=USD&to=EUR`);
  assert.equal(quoteRes.status, 200);

  const transferRes = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-currency-preview-1',
    },
    body: JSON.stringify({
      senderName: 'Alice',
      recipientName: 'Bob',
      amount,
      from: 'USD',
      to: 'EUR',
    }),
  });
  assert.equal(transferRes.status, 201);
  assert.equal(transferRes.body.sendAmount, quoteRes.body.sendAmount);
  assert.equal(transferRes.body.from, quoteRes.body.from);
  assert.equal(transferRes.body.to, quoteRes.body.to);
  assert.equal(transferRes.body.receiveAmount, quoteRes.body.receiveAmount);
});

test('JPY quote and transfer use the fee rounded after both components are added', async () => {
  const quoteRes = await fetchJson('/api/quote?amount=30&from=JPY&to=USD');
  assert.equal(quoteRes.status, 200);
  assert.equal(quoteRes.body.sendAmount, 30);
  assert.equal(quoteRes.body.fee, 1);
  assert.equal(quoteRes.body.amountAfterFee, 29);
  assert.equal(quoteRes.body.receiveAmount, 0.19);

  const transferRes = await fetchJson('/api/transfers', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token-admin',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-currency-jpy-fee',
    },
    body: JSON.stringify({
      senderName: 'Alice',
      recipientName: 'Bob',
      amount: 30,
      from: 'JPY',
      to: 'USD',
    }),
  });
  assert.equal(transferRes.status, 201);
  assert.equal(transferRes.body.sendAmount, 30);
  assert.equal(transferRes.body.fee, 1);
  assert.equal(transferRes.body.receiveAmount, 0.19);
});

for (const [amount, correctedAmount, from, to, receiveAmount] of [
  [0.01, 0.31, 'USD', 'EUR', 0.01],
  [0.30, 0.31, 'USD', 'EUR', 0.01],
  [8.11, 8.12, 'NGN', 'USD', 0.01],
  [5.53, 5.54, 'NGN', 'JPY', 1],
]) {
  test(`quote and transfer reject an unpayable ${amount} ${from} to ${to} before mutation`, async (t) => {
    // Observe the existing settlement adapter without replacing its behavior.
    const submitPayment = t.mock.method(stellarService, 'submitPayment');
    const createTransfer = (value) => fetchJson('/api/transfers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token-admin',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-currency-positive-payout',
      },
      body: JSON.stringify({
        senderName: 'Alice', recipientName: 'Bob', amount: value, from, to,
      }),
    });

    const quote = await fetchJson(`/api/quote?amount=${amount}&from=${from}&to=${to}`);
    const rejected = await createTransfer(amount);
    assert.equal(quote.status, 400);
    assert.equal(rejected.status, 400);
    assert.match(quote.body.error.message, /positive receive amount/i);
    assert.equal(rejected.body.error.message, quote.body.error.message);
    assert.equal(submitPayment.mock.callCount(), 0);
    assert.equal(store.transfers.size, 0);
    assert.equal(store.transferIndex.size, 0);
    assert.equal(auditService.countEntries(), 0);
    assert.equal(store.idempotency.size, 0);

    // A corrected amount can reuse the rejected request's key. Amounts that
    // round up to one destination minor unit remain valid.
    const correctedQuote = await fetchJson(
      `/api/quote?amount=${correctedAmount}&from=${from}&to=${to}`
    );
    const corrected = await createTransfer(correctedAmount);
    assert.equal(correctedQuote.status, 200);
    assert.equal(corrected.status, 201);
    assert.equal(correctedQuote.body.receiveAmount, receiveAmount);
    assert.equal(corrected.body.receiveAmount, correctedQuote.body.receiveAmount);
    assert.equal(submitPayment.mock.callCount(), 1);
    assert.equal(store.transfers.size, 1);
    assert.equal(store.transferIndex.size, 1);
    assert.equal(auditService.countEntries(), 1);
    assert.equal(store.idempotency.size, 1);
  });
}

for (const [amount, from, to, fee, receiveAmount] of [
  [1, 'JPY', 'USD', 0, 0.01],
  [50000, 'USD', 'NGN', 750.30, 75768769.23],
]) {
  test(`positive payout preserves the source amount boundary ${amount} ${from} to ${to}`, async () => {
    const quote = await fetchJson(`/api/quote?amount=${amount}&from=${from}&to=${to}`);
    const transfer = await fetchJson('/api/transfers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token-admin',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-currency-source-boundary',
      },
      body: JSON.stringify({
        senderName: 'Alice', recipientName: 'Bob', amount, from, to,
      }),
    });
    assert.equal(quote.status, 200);
    assert.equal(transfer.status, 201);
    assert.equal(quote.body.fee, fee);
    assert.equal(quote.body.receiveAmount, receiveAmount);
    assert.equal(transfer.body.sendAmount, amount);
    assert.equal(transfer.body.receiveAmount, quote.body.receiveAmount);
  });
}


// Decimal cents must survive the existing Number-valued API representation.
test('numeric readback rejects cent values rounded by the Number representation', () => {
  for (const code of ['USD', 'EUR', 'GBP', 'INR', 'NGN', 'PHP', 'MXN', 'KES']) {
    for (const amount of ['90071992547409.91', '70368744177664.01', '-70368744177664.01']) {
      assert.throws(() => currencyPolicy.roundToCurrency(amount, code),
        (error) => error instanceof RangeError && /numeric range/.test(error.message));
    }
  }
});

test('numeric readback returns structured canonical errors without throwing', () => {
  for (const amount of ['90071992547409.91', '70368744177664.01']) {
    assert.deepEqual(currencyPolicy.canonicalizeAmount(amount, 'USD', { enforceMax: false }), {
      ok: false, errors: ['amount is outside the supported numeric range'],
    });
    assert.deepEqual(currencyPolicy.validateTransferPair(amount, 'USD', 'EUR', { enforceMax: false }),
      ['amount is outside the supported numeric range']);
  }
});

test('numeric readback retains representable decimal and whole-yen boundaries', () => {
  for (const amount of ['90071992547409.89', '90071992547409.88', '90071992547409.90', '0.01', '1.01']) {
    const result = currencyPolicy.canonicalizeAmount(amount, 'USD', { enforceMax: false });
    assert.equal(result.ok, true);
    const text = JSON.parse(JSON.stringify(result.amount)).toString();
    const [whole, fraction = ''] = text.split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    assert.equal(cents, BigInt(amount.replace('.', '')));
  }
  assert.equal(currencyPolicy.roundToCurrency(Number.MAX_SAFE_INTEGER, 'JPY'), Number.MAX_SAFE_INTEGER);
  assert.equal(currencyPolicy.roundToCurrency(-Number.MAX_SAFE_INTEGER, 'JPY'), -Number.MAX_SAFE_INTEGER);
  assert.ok(Object.is(currencyPolicy.roundToCurrency('-0.001', 'USD'), -0));
});

test('numeric readback returns HTTP 400 before transfer or audit effects', async (t) => {
  const submitPayment = t.mock.method(stellarService, 'submitPayment');
  for (const amount of ['90071992547409.91', '70368744177664.01']) {
    const response = await fetchJson(`/api/quote?amount=${amount}&from=USD&to=EUR`);
    assert.equal(response.status, 400);
    assert.ok(response.body.error.details.errors.includes('amount is outside the supported numeric range'));
  }
  assert.equal(submitPayment.mock.callCount(), 0);
  assert.equal(store.transfers.size, 0);
  assert.equal(store.idempotency.size, 0);
  assert.equal(auditService.countEntries(), 0);
});
