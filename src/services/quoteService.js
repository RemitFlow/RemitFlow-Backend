'use strict';

const config = require('../config');
const rateService = require('./rateService');
const currencyPolicy = require('../utils/currencyPolicy');
const ApiError = require('../utils/ApiError');

/**
 * Quote calculation.
 * A quote tells the sender how much the recipient will receive after
 * RemitFlow's fee and the FX conversion are applied.
 *
 * Amounts are canonicalized through `currencyPolicy` so the send amount
 * recorded on a transfer matches the amount this preview returned.
 */

/**
 * Compute the fee charged on a send amount.
 * Fee is a percentage of the amount plus a small flat component, rounded
 * to the source currency's minor units.
 * @param {number} amount - canonical amount in the source currency.
 * @param {string} fromCode
 * @returns {number}
 */
function calculateFee(amount, fromCode = config.baseCurrency) {
  return currencyPolicy.roundToCurrency(amount, fromCode, {
    multiplier: config.fee.percent,
    divisor: 100,
    addend: config.fee.flat,
  });
}

/**
 * Build a full quote for converting `amount` from `from` to `to`.
 * @param {number|string} amount
 * @param {string} from
 * @param {string} to
 * @returns {object} quote breakdown.
 */
function getQuote(amount, from, to) {
  const canonical = currencyPolicy.canonicalizeAmount(amount, from, {
    enforceMax: true,
  });
  if (!canonical.ok) {
    throw ApiError.badRequest(canonical.errors[0] || 'Invalid amount');
  }

  if (!currencyPolicy.isSupported(to)) {
    throw ApiError.badRequest(`Unsupported target currency: ${currencyPolicy.describeCurrency(to)}`);
  }

  const fromCode = canonical.currency;
  const toMeta = currencyPolicy.getMeta(to);
  const toCode = toMeta.code;
  const numericAmount = canonical.amount;

  if (fromCode === toCode) {
    throw ApiError.badRequest('from and to currencies must differ');
  }

  const fee = calculateFee(numericAmount, fromCode);
  const amountAfterFee = currencyPolicy.roundToCurrency(
    numericAmount,
    fromCode,
    { addend: -fee }
  );
  const rate = rateService.getRate(fromCode, toCode);
  // Receive side rounds to the *destination* currency's minor units so a
  // JPY payout never carries fractional yen that settlement cannot pay.
  let receiveAmount;
  try {
    receiveAmount = rateService.convert(amountAfterFee, fromCode, toCode);
  } catch (err) {
    // Valid source units can still overflow the destination's minor units.
    if (!(err instanceof RangeError)) throw err;
    throw ApiError.badRequest('receive amount is outside the supported numeric range');
  }
  if (receiveAmount <= 0) {
    throw ApiError.badRequest(
      'Amount must produce a positive receive amount after fees and currency rounding'
    );
  }

  return {
    from: fromCode,
    to: toCode,
    sendAmount: numericAmount,
    fee,
    amountAfterFee,
    // FX ratios are not currency amounts; retain the conversion precision.
    rate,
    receiveAmount,
  };
}

module.exports = {
  calculateFee,
  getQuote,
};
