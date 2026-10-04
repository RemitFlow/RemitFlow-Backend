'use strict';

/**
 * Canonical action/resource scope catalog.
 *
 * Every secured route and service boundary must require one of these values.
 * Unknown scope strings are rejected at configuration time so a typo cannot
 * silently open an endpoint.
 *
 * Format: `<resource>:<action>`
 */

const SCOPES = Object.freeze({
  TRANSFERS_READ: 'transfers:read',
  TRANSFERS_WRITE: 'transfers:write',
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',
  AUDIT_READ: 'audit:read',
  ADMIN_READ: 'admin:read',
});

/** All known scope strings, for validation and docs. */
const ALL_SCOPES = Object.freeze(Object.values(SCOPES));

/**
 * Route → required scopes matrix. Used by docs and the scope-matrix test so
 * the documented contract cannot drift from the mounted routers.
 *
 * `anyOf` is reserved for future OR-semantics; today every entry is AND.
 *
 * @type {ReadonlyArray<{ method: string, path: string, scopes: string[], surface: string }>}
 */
const SCOPE_MATRIX = Object.freeze([
  { method: 'GET', path: '/api/transfers', scopes: [SCOPES.TRANSFERS_READ], surface: 'list' },
  { method: 'GET', path: '/api/transfers/stats', scopes: [SCOPES.TRANSFERS_READ], surface: 'direct' },
  { method: 'GET', path: '/api/transfers/:id', scopes: [SCOPES.TRANSFERS_READ], surface: 'direct' },
  { method: 'POST', path: '/api/transfers', scopes: [SCOPES.TRANSFERS_WRITE], surface: 'direct' },
  { method: 'POST', path: '/api/transfers/:id/claim', scopes: [SCOPES.TRANSFERS_WRITE], surface: 'direct' },
  { method: 'POST', path: '/api/transfers/:id/cancel', scopes: [SCOPES.TRANSFERS_WRITE], surface: 'direct' },
  { method: 'POST', path: '/api/transfers/:id/archive', scopes: [SCOPES.TRANSFERS_WRITE], surface: 'direct' },
  { method: 'POST', path: '/api/transfers/:id/unarchive', scopes: [SCOPES.TRANSFERS_WRITE], surface: 'direct' },
  { method: 'POST', path: '/api/transfers/bulk', scopes: [SCOPES.TRANSFERS_WRITE], surface: 'bulk' },
  { method: 'GET', path: '/api/users', scopes: [SCOPES.USERS_READ], surface: 'list' },
  { method: 'GET', path: '/api/users/:id', scopes: [SCOPES.USERS_READ], surface: 'direct' },
  { method: 'POST', path: '/api/users', scopes: [SCOPES.USERS_WRITE], surface: 'direct' },
  { method: 'GET', path: '/api/audit', scopes: [SCOPES.AUDIT_READ], surface: 'list' },
  { method: 'GET', path: '/api/admin/diagnostics', scopes: [SCOPES.ADMIN_READ], surface: 'admin' },
]);

/**
 * Assert every entry in `scopes` is a known catalog value.
 * @param {string[]} scopes
 * @param {string} [label]
 * @returns {string[]}
 */
function assertKnownScopes(scopes, label = 'scope') {
  if (!Array.isArray(scopes)) {
    throw new Error(`${label} must be an array of scope strings`);
  }
  for (const scope of scopes) {
    if (!ALL_SCOPES.includes(scope)) {
      throw new Error(`Unknown ${label}: ${scope}`);
    }
  }
  return scopes;
}

module.exports = {
  SCOPES,
  ALL_SCOPES,
  SCOPE_MATRIX,
  assertKnownScopes,
};
