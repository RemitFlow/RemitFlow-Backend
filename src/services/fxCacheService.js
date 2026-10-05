'use strict';

const config = require('../config');
const fxProviders = require('./fxProviders');
const ApiError = require('../utils/ApiError');

/**
 * Bounded FX rate cache with stampede protection and explicit stale policy.
 *
 * Cache key is a single global snapshot: RemitFlow converts via USD cross rates,
 * so one provider pull feeds every pair. TTL bounds how long a snapshot is
 * "fresh"; staleGraceMs bounds how long an expired snapshot may still be served
 * under allow_stale / outage policy.
 *
 * Stampede control is synchronous singleflight: the first miss starts a
 * provider fetch and marks the key in-flight. A re-entrant or concurrent caller
 * that arrives while the fetch is running must NOT start another provider call.
 * It either receives a still-within-grace cached snapshot marked stale, or a
 * 503 with code FX_REFRESH_IN_PROGRESS when no usable cache exists.
 */

const CACHE_KEY = 'rates:usd';

/** @type {Map<string, { ratesToUsd: object, fetchedAt: number, providerId: string, expiresAt: number }>} */
const cache = new Map();

/** @type {Set<string>} keys currently being refreshed */
const inflight = new Set();

// Singleflight alone does not stop sequential requests from retrying an outage.
// Keep at most two failure records: freshness rejection under reject_stale must
// not suppress a provider response that allow_stale could accept for display.
const RETRY_COOLDOWN_MS = 1_000;
const failedRefreshes = new Map();

/** Counter for tests: how many times providers were actually invoked. */
let providerFetchCount = 0;

function ttlMs() {
  return config.fx.cacheTtlMs;
}

function staleGraceMs() {
  return config.fx.staleGraceMs;
}

/**
 * Classify a cache entry relative to `now`.
 * @param {{ fetchedAt: number, expiresAt: number }} entry
 * @param {number} now
 * @returns {'fresh'|'stale'|'expired'}
 */
function classify(entry, now) {
  if (now < entry.expiresAt) return 'fresh';
  if (now < entry.expiresAt + staleGraceMs()) return 'stale';
  return 'expired';
}

/**
 * Attach freshness metadata without mutating the stored entry.
 * @param {object} entry
 * @param {number} now
 * @param {{ cacheHit: boolean, source: string }} extra
 */
function decorate(entry, now, extra) {
  const status = classify(entry, now);
  return {
    ratesToUsd: { ...entry.ratesToUsd },
    providerId: entry.providerId,
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
    ageMs: Math.max(0, now - entry.fetchedAt),
    status,
    stale: status !== 'fresh',
    cacheHit: Boolean(extra.cacheHit),
    source: extra.source,
  };
}

/**
 * Pull from providers (counted), accepting only snapshots within policy before
 * choosing a provider or replacing the cache. A successful fetch is not proof
 * that the provider's timestamp is current.
 * @param {() => number} readNow
 * @param {'reject_stale'|'allow_stale'} policy
 */
function refresh(readNow, policy) {
  providerFetchCount += 1;
  let acceptedAt;
  const snapshot = fxProviders.fetchWithFallback({
    // Each fallback starts at the current time. A slow earlier provider must
    // not make the next provider inherit an already-expired request timestamp.
    get now() { return readNow(); },
    acceptSnapshot(candidate) {
      const now = readNow();
      const expiresAt = candidate.fetchedAt + ttlMs();
      // A future provider timestamp would extend freshness beyond the local
      // TTL. Reject it instead of clamping away its provenance so a usable
      // fallback can still win.
      if (!Number.isFinite(candidate.fetchedAt) || !Number.isFinite(expiresAt) ||
          candidate.fetchedAt > now) {
        return false;
      }
      const status = classify({ expiresAt }, now);
      const accepted = status === 'fresh' || (policy === 'allow_stale' && status === 'stale');
      if (accepted) acceptedAt = now;
      return accepted;
    },
  });
  const entry = {
    ratesToUsd: { ...snapshot.ratesToUsd },
    fetchedAt: snapshot.fetchedAt,
    providerId: snapshot.providerId,
    expiresAt: snapshot.fetchedAt + ttlMs(),
  };
  cache.set(CACHE_KEY, entry);
  return decorate(entry, acceptedAt, { cacheHit: false, source: 'provider' });
}

