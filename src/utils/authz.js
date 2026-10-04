'use strict';

const ApiError = require('./ApiError');
const { SCOPES, assertKnownScopes } = require('../config/scopes');

/**
 * Authorization helpers shared by middleware and service boundaries.
 *
 * Design notes:
 * - Route middleware is the first gate; service helpers are the second so a
 *   forgotten middleware cannot expose a privileged mutation.
 * - Missing, malformed, and unauthorized resource lookups share one 404
 *   message so callers cannot enumerate identifiers by status/body shape.
 * - Internal callers (seed, unit tests) omit `auth` and skip the checks.
 */

/** Maximum ids accepted by a single bulk mutation. */
const MAX_BULK_IDS = 50;

/**
 * Transfer ids are `txn_<uuid>`. Anything else is treated as "not found"
 * rather than 400, so probing the id format does not yield a distinct signal.
 */
const TRANSFER_ID_RE = /^txn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable non-enumerating not-found message for transfers. */
const TRANSFER_NOT_FOUND_MESSAGE = 'Transfer not found';

/**
 * Build an auth context from an Express request that has already passed
 * requireScope / adminAuth.
 * @param {import('express').Request} req
 * @returns {{ actor: string|null, scopes: string[] }}
 */
function authFromRequest(req) {
  return {
    actor: req.token || null,
    scopes: Array.isArray(req.tokenScopes) ? req.tokenScopes.slice() : [],
  };
}

/**
 * @param {string[]|undefined|null} tokenScopes
 * @param {string[]} required
 * @returns {boolean}
 */
function hasAllScopes(tokenScopes, required) {
  if (!Array.isArray(tokenScopes) || !Array.isArray(required)) return false;
  return required.every((scope) => tokenScopes.includes(scope));
}

/**
 * Require every scope in `required`. When `auth` is omitted the check is a
 * no-op so trusted internal callers stay ergonomic.
 *
 * @param {{ scopes?: string[] }|null|undefined} auth
 * @param {string|string[]} required
 * @throws {ApiError} 403 when the caller is present but under-scoped
 */
function assertScopes(auth, required) {
  if (auth == null) return;
  const needed = assertKnownScopes(
    Array.isArray(required) ? required : [required],
    'required scope'
  );
  if (!hasAllScopes(auth.scopes, needed)) {
    throw ApiError.forbidden('Insufficient token scopes');
  }
}

/**
 * Non-enumerating transfer 404. Same status and message whether the id is
 * missing, malformed, or (in future) out of the caller's tenancy.
 * @returns {ApiError}
 */
function transferNotFoundError() {
  return ApiError.notFound(TRANSFER_NOT_FOUND_MESSAGE);
}

/**
 * @param {*} id
 * @returns {boolean}
 */
function isWellFormedTransferId(id) {
  return typeof id === 'string' && TRANSFER_ID_RE.test(id);
}

/**
 * Validate and normalise a bulk id list.
 * @param {*} raw
 * @returns {string[]}
 * @throws {ApiError} 400 on shape problems (not on unknown ids)
 */
function normaliseBulkIds(raw) {
  if (!Array.isArray(raw)) {
    throw ApiError.badRequest('ids must be an array of transfer ids');
  }
  if (raw.length === 0) {
    throw ApiError.badRequest('ids must not be empty');
  }
  if (raw.length > MAX_BULK_IDS) {
    throw ApiError.badRequest(`ids may contain at most ${MAX_BULK_IDS} entries`, {
      max: MAX_BULK_IDS,
    });
  }
  const ids = [];
  for (const value of raw) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw ApiError.badRequest('each id must be a non-empty string');
    }
    ids.push(value.trim());
  }
  return ids;
}

module.exports = {
  SCOPES,
  MAX_BULK_IDS,
  TRANSFER_NOT_FOUND_MESSAGE,
  authFromRequest,
  hasAllScopes,
  assertScopes,
  transferNotFoundError,
  isWellFormedTransferId,
  normaliseBulkIds,
};
