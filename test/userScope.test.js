'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { store, reset } = require('../src/store');
const userService = require('../src/services/userService');
const { SCOPES } = require('../src/config/scopes');

test('findUser rejects explicit under-scoped contexts before looking up users', () => {
  reset();
  const user = userService.createUser({
    name: 'Scope fixture',
    email: 'scope-fixture@example.invalid',
  });
  const originalGet = store.users.get;
  let lookups = 0;
  store.users.get = function (...args) {
    lookups += 1;
    return originalGet.apply(this, args);
  };

  try {
    for (const id of [user.id, 'usr_missing']) {
      for (const auth of [{}, { scopes: [] }, { scopes: [SCOPES.USERS_WRITE] }]) {
        assert.throws(
          () => userService.findUser(id, auth),
          (error) => error.statusCode === 403
            && error.message === 'Insufficient token scopes'
        );
      }
    }
    assert.equal(lookups, 0);
  } finally {
    store.users.get = originalGet;
  }
});

test('findUser preserves authorized reads and trusted internal lookup behavior', () => {
  reset();
  const user = userService.createUser({
    name: 'Scope fixture',
    email: 'scope-fixture@example.invalid',
  });
  const reader = { scopes: [SCOPES.USERS_READ] };
  for (const auth of [reader, undefined, null]) {
    assert.equal(userService.findUser(user.id, auth), user);
    assert.equal(userService.findUser('usr_missing', auth), undefined);
  }
  assert.equal(userService.getUserOrThrow(user.id, reader), user);
});
