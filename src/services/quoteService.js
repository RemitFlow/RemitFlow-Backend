'use strict';

const config = require('../config');
const rateService = require('./rateService');
const fxCacheService = require('./fxCacheService');
const money = require('../utils/money');
const currency = require('../utils/currency');
const ApiError = require('../utils/ApiError');
const { prefixedId } = require('../utils/ids');
const { store } = require('../store');

/**
 * Quote calculation with versioning and explicit stale/error policy.
 *
 * A quote tells the sender how much the recipient will receive after
 * RemitFlow's fee and the FX conversion are applied. Each quote is given a
 * stable identity (`quoteId` + `quoteVersion`) so transfer creation can bind
 * to the exact quote the sender saw, rather than silently recomputing against
 * a moved rate.
 *
 * Freshness:
 * - Quotes always carry freshness metadata so stale data is visible.
 * - Transfer pricing uses `reject_stale` and refuses a quote whose underlying
 *   FX snapshot is outside policy.
 */

/** Monotonic version counter for quote identity within the process. */
let quoteVersionSeq = 0;

/**
 * Compute the fee charged on a send amount.
 * Fee is a percentage of the amount plus a small flat component.
 * @param {number} amount - amount in the source currency.
 * @returns {number}
 */
function calculateFee(amount) {
  const percentFee = money.percentage(amount, config.fee.percent);
  return money.round(percentFee + config.fee.flat);
}

/**
 * Build freshness fields from an FX snapshot.
 * @param {object} snapshot
 */
function freshnessFromSnapshot(snapshot) {
  return {
    status: snapshot.status,
    stale: snapshot.stale,
    providerId: snapshot.providerId,
    fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    expiresAt: new Date(snapshot.expiresAt).toISOString(),
    ageMs: snapshot.ageMs,
    cacheHit: snapshot.cacheHit,
    source: snapshot.source,
  };
}

/**
 * Persist a quote so transfer creation can bind to it later.
 * @param {object} quote
 */
function remember(quote) {
  store.quotes.set(quote.quoteId, quote);
  return quote;
}

/**
 * Drop expired quotes opportunistically so the map cannot grow without bound.
 *
 * Only runs once the map crosses a size threshold so bulk transfer seeding
 * (pagination cost tests) stays O(n) rather than O(n²) from a full scan on
 * every mint.
 *
 * @param {number} now
 */
const QUOTE_GC_THRESHOLD = 256;

// Quotes are scanned repeatedly while still live. Cache only their parsed
// string timestamp, not the grace-adjusted deadline. Weak keys do not keep
// evicted quotes alive, and a changed expiry string is parsed again.
const quoteExpiryCache = new WeakMap();

function quoteExpiryMs(quote) {
  const value = quote.quoteExpiresAt;
  const cached = quoteExpiryCache.get(quote);
  if (cached && cached.value === value) return cached.ms;
  const ms = Date.parse(value);
  if (typeof value === 'string') quoteExpiryCache.set(quote, { value, ms });
  return ms;
}

