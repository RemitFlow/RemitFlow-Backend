'use strict';

/**
 * Canonical currency metadata shared by API validators and settlement.
 *
 * Every supported currency declares its ISO minor-unit precision, inclusive
 * minimum send amount, and (optional) hard maximum. Amounts are validated and
 * rounded against this table so preview quotes and executed transfers never
 * disagree on precision or supported codes.
 */

const { SUPPORTED_CURRENCIES } = require('../config/rates');
const config = require('../config');
const currency = require('./currency');

/** @typedef {{ code: string, minorUnits: number, minAmount: number, maxAmount: number|null }} CurrencyMeta */

/**
 * Minor units follow ISO 4217 where RemitFlow lists the currency.
 * JPY is zero-decimal; every other corridor currency RemitFlow supports today
 * is two-decimal. Unknown codes are rejected by `getMeta`, not silently
 * defaulted, so a typo cannot settle with the wrong precision.
 *
 * @type {Record<string, CurrencyMeta>}
 */
const CURRENCY_META = Object.freeze({
  USD: { code: 'USD', minorUnits: 2, minAmount: 0.01, maxAmount: null },
  EUR: { code: 'EUR', minorUnits: 2, minAmount: 0.01, maxAmount: null },
  GBP: { code: 'GBP', minorUnits: 2, minAmount: 0.01, maxAmount: null },
  INR: { code: 'INR', minorUnits: 2, minAmount: 0.01, maxAmount: null },
  NGN: { code: 'NGN', minorUnits: 2, minAmount: 0.01, maxAmount: null },
  JPY: { code: 'JPY', minorUnits: 0, minAmount: 1, maxAmount: null },
  PHP: { code: 'PHP', minorUnits: 2, minAmount: 0.01, maxAmount: null },
  MXN: { code: 'MXN', minorUnits: 2, minAmount: 0.01, maxAmount: null },
  KES: { code: 'KES', minorUnits: 2, minAmount: 0.01, maxAmount: null },
});

/**
 * Ensure the policy table stays aligned with the FX rate table. A currency
 * present in rates but missing here (or vice versa) is a programming error
 * that must fail closed at boot rather than settle with wrong precision.
 */
function assertPolicyCoversRates() {
  for (const code of SUPPORTED_CURRENCIES) {
    if (!CURRENCY_META[code]) {
      throw new Error(`currencyPolicy: missing metadata for rate-listed currency ${code}`);
    }
  }
  for (const code of Object.keys(CURRENCY_META)) {
    if (!SUPPORTED_CURRENCIES.includes(code)) {
      throw new Error(`currencyPolicy: metadata for unlisted currency ${code}`);
    }
  }
}

assertPolicyCoversRates();

/**
 * @param {*} code
 * @returns {boolean}
 */
function isSupported(code) {
  const normalized = currency.normalize(code);
  return Object.prototype.hasOwnProperty.call(CURRENCY_META, normalized);
}

/** Describe invalid input without calling user-supplied conversion properties. */
function describeCurrency(code) {
  if (code == null || code === '') return '(empty)';
  return typeof code === 'string' ? code : '(invalid type)';
}

/**
 * @param {*} code
 * @returns {CurrencyMeta}
 */
function getMeta(code) {
  const normalized = currency.normalize(code);
  const meta = CURRENCY_META[normalized];
  if (!meta) {
    const err = new Error(`Unsupported currency: ${describeCurrency(code)}`);
    err.code = 'UNSUPPORTED_CURRENCY';
    err.currency = code;
    throw err;
  }
  return meta;
}

/**
 * Effective max for a currency: per-currency override, else the global
 * `config.maxTransferAmount` ceiling.
 * @param {CurrencyMeta} meta
 * @returns {number}
 */
function effectiveMax(meta) {
  if (meta.maxAmount != null) return meta.maxAmount;
  return config.maxTransferAmount;
}

/**
 * Largest magnitude that still fits in Number.MAX_SAFE_INTEGER once scaled
 * to the currency's minor unit.
 * @param {number} minorUnits
 * @returns {number}
 */
