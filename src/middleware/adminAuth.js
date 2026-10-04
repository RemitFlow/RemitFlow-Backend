'use strict';

const config = require('../config');
const ApiError = require('../utils/ApiError');

/**
 * Middleware to restrict route access to authorized admins.
 * Expects the admin key in either the 'X-Admin-Token' header or
 * as a Bearer token in the 'Authorization' header.
 */
function adminAuth(req, res, next) {
  let token = req.headers['x-admin-token'];

  // Check Authorization header for Bearer token
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token || token !== config.adminApiKey) {
    return next(new ApiError(401, 'Unauthorized'));
  }

  // Expose for downstream actor-keyed rate limiting (never log the raw value).
  req.adminToken = token;
  next();
}

module.exports = adminAuth;
