'use strict';

const { newId } = require('../utils/ids');
const { OrderedIndex } = require('../utils/orderedIndex');
const config = require('../config');

/**
 * Audit log service.
 *
 * Records an immutable, append-only log of write operations performed
 * against the API. Entries are stored in memory (consistent with the
 * rest of the in-memory store) and are therefore cleared when the
 * process restarts.
 *
 * Supported actions (non-exhaustive, extend as needed):
 *   transfer.created   transfer.claimed   transfer.cancelled
 *   user.created
 *
 * Each entry captures:
 *   id         — unique audit entry id (aud_ prefix)
 *   action     — dot-namespaced action string (e.g. "transfer.created")
 *   resourceId — id of the created / mutated resource
 *   payload    — arbitrary context snapshot (sanitised by the caller)
 *   requestId  — correlation id from the originating HTTP request (optional)
 *   at         — ISO-8601 timestamp of when the entry was recorded
 */

/**
 * Entries live in an append-only ordered index rather than a plain array.
 *
 * The index adds two things a plain array cannot: a dense sequence number per
 * entry, which gives cursor pagination a deterministic tie-breaker when several
 * entries share a millisecond, and a secondary index by `resourceId`, so
 * filtering by resource no longer scans the whole log.
 */
const auditIndex = new OrderedIndex({
  sortKeyOf: (entry) => entry.at,
  groupKeyOf: (entry) => entry.resourceId,
});

/**
 * Append a new entry to the audit log.
 *
 * @param {object} params
 * @param {string} params.action     - action identifier (e.g. "transfer.created")
 * @param {string} params.resourceId - id of the affected resource
 * @param {object} [params.payload]  - additional context to record
 * @param {string} [params.requestId]- request correlation id
 * @returns {object} the newly created audit entry
 */
function addEntry({ action, resourceId, payload = {}, requestId } = {}) {
  if (!action) throw new Error('audit.addEntry: action is required');
  if (!resourceId) throw new Error('audit.addEntry: resourceId is required');

  const entry = {
    id: newId(),
    action,
    resourceId,
    payload,
    requestId: requestId || null,
    at: new Date().toISOString(),
  };

  auditIndex.append(entry);
  return entry;
}

/**
 * Return all audit entries, newest first.
 * @returns {Array<object>}
 */
function getEntries() {
  return auditIndex.records.map((record) => record.item).reverse();
}

/**
 * Return only the entries for a specific resource id.
 * @param {string} resourceId
 * @returns {Array<object>}
 */
function getEntriesForResource(resourceId) {
  // A nullish id matches no resource. Guarded explicitly because the index
  // treats a null group key as "the whole index".
  if (resourceId == null || resourceId === '') return [];
  return auditIndex.recordsFor(String(resourceId)).map((record) => record.item).reverse();
}

/**
 * Page through the audit log using the ordered index.
 *
 * Entries are immutable once written, so the sort position of an entry never
 * changes. That is what makes a cursor into this log stable: a page boundary
 * recorded now still means the same thing after any number of later appends.
 *
 * @param {object} [options]
 * @param {string} [options.resourceId] - restrict to one resource via the secondary index.
 * @param {'asc'|'desc'} [options.order] - defaults to newest first.
 * @param {number} [options.limit]
 * @param {number|null} [options.afterSeq] - exclusive start position from a cursor.
 * @param {number} [options.skip] - legacy offset support.
 * @param {number} [options.maxScan] - per-request work budget.
 * @returns {{ items: object[], last: object|null, hasMore: boolean, scanned: number,
 *   scanTruncated: boolean, skipped: number }}
 */
function queryEntries({
  resourceId,
  order = 'desc',
  limit = config.pagination.defaultLimit,
  afterSeq = null,
  skip = 0,
  maxScan = config.pagination.maxScan,
} = {}) {
  return auditIndex.scan({
    group: resourceId == null || resourceId === '' ? null : String(resourceId),
    order,
    limit,
    afterSeq,
    skip,
    maxScan,
  });
}

/**
 * Timestamp of the entry occupying a given index position within the same
 * grouping the query uses, or null when no such position exists.
 * @param {number} seq
 * @param {string} [resourceId]
 * @returns {string|null}
 */
function positionKeyAt(seq, resourceId) {
  const group = resourceId == null || resourceId === '' ? null : String(resourceId);
  const record = auditIndex.recordAt(seq, group);
  return record ? record.key : null;
}

/**
 * Number of entries recorded for a resource, or in the whole log.
 * @param {string} [resourceId]
 * @returns {number}
 */
function countEntries(resourceId) {
  if (resourceId == null || resourceId === '') return auditIndex.size;
  return auditIndex.recordsFor(String(resourceId)).length;
}

/**
 * Clear all audit entries. Primarily used in tests and when the store is reset.
 */
function reset() {
  auditIndex.reset();
}

module.exports = {
  addEntry,
  countEntries,
  getEntries,
  getEntriesForResource,
  positionKeyAt,
  queryEntries,
  reset,
};
