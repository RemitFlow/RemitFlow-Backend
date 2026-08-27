'use strict';

const config = require('../config');
const ApiError = require('./ApiError');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parse and clamp pagination query parameters.
 *
 * Legacy lenient parser: unparseable values silently fall back to defaults and
 * oversized limits are clamped. Retained for the collections that still expose
 * only offset pagination.
 *
 * @param {object} query - typically req.query.
 * @returns {{ limit: number, offset: number }}
 */
function parsePagination(query = {}) {
  let limit = parseInt(query.limit, 10);
  let offset = parseInt(query.offset, 10);

  if (!Number.isFinite(limit) || limit <= 0) {
    limit = DEFAULT_LIMIT;
  }
  limit = Math.min(limit, MAX_LIMIT);

  if (!Number.isFinite(offset) || offset < 0) {
    offset = 0;
  }

  return { limit, offset };
}

/**
 * Parse pagination parameters for a history collection.
 *
 * Unlike {@link parsePagination} this rejects out-of-range input instead of
 * quietly correcting it: a client that asks for 10 000 rows and receives 200
 * has no way to tell it did not receive everything, which is exactly the class
 * of bug an unbounded history query causes downstream.
 *
 * @param {object} query - typically req.query.
 * @param {object} [options]
 * @param {'asc'|'desc'} [options.defaultOrder]
 * @param {number} [options.defaultLimit]
 * @param {number} [options.maxLimit]
 * @returns {{ mode: 'cursor'|'offset', limit: number, order: 'asc'|'desc', cursor: string|null, offset: number }}
 * @throws {ApiError} 400 on invalid limit, offset, order, or a cursor combined
 *   with an offset.
 */
function parseHistoryPagination(query = {}, options = {}) {
  const {
    defaultOrder = 'desc',
    defaultLimit = config.pagination.defaultLimit,
    maxLimit = config.pagination.maxLimit,
  } = options;

  const limit = parseLimit(query.limit, defaultLimit, maxLimit);
  const order = parseOrder(query.order, defaultOrder);
  const cursor = query.cursor == null || query.cursor === '' ? null : String(query.cursor);
  const offset = parseOffset(query.offset);

  if (cursor !== null && offset > 0) {
    throw ApiError.badRequest(
      'Provide either cursor or offset, not both',
      { code: 'CONFLICTING_PAGINATION' }
    );
  }

  return { mode: cursor !== null ? 'cursor' : 'offset', limit, order, cursor, offset };
}

/**
 * @param {*} raw
 * @param {number} defaultLimit
 * @param {number} maxLimit
 * @returns {number}
 */
function parseLimit(raw, defaultLimit, maxLimit) {
  if (raw == null || raw === '') return defaultLimit;

  const limit = toInteger(raw);
  if (limit === null || limit < 1) {
    throw ApiError.badRequest('limit must be a positive integer', {
      code: 'INVALID_LIMIT',
      maxLimit,
    });
  }
  if (limit > maxLimit) {
    throw ApiError.badRequest(`limit may not exceed ${maxLimit}`, {
      code: 'LIMIT_TOO_LARGE',
      maxLimit,
    });
  }
  return limit;
}

/**
 * @param {*} raw
 * @returns {number}
 */
function parseOffset(raw) {
  if (raw == null || raw === '') return 0;

  const offset = toInteger(raw);
  if (offset === null || offset < 0) {
    throw ApiError.badRequest('offset must be a non-negative integer', {
      code: 'INVALID_OFFSET',
    });
  }
  return offset;
}

/**
 * @param {*} raw
 * @param {'asc'|'desc'} defaultOrder
 * @returns {'asc'|'desc'}
 */
function parseOrder(raw, defaultOrder) {
  if (raw == null || raw === '') return defaultOrder;
  if (raw !== 'asc' && raw !== 'desc') {
    throw ApiError.badRequest('order must be "asc" or "desc"', {
      code: 'INVALID_ORDER',
      allowed: ['asc', 'desc'],
    });
  }
  return raw;
}

/**
 * Strict integer parse: rejects "12abc", "1.5", "1e3" and other values that
 * parseInt would happily truncate.
 * @param {*} raw
 * @returns {number|null}
 */
function toInteger(raw) {
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseHistoryPagination,
  parsePagination,
};
