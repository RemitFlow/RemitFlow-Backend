'use strict';

const { newId } = require('../utils/ids');
const { OrderedIndex } = require('../utils/orderedIndex');
const config = require('../config');
const {
  GENESIS_HASH,
  actorRef,
  canonicalize,
  computeEntryHash,
  redact,
  scopeFromAction,
} = require('../utils/auditCrypto');

/**
 * Audit log service.
 *
 * Records an append-only, hash-chained log of privileged mutations. Each entry
 * binds to its predecessor via `prevHash` / `entryHash`, so a silent edit,
 * deletion, or reorder is detectable by walking the chain. Sensitive fields in
 * `changes` are redacted before storage so authorized operators can filter
 * without ever being shown secrets.
 *
 * Supported actions (non-exhaustive):
 *   transfer.created   transfer.claimed   transfer.cancelled
 *   transfer.archived  transfer.unarchived
 *   user.created
 *
 * Each entry captures:
 *   id, action, scope, target, actor, correlationId, outcome, changes,
 *   resourceId / requestId / payload  — compat aliases
 *   chainSeq, prevHash, entryHash     — integrity metadata
 *   mutationId                        — optional state-change identity
 *   at                                — ISO-8601 timestamp
 */

const auditIndex = new OrderedIndex({
  sortKeyOf: (entry) => entry.at,
  groupKeyOf: (entry) => entry.resourceId,
});

/** Tip of the integrity chain (hash of the most recently appended entry). */
let tipHash = GENESIS_HASH;

/**
 * Event identity used to suppress duplicate outcome events for the same
 * privileged mutation. A state-change id distinguishes later mutations that
 * share a workflow correlation id; callers without one retain replay behavior.
 * @param {object} parts
 * @returns {string|null} null when the event cannot be safely deduplicated.
 */
function eventIdentity({ action, target, actor, scope, correlationId, outcome, mutationId }) {
  if (!correlationId && !mutationId) return null;
  return JSON.stringify([action, target, actor, scope, correlationId, outcome, mutationId]);
}

/** @type {Map<string, object>} */
const eventsByIdentity = new Map();

/**
 * Append a new entry to the audit log, or return the existing one when the
 * same privileged mutation is recorded again under the same correlation id.
 *
 * @param {object} params
 * @param {string} params.action
 * @param {string} [params.resourceId] - legacy alias for target
 * @param {string} [params.target]
 * @param {object} [params.payload]    - legacy alias for changes (redacted)
 * @param {object} [params.changes]
 * @param {string} [params.requestId]  - legacy alias for correlationId
 * @param {string} [params.correlationId]
 * @param {string} [params.mutationId] - stable id of the recorded state change
 * @param {string} [params.actor]      - legacy token or already-fingerprinted ref
 * @param {string} [params.actorToken] - raw credential; always fingerprinted
 * @param {string} [params.scope]
 * @param {'success'|'failure'|string} [params.outcome]
 * @returns {object} the newly created (or previously recorded) audit entry
 */
function addEntry({
  action,
  resourceId,
  target,
  payload,
  changes,
  requestId,
  correlationId,
  mutationId,
  actor,
  actorToken,
  scope,
  outcome = 'success',
} = {}) {
  if (!action) throw new Error('audit.addEntry: action is required');

  const resolvedTarget = target != null && target !== ''
    ? String(target)
    : (resourceId != null && resourceId !== '' ? String(resourceId) : null);
  if (!resolvedTarget) throw new Error('audit.addEntry: resourceId is required');

  const resolvedCorrelation = correlationId != null && correlationId !== ''
    ? String(correlationId)
    : (requestId != null && requestId !== '' ? String(requestId) : null);

  const resolvedMutationId = mutationId != null && mutationId !== ''
    ? String(mutationId)
    : undefined;

  // Credentials must use the explicit input: their contents can resemble an
  // existing actor reference (or the system sentinel). Keep legacy references
  // working without treating a credential's spelling as proof of redaction.
  let resolvedActor;
  if (actorToken !== undefined) {
    resolvedActor = actorRef(actorToken);
  } else if (actor == null || actor === '') {
    resolvedActor = 'system';
  } else if (String(actor).startsWith('actor:') || actor === 'system') {
    resolvedActor = String(actor);
  } else {
    resolvedActor = actorRef(actor);
  }

  const resolvedScope = scope || scopeFromAction(action);
  const resolvedOutcome = outcome || 'success';
  const identity = eventIdentity({
    action,
    target: resolvedTarget,
    actor: resolvedActor,
    scope: resolvedScope,
    correlationId: resolvedCorrelation,
    outcome: resolvedOutcome,
    mutationId: resolvedMutationId,
  });

  if (identity) {
    const existing = eventsByIdentity.get(identity);
    if (existing) return existing;
  }

  const redactedChanges = redact(
    changes != null ? changes : (payload != null ? payload : {})
  );

  const chainSeq = auditIndex.size;
  const prevHash = tipHash;
  const at = new Date().toISOString();

  const entry = {
    id: newId(),
    action,
    scope: resolvedScope,
    target: resolvedTarget,
    // Compat aliases kept so existing consumers and tests keep working.
    resourceId: resolvedTarget,
    actor: resolvedActor,
    correlationId: resolvedCorrelation,
    requestId: resolvedCorrelation,
    ...(resolvedMutationId === undefined ? {} : { mutationId: resolvedMutationId }),
    outcome: resolvedOutcome,
    changes: redactedChanges,
    payload: redactedChanges,
    chainSeq,
    prevHash,
    at,
  };
  entry.entryHash = computeEntryHash(entry, prevHash);

  auditIndex.append(entry);
  tipHash = entry.entryHash;

  if (identity) {
    eventsByIdentity.set(identity, entry);
  }

  return entry;
}

