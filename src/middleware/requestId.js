'use strict';

const { newId } = require('../utils/ids');

/** Max length accepted for an inbound correlation / request id. */
const MAX_CORRELATION_ID_LENGTH = 128;

/**
 * Validate correlation-id syntax and size. This alone cannot identify
 * credentials or arbitrary personal data; requestId separately excludes
 * credentials presented with the current request.
 * @param {*} value
 * @returns {string|null}
 */
function sanitizeCorrelationId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CORRELATION_ID_LENGTH) {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Attach a unique correlation identifier to every request.
 *
 * Honour inbound `X-Request-Id` or `X-Correlation-Id` when they pass
 * sanitization and contain neither presented Bearer nor admin token. A
 * syntactically valid ID is not proof that arbitrary data is non-secret.
 * Callers must use independent correlation IDs. Otherwise a
 * fresh id is generated. The same value is exposed as `req.id` and
 * `req.correlationId`, and echoed on both response headers so either
 * convention works for clients.
 */
function requestId(req, res, next) {
  // This middleware runs before authentication, so inspect the presented
  // credentials without changing whether the request is authorized.
  const authorization = req.get('Authorization');
  const bearer = typeof authorization === 'string'
    ? /^Bearer\s+(\S+)/i.exec(authorization)
    : null;
  const credentials = [bearer && bearer[1], req.get('X-Admin-Token')]
    .filter((value) => typeof value === 'string' && value.length > 0);
  const safeIncoming = (value) => {
    const candidate = sanitizeCorrelationId(value);
    return candidate && !credentials.some((token) => candidate.includes(token))
      ? candidate
      : null;
  };
  const incoming =
    safeIncoming(req.get('X-Request-Id')) ||
    safeIncoming(req.get('X-Correlation-Id'));
  const id = incoming || newId();
  req.id = id;
  req.correlationId = id;
  res.set('X-Request-Id', id);
  res.set('X-Correlation-Id', id);
  next();
}

module.exports = requestId;
module.exports.sanitizeCorrelationId = sanitizeCorrelationId;
module.exports.MAX_CORRELATION_ID_LENGTH = MAX_CORRELATION_ID_LENGTH;
