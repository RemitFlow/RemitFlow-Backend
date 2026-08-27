'use strict';

const crypto = require('crypto');
const ApiError = require('./ApiError');

/**
 * Opaque, tamper-evident pagination cursors.
 *
 * A cursor is `base64url(payload) + "." + base64url(HMAC-SHA256(payload))`.
 * It is opaque to clients: the payload is an implementation detail and the
 * signature means a client cannot craft or edit one.
 *
 * The payload binds a cursor to the query that produced it:
 *   v  cursor format version
 *   o  sort order the page was produced with
 *   k  timestamp of the record the cursor points at (validated on resume)
 *   s  sequence number of that record (the authoritative position)
 *   f  fingerprint of the filter set
 *   a  fingerprint of the calling actor
 *
 * Binding matters because a cursor is a position inside one specific ordered
 * result set. Replaying it against a different filter, a different sort order,
 * or - most importantly - a different API token would silently return a page
 * from a result set the cursor was never computed against. Every mismatch is
 * rejected rather than reinterpreted.
 *
 * The signing key comes from PAGINATION_CURSOR_SECRET. Without it a random
 * per-process key is generated, which is correct for the in-memory store
 * (cursors are meaningless across restarts anyway) but must be set explicitly
 * before running more than one instance behind a load balancer.
 */

const CURSOR_VERSION = 1;

const SECRET = process.env.PAGINATION_CURSOR_SECRET
  || crypto.randomBytes(32).toString('hex');

/** Longest cursor string accepted, to bound work on hostile input. */
const MAX_CURSOR_LENGTH = 512;

/**
 * Stable fingerprint of an arbitrary value.
 * Object keys are sorted so that fingerprints do not depend on insertion order.
 * @param {*} value
 * @returns {string} 16 hex characters.
 */
function fingerprint(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex').slice(0, 16);
}

/**
 * Deterministic JSON encoding used as fingerprint input.
 * @param {*} value
 * @returns {string}
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

/**
 * Fingerprint identifying the caller a cursor belongs to.
 *
 * Derived from the API token so a cursor minted for one token is rejected when
 * presented with another, even when both tokens can read the collection. The
 * raw token is never stored in the cursor.
 *
 * Keyed with the signing secret rather than plainly hashed: a cursor is handed
 * to the client, and an unkeyed hash of a token would let anyone who captured
 * one brute-force the token offline.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function actorFingerprint(req) {
  const subject = req && req.token ? `token:${req.token}` : 'anonymous';
  return crypto.createHmac('sha256', SECRET).update(subject).digest('hex').slice(0, 16);
}

/**
 * Encode a signed cursor.
 * @param {object} params
 * @param {'asc'|'desc'} params.order
 * @param {string} params.key    - timestamp of the record pointed at.
 * @param {number} params.seq    - sequence number of that record.
 * @param {string} params.filter - filter fingerprint.
 * @param {string} params.actor  - actor fingerprint.
 * @returns {string}
 */
function encodeCursor({ order, key, seq, filter, actor }) {
  const payload = Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, o: order, k: key, s: seq, f: filter, a: actor }),
    'utf8'
  ).toString('base64url');

  return `${payload}.${signPayload(payload)}`;
}

/**
 * Decode and fully validate a cursor.
 *
 * @param {string} raw
 * @param {object} expected
 * @param {'asc'|'desc'} expected.order
 * @param {string} expected.filter
 * @param {string} expected.actor
 * @returns {{ order: 'asc'|'desc', key: string, seq: number }}
 * @throws {ApiError} 400 for malformed, forged, stale-format or cross-filter
 *   cursors; 403 for a cursor belonging to a different actor.
 */
function decodeCursor(raw, expected) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor('Cursor is malformed');
  }

  const separator = raw.indexOf('.');
  if (separator <= 0 || separator === raw.length - 1) {
    throw invalidCursor('Cursor is malformed');
  }

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);

  if (!constantTimeEquals(signature, signPayload(payload))) {
    // Same error as a malformed cursor: a caller probing the endpoint learns
    // nothing about whether their edit was structurally valid.
    throw invalidCursor('Cursor is malformed');
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('Cursor is malformed');
  }

  if (!decoded || typeof decoded !== 'object' || decoded.v !== CURSOR_VERSION) {
    throw invalidCursor('Cursor was issued by an incompatible API version');
  }
  if (!Number.isSafeInteger(decoded.s) || decoded.s < 0 || typeof decoded.k !== 'string') {
    throw invalidCursor('Cursor is malformed');
  }

  // Actor first: crossing an actor boundary is the security-relevant failure.
  if (decoded.a !== expected.actor) {
    throw new ApiError(403, 'Cursor was issued to a different API token', {
      code: 'CURSOR_ACTOR_MISMATCH',
    });
  }
  if (decoded.o !== expected.order) {
    throw invalidCursor('Cursor was issued for a different sort order', 'CURSOR_ORDER_MISMATCH');
  }
  if (decoded.f !== expected.filter) {
    throw invalidCursor(
      'Cursor was issued for a different set of filters; restart paging without a cursor',
      'CURSOR_FILTER_MISMATCH'
    );
  }

  return { order: decoded.o, key: decoded.k, seq: decoded.s };
}

/**
 * @param {string} payload
 * @returns {string}
 */
function signPayload(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/**
 * Length-safe constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEquals(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * @param {string} message
 * @param {string} [code]
 * @returns {ApiError}
 */
function invalidCursor(message, code = 'INVALID_CURSOR') {
  return ApiError.badRequest(message, { code });
}

module.exports = {
  CURSOR_VERSION,
  MAX_CURSOR_LENGTH,
  actorFingerprint,
  decodeCursor,
  encodeCursor,
  fingerprint,
};
