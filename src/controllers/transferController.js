'use strict';

const transferService = require('../services/transferService');
const { buildHistoryPage } = require('../utils/historyPage');
const idempotencyService = require('../services/idempotencyService');
const ApiError = require('../utils/ApiError');

/** Upper bound on a client-supplied key, so the map cannot be grown without limit. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Read and validate the Idempotency-Key header.
 *
 * Required rather than optional: this endpoint moves money, and a client that
 * omits the header is not opting out of protection, it is unaware it needs it.
 * Failing the request is the only outcome that cannot silently duplicate a
 * transfer.
 *
 * @param {import('express').Request} req
 * @returns {string}
 * @throws {ApiError} 400 when the header is missing or unusable.
 */
function requireIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw ApiError.badRequest(
      'Idempotency-Key header is required to create a transfer'
    );
  }
  const key = raw.trim();
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw ApiError.badRequest(
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
    );
  }
  return key;
}

/**
 * Transfer controllers.
 */

/**
 * POST /api/transfers
 * Create a new transfer.
 */
function createTransfer(req, res) {
  const key = requireIdempotencyKey(req);

  // The fingerprint covers the fields that determine the operation, not the raw
  // body: an unrelated extra property must not read as a conflicting retry.
  // `amount` is normalized because "100" and 100 both validate and produce the
  // same transfer, so treating them as different requests would reject a
  // legitimate retry from a client that re-serialized its payload.
  const fingerprint = idempotencyService.fingerprint({
    senderName: req.body.senderName,
    recipientName: req.body.recipientName,
    amount: Number(req.body.amount),
    from: req.body.from,
    to: req.body.to,
  });

  const transfer = transferService.createTransfer(req.body, req.id, {
    actor: req.token,
    key,
    fingerprint,
  });

  // A replay answers 201 with the original transfer, exactly as the first call
  // did. Replaying the stored result means replaying all of it; downgrading the
  // status would make a successful retry look different from the response it is
  // standing in for.
  res.status(201).json(transfer);
}

/**
 * GET /api/transfers
 * List transfers, optionally filtered by ?status= and/or ?q= (name search).
 * Archived transfers are excluded by default; pass ?archived=true to see only archived,
 * or ?archived=all to include both archived and non-archived.
 *
 * Pagination: pass ?cursor= to page by the creation-order index (stable while
 * transfers are being created), or the legacy ?offset=. ?order= selects asc
 * (oldest first, the default) or desc. ?limit= is capped by config.pagination.maxLimit.
 */
function listTransfers(req, res) {
  const archivedParam = req.query.archived;
  let archived;
  if (archivedParam === 'true') {
    archived = true;
  } else if (archivedParam === 'all') {
    archived = 'all';
  } else {
    archived = false;
  }

  const filters = transferService.normaliseTransferFilters({
    status: req.query.status,
    search: req.query.q,
    archived,
  });

  const { items, envelope } = buildHistoryPage({
    req,
    collection: 'transfers',
    filters,
    defaultOrder: 'asc',
    query: (args) => transferService.queryTransfers({ ...filters, ...args }),
    countTotal: () => transferService.listTransfers(filters).length,
    resolvePosition: (seq) => transferService.positionKeyAt(seq),
  });

  res.json({ ...envelope, transfers: items });
}

/**
 * GET /api/transfers/stats
 * Return aggregate transfer statistics.
 */
function getStats(req, res) {
  res.json(transferService.getStats());
}

/**
 * GET /api/transfers/:id
 * Fetch a single transfer by id.
 */
function getTransfer(req, res) {
  const transfer = transferService.getTransferOrThrow(req.params.id);
  res.json(transfer);
}

/**
 * POST /api/transfers/:id/claim
 * Mark a transfer as claimed by the recipient.
 */
function claimTransfer(req, res) {
  const transfer = transferService.claimTransfer(req.params.id, req.id);
  res.json(transfer);
}

/**
 * POST /api/transfers/:id/cancel
 * Cancel a pending transfer.
 */
function cancelTransfer(req, res) {
  const transfer = transferService.cancelTransfer(req.params.id, req.id);
  res.json(transfer);
}

/**
 * POST /api/transfers/:id/archive
 * Archive a transfer, hiding it from default list results.
 */
function archiveTransfer(req, res) {
  const transfer = transferService.archiveTransfer(req.params.id);
  res.json(transfer);
}

/**
 * POST /api/transfers/:id/unarchive
 * Unarchive a transfer, restoring it to default list results.
 */
function unarchiveTransfer(req, res) {
  const transfer = transferService.unarchiveTransfer(req.params.id);
  res.json(transfer);
}

module.exports = {
  createTransfer,
  listTransfers,
  getStats,
  getTransfer,
  claimTransfer,
  cancelTransfer,
  archiveTransfer,
  unarchiveTransfer,
};