function maxSafeMagnitude(minorUnits) {
  return Number.MAX_SAFE_INTEGER / 10 ** minorUnits;
}

/** Convert a finite decimal input to an exact numerator/denominator pair. */
function decimalRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new RangeError('amount is outside the supported numeric range');
  }
  if (numeric === 0) return [0n, 1n];
  // Safe integer Numbers already are exact decimal integers. In particular,
  // the identity factors used by rounding need no string or regexp parsing.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return [BigInt(value), 1n];
  }
  const text = typeof value === 'string' ? value.trim() : String(numeric);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) {
    throw new TypeError('amount must be a decimal number');
  }
  const fraction = match[3] || '';
  const scale = fraction.length - Number(match[4] || 0);
  const numerator = BigInt(`${match[1]}${match[2]}${fraction}`);
  return scale >= 0
    ? [numerator, 10n ** BigInt(scale)]
    : [numerator * 10n ** BigInt(-scale), 1n];
}

/**
 * Round a decimal amount to minor units, with ties toward positive infinity
 * (HALF_UP for nonnegative funds, preserving Math.round's negative ties).
 * Fee and FX callers pass their original decimal factors so multiplication,
 * division and addition happen before the single rounding operation.
 * @param {number|string} amount
 * @param {string} code
 * @param {{ multiplier?: number, divisor?: number, addend?: number }} [options]
 * @returns {number}
 */
function roundToCurrency(amount, code, options = {}) {
  const { minorUnits } = getMeta(code);
  const factor = 10 ** minorUnits;
  const [amountN, amountD] = decimalRatio(amount);
  const [multiplyN, multiplyD] = decimalRatio(options.multiplier ?? 1);
  const [divideN, divideD] = decimalRatio(options.divisor ?? 1);
  const [addN, addD] = decimalRatio(options.addend ?? 0);
  if (divideN === 0n) {
    throw new RangeError('currency conversion divisor must not be zero');
  }
  let denominator = amountD * multiplyD * divideN * addD;
  let numerator = (amountN * multiplyN * divideD * addD
    + addN * amountD * multiplyD * divideN) * BigInt(factor);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let rounded = magnitude / denominator;
  const twiceRemainder = (magnitude % denominator) * 2n;
  if (negative ? twiceRemainder > denominator : twiceRemainder >= denominator) {
    rounded += 1n;
  }
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('amount is outside the supported numeric range');
  }
  const result = (negative ? -Number(rounded) : Number(rounded)) / factor;
  // A safe integer number of cents need not survive division as a Number.
  // Compare its decimal serialization exactly, not another float multiply.
  const [readbackN, readbackD] = decimalRatio(result);
  const signedUnits = negative ? -rounded : rounded;
  if (readbackN * BigInt(factor) !== signedUnits * readbackD) {
    throw new RangeError('amount is outside the supported numeric range');
  }
  return result;
}

/** Amount input is numeric or textual; objects and arrays are never coerced. */
function parseAmountNumber(amount) {
  return typeof amount === 'number' || typeof amount === 'string' ? Number(amount) : NaN;
}

/**
 * Validate and canonicalize a send amount for a currency.
 * Returns `{ ok: true, amount, currency, meta }` or `{ ok: false, errors }`.
 *
 * @param {*} amount
 * @param {*} code
 * @param {{ enforceMax?: boolean }} [options]
 * @returns {{ ok: true, amount: number, currency: string, meta: CurrencyMeta } | { ok: false, errors: string[] }}
 */
