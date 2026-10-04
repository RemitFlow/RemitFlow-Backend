'use strict';

const config = require('../config');
const ApiError = require('../utils/ApiError');
const { SCOPES, hasAllScopes } = require('../utils/authz');

/**
 * Restrict route access to callers that hold the explicit `admin:read` scope.
 *
 * Accepted credentials (checked in order):
 *   1. `Authorization: Bearer <api-token>` whose catalog entry includes admin:read
 *   2. Legacy admin key via `X-Admin-Token` or `Authorization: Bearer <admin-key>`
 *      — the key is treated as an actor that holds `[admin:read]` so admin paths
 *      stay scope-gated even when the shared key is used.
 *
 * Failures are non-enumerating: missing, unknown, and under-scoped callers all
 * receive the same 401/403 vocabulary used by requireScope.
 */
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  let bearer = null;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    bearer = authHeader.slice('Bearer '.length).trim();
  }

  // Prefer a scoped API token when one is presented.
  if (bearer && config.apiTokens[bearer]) {
    const tokenScopes = config.apiTokens[bearer];
    if (!hasAllScopes(tokenScopes, [SCOPES.ADMIN_READ])) {
      return next(ApiError.forbidden('Insufficient token scopes'));
    }
    req.token = bearer;
    req.tokenScopes = tokenScopes;
    return next();
  }

  const headerKey = req.headers['x-admin-token'];
  const legacyKey = (typeof headerKey === 'string' && headerKey.trim() !== '')
    ? headerKey.trim()
    : bearer;

  if (!legacyKey || legacyKey !== config.adminApiKey) {
    // Do not reveal whether the failure was "no credential" vs "wrong key".
    return next(ApiError.unauthorized('Unauthorized'));
  }

  // Legacy admin key maps onto the explicit admin:read scope.
  req.token = legacyKey;
  req.tokenScopes = [SCOPES.ADMIN_READ];
  return next();
}

module.exports = adminAuth;