function gcQuotes(now) {
  if (store.quotes.size < QUOTE_GC_THRESHOLD) return;
  for (const [id, quote] of store.quotes.entries()) {
    const expiresAtMs = quoteExpiryMs(quote);
    if (Number.isFinite(expiresAtMs) && expiresAtMs + config.fx.staleGraceMs < now) {
      store.quotes.delete(id);
    }
  }
  // If everything is still live (e.g. bulk seeding within quote TTL), evict the
  // oldest half by insertion order so the map stays bounded.
  if (store.quotes.size >= QUOTE_GC_THRESHOLD * 2) {
    const excess = store.quotes.size - QUOTE_GC_THRESHOLD;
    let removed = 0;
    for (const id of store.quotes.keys()) {
      store.quotes.delete(id);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

/**
 * Build a full quote for converting `amount` from `from` to `to`.
 *
 * Display/default policy is `allow_stale` so an outage still lets a client see
 * a visibly-stale quote; transfer binding later enforces `reject_stale`.
 *
 * @param {number} amount
 * @param {string} from
 * @param {string} to
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {'reject_stale'|'allow_stale'} [opts.policy]
 * @returns {object} quote breakdown.
 */
function getQuote(amount, from, to, opts = {}) {
  if (!money.isPositiveAmount(amount)) {
    throw ApiError.badRequest('amount must be a positive number');
  }
  if (!money.isSafeAmount(amount)) {
    throw ApiError.badRequest('amount is outside the supported numeric range');
  }
  if (!money.hasValidPrecision(amount)) {
    throw ApiError.badRequest(
      `amount must have at most ${money.DECIMALS} decimal places`
    );
  }

  const now = opts.now != null ? opts.now : Date.now();
  const policy = opts.policy || 'allow_stale';
  gcQuotes(now);

  const fromCode = currency.normalize(from);
  const toCode = currency.normalize(to);
  const numericAmount = money.round(Number(amount));
  const fee = calculateFee(numericAmount);
  const amountAfterFee = money.round(numericAmount - fee);

  // Leave normal requests on the cache's live clock through provider work.
  // Only an explicitly supplied snapshot time should freeze admission time.
  const snapshot = rateService.getSnapshot({ now: opts.now, policy });
  if (!Object.prototype.hasOwnProperty.call(snapshot.ratesToUsd, fromCode)) {
    throw ApiError.badRequest(`Unsupported source currency: ${from}`);
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot.ratesToUsd, toCode)) {
    throw ApiError.badRequest(`Unsupported target currency: ${to}`);
  }

  const rate = snapshot.ratesToUsd[fromCode] / snapshot.ratesToUsd[toCode];
  const convertedAmount = amountAfterFee * rate;
  // A safe source amount can exceed safe cent arithmetic after FX conversion.
  // Reject before rounding, assigning an identity, or storing the quote.
  if (!money.isSafeAmount(convertedAmount)) {
    throw ApiError.badRequest('receive amount is outside the supported numeric range');
  }
  const receiveAmount = money.round(convertedAmount);
  quoteVersionSeq += 1;

  const quote = {
    quoteId: prefixedId('quote'),
    quoteVersion: quoteVersionSeq,
    from: fromCode,
    to: toCode,
    sendAmount: numericAmount,
    fee,
    amountAfterFee,
    // Keep the conversion ratio; money precision applies to amounts only.
    rate,
    receiveAmount,
    stale: snapshot.stale,
    freshness: freshnessFromSnapshot(snapshot),
    quoteCreatedAt: new Date(now).toISOString(),
    quoteExpiresAt: new Date(now + config.fx.quoteTtlMs).toISOString(),
  };

  return remember(quote);
}

/**
 * Look up a previously issued quote.
 * @param {string} quoteId
 * @returns {object}
 */
function getQuoteById(quoteId) {
  const quote = store.quotes.get(quoteId);
  if (!quote) {
    throw ApiError.notFound(`Quote not found: ${quoteId}`, {
      code: 'QUOTE_NOT_FOUND',
    });
  }
  return quote;
}

/** Reclassify the bound snapshot without changing the stored quote's terms. */
function withCurrentFreshness(quote, now) {
  const freshness = quote.freshness || {};
  const fetchedAt = Date.parse(freshness.fetchedAt);
  const status = fxCacheService.classify({
    expiresAt: Date.parse(freshness.expiresAt),
  }, now);
  const stale = Boolean(quote.stale || freshness.stale || status !== 'fresh');

  return {
    ...quote,
    stale,
    freshness: {
      ...freshness,
      status: status === 'fresh' && stale ? 'stale' : status,
      stale,
      ageMs: Number.isFinite(fetchedAt) ? Math.max(0, now - fetchedAt) : freshness.ageMs,
    },
  };
}

/**
 * Decide whether a quote may be used under a named policy.
 *
 * - Quote TTL expiry always blocks transfer use (the sender must refresh).
 * - FX freshness is re-evaluated at use time, not fixed at quote issuance.
 * - Stale FX blocks transfer use unless allowStaleForTransfers, within grace.
 * - Display policy never throws for staleness; callers still see `stale: true`.
 *
 * @param {object} quote
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {'reject_stale'|'allow_stale'} [opts.policy]
 * @returns {object} the quote's original terms with current freshness metadata
 */
function assertUsable(quote, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const policy = opts.policy || 'reject_stale';
  const expiresAtMs = Date.parse(quote.quoteExpiresAt);
  const current = withCurrentFreshness(quote, now);

  if (!Number.isFinite(expiresAtMs) || now >= expiresAtMs) {
    if (policy === 'allow_stale') {
      return current;
    }
    throw ApiError.conflict('Quote has expired; request a fresh quote', {
      code: 'QUOTE_EXPIRED',
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      quoteExpiresAt: quote.quoteExpiresAt,
    });
  }

  if (current.stale) {
    const allow =
      policy === 'allow_stale' ||
      (config.fx.allowStaleForTransfers === true && current.freshness.status === 'stale');
    if (!allow) {
      throw ApiError.conflict(
        'Quote is based on a stale FX rate and cannot be used for transfer pricing',
        {
          code: 'QUOTE_STALE',
          quoteId: quote.quoteId,
          quoteVersion: quote.quoteVersion,
          freshness: current.freshness,
        }
      );
    }
  }

  return current;
}

/**
 * Resolve the quote a transfer will bind to.
 *
 * When `quoteId` is supplied the stored quote is loaded and checked under
 * transfer policy, and the request amount/currencies must match so a client
 * cannot bind a USD→EUR quote to a GBP→NGN transfer.
 *
 * When omitted, a fresh reject_stale quote is minted and bound. That keeps
 * existing callers working while still attaching quote identity to every
 * transfer.
 *
 * @param {object} data
 * @param {object} [opts]
 * @returns {object}
 */
function resolveForTransfer(data, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();

  if (data.quoteId) {
    const quote = assertUsable(getQuoteById(data.quoteId), {
      now,
      policy: 'reject_stale',
    });

    const fromCode = currency.normalize(data.from);
    const toCode = currency.normalize(data.to);
    const amount = money.round(Number(data.amount));

    if (
      quote.from !== fromCode ||
      quote.to !== toCode ||
      quote.sendAmount !== amount
    ) {
      throw ApiError.conflict(
        'Quote identity does not match the transfer amount and currencies',
        {
          code: 'QUOTE_MISMATCH',
          quoteId: quote.quoteId,
          quoteVersion: quote.quoteVersion,
          expected: {
            from: quote.from,
            to: quote.to,
            sendAmount: quote.sendAmount,
          },
          received: { from: fromCode, to: toCode, sendAmount: amount },
        }
      );
    }

    return quote;
  }

  const quote = getQuote(data.amount, data.from, data.to, {
    now: opts.now,
    policy: config.fx.allowStaleForTransfers ? 'allow_stale' : 'reject_stale',
  });
  // A synchronous provider may consume the remaining FX or quote TTL.
  // Check at completion before settlement, retaining an explicit test clock.
  return assertUsable(quote, {
    now: opts.now != null ? now : Date.now(),
    policy: 'reject_stale',
  });
}

function resetQuoteVersions() {
  quoteVersionSeq = 0;
}

module.exports = {
  calculateFee,
  getQuote,
  getQuoteById,
  assertUsable,
  resolveForTransfer,
  resetQuoteVersions,
};
