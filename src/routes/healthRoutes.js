'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const healthController = require('../controllers/healthController');

const router = express.Router();

// GET /api/health
router.get('/', asyncHandler(healthController.getHealth));

// GET /api/health/ready
router.get('/ready', asyncHandler(healthController.getReadiness));

module.exports = router;
