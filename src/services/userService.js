'use strict';

const { store } = require('../store');
const { prefixedId } = require('../utils/ids');
const ApiError = require('../utils/ApiError');
const auditService = require('./auditService');
const { SCOPES, assertScopes } = require('../utils/authz');

/**
 * User management backed by the in-memory store.
 */

/**
 * Return all users.
 * @returns {Array<object>}
 */
function listUsers(auth) {
  assertScopes(auth, SCOPES.USERS_READ);
  return Array.from(store.users.values());
}

/**
 * Find a user by id.
 * @param {string} id
 * @param {{ scopes?: string[] }|null} [auth] - optional service authorization context
 * @returns {object|undefined}
 */
function findUser(id, auth) {
  assertScopes(auth, SCOPES.USERS_READ);
  return store.users.get(id);
}

/**
 * Get a user or throw a 404 if missing.
 * @param {string} id
 * @returns {object}
 */
function getUserOrThrow(id, auth) {
  assertScopes(auth, SCOPES.USERS_READ);
  const user = findUser(id);
  if (!user) {
    throw ApiError.notFound('User not found');
  }
  return user;
}

/**
 * Create and persist a new user.
 * @param {{ name: string, email: string, country?: string }} data
 * @param {string} [requestId] - optional correlation id for audit logging
 * @returns {object}
 */
function createUser(data, requestId, auth) {
  assertScopes(auth, SCOPES.USERS_WRITE);
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
  });

  return user;
}

module.exports = {
  listUsers,
  findUser,
  getUserOrThrow,
  createUser,
};
