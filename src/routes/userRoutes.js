'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const requireScope = require('../middleware/requireScope');
const mutationRateLimit = require('../middleware/mutationRateLimit');
const userController = require('../controllers/userController');
const { validateCreateUser } = require('../validators/userValidator');

const router = express.Router();

// GET /api/users
router.get('/', requireScope(['users:read']), asyncHandler(userController.listUsers));

// GET /api/users/:id
router.get('/:id', requireScope(['users:read']), asyncHandler(userController.getUser));

// POST /api/users
router.post(
  '/',
  requireScope(['users:write']),
  mutationRateLimit.users,
  validate(validateCreateUser),
  asyncHandler(userController.createUser)
);

module.exports = router;
