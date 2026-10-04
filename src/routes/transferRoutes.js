'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const requireScope = require('../middleware/requireScope');
const mutationRateLimit = require('../middleware/mutationRateLimit');
const transferController = require('../controllers/transferController');
const { validateCreateTransfer } = require('../validators/transferValidator');

const router = express.Router();

// POST /api/transfers
router.post(
  '/',
  requireScope(['transfers:write']),
  mutationRateLimit.transfers,
  validate(validateCreateTransfer),
  asyncHandler(transferController.createTransfer)
);

// GET /api/transfers
router.get('/', requireScope(['transfers:read']), asyncHandler(transferController.listTransfers));

// GET /api/transfers/stats (declared before /:id so it is not captured)
router.get('/stats', requireScope(['transfers:read']), asyncHandler(transferController.getStats));

// GET /api/transfers/:id
router.get('/:id', requireScope(['transfers:read']), asyncHandler(transferController.getTransfer));

// POST /api/transfers/:id/claim
router.post(
  '/:id/claim',
  requireScope(['transfers:write']),
  mutationRateLimit.transfers,
  asyncHandler(transferController.claimTransfer)
);

// POST /api/transfers/:id/cancel
router.post(
  '/:id/cancel',
  requireScope(['transfers:write']),
  mutationRateLimit.transfers,
  asyncHandler(transferController.cancelTransfer)
);

// POST /api/transfers/:id/archive
router.post(
  '/:id/archive',
  requireScope(['transfers:write']),
  mutationRateLimit.transfers,
  asyncHandler(transferController.archiveTransfer)
);

// POST /api/transfers/:id/unarchive
router.post(
  '/:id/unarchive',
  requireScope(['transfers:write']),
  mutationRateLimit.transfers,
  asyncHandler(transferController.unarchiveTransfer)
);

module.exports = router;
