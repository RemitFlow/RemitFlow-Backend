'use strict';

const userService = require('../services/userService');
const { parsePagination } = require('../utils/pagination');

/**
 * User controllers.
 */

/**
 * GET /api/users
 * List users with limit/offset pagination.
 */
function listUsers(req, res) {
  const all = userService.listUsers();
  const { limit, offset } = parsePagination(req.query);
  const users = all.slice(offset, offset + limit);
  res.json({ total: all.length, count: users.length, limit, offset, users });
}

/**
 * GET /api/users/:id
 * Fetch a single user by id.
 */
function getUser(req, res) {
  const user = userService.getUserOrThrow(req.params.id);
  res.json(user);
}

/**
 * POST /api/users
 * Create a new user.
 */
function createUser(req, res) {
  const user = userService.createUser(req.body, req.id, req.token);
  res.status(201).json(user);
}

module.exports = {
  listUsers,
  getUser,
  createUser,
};
