'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SUPPORTED_CURRENCIES } = require('../src/config/rates');
const rateService = require('../src/services/rateService');
const quoteService = require('../src/services/quoteService');

test('small FX rates stay positive and retain the conversion ratio', () => {
  const pair = rateService.getPair('NGN', 'USD');
  const quote = quoteService.getQuote(10000, 'NGN', 'USD');
  assert.equal(pair.rate, 0.00065);
  assert.equal(quote.rate, pair.rate);
  assert.ok(quote.receiveAmount > 0);
});

test('rate responses use the same ratio for every supported currency pair', () => {
  for (const from of SUPPORTED_CURRENCIES) {
    for (const to of SUPPORTED_CURRENCIES) {
      if (from === to) continue;
      const pair = rateService.getPair(from, to);
      const quote = quoteService.getQuote(10000, from, to);
      const expected = rateService.getRate(from, to);
      assert.equal(pair.rate, expected, `${from}-${to} pair`);
      assert.equal(quote.rate, expected, `${from}-${to} quote`);
      assert.equal(JSON.parse(JSON.stringify(quote)).rate, expected);
      assert.equal(quote.receiveAmount, rateService.convert(quote.amountAfterFee, from, to));
    }
  }
});

test('rate precision does not relax quote validation or currency amount rounding', () => {
  assert.throws(() => quoteService.getQuote(10.001, 'USD', 'EUR'), {statusCode: 400});
  assert.throws(() => quoteService.getQuote(100, 'USD', 'USD'), {statusCode: 400});
  assert.throws(() => rateService.getPair('USD', 'UNKNOWN'), {statusCode: 400});
  const yen = quoteService.getQuote(100, 'USD', 'JPY');
  assert.ok(Number.isInteger(yen.receiveAmount));
  assert.equal(yen.fee, 1.8);
  assert.equal(yen.amountAfterFee, 98.2);
});
