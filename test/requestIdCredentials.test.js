'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const requestId = require('../src/middleware/requestId');

function invoke(headers) {
  const sent = {};
  const req = { get: (name) => headers[name.toLowerCase()] };
  let calls = 0;
  requestId(req, { set: (name, value) => { sent[name] = value; } }, () => { calls += 1; });
  assert.equal(calls, 1);
  assert.equal(req.id, req.correlationId);
  assert.equal(sent['X-Request-Id'], req.id);
  assert.equal(sent['X-Correlation-Id'], req.id);
  return req.id;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('presented Bearer credentials cannot become correlation identifiers', () => {
  const token = 'example-secret-token.42';
  for (const authorization of [`Bearer ${token}`, `bearer ${token}`]) {
    for (const value of [token, `trace:${token}:retry`]) {
      for (const header of ['x-request-id', 'x-correlation-id']) {
        const id = invoke({ authorization, [header]: value });
        assert.ok(!id.includes(token));
        assert.match(id, uuid);
      }
    }
  }
});

test('admin credentials are excluded even when another Bearer token is supplied', () => {
  const token = 'example-admin-secret';
  for (const value of [token, `retry:${token}`]) {
    const id = invoke({
      authorization: 'Bearer example-user-secret',
      'x-admin-token': token,
      'x-request-id': value,
      'x-correlation-id': 'example-user-secret',
    });
    assert.match(id, uuid);
    assert.ok(!id.includes(token));
    assert.ok(!id.includes('example-user-secret'));
  }
});

test('an independent fallback is retained when the preferred id contains a credential', () => {
  assert.equal(invoke({
    authorization: 'Bearer example-token',
    'x-request-id': 'example-token',
    'x-correlation-id': 'order-123:attempt-2',
  }), 'order-123:attempt-2');
});

test('ordinary identifier precedence and syntax handling are unchanged', () => {
  assert.equal(invoke({
    authorization: 'Bearer example-token',
    'x-admin-token': 'example-admin',
    'x-request-id': '  upstream.123  ',
    'x-correlation-id': 'other-id',
  }), 'upstream.123');
  assert.equal(invoke({ 'x-request-id': 'unsafe value', 'x-correlation-id': 'safe-id' }), 'safe-id');
  assert.equal(invoke({ 'x-request-id': 'x'.repeat(128) }), 'x'.repeat(128));
  for (const value of ['x'.repeat(129), 'has\ncontrol', 'has space', '"quoted"', ['array']]) {
    assert.match(invoke({ 'x-request-id': value }), uuid);
  }
  assert.equal(requestId.sanitizeCorrelationId('trace-12'), 'trace-12');
});

test('replacement identifiers are fresh for separate requests', () => {
  const headers = { authorization: 'Bearer example-token', 'x-request-id': 'example-token' };
  const first = invoke(headers);
  const second = invoke(headers);
  assert.match(first, uuid);
  assert.match(second, uuid);
  assert.notEqual(first, second);
});
