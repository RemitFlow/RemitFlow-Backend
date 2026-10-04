'use strict';

const config = require('../config');
const ApiError = require('../utils/ApiError');
const { assertKnownScopes } = require('../config/scopes');
const { hasAllScopes } = require('../utils/authz');

/**
 * Middleware to require a specific set of scopes from the provided API token.
 * Validates the Bearer token in the Authorization header.
 *
 * Required scopes are checked against the canonical catalog at middleware
 * construction time so a typo cannot ship as an open route.
 *
 * @param {string[]} requiredScopes - Array of scopes required to access the endpoint.
 * @returns {import('express').RequestHandler}
 */
function requireScope(requiredScopes) {
  const needed = assertKnownScopes(
    Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes],
    'required scope'
  );

  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(ApiError.unauthorized('Missing or invalid Authorization header'));
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      return next(ApiError.unauthorized('Missing or invalid Authorization header'));
    }

    const tokenScopes = config.apiTokens[token];

    if (!tokenScopes) {
      // Same 401 as a missing header: do not confirm whether the secret looked
      // "almost right".
      return next(ApiError.unauthorized('Invalid API token'));
    }

    if (!hasAllScopes(tokenScopes, needed)) {
      return next(ApiError.forbidden('Insufficient token scopes'));
    }

    req.token = token;
    req.tokenScopes = tokenScopes;

    next();
  };
}

module.exports = requireScope;
