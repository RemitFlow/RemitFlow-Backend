'use strict';

const crypto = require('crypto');

/**
 * Cryptographic helpers for tamper-evident audit records.
 *
 * The hash chain binds each entry to its predecessor so a silent edit, insert,
 * or reorder is detectable by recomputing the chain. Actor references are
 * keyed digests of the API token so operators can filter by who acted without
 * ever storing or returning the raw secret.
 */

/** Genesis predecessor for the first entry in a chain. */
const GENESIS_HASH = '0'.repeat(64);

/**
 * Secret used to fingerprint actors. Falls back to the pagination cursor
 * secret so a single ops configuration covers both, then to a per-process
 * random value (correct for the in-memory demo store).
 */
const ACTOR_SECRET = process.env.AUDIT_ACTOR_SECRET
  || process.env.PAGINATION_CURSOR_SECRET
  || crypto.randomBytes(32).toString('hex');

/**
 * Field names (case-insensitive, ignoring `_` / `-`) that must never appear
 * in stored or returned audit changes. Matched on every nested object key.
 */
const SENSITIVE_KEY_PATTERN = /^(password|passwd|secret|token|(?:x[_-]?)?api[_-]?key|authorization|auth|bearer|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|ssn|cvv|pin|credential|credentials)$/i;

const REDACTED = '[REDACTED]';

/**
 * Deterministic JSON encoding so hash inputs do not depend on key order.
 * @param {*} value
 * @returns {string}
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    // Capture the length and visit every slot, including holes as null.
    const length = value.length;
    let encoded = '[';
    for (let index = 0; index < length; index += 1) {
      if (index > 0) encoded += ',';
      encoded += canonicalize(value[index]);
    }
    return `${encoded}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  let encoded = '{';
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) encoded += ',';
    const key = keys[index];
    encoded += `${JSON.stringify(key)}:${canonicalize(value[key])}`;
  }
  return `${encoded}}`;
}

/**
 * SHA-256 hex digest of a canonicalized value.
 * @param {*} value
 * @returns {string}
 */
function sha256(value) {
  return crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/**
 * Stable, non-reversible actor reference derived from an API token.
 * Anonymous / missing actors collapse to the literal `"system"`.
 * @param {string|null|undefined} token
 * @returns {string}
 */
function actorRef(token) {
  if (token == null || token === '') return 'system';
  return `actor:${crypto.createHmac('sha256', ACTOR_SECRET).update(String(token)).digest('hex').slice(0, 16)}`;
}

/**
 * Deep-clone `value`, replacing sensitive keys with `[REDACTED]`.
 * Non-objects are returned as-is. Arrays are walked element-wise.
 * @param {*} value
 * @returns {*}
 */
function redact(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  // Create own data properties even for JSON keys such as "__proto__".
  // Assignment to {} would invoke the inherited setter, dropping evidence
  // from both JSON responses and the canonical hash's own-key traversal.
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key.replace(/-/g, '_')) ? REDACTED : redact(child),
  ]));
}

/**
 * Compute the integrity hash for one audit entry given its predecessor hash.
 * Only fields that define the event participate; `entryHash` itself is excluded.
 * @param {object} entry
 * @param {string} prevHash
 * @returns {string}
 */
function computeEntryHash(entry, prevHash) {
  return sha256({
    prevHash,
    chainSeq: entry.chainSeq,
    id: entry.id,
    action: entry.action,
    scope: entry.scope,
    target: entry.target,
    actor: entry.actor,
    correlationId: entry.correlationId,
    outcome: entry.outcome,
    mutationId: entry.mutationId, // Undefined is omitted, preserving legacy hashes.
    changes: entry.changes,
    at: entry.at,
  });
}

/**
 * Derive a coarse scope from a dotted action (`transfer.created` → `transfers`).
 * @param {string} action
 * @returns {string}
 */
function scopeFromAction(action) {
  const head = String(action || '').split('.')[0] || 'unknown';
  if (head === 'transfer') return 'transfers';
  if (head === 'user') return 'users';
  if (head === 'admin') return 'admin';
  return `${head}s`;
}

module.exports = {
  GENESIS_HASH,
  REDACTED,
  SENSITIVE_KEY_PATTERN,
  actorRef,
  canonicalize,
  computeEntryHash,
  redact,
  scopeFromAction,
  sha256,
};
