'use strict';

const { store } = require('../store');
const { prefixedId } = require('../utils/ids');
const ApiError = require('../utils/ApiError');
const { TRANSFER_STATUS, TRANSFER_TRANSITIONS } = require('../config/constants');
const quoteService = require('./quoteService');
const stellarService = require('./stellarService');
const idempotencyService = require('./idempotencyService');
const auditService = require('./auditService');
const config = require('../config');

// Keep lifecycle timestamps strictly increasing even when multiple operations
// happen within the same millisecond (common in tests and API batches).
function nextTimestamp(...previous) {
  const next = previous.reduce((latest, value) => {
    const previousMs = value ? Date.parse(value) : NaN;
    return Number.isFinite(previousMs) ? Math.max(latest, previousMs + 1) : latest;
  }, Date.now());
  return new Date(next).toISOString();
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
    stellar: settlement,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    archivedAt: null,
    lastArchivedAt: null,
    // Append-only archive/unarchive events. Timestamps here are immutable once
    // written so repeated archive cycles never erase earlier lifecycle order.
    archiveHistory: [],
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
 * Move a transfer to a new status if the transition is allowed.
 * @param {object} transfer
 * @param {string} nextStatus
 * @returns {object}
 */
function transition(transfer, nextStatus) {
  const allowed = TRANSFER_TRANSITIONS[transfer.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw ApiError.conflict(
      `Cannot change transfer from ${transfer.status} to ${nextStatus}`
    );
  }
  transfer.status = nextStatus;
  transfer.updatedAt = nextTimestamp(transfer.updatedAt);
  return transfer;
}

/**
 * Mark a transfer as claimed by the recipient.
 * @param {string} id
 * @param {string} [requestId] - optional correlation id for audit logging
 * @returns {object}
 */
function claimTransfer(id, requestId) {
  const transfer = getTransferOrThrow(id);
  transition(transfer, TRANSFER_STATUS.CLAIMED);
  transfer.claimableBalanceId = stellarService.createClaimableBalanceId();

  auditService.addEntry({
    action: 'transfer.claimed',
    resourceId: transfer.id,
    payload: { claimableBalanceId: transfer.claimableBalanceId },
    requestId,
  });

  return transfer;
}

/**
 * Cancel a pending transfer.
 * @param {string} id
 * @param {string} [requestId] - optional correlation id for audit logging
 * @returns {object}
 */
function cancelTransfer(id, requestId) {
  const transfer = getTransferOrThrow(id);
  transition(transfer, TRANSFER_STATUS.CANCELLED);

  auditService.addEntry({
    action: 'transfer.cancelled',
    resourceId: transfer.id,
    payload: {},
    requestId,
  });

  return transfer;
}

/**
 * Normalise archive/unarchive options. Accepts either an options object or a
 * legacy bare requestId string so existing call sites keep working.
 * @param {string|object} [optionsOrRequestId]
 * @returns {{ requestId: string|undefined, actor: string|null, reason: string|null, expectedUpdatedAt: string|undefined }}
 */
function normaliseArchiveOptions(optionsOrRequestId) {
  if (optionsOrRequestId == null) {
    return { requestId: undefined, actor: null, reason: null, expectedUpdatedAt: undefined };
  }
  if (typeof optionsOrRequestId === 'string') {
    return {
      requestId: optionsOrRequestId,
      actor: null,
      reason: null,
      expectedUpdatedAt: undefined,
    };
  }
  const reason = optionsOrRequestId.reason;
  if (reason !== null && typeof reason === 'object') {
    throw ApiError.badRequest('reason must not be an object or array');
  }
  return {
    requestId: optionsOrRequestId.requestId,
    actor: optionsOrRequestId.actor == null ? null : String(optionsOrRequestId.actor),
    reason: reason == null || reason === '' ? null : String(reason),
    expectedUpdatedAt: optionsOrRequestId.expectedUpdatedAt,
  };
}

/**
 * Reject a command whose caller observed a stale `updatedAt`.
 * Omitting expectedUpdatedAt preserves the previous unversioned behaviour.
 * @param {object} transfer
 * @param {string|undefined} expectedUpdatedAt
 */
function assertFreshArchiveCommand(transfer, expectedUpdatedAt) {
  if (expectedUpdatedAt == null) return;
  if (transfer.updatedAt !== expectedUpdatedAt) {
    throw ApiError.conflict(
      `Stale archive command for transfer ${transfer.id}`,
      {
        code: 'STALE_ARCHIVE_COMMAND',
        expectedUpdatedAt,
        actualUpdatedAt: transfer.updatedAt,
        archivedAt: transfer.archivedAt,
      }
    );
  }
}

/**
 * Latest immutable archive-history timestamp, used as a monotonic floor.
 * @param {object} transfer
 * @returns {string|null}
 */
function lastArchiveHistoryAt(transfer) {
  const history = transfer.archiveHistory;
  if (!Array.isArray(history) || history.length === 0) return null;
  return history[history.length - 1].at;
}

/**
 * Append an immutable archive lifecycle event and return it.
 * @param {object} transfer
 * @param {object} event
 * @returns {object}
 */
function appendArchiveHistory(transfer, event) {
  if (!Array.isArray(transfer.archiveHistory)) {
    transfer.archiveHistory = [];
  }
  const frozen = Object.freeze({
    action: event.action,
    at: event.at,
    actor: event.actor,
    reason: event.reason,
    requestId: event.requestId,
  });
  transfer.archiveHistory.push(frozen);
  return frozen;
}

/**
 * Archive a transfer. An archived transfer is hidden from default list results
 * but remains queryable. Archiving is idempotent for retries that observe the
 * current archived state, orthogonal to the transfer lifecycle status, and
 * records an immutable, auditable event with actor and reason.
 *
 * Pass `expectedUpdatedAt` to opt into optimistic concurrency: a mismatched
 * value is rejected as a stale command so concurrent archive/unarchive cycles
 * cannot silently overwrite each other.
 *
 * @param {string} id
 * @param {string|object} [optionsOrRequestId]
 * @returns {object}
 */
function archiveTransfer(id, optionsOrRequestId) {
  const options = normaliseArchiveOptions(optionsOrRequestId);
  const transfer = getTransferOrThrow(id);
  assertFreshArchiveCommand(transfer, options.expectedUpdatedAt);

  // Already archived: idempotent retry. Do not move archivedAt / updatedAt
  // backwards or rewrite history — that was the original failure mode.
  if (transfer.archivedAt) {
    return transfer;
  }

  const timestamp = nextTimestamp(
    transfer.updatedAt,
    lastArchiveHistoryAt(transfer)
  );
  // Keep the current state and concurrency token intact if audit append fails.
  auditService.addEntry({
    action: 'transfer.archived',
    resourceId: transfer.id,
    payload: {
      archivedAt: timestamp,
      actor: options.actor,
      reason: options.reason,
    },
    requestId: options.requestId,
  });

  transfer.archivedAt = timestamp;
  transfer.lastArchivedAt = timestamp;
  transfer.updatedAt = timestamp;

  appendArchiveHistory(transfer, {
    action: 'archive',
    at: timestamp,
    actor: options.actor,
    reason: options.reason,
    requestId: options.requestId || null,
  });

  return transfer;
}

/**
 * Unarchive a previously archived transfer, restoring it to default list results.
 * Clears the current-state `archivedAt` flag but retains `lastArchivedAt` and
 * an immutable history entry so the lifecycle order stays reconcilable.
 *
 * @param {string} id
 * @param {string|object} [optionsOrRequestId]
 * @returns {object}
 */
function unarchiveTransfer(id, optionsOrRequestId) {
  const options = normaliseArchiveOptions(optionsOrRequestId);
  const transfer = getTransferOrThrow(id);
  assertFreshArchiveCommand(transfer, options.expectedUpdatedAt);

  if (!transfer.archivedAt) {
    throw ApiError.conflict(`Transfer is not archived: ${id}`, {
      code: 'NOT_ARCHIVED',
    });
  }

  const previousArchivedAt = transfer.archivedAt;
  const timestamp = nextTimestamp(
    transfer.updatedAt,
    lastArchiveHistoryAt(transfer),
    previousArchivedAt
  );

  // Keep the current state and concurrency token intact if audit append fails.
  auditService.addEntry({
    action: 'transfer.unarchived',
    resourceId: transfer.id,
    payload: {
      previousArchivedAt,
      unarchivedAt: timestamp,
      actor: options.actor,
      reason: options.reason,
    },
    requestId: options.requestId,
  });

  transfer.archivedAt = null;
  transfer.lastArchivedAt = previousArchivedAt;
  transfer.updatedAt = timestamp;

  appendArchiveHistory(transfer, {
    action: 'unarchive',
    at: timestamp,
    actor: options.actor,
    reason: options.reason,
    requestId: options.requestId || null,
  });

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
};
