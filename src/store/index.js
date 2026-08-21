'use strict';

const auditService = require('../services/auditService');

/**
 * Simple in-memory data store.
 * Data lives only for the lifetime of the process; restarting the
 * server clears everything. This keeps the demo dependency-free.
 */
const store = {
  users: new Map(),
  transfers: new Map(),
  // Keyed by "<actor> <idempotency-key>". Lives here rather than in a module
  // local so it shares the transfers' lifetime: a replay can never outlive the
  // transfer it would replay.
  idempotency: new Map(),
};

/** Remove all records from the store. Primarily used in tests/seeding. */
function reset() {
  store.users.clear();
  store.transfers.clear();
  store.idempotency.clear();
  auditService.reset();
}

module.exports = {
  store,
  reset,
};
