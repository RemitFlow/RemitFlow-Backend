'use strict';

const config = require('../config');
const userService = require('../services/userService');
const transferService = require('../services/transferService');
const { SCOPES, assertScopes, authFromRequest } = require('../utils/authz');

/**
 * GET /api/admin/diagnostics
 * Returns system diagnostics, active configurations, and usage statistics.
 *
 * Requires the explicit `admin:read` scope (enforced at the route by adminAuth
 * and re-checked here so the privileged aggregate cannot be reached through a
 * future helper that forgets the middleware).
 */
function getDiagnostics(req, res) {
  const auth = authFromRequest(req);
  assertScopes(auth, SCOPES.ADMIN_READ);

  // Admin diagnostics aggregates across tenants; call services without a
  // caller auth context so the read-scope gates do not reject an admin-only
  // token that intentionally has no transfers:read / users:read grants.
  const transferStats = transferService.getStats();
  const userCount = userService.listUsers().length;

  res.json({
    system: {
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
      timestamp: new Date().toISOString(),
    },
    config: {
      env: config.env,
      port: config.port,
      baseCurrency: config.baseCurrency,
      fee: config.fee,
      maxTransferAmount: config.maxTransferAmount,
      stellar: config.stellar,
      rateLimit: config.rateLimit,
      errorTrackingEnabled: config.errorTracking.enabled,
    },
    stats: {
      totalUsers: userCount,
      transfers: transferStats,
    },
  });
}

module.exports = {
  getDiagnostics,
};
