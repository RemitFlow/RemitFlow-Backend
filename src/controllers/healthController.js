'use strict';

const config = require('../config');
const { name, version } = require('../../package.json');
const dependencyHealth = require('../services/dependencyHealthService');

/**
 * Health controller.
 *
 * Liveness answers "is the process up?" and must stay cheap and dependency-
 * free so orchestrators do not restart a process that is merely waiting on
 * a degraded dependency. Readiness answers "can this instance serve traffic?"
 * by running bounded, redacted dependency probes that recover automatically
 * once the dependency is healthy again.
 */

/**
 * GET /api/health
 * Reports basic process information (not a dependency gate).
 */
function getHealth(req, res) {
  res.json({
    status: 'ok',
    service: 'remitflow-backend',
    version,
    env: config.env,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/version
 * Reports the service name and version.
 */
function getVersion(req, res) {
  res.json({
    name,
    version,
    env: config.env,
  });
}

/**
 * GET /api/health/live
 * Liveness probe: confirms the process is up and responding. Intentionally
 * ignores store / payment / FX state so outages do not flap restarts.
 */
function getLiveness(req, res) {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
}

/**
 * GET /api/health/ready
 * Readiness probe: bounded checks against store, payments, and FX.
 * Returns 200 when every dependency is healthy and 503 otherwise. Reason
 * codes are redacted; recovery is automatic on the next successful probe.
 */
async function getReadiness(req, res) {
  const result = await dependencyHealth.evaluateReadiness();
  const payload = {
    status: result.status,
    checks: result.checks,
    timeoutMs: result.timeoutMs,
    timestamp: new Date().toISOString(),
  };
  res.status(result.ready ? 200 : 503).json(payload);
}

module.exports = {
  getHealth,
  getVersion,
  getLiveness,
  getReadiness,
};
