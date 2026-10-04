'use strict';

const { createHash } = require('node:crypto');

const { store } = require('../store');
const { prefixedId } = require('../utils/ids');
const ApiError = require('../utils/ApiError');
const { TRANSFER_STATUS, TRANSFER_TRANSITIONS } = require('../config/constants');
const quoteService = require('./quoteService');
const stellarService = require('./stellarService');
const settlementWorker = require('./settlementWorker');
const idempotencyService = require('./idempotencyService');
const auditService = require('./auditService');
const config = require('../config');

// Keep lifecycle timestamps strictly increasing even when multiple operations
// happen within the same millisecond (common in tests and API batches).
function nextTimestamp(previous) {
  const now = Date.now();
  const previousMs = previous ? Date.parse(previous) : NaN;
  return new Date(Math.max(now, Number.isFinite(previousMs) ? previousMs + 1 : now)).toISOString();
}

/**
 * Build a stable provider idempotency identifier without copying bearer tokens
 * or caller keys into provider receipts or client-visible transfer state.
 * JSON tuple framing removes delimiter ambiguity before hashing.
 */
function createSettlementOperationId(transferId, action, actor, key) {
  const canonical = JSON.stringify([transferId, action, actor, key]);
  return `settlement_${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Transfer lifecycle management.
 * A transfer is created in the PENDING state and can either be
 * CLAIMED by the recipient or CANCELLED by the sender.
 */

/**
 * Return all transfers, optionally filtered by status and/or a free-text
 * search across the sender and recipient names.
 * Archived transfers are excluded from default results unless explicitly requested.
 * @param {object} [filters]
 * @param {string} [filters.status]
 * @param {string} [filters.search]
 * @param {boolean} [filters.archived] - if true, return only archived; if false, exclude archived (default)
 * @returns {Array<object>}
 */
function listTransfers(filters = {}) {
  const match = buildTransferFilter(filters);
  return Array.from(store.transfers.values()).filter(match);
}

/**
 * Normalise a transfer filter set into a canonical description.
 *
 * The canonical form is what a cursor is fingerprinted against, so two requests
 * that mean the same thing (`?status=pending` and `?status=pending&archived=false`)
 * produce interchangeable cursors, while two that mean different things never do.
 *
 * @param {object} [filters]
 * @returns {{ status: string|null, search: string|null, archived: boolean|'all' }}
 * @throws {ApiError} 400 when the status filter is not a known status.
 */
function normaliseTransferFilters(filters = {}) {
  const { status, search, archived } = filters;

  if (status) {
    const validStatuses = Object.values(TRANSFER_STATUS);
    if (!validStatuses.includes(status)) {
      throw ApiError.badRequest(
        `Invalid status filter: ${status}`,
        { allowed: validStatuses }
      );
    }
  }

  const needle = search == null ? '' : String(search).trim().toLowerCase();

  return {
    status: status || null,
    search: needle === '' ? null : needle,
    archived: archived === true ? true : (archived === 'all' ? 'all' : false),
  };
}

/**
 * Build the predicate for a transfer filter set.
 * @param {object} [filters]
 * @returns {(transfer: object) => boolean}
 */
function buildTransferFilter(filters = {}) {
  const { status, search, archived } = normaliseTransferFilters(filters);

  return function matches(transfer) {
    // Archived state: `true` returns only archived, `'all'` returns both,
    // anything else (the default) excludes archived transfers.
    if (archived === true) {
      if (transfer.archivedAt == null) return false;
    } else if (archived !== 'all') {
      if (transfer.archivedAt) return false;
    }

    if (status && transfer.status !== status) return false;

    if (search) {
      const inSender = transfer.senderName.toLowerCase().includes(search);
      const inRecipient = transfer.recipientName.toLowerCase().includes(search);
      if (!inSender && !inRecipient) return false;
    }

    return true;
  };
}

/**
 * Page through transfer history using the creation-order index.
 *
 * Ordering is by creation position, which is immutable: claiming, cancelling
 * or archiving a transfer never moves it. A cursor therefore stays valid across
 * arbitrary concurrent writes - new transfers only ever appear at the newest
 * edge of the ordering, never in the middle of a page the client already read.
 *
 * @param {object} [options]
 * @param {string} [options.status]
 * @param {string} [options.search]
 * @param {boolean|'all'} [options.archived]
 * @param {'asc'|'desc'} [options.order] - defaults to oldest first.
 * @param {number} [options.limit]
 * @param {number|null} [options.afterSeq] - exclusive start position from a cursor.
 * @param {number} [options.skip] - legacy offset support.
 * @param {number} [options.maxScan] - per-request work budget.
 * @returns {{ items: object[], last: object|null, hasMore: boolean, scanned: number,
 *   scanTruncated: boolean, skipped: number }}
 */
function queryTransfers({
  status,
  search,
  archived,
  order = 'asc',
  limit = config.pagination.defaultLimit,
  afterSeq = null,
  skip = 0,
  maxScan = config.pagination.maxScan,
} = {}) {
  return store.transferIndex.scan({
    match: buildTransferFilter({ status, search, archived }),
    order,
    limit,
    afterSeq,
    skip,
    maxScan,
  });
}

/**
 * Timestamp of the transfer occupying a given index position, or null when no
 * such position exists. Used to detect cursors that survived a store reset and
 * now point at an unrelated record.
 * @param {number} seq
 * @returns {string|null}
 */
function positionKeyAt(seq) {
  const record = store.transferIndex.recordAt(seq);
  return record ? record.key : null;
}

/**
 * Aggregate summary statistics across all transfers.
 * Reports per-status counts and total send volume grouped by currency.
 * @returns {{ total: number, byStatus: object, volumeByCurrency: object }}
 */
function getStats() {
  const transfers = Array.from(store.transfers.values());

  const byStatus = {};
  for (const status of Object.values(TRANSFER_STATUS)) {
    byStatus[status] = 0;
  }

  const volumeByCurrency = {};
  for (const transfer of transfers) {
    byStatus[transfer.status] = (byStatus[transfer.status] || 0) + 1;
    const current = volumeByCurrency[transfer.from] || 0;
    volumeByCurrency[transfer.from] = Math.round((current + transfer.sendAmount) * 100) / 100;
  }

  return { total: transfers.length, byStatus, volumeByCurrency };
}

/**
 * Get a transfer or throw a 404 if missing.
 * @param {string} id
 * @returns {object}
 */
function getTransferOrThrow(id) {
  const transfer = store.transfers.get(id);
  if (!transfer) {
    throw ApiError.notFound(`Transfer not found: ${id}`);
  }
  return transfer;
}

/**
 * Create a new transfer using a freshly computed quote.
 *
 * When `idempotency` is supplied the whole operation is exactly-once for that
 * (actor, key) pair: the key is reserved before the provider is called, so a
 * retry arriving mid-flight cannot start a second settlement, and once the
 * transfer exists the stored result is replayed instead of re-running.
 *
 * The context is optional because idempotency is actor-scoped and an actor only
 * exists at the HTTP boundary; internal callers have no token to scope to. The
 * route requires the header, so every request-driven creation is covered.
 *
 * @param {object} data
 * @param {string} [requestId] - optional correlation id for audit logging
 * @param {{ actor: string, key: string, fingerprint: string }} [idempotency]
 * @returns {object}
 */
function createTransfer(data, requestId, idempotency) {
  if (idempotency) {
    const outcome = idempotencyService.begin(
      store.idempotency,
      idempotency.actor,
      idempotency.key,
      idempotency.fingerprint
    );
    // A completed record short-circuits before the quote is recomputed. Rates
    // move, so recomputing would hand the client a different transfer under the
    // same key, which is the duplicate this is meant to prevent.
    if (outcome.status === 'replay') {
      return outcome.result;
    }
  }

  try {
    return createTransferUnchecked(data, requestId, idempotency);
  } catch (err) {
    // The operation never reached a terminal state, so the key must not stay
    // burned: the client's correct response to a provider failure is to retry
    // with the same key, and that has to be able to succeed.
    if (idempotency) {
      idempotencyService.release(store.idempotency, idempotency.actor, idempotency.key);
    }
    throw err;
  }
}

/**
 * Perform the creation itself, with the reservation already held.
 * @param {object} data
 * @param {string} [requestId]
 * @param {{ actor: string, key: string }} [idempotency]
 * @returns {object}
 */
function createTransferUnchecked(data, requestId, idempotency) {
  const quote = quoteService.getQuote(data.amount, data.from, data.to);
  const settlement = stellarService.submitPayment({
    amount: quote.sendAmount,
    currency: quote.from,
    idempotencyKey: idempotency
      ? `create:${idempotency.actor}:${idempotency.key}`
      : undefined,
  });

  const transfer = {
    id: prefixedId('txn'),
    senderName: data.senderName,
    recipientName: data.recipientName,
    from: quote.from,
    to: quote.to,
    sendAmount: quote.sendAmount,
    fee: quote.fee,
    rate: quote.rate,
    receiveAmount: quote.receiveAmount,
    status: TRANSFER_STATUS.PENDING,
    version: 1,
    stellar: settlement,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    archivedAt: null,
  };
  transfer.updatedAt = nextTimestamp(transfer.createdAt);

  store.transfers.set(transfer.id, transfer);
  store.transferIndex.append(transfer);

  auditService.addEntry({
    action: 'transfer.created',
    resourceId: transfer.id,
    payload: {
      senderName: transfer.senderName,
      recipientName: transfer.recipientName,
      from: transfer.from,
      to: transfer.to,
      sendAmount: transfer.sendAmount,
    },
    requestId,
  });

  if (idempotency) {
    idempotencyService.complete(
      store.idempotency,
      idempotency.actor,
      idempotency.key,
      transfer
    );
  }

  return transfer;
}

/**
 * Snapshot a transfer before storing it as an idempotent replay result.
 * @param {object} transfer
 * @returns {object}
 */
function snapshotTransfer(transfer) {
  return JSON.parse(JSON.stringify(transfer));
}

/**
 * Ensure every transfer carries a positive integer resource version.
 * Older in-memory records created before versioning default to 1.
 * @param {object} transfer
 * @returns {number}
 */
function currentVersion(transfer) {
  if (!Number.isInteger(transfer.version) || transfer.version < 1) {
    transfer.version = 1;
  }
  return transfer.version;
}

/**
 * Validate a status transition without mutating state.
 * @param {object} transfer
 * @param {string} nextStatus
 */
function assertTransitionAllowed(transfer, nextStatus) {
  const allowed = TRANSFER_TRANSITIONS[transfer.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw ApiError.conflict(
      `Cannot change transfer from ${transfer.status} to ${nextStatus}`,
      {
        transferId: transfer.id,
        currentStatus: transfer.status,
        requestedStatus: nextStatus,
        version: currentVersion(transfer),
      }
    );
  }
}

/**
 * Compare the caller's observed version with current state.
 * @param {object} transfer
 * @param {number} expectedVersion
 */
function assertExpectedVersion(transfer, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw ApiError.badRequest('expectedVersion must be a positive integer');
  }
  const actual = currentVersion(transfer);
  if (actual !== expectedVersion) {
    throw ApiError.conflict('Transfer version conflict', {
      transferId: transfer.id,
      expectedVersion,
      actualVersion: actual,
      currentStatus: transfer.status,
    });
  }
}

/**
 * Compare-and-set a lifecycle transition on a transfer.
 *
 * Checks expected version and allowed transition, then commits status,
 * version, and optional field mutations in one synchronous step. This is the
 * only write path for terminal claim/cancel mutations.
 *
 * @param {object} transfer
 * @param {object} options
 * @param {number} options.expectedVersion
 * @param {string} options.nextStatus
 * @param {(transfer: object) => void} [options.mutate]
 * @returns {object} the mutated transfer
 */
function compareAndSetTransition(transfer, { expectedVersion, nextStatus, mutate }) {
  assertExpectedVersion(transfer, expectedVersion);
  assertTransitionAllowed(transfer, nextStatus);

  const beforeVersion = currentVersion(transfer);
  transfer.status = nextStatus;
  transfer.version = beforeVersion + 1;
  transfer.updatedAt = nextTimestamp(transfer.updatedAt);
  if (typeof mutate === 'function') {
    mutate(transfer);
  }
  return transfer;
}

/**
 * Acquire an exclusive lease for one transfer while a lifecycle mutation runs.
 * Two different operation keys cannot both prepare provider work for the same
 * transfer — that is the original double-settlement window.
 * @param {string} transferId
 * @param {{ action: string, actor: string, key: string, token: string }} lease
 */
function assertLifecycleLeaseAvailable(transferId, requestedAction) {
  const existing = store.lifecycleLeases.get(transferId);
  if (existing) {
    throw ApiError.conflict(
      'Transfer lifecycle operation already in progress',
      {
        transferId,
        heldAction: existing.action,
        requestedAction,
      }
    );
  }
}

function acquireLifecycleLease(transferId, lease) {
  assertLifecycleLeaseAvailable(transferId, lease.action);
  store.lifecycleLeases.set(transferId, lease);
}

/**
 * Release a lifecycle lease when the holder still owns it.
 * @param {string} transferId
 * @param {string} token
 */
function releaseLifecycleLease(transferId, token) {
  const existing = store.lifecycleLeases.get(transferId);
  if (existing && existing.token === token) {
    store.lifecycleLeases.delete(transferId);
  }
}

/**
 * Execute one terminal lifecycle mutation with optimistic concurrency, a
 * transfer-scoped lease, and an actor-scoped idempotency reservation.
 *
 * Order of operations:
 * 1. reserve the actor/key pair (replay if already completed);
 * 2. acquire the per-transfer lease;
 * 3. check expected version + allowed transition;
 * 4. prepare provider work with a stable operation id;
 * 5. compare-and-set status/version (and apply prepared fields);
 * 6. complete the idempotency receipt and audit.
 *
 * Provider failure happens before the local terminal commit, so status/version
 * stay unchanged and both the lease and reservation are released for retry.
 *
 * @param {string} id
 * @param {object} spec
 * @param {string} spec.action
 * @param {string} spec.nextStatus
 * @param {(operationId: string) => unknown} [spec.prepare]
 * @param {(transfer: object, prepared: unknown) => void} [spec.applyPrepared]
 * @param {string} spec.auditAction
 * @param {(transfer: object) => object} spec.auditPayload
 * @param {string} [requestId]
 * @param {{actor: string, key: string, expectedVersion: number}} [lifecycle]
 * @returns {object}
 */
function executeLifecycleMutation(id, spec, requestId, lifecycle) {
  const initial = getTransferOrThrow(id);
  const context = lifecycle || {
    actor: 'internal',
    key: `${spec.action}:${id}:${currentVersion(initial)}`,
    expectedVersion: currentVersion(initial),
  };

  if (!context.actor || !context.key) {
    throw ApiError.badRequest(
      'Lifecycle mutations require an actor and idempotency key'
    );
  }

  const fingerprint = idempotencyService.fingerprint({
    transferId: id,
    action: spec.action,
    expectedVersion: context.expectedVersion,
  });
  const scopedKey = `${id}:${spec.action}:${context.key}`;
  const reservation = idempotencyService.begin(
    store.lifecycleIdempotency,
    context.actor,
    scopedKey,
    fingerprint
  );

  if (reservation.status === 'replay') {
    return reservation.result;
  }

  const leaseToken = `${context.actor}:${scopedKey}:${Date.now()}`;
  let leased = false;
  let committed = false;

  try {
    acquireLifecycleLease(id, {
      action: spec.action,
      actor: context.actor,
      key: context.key,
      token: leaseToken,
    });
    leased = true;

    const transfer = getTransferOrThrow(id);
    assertExpectedVersion(transfer, context.expectedVersion);
    assertTransitionAllowed(transfer, spec.nextStatus);

    const beforeStatus = transfer.status;
    const beforeVersion = currentVersion(transfer);
    const operationId = createSettlementOperationId(id, spec.action, context.actor, context.key);
    const prepared = spec.prepare ? spec.prepare(operationId) : undefined;

    // Re-check immediately before CAS so a re-entrant adapter that somehow
    // mutated state during prepare cannot commit over newer state. The lease
    // already blocks competing lifecycle keys; this is defense in depth.
    if (transfer.status !== beforeStatus || currentVersion(transfer) !== beforeVersion) {
      throw ApiError.conflict(
        'Transfer changed while lifecycle operation was in progress',
        {
          transferId: id,
          expectedVersion: beforeVersion,
          actualVersion: currentVersion(transfer),
          currentStatus: transfer.status,
        }
      );
    }

    compareAndSetTransition(transfer, {
      expectedVersion: beforeVersion,
      nextStatus: spec.nextStatus,
      mutate: spec.applyPrepared
        ? (target) => spec.applyPrepared(target, prepared)
        : undefined,
    });

    const result = snapshotTransfer(transfer);
    idempotencyService.complete(
      store.lifecycleIdempotency,
      context.actor,
      scopedKey,
      result
    );
    committed = true;

    auditService.addEntry({
      action: spec.auditAction,
      resourceId: transfer.id,
      payload: spec.auditPayload(transfer),
      requestId,
    });

    return result;
  } catch (err) {
    if (!committed) {
      idempotencyService.release(
        store.lifecycleIdempotency,
        context.actor,
        scopedKey
      );
    }
    throw err;
  } finally {
    if (leased) {
      releaseLifecycleLease(id, leaseToken);
    }
  }
}

/**
 * Mark a transfer as claimed by the recipient (settlement).
 * @param {string} id
 * @param {string} [requestId]
 * @param {{actor: string, key: string, expectedVersion: number}} [lifecycle]
 * @returns {object}
 */
function claimTransfer(id, requestId, lifecycle) {
  return executeLifecycleMutation(
    id,
    {
      action: 'claim',
      nextStatus: TRANSFER_STATUS.CLAIMED,
      prepare: (operationId) => settlementWorker.settleClaim(operationId),
      applyPrepared: (transfer, receipt) => {
        transfer.claimableBalanceId = receipt.claimableBalanceId;
        transfer.settlementOperationId = receipt.operationId;
      },
      auditAction: 'transfer.claimed',
      auditPayload: (transfer) => ({
        claimableBalanceId: transfer.claimableBalanceId,
        settlementOperationId: transfer.settlementOperationId,
        version: transfer.version,
      }),
    },
    requestId,
    lifecycle
  );
}

/**
 * Cancel a pending transfer.
 * @param {string} id
 * @param {string} [requestId]
 * @param {{actor: string, key: string, expectedVersion: number}} [lifecycle]
 * @returns {object}
 */
function cancelTransfer(id, requestId, lifecycle) {
  return executeLifecycleMutation(
    id,
    {
      action: 'cancel',
      nextStatus: TRANSFER_STATUS.CANCELLED,
      auditAction: 'transfer.cancelled',
      auditPayload: (transfer) => ({ version: transfer.version }),
    },
    requestId,
    lifecycle
  );
}

/**
 * Archive a transfer. An archived transfer is hidden from default list results
 * but remains queryable. Archiving is idempotent and orthogonal to the transfer
 * lifecycle status.
 * @param {string} id
 * @returns {object}
 */
function archiveTransfer(id) {
  const transfer = getTransferOrThrow(id);
  if (!transfer.archivedAt) {
    assertLifecycleLeaseAvailable(id, 'archive');
    const timestamp = nextTimestamp(transfer.updatedAt);
    transfer.archivedAt = timestamp;
    transfer.updatedAt = timestamp;
    transfer.version = currentVersion(transfer) + 1;
  }
  return transfer;
}

/**
 * Unarchive a previously archived transfer, restoring it to default list results.
 * @param {string} id
 * @returns {object}
 */
function unarchiveTransfer(id) {
  const transfer = getTransferOrThrow(id);
  if (!transfer.archivedAt) {
    throw ApiError.conflict(`Transfer is not archived: ${id}`);
  }
  assertLifecycleLeaseAvailable(id, 'unarchive');
  transfer.archivedAt = null;
  transfer.updatedAt = nextTimestamp(transfer.updatedAt);
  transfer.version = currentVersion(transfer) + 1;
  return transfer;
}

module.exports = {
  listTransfers,
  normaliseTransferFilters,
  positionKeyAt,
  queryTransfers,
  getStats,
  getTransferOrThrow,
  createTransfer,
  claimTransfer,
  cancelTransfer,
  archiveTransfer,
  unarchiveTransfer,
  compareAndSetTransition,
  assertTransitionAllowed,
  currentVersion,
};
