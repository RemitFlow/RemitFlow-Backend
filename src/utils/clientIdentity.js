'use strict';

const crypto = require('crypto');

/**
 * Client identity helpers for abuse controls.
 *
 * Keys and correlation values must never embed raw API tokens, admin keys,
 * account numbers, or other secrets. Fingerprints are one-way and truncated
 * so they are useful for isolation without being reversible.
 */

const FINGERPRINT_CHARS = 16;

/**
 * One-way, truncated fingerprint of a secret string.
 * @param {string} value
 * @returns {string}
 */
function fingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'anon';
  }
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, FINGERPRINT_CHARS);
}

/**
 * Resolve the client IP for rate limiting.
 *
 * When `trustProxy` is false (default), only the direct socket address is
 * used. When true, Express resolves `req.ip` from its configured trusted
 * proxy hops. The left-most forwarded value is not necessarily trustworthy.
 *
 * @param {import('express').Request} req
 * @param {{ trustProxy?: boolean }} [options]
 * @returns {string}
 */
function resolveClientIp(req, options = {}) {
  const trustProxy = Boolean(options.trustProxy);
  if (trustProxy && typeof req.ip === 'string' && req.ip) {
    return req.ip;
  }
  return (req.socket && req.socket.remoteAddress) || req.ip || 'unknown';
}

/**
 * Build a stable actor key for mutation rate limiting.
 * Prefers an authenticated token fingerprint; falls back to client IP.
 * Never returns the raw token or admin key.
 *
 * @param {import('express').Request} req
 * @param {{ trustProxy?: boolean }} [options]
 * @returns {string}
 */
function resolveActorKey(req, options = {}) {
  if (typeof req.token === 'string' && req.token) {
    return `actor:${fingerprint(req.token)}`;
  }
  if (typeof req.adminToken === 'string' && req.adminToken) {
    return `admin:${fingerprint(req.adminToken)}`;
  }
  return `ip:${resolveClientIp(req, options)}`;
}

module.exports = {
  fingerprint,
  resolveClientIp,
  resolveActorKey,
};