function canonicalizeAmount(amount, code, options = {}) {
  const enforceMax = options.enforceMax !== false;
  const errors = [];

  if (!code && code !== 0) {
    errors.push('currency is required');
    return { ok: false, errors };
  }

  let meta;
  try {
    meta = getMeta(code);
  } catch (err) {
    errors.push(`Unsupported currency: ${describeCurrency(code)}`);
    return { ok: false, errors };
  }

  if (amount === undefined || amount === null || amount === '') {
    errors.push('amount is required');
    return { ok: false, errors };
  }

  const n = parseAmountNumber(amount);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push('amount must be a positive number');
    return { ok: false, errors };
  }

  if (Math.abs(n) > maxSafeMagnitude(meta.minorUnits)) {
    errors.push('amount is outside the supported numeric range');
    return { ok: false, errors };
  }

  if (!hasValidPrecisionFor(amount, meta.minorUnits)) {
    if (meta.minorUnits === 0) {
      errors.push(`amount for ${meta.code} must be a whole number`);
    } else {
      errors.push(
        `amount must have at most ${meta.minorUnits} decimal places for ${meta.code}`
      );
    }
    return { ok: false, errors };
  }

  let canonical;
  try {
    canonical = roundToCurrency(amount, meta.code);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    errors.push('amount is outside the supported numeric range');
    return { ok: false, errors };
  }

  if (canonical < meta.minAmount) {
    errors.push(`amount must be at least ${meta.minAmount} ${meta.code}`);
    return { ok: false, errors };
  }

  if (enforceMax) {
    const max = effectiveMax(meta);
    if (canonical > max) {
      errors.push(`amount must not exceed ${max}`);
      return { ok: false, errors };
    }
  }

  return { ok: true, amount: canonical, currency: meta.code, meta };
}

/**
 * @param {*} value
 * @param {number} decimals
 * @returns {boolean}
 */
function hasValidPrecisionFor(value, decimals) {
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
 * Collect validation errors for a from/to transfer or quote pair.
 * @param {*} amount
 * @param {*} from
 * @param {*} to
 * @param {{ enforceMax?: boolean, amountLabel?: string }} [options]
 * @returns {string[]}
 */
function validateTransferPair(amount, from, to, options = {}) {
  const errors = [];
  const amountLabel = options.amountLabel || 'amount';

  if (!from) {
    errors.push('from currency is required');
  } else if (!isSupported(from)) {
    errors.push(`Unsupported source currency: ${describeCurrency(from)}`);
  }

  if (!to) {
    errors.push('to currency is required');
  } else if (!isSupported(to)) {
    errors.push(`Unsupported target currency: ${describeCurrency(to)}`);
  }

  if (from && to && currency.normalize(from) && currency.normalize(to)
      && currency.normalize(from) === currency.normalize(to)) {
    errors.push('from and to currencies must differ');
  }

  // Only canonicalize the send amount against the source currency once the
  // source code itself is known/supported — otherwise we would double-report.
  if (from && isSupported(from)) {
    const result = canonicalizeAmount(amount, from, {
      enforceMax: options.enforceMax,
    });
    if (!result.ok) {
      for (const e of result.errors) {
        // Rewrite generic "currency is required" / bare amount messages with
        // the caller's label when useful; keep specific currency messages.
        if (e === 'amount is required') {
          errors.push(`${amountLabel} is required`);
        } else if (e === 'amount must be a positive number') {
          errors.push(`${amountLabel} must be a positive number`);
        } else if (e === 'amount is outside the supported numeric range') {
          errors.push(`${amountLabel} is outside the supported numeric range`);
        } else {
          errors.push(e.replace(/^amount/, amountLabel));
        }
      }
    }
  } else if (amount === undefined || amount === null || amount === '') {
    errors.push(`${amountLabel} is required`);
  } else if (!Number.isFinite(parseAmountNumber(amount)) || parseAmountNumber(amount) <= 0) {
    // Surface a basic amount error even when the currency is missing so the
    // client learns both problems in one round-trip.
    errors.push(`${amountLabel} must be a positive number`);
  }

  return errors;
}

module.exports = {
  CURRENCY_META,
  isSupported,
  describeCurrency,
  getMeta,
  effectiveMax,
  maxSafeMagnitude,
  roundToCurrency,
  canonicalizeAmount,
  hasValidPrecisionFor,
  validateTransferPair,
};
