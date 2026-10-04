'use strict';

const auditService = require('../services/auditService');
const { buildHistoryPage } = require('../utils/historyPage');

/**
 * Audit log controllers.
 */

/**
 * Collect optional attribution / outcome filters from the query string.
 * Empty strings are treated as absent so `?action=` does not over-filter.
 * @param {import('express').Request} req
 * @returns {{ action: string|null, scope: string|null, outcome: string|null,
 *   correlationId: string|null, actor: string|null }}
 */
function readFilters(req) {
  const pick = (name) => {
    const raw = req.query[name];
    if (raw == null || raw === '') return null;
    return String(raw);
  };

  return {
    action: pick('action'),
    scope: pick('scope'),
    outcome: pick('outcome'),
    correlationId: pick('correlationId'),
    actor: pick('actor'),
  };
}

/**
 * GET /api/audit
 * Return audit log entries, newest first by default.
 *
 * Supports ?resourceId=, ?action=, ?scope=, ?outcome=, ?correlationId=,
 * ?actor=, ?order=asc|desc, ?limit=, and either ?cursor= or legacy ?offset=.
 * Responses only ever contain redacted changes — secrets are stripped at write.
 */
function listAuditEntries(req, res) {
  const resourceId = req.query.resourceId == null || req.query.resourceId === ''
    ? null
    : String(req.query.resourceId);

  const attribution = readFilters(req);
  const filters = { resourceId, ...attribution };

  const { items, envelope } = buildHistoryPage({
    req,
    collection: 'audit',
    filters,
    defaultOrder: 'desc',
    query: (args) => auditService.queryEntries({ resourceId, ...attribution, ...args }),
    countTotal: () => auditService.countEntries(resourceId, attribution),
    resolvePosition: (seq) => auditService.positionKeyAt(seq, resourceId),
  });

  res.json({ ...envelope, entries: items });
}

/**
 * GET /api/audit/integrity
 * Report whether the hash chain is intact. Authorized operators use this to
 * detect silent tampering without reading every entry's payload.
 */
function getIntegrity(req, res) {
  const report = auditService.verifyIntegrity();
  res.json(report);
}

module.exports = {
  getIntegrity,
  listAuditEntries,
};
