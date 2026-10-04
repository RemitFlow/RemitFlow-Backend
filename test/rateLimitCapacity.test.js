'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const rateLimit = require('../src/middleware/rateLimit');
const { resolveActorKey } = require('../src/utils/clientIdentity');

// Exercise the complete production middleware and actor-key helper over actual
// loopback HTTP. Only the clock, authenticated token assignment and Express
// response/error adapter are controlled; no application/auth integration claim.
async function fixture(t, { maxKeys = 1, stacked = true } = {}) {
  const epoch = 1_700_000_000_000;
  let now = epoch;
  t.mock.method(Date, 'now', () => now);
  const outer = rateLimit({ name: 'global', max: 100, windowMs: 60_000, forceInTest: true });
  const inner = rateLimit({
    name: 'mutation:transfers', max: 10, maxKeys, windowMs: 60_000,
    forceInTest: true, keyGenerator: resolveActorKey,
  });
  const server = http.createServer((req, res) => {
    req.token = req.headers['x-fixture-token'];
    res.set = (name, value) => { res.setHeader(name, value); return res; };
    const finish = (error) => {
      res.statusCode = error ? error.statusCode : 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(error ? { message: error.message, details: error.details } : { ok: true }));
    };
    const route = (error) => {
      if (error) finish(error);
      else if (req.url === '/global') finish();
      else inner(req, res, finish);
    };
    if (stacked) outer(req, res, route);
    else route();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  async function request(offset, token, path = '/transfer') {
    now = epoch + offset;
    return new Promise((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1', port: server.address().port, path, agent: false,
        headers: token ? { 'X-Fixture-Token': token } : {},
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  function blocked(response, offset, retryAfter) {
    assert.equal(response.status, 429);
    assert.equal(response.headers['x-ratelimit-policy'], 'mutation:transfers');
    assert.equal(response.headers['x-ratelimit-limit'], '10');
    assert.equal(response.headers['x-ratelimit-remaining'], '0');
    assert.equal(response.headers['retry-after'], String(retryAfter));
    assert.equal(response.body.details.retryAfter, retryAfter);
    assert.equal(response.body.details.policy, 'mutation:transfers');
    assert.equal(response.headers['x-ratelimit-reset'], String(Math.ceil((epoch + offset) / 1000)));
  }
  return { request, blocked };
}

test('capacity rejection replaces the outer policy reset and admits at its own deadline', async t => {
  const { request, blocked } = await fixture(t);
  const globalOnly = await request(0, undefined, '/global');
  const first = await request(30_000, 'actor-a');
  const rejected = await request(45_000, 'actor-b');
  const beforeDeadline = await request(89_999, 'actor-b');
  const atDeadline = await request(90_000, 'actor-b');

  assert.equal(globalOnly.status, 200);
  assert.equal(globalOnly.headers['x-ratelimit-reset'], '1700000060');
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-ratelimit-reset'], '1700000090');
  assert.equal(atDeadline.status, 200);
  assert.equal(atDeadline.headers['x-ratelimit-remaining'], '9');
  blocked(rejected, 90_000, 45);
  blocked(beforeDeadline, 90_000, 1);
});

test('standalone capacity rejection includes the rounded-up expiry header', async t => {
  const { request, blocked } = await fixture(t, { stacked: false });
  const first = await request(1_250, 'actor-a');
  const rejected = await request(2_000, 'actor-b');
  const beforeDeadline = await request(61_249, 'actor-b');
  const atDeadline = await request(61_250, 'actor-b');

  assert.equal(first.status, 200);
  assert.equal(atDeadline.status, 200);
  assert.equal(atDeadline.headers['x-ratelimit-remaining'], '9');
  blocked(rejected, 61_250, 60);
  blocked(beforeDeadline, 61_250, 1);
});

test('capacity reset advances to the next surviving expiry after a slot is reused', async t => {
  const { request, blocked } = await fixture(t, { maxKeys: 2 });
  const first = await request(2_000, 'actor-a');
  const second = await request(10_000, 'actor-b');
  const rejected = await request(15_000, 'actor-c');
  const reused = await request(62_000, 'actor-c');
  const nextRejected = await request(62_500, 'actor-a');

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(reused.status, 200);
  assert.equal(reused.headers['x-ratelimit-remaining'], '9');
  blocked(rejected, 62_000, 47);
  blocked(nextRejected, 70_000, 8);
});
