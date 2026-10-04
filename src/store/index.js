'use strict';

const auditService = require('../services/auditService');
const { OrderedIndex } = require('../utils/orderedIndex');

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
  // Keyed by "<actor>\0<idempotency-key>". Lives here rather than in a module
  // local so it shares the transfers' lifetime: a replay can never outlive the
  // transfer it would replay.
  idempotency: new Map(),
  // Actor-scoped receipts for terminal claim/cancel mutations. Isolated from
  // create idempotency so a retry of a claim replays the terminal result
  // without colliding with the key used to create the transfer.
  lifecycleIdempotency: new Map(),
  // Per-transfer leases held while a lifecycle mutation is between reservation
  // and commit. Prevents two different operation keys from both calling the
  // provider for the same transfer (the double-settlement window).
  lifecycleLeases: new Map(),
  // Provider settlement receipts keyed by stable operation id. Shared with the
  // settlement worker so a module reload still returns the first artifact.
  settlementReceipts: new Map(),
};

/** Remove all records from the store. Primarily used in tests/seeding. */
function reset() {
  store.users.clear();
  store.transfers.clear();
  store.transferIndex.reset();
  store.idempotency.clear();
  store.lifecycleIdempotency.clear();
  store.lifecycleLeases.clear();
  store.settlementReceipts.clear();
  auditService.reset();
}

module.exports = {
  store,
  reset,
};
