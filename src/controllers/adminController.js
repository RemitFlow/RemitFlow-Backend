'use strict';

const config = require('../config');
const userService = require('../services/userService');
const transferService = require('../services/transferService');

/**
 * GET /api/admin/diagnostics
 * Returns system diagnostics, active configurations, and usage statistics.
 */
function getDiagnostics(req, res) {
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
      trustProxy: config.trustProxy,
      rateLimit: config.rateLimit,
      mutationRateLimit: config.mutationRateLimit,
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
