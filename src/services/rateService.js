'use strict';

const { SUPPORTED_CURRENCIES } = require('../config/rates');
const money = require('../utils/money');
const currency = require('../utils/currency');
const ApiError = require('../utils/ApiError');
const fxCacheService = require('./fxCacheService');

/**
 * Foreign exchange helpers built on the cached FX provider snapshot.
 *
 * Callers that only need a number keep using getRate/convert/getPair. Paths
 * that must expose freshness (quotes, rate list responses) use the snapshot
 * helpers so stale data is visible rather than silent.
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {'reject_stale'|'allow_stale'} [opts.policy]
 */
function getSnapshot(opts = {}) {
  return fxCacheService.getSnapshot({
    now: opts.now,
    policy: opts.policy || 'reject_stale',
  });
}

/**
 * Return supported currencies and their USD rate, plus freshness metadata.
 * Display-oriented: may surface a visibly-stale snapshot during outage.
 * @param {object} [opts]
 * @returns {{ rates: Array<{currency: string, rateToUsd: number}>, freshness: object }}
 */
function listRates(opts = {}) {
  const snapshot = getSnapshot({ ...opts, policy: opts.policy || 'allow_stale' });
  return {
    rates: SUPPORTED_CURRENCIES.map((code) => ({
      currency: code,
      rateToUsd: snapshot.ratesToUsd[code],
    })),
    freshness: {
      status: snapshot.status,
      stale: snapshot.stale,
      providerId: snapshot.providerId,
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
      expiresAt: new Date(snapshot.expiresAt).toISOString(),
      ageMs: snapshot.ageMs,
      cacheHit: snapshot.cacheHit,
      source: snapshot.source,
    },
  };
}

/**
 * Check configured currencies before inspecting any provider-added codes.
 * Known currencies need no decorated snapshot or rate-table copy. Validation
 * remains available during provider outages and never initiates a live pull.
 * @param {string} code
 * @returns {boolean}
 */
function isSupported(code) {
  const normalized = currency.normalize(code);
  if (!normalized) return false;
  if (SUPPORTED_CURRENCIES.includes(normalized)) return true;
  const peeked = fxCacheService.peek();
  if (peeked && Object.prototype.hasOwnProperty.call(peeked.ratesToUsd, normalized)) {
    return true;
  }
  return false;
}

/**
 * Compute the exchange rate to convert one unit of `from` into `to`.
 * Uses reject_stale so transfer pricing never silently consumes expired data.
 * @param {string} from
 * @param {string} to
 * @param {object} [opts]
 * @returns {number}
 */
function getRate(from, to, opts = {}) {
  const fromCode = currency.normalize(from);
  const toCode = currency.normalize(to);
  const snapshot = getSnapshot({
    now: opts.now,
    policy: opts.policy || 'reject_stale',
  });

  if (!Object.prototype.hasOwnProperty.call(snapshot.ratesToUsd, fromCode)) {
    throw ApiError.badRequest(`Unsupported source currency: ${from}`);
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot.ratesToUsd, toCode)) {
    throw ApiError.badRequest(`Unsupported target currency: ${to}`);
  }

  return snapshot.ratesToUsd[fromCode] / snapshot.ratesToUsd[toCode];
}

/**
 * Convert an amount from one currency to another.
 * @param {number} amount
 * @param {string} from
 * @param {string} to
 * @param {object} [opts]
 * @returns {number}
 */
function convert(amount, from, to, opts = {}) {
  const rate = getRate(from, to, opts);
  return money.round(amount * rate);
}

/**
 * Describe a single currency pair, e.g. "USD-INR", with freshness.
 * @param {string} from
 * @param {string} to
 * @param {object} [opts]
 * @returns {object}
 */
function getPair(from, to, opts = {}) {
  const fromCode = currency.normalize(from);
  const toCode = currency.normalize(to);
  const snapshot = getSnapshot({
    now: opts.now,
    policy: opts.policy || 'allow_stale',
  });

  if (!Object.prototype.hasOwnProperty.call(snapshot.ratesToUsd, fromCode)) {
    throw ApiError.badRequest(`Unsupported source currency: ${from}`);
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot.ratesToUsd, toCode)) {
    throw ApiError.badRequest(`Unsupported target currency: ${to}`);
  }

  const rate = snapshot.ratesToUsd[fromCode] / snapshot.ratesToUsd[toCode];
  return {
    from: fromCode,
    to: toCode,
    // Applying minor-unit rounding here can turn a valid FX rate into zero.
    rate,
    freshness: {
      status: snapshot.status,
      stale: snapshot.stale,
      providerId: snapshot.providerId,
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
      expiresAt: new Date(snapshot.expiresAt).toISOString(),
      ageMs: snapshot.ageMs,
      cacheHit: snapshot.cacheHit,
      source: snapshot.source,
    },
  };
}

module.exports = {
  listRates,
  isSupported,
  getRate,
  convert,
  getPair,
  getSnapshot,
};
