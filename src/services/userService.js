'use strict';

const { store } = require('../store');
const { prefixedId } = require('../utils/ids');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');

/**
 * User management backed by the in-memory store.
 */

/**
 * Return all users.
 * @returns {Array<object>}
 */
function listUsers() {
  return Array.from(store.users.values());
}

/**
 * Find a user by id.
 * @param {string} id
 * @returns {object|undefined}
 */
function findUser(id) {
  return store.users.get(id);
}

/**
 * Get a user or throw a 404 if missing.
 * @param {string} id
 * @returns {object}
 */
function getUserOrThrow(id) {
  const user = findUser(id);
  if (!user) {
    throw ApiError.notFound(`User not found: ${id}`);
  }
  return user;
}

/**
 * Create and persist a new user.
 * @param {{ name: string, email: string, country?: string }} data
 * @param {string} [requestId] - optional correlation id for audit logging
 * @returns {object}
 */
function createUser(data, requestId, actor) {
  const user = {
    id: prefixedId('usr'),
    name: data.name,
    email: data.email,
    country: data.country || null,
    createdAt: new Date().toISOString(),
  };
  store.users.set(user.id, user);

  auditService.addEntry({
    action: 'user.created',
    resourceId: user.id,
    payload: { name: user.name, country: user.country },
    requestId,
    actorToken: actor,
    outcome: 'success',
  });

  return user;
}

module.exports = {
  listUsers,
  findUser,
  getUserOrThrow,
  createUser,
};
