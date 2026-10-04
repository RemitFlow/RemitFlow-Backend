'use strict';

/**
 * Money helpers.
 * All amounts are treated as plain numbers but rounded to a fixed
 * number of decimal places to avoid floating point surprises.
 *
 * Prefer `currencyPolicy.roundToCurrency` / `canonicalizeAmount` at API and
 * settlement boundaries; the helpers here remain for shared arithmetic and
 * for callers that do not yet have a currency code.
 */

const DECIMALS = 2;

// Largest magnitude an amount can have while `amount * 10 ** DECIMALS`
// still fits within Number.MAX_SAFE_INTEGER, so cent-level arithmetic
// (fees, FX conversion) never silently loses precision.
const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER / 10 ** DECIMALS;

/**
 * Round a numeric amount to the configured number of decimals.
 * @param {number} amount
 * @param {number} [decimals]
 * @returns {number}
 */
function round(amount, decimals = DECIMALS) {
  const factor = 10 ** decimals;
  return Math.round((Number(amount) + Number.EPSILON) * factor) / factor;
}

/**
 * Determine whether a value is a finite number small enough to be
 * represented exactly at the configured decimal precision. Rejects
 * NaN, +/-Infinity, and magnitudes that would overflow safe-integer
 * arithmetic once scaled to the smallest currency unit (e.g. cents).
 * @param {*} value
 * @returns {boolean}
 */
function isSafeAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= MAX_SAFE_AMOUNT;
}

/**
 * Determine whether a value's decimal representation has at most
 * `decimals` fractional digits, guarding against sub-cent precision
 * (e.g. "10.129") being silently truncated by `round()` downstream.
 * Exponential notation (e.g. "1e21") is treated as invalid.
 * @param {*} value
 * @param {number} [decimals]
 * @returns {boolean}
 */
function hasValidPrecision(value, decimals = DECIMALS) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return false;
  }
  const str = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    return false;
  }
  const fraction = str.split('.')[1] || '';
  return fraction.length <= decimals;
}

/**
 * Determine whether a value is a usable positive amount.
 * @param {*} value
 * @returns {boolean}
 */
function isPositiveAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * Constrain a numeric amount to an inclusive [min, max] range.
 * Non-numeric input falls back to the minimum bound.
 * @param {number} amount
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(amount, min, max) {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.min(Math.max(n, min), max);
}

/**
 * Compute `percent` percent of `amount`, rounded to the money precision.
 * When a currency code is supplied, rounding uses that currency's minor
 * units via currencyPolicy (lazy-required to avoid a circular import at
 * module load).
 * @param {number} amount
 * @param {number} percent - e.g. 1.5 for 1.5%.
 * @param {string} [currencyCode]
 * @returns {number}
 */
function percentage(amount, percent, currencyCode) {
  if (currencyCode) {
    const currencyPolicy = require('./currencyPolicy');
    return currencyPolicy.roundToCurrency(amount, currencyCode, {
      multiplier: percent,
      divisor: 100,
    });
  }
  return round(Number(amount) * (Number(percent) / 100));
}

/**
 * Format an amount with its currency code, e.g. "10.00 USD".
 * @param {number} amount
 * @param {string} currencyCode
 * @returns {string}
 */
function format(amount, currencyCode) {
  try {
    const currencyPolicy = require('./currencyPolicy');
    const meta = currencyPolicy.getMeta(currencyCode);
    const rounded = currencyPolicy.roundToCurrency(amount, meta.code);
    return `${rounded.toFixed(meta.minorUnits)} ${meta.code}`;
  } catch {
    return `${round(amount).toFixed(DECIMALS)} ${currencyCode}`;
  }
}

module.exports = {
  DECIMALS,
  MAX_SAFE_AMOUNT,
  round,
  isPositiveAmount,
  isSafeAmount,
  hasValidPrecision,
  clamp,
  percentage,
  format,
};
