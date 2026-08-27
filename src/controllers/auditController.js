'use strict';

const auditService = require('../services/auditService');
const { buildHistoryPage } = require('../utils/historyPage');

/**
 * Audit log controllers.
 */

/**
 * GET /api/audit
 * Return audit log entries, newest first by default.
 *
 * Supports ?resourceId= to filter by resource, ?order=asc|desc, ?limit=, and
 * either ?cursor= (stable under concurrent writes) or the legacy ?offset=.
 */
function listAuditEntries(req, res) {
  const resourceId = req.query.resourceId == null || req.query.resourceId === ''
    ? null
    : String(req.query.resourceId);

  const filters = { resourceId };

  const { items, envelope } = buildHistoryPage({
    req,
    collection: 'audit',
    filters,
    defaultOrder: 'desc',
    query: (args) => auditService.queryEntries({ resourceId, ...args }),
    countTotal: () => auditService.countEntries(resourceId),
    resolvePosition: (seq) => auditService.positionKeyAt(seq, resourceId),
  });

  res.json({ ...envelope, entries: items });
}

module.exports = {
  listAuditEntries,
};
