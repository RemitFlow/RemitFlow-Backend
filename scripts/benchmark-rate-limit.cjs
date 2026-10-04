'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

// Usage: node scripts/benchmark-rate-limit.cjs NEW-RESULT.json [APP-CHECKOUT]
const outputPath = process.argv[2];
if (!outputPath || process.argv.length > 4) {
  console.error('Usage: node scripts/benchmark-rate-limit.cjs NEW-RESULT.json [APP-CHECKOUT]');
  process.exitCode = 2;
} else {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function run() {
  if (fs.existsSync(outputPath)) throw new Error(`Result already exists: ${outputPath}`);
  const appRoot = path.resolve(process.argv[3] || path.join(__dirname, '..'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    ENABLE_RATE_LIMIT_IN_TEST: '1',
    RATE_LIMIT_MAX_KEYS: '10000',
    RATE_LIMIT_MAX: '1',
    RATE_LIMIT_WINDOW_MS: '180000',
    TRUST_PROXY: 'true',
    ERROR_TRACKING_ENABLED: 'false',
  });

  const createApp = require(path.join(appRoot, 'src/app'));
  const server = http.createServer(createApp());
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  let port;

  function request(identity) {
    const ip = `10.${(identity >>> 16) & 255}.${(identity >>> 8) & 255}.${identity & 255}`;
    return new Promise((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1', port, path: '/api/version', agent,
        headers: { 'X-Forwarded-For': ip, 'X-Request-Id': `load-${identity}` },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.setTimeout(30_000, () => req.destroy(new Error('Local benchmark request timed out')));
      req.on('error', reject);
    });
  }

  async function batch(start, count, expectedStatus) {
    let next = 0;
    let completed = 0;
    await Promise.all(Array.from({ length: 32 }, async () => {
      while (next < count) {
        const identity = start + next++;
        const result = await request(identity);
        assert.equal(result.status, expectedStatus);
        if (expectedStatus === 429) {
          assert.equal(result.body.error.details.policy, 'global');
          assert.equal(result.headers['x-request-id'], `load-${identity}`);
        }
        completed += 1;
      }
    }));
    return completed;
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    const fill = await batch(1, 10_000, 200);
    const samples = [];
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now();
      const cpuStarted = process.cpuUsage();
      const count = await batch(20_000 + round * 2_000, 2_000, 429);
      const cpu = process.cpuUsage(cpuStarted);
      samples.push({ count, elapsedMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1_000 });
    }

    const original = await request(1);
    assert.equal(original.status, 429);
    assert.equal(original.body.error.message, 'Too many requests, please try again later');

    const sourceSha256 = {};
    for (const file of ['src/app.js', 'src/middleware/rateLimit.js']) {
      sourceSha256[file] = createHash('sha256').update(fs.readFileSync(path.join(appRoot, file))).digest('hex');
    }
    const result = {
      node: process.version,
      express: require(path.join(appRoot, 'node_modules/express/package.json')).version,
      sourceSha256,
      path: '/api/version', concurrency: 32, maxKeys: 10_000, fill, samples,
      activeBudgetPreserved: true,
      scope: 'Real createApp HTTP on loopback; test mode with rate limiting enabled; one trusted proxy hop; error tracking disabled; CPU includes client and server in one process; generated local load, not deployed performance.',
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  } finally {
    agent.destroy();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
