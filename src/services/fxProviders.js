'use strict';

const { RATES_TO_USD, SUPPORTED_CURRENCIES } = require('../config/rates');
const ApiError = require('../utils/ApiError');

/**
 * FX provider adapters.
 *
 * RemitFlow currently demos against a static rate table. These adapters wrap
 * that table behind a provider interface so the cache layer can apply TTL,
 * fallback, freshness, and stampede controls without rewriting callers.
 *
 * Providers are intentionally synchronous: the rest of the transfer path is
 * sync, and stampede coverage re-enters mid-fetch the same way the
 * idempotency suite does.
 */

/** @typedef {{ providerId: string, ratesToUsd: Record<string, number>, fetchedAt: number }} FxSnapshot */

/**
 * Clone the configured rate table so callers cannot mutate the module constant.
 * @returns {Record<string, number>}
 */
function cloneRates() {
  return { ...RATES_TO_USD };
}

/**
 * Primary FX oracle. Throws when forced down (tests / outage simulation).
 * @param {{ now?: number }} [opts]
 * @returns {FxSnapshot}
 */
function primaryFetch(opts = {}) {
  if (primaryFetch._down) {
    throw ApiError.serviceUnavailable('Primary FX provider unavailable');
  }
  const now = opts.now != null ? opts.now : Date.now();
  return {
    providerId: 'primary',
    ratesToUsd: cloneRates(),
    fetchedAt: now,
  };
}

/**
 * Deterministic secondary oracle. Same table, distinct identity, so fallback
 * is observable without inventing a second price source for the demo.
 * @param {{ now?: number }} [opts]
 * @returns {FxSnapshot}
 */
function fallbackFetch(opts = {}) {
  if (fallbackFetch._down) {
    throw ApiError.serviceUnavailable('Fallback FX provider unavailable');
  }
  const now = opts.now != null ? opts.now : Date.now();
  return {
    providerId: 'fallback',
    ratesToUsd: cloneRates(),
    fetchedAt: now,
  };
}

primaryFetch._down = false;
fallbackFetch._down = false;

/** Ordered registry. First usable success wins; order is the fallback contract. */
const DEFAULT_PROVIDERS = [
  { id: 'primary', fetch: primaryFetch },
  { id: 'fallback', fetch: fallbackFetch },
];

let providers = DEFAULT_PROVIDERS.slice();

/**
 * Replace the provider list (tests). Pass null/undefined to restore defaults.
 * @param {Array<{ id: string, fetch: Function }>|null|undefined} next
 */
function setProviders(next) {
  providers = next && next.length ? next.slice() : DEFAULT_PROVIDERS.slice();
}

/** @returns {Array<{ id: string, fetch: Function }>} */
function listProviders() {
  return providers.slice();
}

/**
 * Walk providers in order until one returns valid rates accepted by the caller.
 * Incomplete/malformed rates or a response outside the caller's freshness policy are
 * failed attempts, so neither can hide a usable response from a later provider.
 * @param {{ now?: number, acceptSnapshot?: (snapshot: FxSnapshot) => boolean }} [opts]
 * @returns {FxSnapshot}
 * @throws {ApiError} 503 when every provider fails.
 */
function fetchWithFallback(opts = {}) {
  const errors = [];
  for (const provider of providers) {
    try {
      const snapshot = provider.fetch(opts);
      const rates = snapshot && snapshot.ratesToUsd;
      if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
        throw new Error(`Provider ${provider.id} returned an invalid snapshot`);
      }
      const ratesToUsd = { ...rates };
      const values = Object.values(ratesToUsd);
      if (values.length === 0 || values.some((rate) => !Number.isFinite(rate) || rate <= 0)) {
        throw new Error(`Provider ${provider.id} returned invalid rates`);
      }
      // One global snapshot feeds every configured pair. Partial provider
      // responses must not displace the complete cache or hide a usable fallback.
      // Validate the own-property copy so inherited rates cannot fill gaps.
      const missingCurrency = SUPPORTED_CURRENCIES.find((code) =>
        !Object.prototype.hasOwnProperty.call(ratesToUsd, code));
      if (missingCurrency) {
        throw new Error(`Provider ${provider.id} omitted supported currency ${missingCurrency}`);
      }
      // Finite positive entries can still yield Infinity (or zero in the
      // reverse direction) when divided. Every configured pair uses this
      // snapshot, so reject it before it can suppress a usable fallback.
      let minRate = Infinity;
      let maxRate = 0;
      for (const code of SUPPORTED_CURRENCIES) {
        minRate = Math.min(minRate, ratesToUsd[code]);
        maxRate = Math.max(maxRate, ratesToUsd[code]);
      }
      if (!Number.isFinite(maxRate / minRate)) {
        throw new Error(`Provider ${provider.id} returned unrepresentable cross-rates`);
      }
      const normalized = {
        providerId: snapshot.providerId || provider.id,
        ratesToUsd,
        fetchedAt: snapshot.fetchedAt != null ? snapshot.fetchedAt : (opts.now != null ? opts.now : Date.now()),
      };
      if (opts.acceptSnapshot && !opts.acceptSnapshot(normalized)) {
        throw new Error(`Provider ${provider.id} returned a snapshot outside the requested freshness policy`);
      }
      return normalized;
    } catch {
      // Attempts are serialized in public HTTP errors. Adapter exceptions can
      // contain credentials or upstream response bodies, so never expose them.
      errors.push({
        providerId: provider.id,
        message: 'FX provider failed',
      });
    }
  }

  throw ApiError.serviceUnavailable('All FX providers failed', {
    code: 'FX_PROVIDERS_DOWN',
    attempted: errors,
  });
}

/**
 * Test helpers: force a named provider down or recover it.
 * @param {'primary'|'fallback'|string} id
 * @param {boolean} down
 */
function setProviderDown(id, down) {
  if (id === 'primary') primaryFetch._down = Boolean(down);
  if (id === 'fallback') fallbackFetch._down = Boolean(down);
}

/** Reset provider health and registry to defaults. */
function resetProviders() {
  primaryFetch._down = false;
  fallbackFetch._down = false;
  providers = DEFAULT_PROVIDERS.slice();
}

module.exports = {
  primaryFetch,
  fallbackFetch,
  fetchWithFallback,
  setProviders,
  listProviders,
  setProviderDown,
  resetProviders,
  DEFAULT_PROVIDERS,
};
