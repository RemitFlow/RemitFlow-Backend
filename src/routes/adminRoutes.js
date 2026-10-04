'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const adminAuth = require('../middleware/adminAuth');
const mutationRateLimit = require('../middleware/mutationRateLimit');
const adminController = require('../controllers/adminController');

const router = express.Router();

// GET /api/admin/diagnostics
router.get(
  '/diagnostics',
  adminAuth,
  mutationRateLimit.admin,
  asyncHandler(adminController.getDiagnostics)
);

module.exports = router;
