'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const requireScope = require('../middleware/requireScope');
const transferController = require('../controllers/transferController');
const { validateCreateTransfer } = require('../validators/transferValidator');

const router = express.Router();

// POST /api/transfers
router.post(
  '/',
  requireScope(['transfers:write']),
  validate(validateCreateTransfer),
  asyncHandler(transferController.createTransfer)
);

// GET /api/transfers
router.get('/', requireScope(['transfers:read']), asyncHandler(transferController.listTransfers));

// GET /api/transfers/stats (declared before /:id so it is not captured)
router.get('/stats', requireScope(['transfers:read']), asyncHandler(transferController.getStats));

// POST /api/transfers/bulk (declared before /:id so "bulk" is not captured)
router.post('/bulk', requireScope(['transfers:write']), asyncHandler(transferController.bulkMutate));

// GET /api/transfers/:id
router.get('/:id', requireScope(['transfers:read']), asyncHandler(transferController.getTransfer));

// POST /api/transfers/:id/claim
router.post('/:id/claim', requireScope(['transfers:write']), asyncHandler(transferController.claimTransfer));

// POST /api/transfers/:id/cancel
router.post('/:id/cancel', requireScope(['transfers:write']), asyncHandler(transferController.cancelTransfer));

// POST /api/transfers/:id/archive
router.post('/:id/archive', requireScope(['transfers:write']), asyncHandler(transferController.archiveTransfer));

// POST /api/transfers/:id/unarchive
router.post('/:id/unarchive', requireScope(['transfers:write']), asyncHandler(transferController.unarchiveTransfer));

module.exports = router;
