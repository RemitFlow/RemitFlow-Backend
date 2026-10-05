'use strict';

const auditService = require('../services/auditService');
const { OrderedIndex } = require('../utils/orderedIndex');

// Lazy requires avoid a circular init with quoteService -> store.
function resetFxState() {
  const fxCacheService = require('../services/fxCacheService');
  const fxProviders = require('../services/fxProviders');
  const quoteService = require('../services/quoteService');
  fxCacheService.reset();
  fxProviders.resetProviders();
  quoteService.resetQuoteVersions();
}

/**
 * Simple in-memory data store.
 * Data lives only for the lifetime of the process; restarting the
 * server clears everything. This keeps the demo dependency-free.
 */
const store = {
  users: new Map(),
  transfers: new Map(),
  /**
   * Append-only creation-order index over `transfers`, maintained alongside the
   * map by transferService. It gives transfer history a stable total order and
   * O(1) seeks, which a Map cannot provide. Transfers are never deleted - the
   * lifecycle only mutates status and archive flags - so appended entries stay
   * valid for the life of the process.
   */
  transferIndex: new OrderedIndex({ sortKeyOf: (transfer) => transfer.createdAt }),
  // Keyed by "<actor> <idempotency-key>". Lives here rather than in a module
  // local so it shares the transfers' lifetime: a replay can never outlive the
  // transfer it would replay.
  idempotency: new Map(),
  // Versioned FX quotes awaiting transfer binding. GC'd by quoteService.
  quotes: new Map(),
};

/** Remove all records from the store. Primarily used in tests/seeding. */
function reset() {
  store.users.clear();
  store.transfers.clear();
  store.transferIndex.reset();
  store.idempotency.clear();
  store.quotes.clear();
  auditService.reset();
  resetFxState();
}

module.exports = {
  store,
  reset,
};
