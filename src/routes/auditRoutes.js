'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const requireScope = require('../middleware/requireScope');
const auditController = require('../controllers/auditController');

const router = express.Router();

// GET /api/audit/integrity
// Hash-chain verification for authorized operators (requires audit:read).
router.get(
  '/integrity',
  requireScope(['audit:read']),
  asyncHandler(auditController.getIntegrity)
);

// GET /api/audit
// Lists audit log entries (newest first). Supports resource and attribution filters.
router.get('/', requireScope(['audit:read']), asyncHandler(auditController.listAuditEntries));

module.exports = router;