/**
 * Walk the chain and recompute every hash.
 *
 * Detects in-place field edits, broken predecessor links, and gaps. Used by
 * operators and by regression tests for the original failure mode (silent
 * mutation of an audit record).
 *
 * @returns {{ valid: boolean, checked: number, tipHash: string,
 *   brokenAt: number|null, reason: string|null }}
 */
function verifyIntegrity() {
  let expectedPrev = GENESIS_HASH;
  const records = auditIndex.records;

  for (let i = 0; i < records.length; i += 1) {
    const entry = records[i].item;

    if (entry.chainSeq !== i) {
      return {
        valid: false,
        checked: i,
        tipHash,
        brokenAt: i,
        reason: `chainSeq mismatch at index ${i}: expected ${i}, got ${entry.chainSeq}`,
      };
    }

    if (entry.prevHash !== expectedPrev) {
      return {
        valid: false,
        checked: i,
        tipHash,
        brokenAt: i,
        reason: `prevHash mismatch at chainSeq ${entry.chainSeq}`,
      };
    }

    try {
      const recomputed = computeEntryHash(entry, expectedPrev);
      if (recomputed !== entry.entryHash) {
        return {
          valid: false,
          checked: i,
          tipHash,
          brokenAt: i,
          reason: `entryHash mismatch at chainSeq ${entry.chainSeq}`,
        };
      }

      // Legacy consumers read these aliases, while the hash binds the canonical
      // fields. Verify their values without changing the stored hash format.
      if (entry.resourceId !== entry.target
        || entry.requestId !== entry.correlationId
        || (entry.payload !== entry.changes
          && canonicalize(entry.payload) !== canonicalize(entry.changes))) {
        return {
          valid: false,
          checked: i,
          tipHash,
          brokenAt: i,
          reason: `compatibility alias mismatch at chainSeq ${entry.chainSeq}`,
        };
      }
    } catch {
      // Tampered payloads may be cyclic or contain throwing accessors. Do not
      // return their contents or exception messages to the integrity caller.
      return {
        valid: false,
        checked: i,
        tipHash,
        brokenAt: i,
        reason: 'entry contents cannot be verified',
      };
    }

    expectedPrev = entry.entryHash;
  }

  if (expectedPrev !== tipHash) {
    return {
      valid: false,
      checked: records.length,
      tipHash,
      brokenAt: records.length,
      reason: 'tipHash does not match the final entry hash',
    };
  }

  return {
    valid: true,
    checked: records.length,
    tipHash,
    brokenAt: null,
    reason: null,
  };
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
  if (resourceId == null || resourceId === '') return [];
  return auditIndex.recordsFor(String(resourceId)).map((record) => record.item).reverse();
}

/**
 * Residual filter over integrity / attribution fields that are not covered by
 * the secondary index. Secrets never participate — only redacted changes and
 * actor fingerprints are visible to callers.
 * @param {object} filters
 * @returns {(entry: object) => boolean}
 */
function buildMatch(filters = {}) {
  const {
    action,
    scope,
    outcome,
    correlationId,
    actor,
  } = filters;

  const hasResidual = action != null || scope != null || outcome != null
    || correlationId != null || actor != null;
  if (!hasResidual) return null;

  return (entry) => {
    if (action != null && entry.action !== String(action)) return false;
    if (scope != null && entry.scope !== String(scope)) return false;
    if (outcome != null && entry.outcome !== String(outcome)) return false;
    if (correlationId != null && entry.correlationId !== String(correlationId)) return false;
    if (actor != null && entry.actor !== String(actor)) return false;
    return true;
  };
}

/**
 * Page through the audit log using the ordered index.
 *
 * @param {object} [options]
 * @param {string} [options.resourceId]
 * @param {string} [options.action]
 * @param {string} [options.scope]
 * @param {string} [options.outcome]
 * @param {string} [options.correlationId]
 * @param {string} [options.actor]
 * @param {'asc'|'desc'} [options.order]
 * @param {number} [options.limit]
 * @param {number|null} [options.afterSeq]
 * @param {number} [options.skip]
 * @param {number} [options.maxScan]
 * @returns {{ items: object[], last: object|null, hasMore: boolean, scanned: number,
 *   scanTruncated: boolean, skipped: number }}
 */
function queryEntries({
  resourceId,
  action,
  scope,
  outcome,
  correlationId,
  actor,
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
    match: buildMatch({ action, scope, outcome, correlationId, actor }),
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
 * When residual filters are supplied the count walks matching entries so
 * page envelopes stay accurate for authorized filtered queries.
 * @param {string} [resourceId]
 * @param {object} [filters]
 * @returns {number}
 */
function countEntries(resourceId, filters = {}) {
  const match = buildMatch(filters);
  if (!match) {
    if (resourceId == null || resourceId === '') return auditIndex.size;
    return auditIndex.recordsFor(String(resourceId)).length;
  }

  const records = resourceId == null || resourceId === ''
    ? auditIndex.records
    : auditIndex.recordsFor(String(resourceId));
  let count = 0;
  for (const record of records) {
    if (match(record.item)) count += 1;
  }
  return count;
}

/**
 * Clear all audit entries. Primarily used in tests and when the store is reset.
 */
function reset() {
  auditIndex.reset();
  tipHash = GENESIS_HASH;
  eventsByIdentity.clear();
}

module.exports = {
  addEntry,
  actorRef,
  countEntries,
  getEntries,
  getEntriesForResource,
  positionKeyAt,
  queryEntries,
  reset,
  verifyIntegrity,
};