/**
 * Resolve a rate snapshot under an explicit stale policy.
 *
 * Policies:
 * - `reject_stale` (transfer pricing): only fresh snapshots are usable. On
 *   provider outage we still refuse stale data rather than price a transfer
 *   on an expired rate.
 * - `allow_stale` (display / quotes for inspection): may return a within-grace
 *   stale snapshot when providers are down or a refresh is in flight. The
 *   response always marks `stale: true` so callers cannot mistake it for current.
 *
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {'reject_stale'|'allow_stale'} [opts.policy]
 * @returns {ReturnType<typeof decorate>}
 */
function getSnapshot(opts = {}) {
  // An explicit time remains a deterministic snapshot for callers/tests.
  // Normal requests must account for time spent inside synchronous providers.
  const readNow = opts.now != null ? () => opts.now : () => Date.now();
  const now = readNow();
  const policy = opts.policy || 'reject_stale';
  const failureKey = policy === 'allow_stale' ? 'allow_stale' : 'reject_stale';
  const entry = cache.get(CACHE_KEY);

  if (entry) {
    const status = classify(entry, now);
    if (status === 'fresh') {
      return decorate(entry, now, { cacheHit: true, source: 'cache' });
    }
  }

  // Stampede guard: someone is already talking to providers for this key.
  if (inflight.has(CACHE_KEY)) {
    if (entry && classify(entry, now) === 'stale' && policy === 'allow_stale') {
      return decorate(entry, now, { cacheHit: true, source: 'cache-stale-inflight' });
    }
    throw ApiError.serviceUnavailable('FX rate refresh in progress', {
      code: 'FX_REFRESH_IN_PROGRESS',
    });
  }

  const failure = failedRefreshes.get(failureKey);
  // A backward clock jump must not turn a one-second cooldown into a long hold.
  if (failure && now >= failure.failedAt && now < failure.retryAt) {
    if (entry && classify(entry, now) === 'stale' && policy === 'allow_stale') {
      return decorate(entry, now, { cacheHit: true, source: 'cache-stale-outage' });
    }
    throw ApiError.serviceUnavailable('All FX providers failed', {
      code: 'FX_PROVIDERS_DOWN',
      attempted: failure.attempted.map((attempt) => ({ ...attempt })),
      retryAfterMs: failure.retryAt - now,
    });
  }

  inflight.add(CACHE_KEY);
  try {
    const snapshot = refresh(readNow, policy);
    if (snapshot.status === 'fresh') failedRefreshes.clear();
    else failedRefreshes.delete(failureKey);
    return snapshot;
  } catch (err) {
    // Provider path failed. Under allow_stale, a within-grace entry is still
    // usable for display — but it is visibly stale. Under reject_stale we
    // never price with it.
    const failedAt = readNow();
    if (err instanceof ApiError && err.statusCode === 503 &&
        err.details && err.details.code === 'FX_PROVIDERS_DOWN') {
      failedRefreshes.set(failureKey, {
        failedAt,
        retryAt: failedAt + RETRY_COOLDOWN_MS,
        // Keep only the provider layer's redacted diagnostics, not its Error.
        attempted: err.details.attempted.map((attempt) => ({ ...attempt })),
      });
    }
    if (entry && classify(entry, failedAt) === 'stale' && policy === 'allow_stale') {
      return decorate(entry, failedAt, { cacheHit: true, source: 'cache-stale-outage' });
    }
    throw err;
  } finally {
    inflight.delete(CACHE_KEY);
  }
}

/**
 * Read the cached entry without refreshing. Used by tests and diagnostics.
 * @param {number} [now]
 */
function peek(now = Date.now()) {
  const entry = cache.get(CACHE_KEY);
  if (!entry) return null;
  return decorate(entry, now, { cacheHit: true, source: 'peek' });
}

/** Drop cache, inflight state, and retry cooldowns. */
function reset() {
  cache.clear();
  inflight.clear();
  failedRefreshes.clear();
  providerFetchCount = 0;
}

function getProviderFetchCount() {
  return providerFetchCount;
}

/**
 * Seed the cache (tests). `fetchedAt` defaults to now; TTL applied from config.
 * @param {object} partial
 */
function seed(partial = {}) {
  const now = partial.fetchedAt != null ? partial.fetchedAt : Date.now();
  const entry = {
    ratesToUsd: { ...(partial.ratesToUsd || require('../config/rates').RATES_TO_USD) },
    fetchedAt: now,
    providerId: partial.providerId || 'primary',
    expiresAt: partial.expiresAt != null ? partial.expiresAt : now + ttlMs(),
  };
  cache.set(CACHE_KEY, entry);
  return entry;
}

module.exports = {
  CACHE_KEY,
  getSnapshot,
  peek,
  reset,
  seed,
  classify,
  getProviderFetchCount,
  ttlMs,
  staleGraceMs,
};
