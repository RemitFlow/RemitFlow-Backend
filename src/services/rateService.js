'use strict';

const { RATES_TO_USD, SUPPORTED_CURRENCIES } = require('../config/rates');
const currency = require('../utils/currency');
const currencyPolicy = require('../utils/currencyPolicy');
const ApiError = require('../utils/ApiError');

/**
 * Foreign exchange helpers built on top of the mock rate table.
 */

/**
 * Return the full list of supported currencies and their USD rate.
 * @returns {Array<{currency: string, rateToUsd: number}>}
 */
function listRates() {
  return SUPPORTED_CURRENCIES.map((currency) => ({
    currency,
    rateToUsd: RATES_TO_USD[currency],
  }));
}

/**
 * Check whether a currency code is supported.
 * @param {string} currency
 * @returns {boolean}
 */
function isSupported(currency) {
  return Object.prototype.hasOwnProperty.call(RATES_TO_USD, currency);
}

/**
 * Compute the exchange rate to convert one unit of `from` into `to`.
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function getRate(from, to) {
  const fromCode = currency.normalize(from);
  const toCode = currency.normalize(to);
  if (!isSupported(fromCode)) {
    throw ApiError.badRequest(`Unsupported source currency: ${currencyPolicy.describeCurrency(from)}`);
  }
  if (!isSupported(toCode)) {
    throw ApiError.badRequest(`Unsupported target currency: ${currencyPolicy.describeCurrency(to)}`);
  }
  // Convert source -> USD -> target.
  return RATES_TO_USD[fromCode] / RATES_TO_USD[toCode];
}

/**
 * Convert an amount from one currency to another.
 * @param {number} amount
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function convert(amount, from, to) {
  getRate(from, to); // Preserve unsupported-currency validation.
  const fromCode = currency.normalize(from);
  const toCode = currency.normalize(to);
  return currencyPolicy.roundToCurrency(amount, toCode, {
    multiplier: RATES_TO_USD[fromCode],
    divisor: RATES_TO_USD[toCode],
  });
}

/**
 * Describe a single currency pair, e.g. "USD-INR".
 * @param {string} from
 * @param {string} to
 * @returns {{ from: string, to: string, rate: number }}
 */
function getPair(from, to) {
  const fromCode = currency.normalize(from);
  const toCode = currency.normalize(to);
  return {
    from: fromCode,
    to: toCode,
    // Applying minor-unit rounding here can turn a valid FX rate into zero.
    rate: getRate(fromCode, toCode),
  };
}

module.exports = {
  listRates,
  isSupported,
  getRate,
  convert,
  getPair,
};
