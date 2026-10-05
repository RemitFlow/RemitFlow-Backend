'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { store, reset } = require('../src/store');
const config = require('../src/config');
const { RATES_TO_USD } = require('../src/config/rates');
const fxCacheService = require('../src/services/fxCacheService');
const fxProviders = require('../src/services/fxProviders');
const quoteService = require('../src/services/quoteService');
const transferService = require('../src/services/transferService');
const rateService = require('../src/services/rateService');
const ApiError = require('../src/utils/ApiError');

const ORIGINAL_TTL = config.fx.cacheTtlMs;
const ORIGINAL_GRACE = config.fx.staleGraceMs;
const ORIGINAL_QUOTE_TTL = config.fx.quoteTtlMs;
const ORIGINAL_ALLOW_STALE = config.fx.allowStaleForTransfers;

beforeEach(() => {
  reset();
  config.fx.cacheTtlMs = 1_000;
  config.fx.staleGraceMs = 5_000;
  config.fx.quoteTtlMs = 2_000;
  config.fx.allowStaleForTransfers = false;
});

afterEach(() => {
  config.fx.cacheTtlMs = ORIGINAL_TTL;
  config.fx.staleGraceMs = ORIGINAL_GRACE;
  config.fx.quoteTtlMs = ORIGINAL_QUOTE_TTL;
  config.fx.allowStaleForTransfers = ORIGINAL_ALLOW_STALE;
  reset();
});

const PAYLOAD = {
  senderName: 'Ada',
  recipientName: 'Bob',
  amount: 100,
  from: 'USD',
  to: 'EUR',
};

// ---------------------------------------------------------------------------
// Cache TTL / freshness
// ---------------------------------------------------------------------------

test('fresh snapshot is served from cache within TTL without re-fetching', () => {
  const t0 = 1_000_000;
  const first = fxCacheService.getSnapshot({ now: t0, policy: 'reject_stale' });
  assert.equal(first.status, 'fresh');
  assert.equal(first.stale, false);
  assert.equal(first.cacheHit, false);
  assert.equal(fxCacheService.getProviderFetchCount(), 1);

  const second = fxCacheService.getSnapshot({ now: t0 + 500, policy: 'reject_stale' });
  assert.equal(second.status, 'fresh');
  assert.equal(second.cacheHit, true);
  assert.equal(second.providerId, first.providerId);
  assert.equal(fxCacheService.getProviderFetchCount(), 1);
});

test('expiry triggers a refresh and the new snapshot is fresh', () => {
  const t0 = 2_000_000;
  fxCacheService.getSnapshot({ now: t0, policy: 'reject_stale' });
  assert.equal(fxCacheService.getProviderFetchCount(), 1);

  const after = fxCacheService.getSnapshot({
    now: t0 + config.fx.cacheTtlMs + 1,
    policy: 'reject_stale',
  });
  assert.equal(after.status, 'fresh');
  assert.equal(after.cacheHit, false);
  assert.equal(fxCacheService.getProviderFetchCount(), 2);
});

// ---------------------------------------------------------------------------
// Provider failure + deterministic fallback
// ---------------------------------------------------------------------------

test('primary failure falls back to the secondary provider deterministically', () => {
  fxProviders.setProviderDown('primary', true);
  const snapshot = fxCacheService.getSnapshot({ now: 3_000_000, policy: 'reject_stale' });
  assert.equal(snapshot.providerId, 'fallback');
  assert.equal(snapshot.status, 'fresh');
  assert.equal(fxCacheService.getProviderFetchCount(), 1);
});

test('all providers down with no cache rejects under reject_stale', () => {
  fxProviders.setProviderDown('primary', true);
  fxProviders.setProviderDown('fallback', true);
  assert.throws(
    () => fxCacheService.getSnapshot({ now: 4_000_000, policy: 'reject_stale' }),
    (err) =>
      err instanceof ApiError &&
      err.statusCode === 503 &&
      err.details &&
      err.details.code === 'FX_PROVIDERS_DOWN'
  );
});

test('all providers down serves visibly-stale cache under allow_stale within grace', () => {
  const t0 = 5_000_000;
  fxCacheService.getSnapshot({ now: t0, policy: 'reject_stale' });
  fxProviders.setProviderDown('primary', true);
  fxProviders.setProviderDown('fallback', true);

  const stale = fxCacheService.getSnapshot({
    now: t0 + config.fx.cacheTtlMs + 1,
    policy: 'allow_stale',
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.source, 'cache-stale-outage');
  assert.ok(stale.ageMs > config.fx.cacheTtlMs);
});

test('fallback order is primary-then-fallback (deterministic)', () => {
  const seen = [];
  fxProviders.setProviders([
    {
      id: 'primary',
      fetch: () => {
        seen.push('primary');
        throw new Error('primary down');
      },
    },
    {
      id: 'fallback',
      fetch: ({ now }) => {
        seen.push('fallback');
        return {
          providerId: 'fallback',
          ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 1.08 },
          fetchedAt: now,
        };
      },
    },
  ]);

  const snapshot = fxCacheService.getSnapshot({ now: 6_000_000 });
  assert.deepEqual(seen, ['primary', 'fallback']);
  assert.equal(snapshot.providerId, 'fallback');
});

test('new provider snapshots obey the requested TTL and grace boundaries before caching', () => {
  const now = 6_100_000;
  for (const policy of ['reject_stale', 'allow_stale']) {
    for (const ageMs of [999, 1_000, 5_999, 6_000]) {
      fxCacheService.reset();
      fxProviders.setProviders([{
        id: 'primary',
        fetch: () => ({ ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 1.08 }, fetchedAt: now - ageMs }),
      }]);
      const usable = ageMs < 1_000 || (policy === 'allow_stale' && ageMs < 6_000);
      if (!usable) {
        assert.throws(
          () => fxCacheService.getSnapshot({ now, policy }),
          (err) => err instanceof ApiError && err.statusCode === 503 &&
            err.details.code === 'FX_PROVIDERS_DOWN',
          `${policy}, age ${ageMs}`
        );
        assert.equal(fxCacheService.peek(now), null);
        continue;
      }
      const snapshot = fxCacheService.getSnapshot({ now, policy });
      assert.equal(snapshot.status, ageMs < 1_000 ? 'fresh' : 'stale');
      assert.equal(snapshot.stale, ageMs >= 1_000);
      assert.equal(snapshot.fetchedAt, now - ageMs);
      assert.equal(snapshot.ageMs, ageMs);
      assert.equal(snapshot.cacheHit, false);
      assert.equal(fxCacheService.peek(now).fetchedAt, now - ageMs);
    }
  }
});

test('invalid provider timestamps cannot win over a usable fallback', () => {
  const now = 6_200_000;
  for (const fetchedAt of [NaN, Infinity, -Infinity, String(now)]) {
    fxCacheService.reset();
    const attempted = [];
    fxProviders.setProviders([
      {
        id: 'primary',
        fetch: () => {
          attempted.push('primary');
          return { ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 1.08 }, fetchedAt };
        },
      },
      {
        id: 'fallback',
        fetch: () => {
          attempted.push('fallback');
          return { ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 1.1 }, fetchedAt: now };
        },
      },
    ]);
    const snapshot = fxCacheService.getSnapshot({ now, policy: 'allow_stale' });
    assert.deepEqual(attempted, ['primary', 'fallback']);
    assert.equal(snapshot.providerId, 'fallback');
    assert.equal(snapshot.status, 'fresh');
    assert.equal(snapshot.ratesToUsd.EUR, 1.1);
  }
});

test('malformed provider rates fall back before either policy can cache them', () => {
  const now = 6_250_000;
  const invalidMaps = [
    null,
    {},
    Object.assign([], { ...RATES_TO_USD, USD: 1, EUR: 1.08 }),
    ...[0, -0, -1, NaN, Infinity, -Infinity, '1.08', null, undefined, true]
      .map((EUR) => ({ ...RATES_TO_USD, USD: 1, EUR })),
    { ...RATES_TO_USD, USD: 1, EUR: 1.08, GBP: 0 },
  ];
  for (const policy of ['reject_stale', 'allow_stale']) {
    for (const ratesToUsd of invalidMaps) {
      fxCacheService.reset();
      const attempted = [];
      const healthyRates = { ...RATES_TO_USD, USD: 1, EUR: 1.1 };
      fxProviders.setProviders([
        { id: 'primary', fetch: () => {
          attempted.push('primary');
          return { ratesToUsd, fetchedAt: now };
        } },
        { id: 'fallback', fetch: () => {
          attempted.push('fallback');
          return { ratesToUsd: healthyRates, fetchedAt: now };
        } },
        { id: 'unused', fetch: () => {
          attempted.push('unused');
          throw new Error('unreachable provider');
        } },
      ]);
      const snapshot = fxCacheService.getSnapshot({ now, policy });
      assert.deepEqual(attempted, ['primary', 'fallback']);
      assert.equal(snapshot.providerId, 'fallback');
      assert.equal(snapshot.stale, false);
      assert.deepEqual(snapshot.ratesToUsd, healthyRates);
      assert.notEqual(snapshot.ratesToUsd, healthyRates);
      assert.equal(fxCacheService.peek(now).providerId, 'fallback');
      assert.deepEqual(fxCacheService.peek(now).ratesToUsd, healthyRates);
      assert.equal(fxCacheService.getProviderFetchCount(), 1);
    }
  }
});

test('fallback order skips responses outside policy and stops at the first usable snapshot', () => {
  const now = 6_300_000;
  for (const policy of ['reject_stale', 'allow_stale']) {
    fxCacheService.reset();
    const attempted = [];
    fxProviders.setProviders([
      { id: 'expired', ageMs: 6_000 },
      { id: 'stale', ageMs: 1_000 },
      { id: 'fresh', ageMs: 0 },
      { id: 'unused', ageMs: 0 },
    ].map(({ id, ageMs }) => ({
      id,
      fetch: () => {
        attempted.push(id);
        return { ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 1.08 }, fetchedAt: now - ageMs };
      },
    })));
    const snapshot = fxCacheService.getSnapshot({ now, policy });
    const allowsStale = policy === 'allow_stale';
    assert.deepEqual(attempted, allowsStale ? ['expired', 'stale'] : ['expired', 'stale', 'fresh']);
    assert.equal(snapshot.providerId, allowsStale ? 'stale' : 'fresh');
    assert.equal(snapshot.stale, allowsStale);
    assert.equal(fxCacheService.getProviderFetchCount(), 1);
  }
});

test('unusable provider responses preserve a cached display snapshot only within its grace', () => {
  const now = 6_400_000;
  const fetchedAt = now - 1_500;
  fxCacheService.seed({ fetchedAt, providerId: 'cached' });
  fxProviders.setProviders([{
    id: 'expired',
    fetch: () => ({ ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 1.08 }, fetchedAt: now - 6_000 }),
  }]);
  assert.throws(
    () => fxCacheService.getSnapshot({ now, policy: 'reject_stale' }),
    (err) => err instanceof ApiError && err.details.code === 'FX_PROVIDERS_DOWN'
  );
  const displayed = fxCacheService.getSnapshot({ now, policy: 'allow_stale' });
  assert.equal(displayed.providerId, 'cached');
  assert.equal(displayed.fetchedAt, fetchedAt);
  assert.equal(displayed.stale, true);
  assert.equal(displayed.source, 'cache-stale-outage');
  assert.throws(
    () => fxCacheService.getSnapshot({ now: fetchedAt + 6_000, policy: 'allow_stale' }),
    (err) => err instanceof ApiError && err.details.code === 'FX_PROVIDERS_DOWN'
  );
  assert.equal(fxCacheService.peek(now).fetchedAt, fetchedAt);
});

test('malformed provider rates preserve a cached display snapshot only within grace', () => {
  const now = 6_450_000;
  const fetchedAt = now - 1_500;
  const ratesToUsd = { ...RATES_TO_USD, USD: 1, EUR: 1.08 };
  fxCacheService.seed({ fetchedAt, providerId: 'cached', ratesToUsd });
  fxProviders.setProviders([
    { id: 'primary', fetch: () => ({ ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 0 }, fetchedAt: now }) },
    { id: 'fallback', fetch: () => ({ ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: -1.1 }, fetchedAt: now }) },
  ]);
  assert.throws(
    () => fxCacheService.getSnapshot({ now, policy: 'reject_stale' }),
    (err) => err instanceof ApiError && err.statusCode === 503 &&
      err.details.code === 'FX_PROVIDERS_DOWN' &&
      err.details.attempted.map((entry) => entry.providerId).join(',') === 'primary,fallback'
  );
  const displayed = fxCacheService.getSnapshot({ now, policy: 'allow_stale' });
  assert.equal(displayed.providerId, 'cached');
  assert.equal(displayed.fetchedAt, fetchedAt);
  assert.deepEqual(displayed.ratesToUsd, ratesToUsd);
  assert.equal(displayed.stale, true);
  assert.equal(displayed.source, 'cache-stale-outage');
  assert.throws(
    () => fxCacheService.getSnapshot({ now: fetchedAt + 6_000, policy: 'allow_stale' }),
    (err) => err instanceof ApiError && err.details.code === 'FX_PROVIDERS_DOWN'
  );
  assert.equal(fxCacheService.peek(now).providerId, 'cached');
  assert.equal(fxCacheService.peek(now).fetchedAt, fetchedAt);
  assert.deepEqual(fxCacheService.peek(now).ratesToUsd, ratesToUsd);
});

test('HTTP invalid FX responses create no records and allow the same transfer key after recovery', async () => {
  const createApp = require('../src/app');
  const originalTokens = config.apiTokens;
  config.apiTokens = { 'fx-invalid-rates-regression': ['transfers:write'] };
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${base}/api/transfers`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fx-invalid-rates-regression',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'fx-invalid-rates-retry',
    },
    body: JSON.stringify(PAYLOAD),
  });
  try {
    const attempted = [];
    fxProviders.setProviders([
      { id: 'primary', fetch: ({ now }) => {
        attempted.push('primary');
        return { ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 0 }, fetchedAt: now };
      } },
      { id: 'fallback', fetch: ({ now }) => {
        attempted.push('fallback');
        return { ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: -1.1 }, fetchedAt: now };
      } },
    ]);
    for (const request of [() => fetch(`${base}/api/quote?amount=100&from=USD&to=EUR`), post]) {
      const rejected = await request();
      const failure = await rejected.json();
      assert.equal(rejected.status, 503);
      assert.equal(failure.error.details.code, 'FX_PROVIDERS_DOWN');
      assert.deepEqual(failure.error.details.attempted.map((entry) => entry.providerId), ['primary', 'fallback']);
      assert.equal(store.transfers.size, 0);
      assert.equal(store.quotes.size, 0);
      assert.equal(store.idempotency.size, 0);
      assert.equal(fxCacheService.peek(), null);
    }
    assert.deepEqual(attempted, ['primary', 'fallback', 'primary', 'fallback']);

    fxProviders.resetProviders();
    const recovered = await post();
    const transfer = await recovered.json();
    assert.equal(recovered.status, 201);
    assert.equal(transfer.rateStale, false);
    assert.equal(transfer.rateProvider, 'primary');
    assert.equal(transfer.rate, RATES_TO_USD.USD / RATES_TO_USD.EUR);
    assert.equal(transfer.receiveAmount, 90.93);
    assert.equal(store.transfers.size, 1);
    assert.equal(store.quotes.size, 1);
    assert.equal(store.idempotency.size, 1);
  } finally {
    config.apiTokens = originalTokens;
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('HTTP transfer rejects newly fetched stale rates without reserving a quote or retry key', async () => {
  const createApp = require('../src/app');
  const originalTokens = config.apiTokens;
  config.apiTokens = { 'fx-http-regression': ['transfers:write'] };
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/transfers`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fx-http-regression',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'fx-policy-retry',
    },
    body: JSON.stringify(PAYLOAD),
  });
  try {
    for (const ageMs of [1_000, 6_000]) {
      reset();
      fxProviders.setProviders([{
        id: 'primary',
        fetch: ({ now }) => ({ ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 1.08 }, fetchedAt: now - ageMs }),
      }]);
      const rejected = await post();
      const failure = await rejected.json();
      assert.equal(rejected.status, 503);
      assert.equal(failure.error.details.code, 'FX_PROVIDERS_DOWN');
      assert.equal(store.transfers.size, 0);
      assert.equal(store.quotes.size, 0);
      assert.equal(store.idempotency.size, 0);
      assert.equal(fxCacheService.peek(), null);

      fxProviders.resetProviders();
      const recovered = await post();
      const transfer = await recovered.json();
      assert.equal(recovered.status, 201);
      assert.equal(transfer.rateStale, false);
      assert.equal(transfer.rateProvider, 'primary');
      assert.equal(store.transfers.size, 1);
      assert.equal(store.quotes.size, 1);
      assert.equal(store.idempotency.size, 1);
    }
  } finally {
    config.apiTokens = originalTokens;
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// ---------------------------------------------------------------------------
// Stampede prevention
// ---------------------------------------------------------------------------

test('stampede: re-entrant refresh does not start a second provider fetch', () => {
  let reentrantError = null;
  let innerCalls = 0;

  fxProviders.setProviders([
    {
      id: 'primary',
      fetch: ({ now }) => {
        // Re-enter while this fetch is in flight — the original failure mode
        // where every concurrent miss stampeded the provider.
        try {
          fxCacheService.getSnapshot({ now, policy: 'reject_stale' });
        } catch (err) {
          reentrantError = err;
        }
        innerCalls += 1;
        return {
          providerId: 'primary',
          ratesToUsd: { ...RATES_TO_USD, USD: 1, EUR: 1.08, GBP: 1.27, INR: 0.012 },
          fetchedAt: now,
        };
      },
    },
  ]);

  const snapshot = fxCacheService.getSnapshot({ now: 7_000_000, policy: 'reject_stale' });
  assert.equal(snapshot.providerId, 'primary');
  // Outer refresh counted once; the re-entrant caller must not have started
  // another provider invocation (innerCalls stays 1 for the outer fetch body).
  assert.equal(fxCacheService.getProviderFetchCount(), 1);
  assert.equal(innerCalls, 1);
  assert.ok(reentrantError instanceof ApiError);
  assert.equal(reentrantError.details.code, 'FX_REFRESH_IN_PROGRESS');
});

test('stampede under allow_stale returns within-grace cache instead of a second fetch', () => {
  const t0 = 8_000_000;
  fxCacheService.seed({
    fetchedAt: t0,
    expiresAt: t0 + config.fx.cacheTtlMs,
    providerId: 'primary',
  });

  let providerHits = 0;
  fxProviders.setProviders([
    {
      id: 'primary',
      fetch: ({ now }) => {
        providerHits += 1;
        // Re-enter as a stampede during the refresh that expiry triggered.
        const nested = fxCacheService.getSnapshot({
          now: t0 + config.fx.cacheTtlMs + 1,
          policy: 'allow_stale',
        });
        assert.equal(nested.stale, true);
        assert.equal(nested.source, 'cache-stale-inflight');
        return {
          providerId: 'primary',
          ratesToUsd: nested.ratesToUsd,
          fetchedAt: now,
        };
      },
    },
  ]);

  const refreshed = fxCacheService.getSnapshot({
    now: t0 + config.fx.cacheTtlMs + 1,
    policy: 'allow_stale',
  });
  assert.equal(refreshed.status, 'fresh');
  assert.equal(providerHits, 1);
  assert.equal(fxCacheService.getProviderFetchCount(), 1);
});

// ---------------------------------------------------------------------------
// Quote versioning, visibility, and transfer binding
// ---------------------------------------------------------------------------

test('quotes expose identity and freshness metadata', () => {
  const quote = quoteService.getQuote(100, 'USD', 'EUR');
  assert.equal(typeof quote.quoteId, 'string');
  assert.ok(quote.quoteId.startsWith('quote_'));
  assert.equal(typeof quote.quoteVersion, 'number');
  assert.equal(quote.stale, false);
  assert.equal(quote.freshness.status, 'fresh');
  assert.equal(typeof quote.freshness.providerId, 'string');
  assert.equal(typeof quote.quoteExpiresAt, 'string');
});

test('a fresh quote becomes unusable at FX expiry before its quote TTL', () => {
  const now = 9_000_000;
  const quote = quoteService.getQuote(100, 'USD', 'EUR', { now });
  const data = { ...PAYLOAD, quoteId: quote.quoteId };
  const fresh = quoteService.resolveForTransfer(data, {
    now: now + config.fx.cacheTtlMs - 1,
  });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.freshness.ageMs, config.fx.cacheTtlMs - 1);

  assert.throws(
    () => quoteService.resolveForTransfer(data, { now: now + config.fx.cacheTtlMs }),
    (err) => err instanceof ApiError && err.statusCode === 409 &&
      err.details.code === 'QUOTE_STALE' &&
      err.details.freshness.status === 'stale' &&
      err.details.freshness.ageMs === config.fx.cacheTtlMs
  );
  // Binding must preserve the quote the sender saw, not silently fetch/reprice.
  assert.equal(fxCacheService.getProviderFetchCount(), 1);
});

test('explicit stale transfer policy returns current freshness with unchanged quote terms', () => {
  const now = 9_100_000;
  const quote = quoteService.getQuote(100, 'USD', 'EUR', { now });
  config.fx.allowStaleForTransfers = true;
  const bound = quoteService.resolveForTransfer({ ...PAYLOAD, quoteId: quote.quoteId }, {
    now: now + config.fx.cacheTtlMs,
  });
  assert.equal(bound.stale, true);
  assert.equal(bound.freshness.stale, true);
  assert.equal(bound.freshness.status, 'stale');
  assert.equal(bound.freshness.ageMs, config.fx.cacheTtlMs);
  for (const field of ['quoteId', 'quoteVersion', 'rate', 'receiveAmount', 'quoteExpiresAt']) {
    assert.equal(bound[field], quote[field]);
  }
  assert.equal(quoteService.getQuoteById(quote.quoteId).stale, false);
});

test('stale transfer opt-in cannot extend FX grace or quote TTL boundaries', () => {
  const now = 9_200_000;
  config.fx.quoteTtlMs = 10_000;
  config.fx.allowStaleForTransfers = true;
  const quote = quoteService.getQuote(100, 'USD', 'EUR', { now });
  const data = { ...PAYLOAD, quoteId: quote.quoteId };
  assert.throws(
    () => quoteService.resolveForTransfer(data, {
      now: now + config.fx.cacheTtlMs + config.fx.staleGraceMs,
    }),
    (err) => err instanceof ApiError && err.details.code === 'QUOTE_STALE' &&
      err.details.freshness.status === 'expired'
  );
  assert.throws(
    () => quoteService.resolveForTransfer(data, { now: now + config.fx.quoteTtlMs }),
    (err) => err instanceof ApiError && err.details.code === 'QUOTE_EXPIRED'
  );
});

test('display policy reclassifies an issued quote without changing its stored terms', () => {
  const now = 9_300_000;
  const quote = quoteService.getQuote(100, 'USD', 'EUR', { now });
  const displayed = quoteService.assertUsable(quote, {
    now: now + config.fx.cacheTtlMs,
    policy: 'allow_stale',
  });
  assert.equal(displayed.stale, true);
  assert.equal(displayed.freshness.status, 'stale');
  assert.equal(displayed.rate, quote.rate);
  assert.equal(quote.stale, false);
});

test('stale quote is visible but cannot be used for transfer pricing', () => {
  // Use wall-clock time so transfer creation (which reads Date.now) and the
  // quote TTL share the same clock. Only the FX snapshot is forced stale.
  const now = Date.now();
  fxCacheService.seed({
    fetchedAt: now - config.fx.cacheTtlMs - 1,
    expiresAt: now - 1,
    providerId: 'primary',
  });
  fxProviders.setProviderDown('primary', true);
  fxProviders.setProviderDown('fallback', true);

  const quote = quoteService.getQuote(100, 'USD', 'EUR', {
    now,
    policy: 'allow_stale',
  });
  assert.equal(quote.stale, true);
  assert.equal(quote.freshness.status, 'stale');

  assert.throws(
    () => quoteService.assertUsable(quote, { now, policy: 'reject_stale' }),
    (err) =>
      err instanceof ApiError &&
      err.statusCode === 409 &&
      err.details.code === 'QUOTE_STALE'
  );

  assert.throws(
    () =>
      transferService.createTransfer(
        { ...PAYLOAD, quoteId: quote.quoteId },
        'req-stale'
      ),
    (err) => err instanceof ApiError && err.details.code === 'QUOTE_STALE'
  );
});

test('expired quote cannot be bound to a transfer (regression: stale mistaken for current)', () => {
  const t0 = 10_000_000;
  const quote = quoteService.getQuote(100, 'USD', 'EUR', { now: t0 });
  assert.equal(quote.stale, false);

  assert.throws(
    () =>
      quoteService.assertUsable(quote, {
        now: t0 + config.fx.quoteTtlMs + 1,
        policy: 'reject_stale',
      }),
    (err) =>
      err instanceof ApiError &&
      err.details.code === 'QUOTE_EXPIRED'
  );
});

test('transfer creation binds quote identity (quoteId + quoteVersion)', () => {
  const quote = quoteService.getQuote(100, 'USD', 'EUR');
  const transfer = transferService.createTransfer(
    { ...PAYLOAD, quoteId: quote.quoteId },
    'req-bind'
  );

  assert.equal(transfer.quoteId, quote.quoteId);
  assert.equal(transfer.quoteVersion, quote.quoteVersion);
  assert.equal(transfer.rate, quote.rate);
  assert.equal(transfer.receiveAmount, quote.receiveAmount);
  assert.equal(transfer.rateProvider, quote.freshness.providerId);
  assert.equal(transfer.rateStale, false);
});

test('transfer rejects a quoteId that does not match amount/currencies', () => {
  const quote = quoteService.getQuote(100, 'USD', 'EUR');
  assert.throws(
    () =>
      transferService.createTransfer(
        { ...PAYLOAD, amount: 200, quoteId: quote.quoteId },
        'req-mismatch'
      ),
    (err) =>
      err instanceof ApiError &&
      err.details.code === 'QUOTE_MISMATCH'
  );
});

test('transfer without quoteId still mints and binds a fresh quote (compat)', () => {
  const transfer = transferService.createTransfer(PAYLOAD, 'req-compat');
  assert.equal(typeof transfer.quoteId, 'string');
  assert.equal(typeof transfer.quoteVersion, 'number');
  assert.equal(transfer.rateStale, false);
  const stored = quoteService.getQuoteById(transfer.quoteId);
  assert.equal(stored.sendAmount, transfer.sendAmount);
});

function delayedFxProvider(t, delayMs) {
  const clock = { now: 40_000_000, delayMs };
  t.mock.method(Date, 'now', () => clock.now);
  fxProviders.setProviders([{
    id: 'primary',
    fetch: ({ now }) => {
      clock.now += clock.delayMs;
      return { providerId: 'primary', ratesToUsd: { ...RATES_TO_USD }, fetchedAt: now };
    },
  }]);
  return clock;
}

test('quote refresh uses the completion clock to reach a healthy fallback', (t) => {
  config.fx.quoteTtlMs = 10_000;
  const clock = delayedFxProvider(t, config.fx.cacheTtlMs + config.fx.staleGraceMs);
  const primary = fxProviders.listProviders()[0];
  fxProviders.setProviders([primary, {
    id: 'fallback',
    fetch: ({ now }) => ({ ratesToUsd: { ...RATES_TO_USD }, fetchedAt: now }),
  }]);

  const quote = quoteService.getQuote(PAYLOAD.amount, PAYLOAD.from, PAYLOAD.to);
  assert.equal(quote.freshness.providerId, 'fallback');
  assert.equal(quote.freshness.fetchedAt, new Date(clock.now).toISOString());
  assert.equal(quote.freshness.status, 'fresh');
  assert.equal(quote.freshness.ageMs, 0);
  assert.equal(quote.stale, false);
  assert.equal(fxCacheService.getProviderFetchCount(), 1);
});

test('unquoted transfers use the completion clock to reach a healthy fallback', (t) => {
  const clock = delayedFxProvider(t, config.fx.cacheTtlMs);
  const primary = fxProviders.listProviders()[0];
  fxProviders.setProviders([primary, {
    id: 'fallback',
    fetch: ({ now }) => ({ ratesToUsd: { ...RATES_TO_USD }, fetchedAt: now }),
  }]);

  const transfer = transferService.createTransfer(PAYLOAD, 'req-current-fallback');
  assert.equal(transfer.rateProvider, 'fallback');
  assert.equal(transfer.rateFetchedAt, new Date(clock.now).toISOString());
  assert.equal(transfer.rateStale, false);
  assert.equal(store.transfers.size, 1);
  assert.equal(fxCacheService.getProviderFetchCount(), 1);
});

test('transfer mint completion rejects FX expiry before settlement', (t) => {
  delayedFxProvider(t, config.fx.cacheTtlMs);
  const settlement = t.mock.method(require('../src/services/stellarService'), 'submitPayment');
  assert.throws(
    () => transferService.createTransfer(PAYLOAD, 'req-delayed-fx'),
    (err) => err instanceof ApiError && err.statusCode === 503 &&
      err.details.code === 'FX_PROVIDERS_DOWN'
  );
  assert.equal(settlement.mock.callCount(), 0);
  assert.equal(store.transfers.size, 0);
  assert.equal(store.quotes.size, 0);
});

test('transfer mint completion rejects quote expiry before settlement', (t) => {
  config.fx.cacheTtlMs = 3_000;
  config.fx.quoteTtlMs = 1_000;
  delayedFxProvider(t, config.fx.quoteTtlMs);
  const settlement = t.mock.method(require('../src/services/stellarService'), 'submitPayment');
  assert.throws(
    () => transferService.createTransfer(PAYLOAD, 'req-delayed-quote'),
    (err) => err instanceof ApiError && err.details.code === 'QUOTE_EXPIRED'
  );
  assert.equal(settlement.mock.callCount(), 0);
  assert.equal(store.transfers.size, 0);
});

test('transfer mint completion refreshes age while preserving terms and explicit clocks', (t) => {
  delayedFxProvider(t, 100);
  const bound = quoteService.resolveForTransfer(PAYLOAD);
  const issued = quoteService.getQuoteById(bound.quoteId);
  assert.equal(bound.stale, false);
  assert.equal(bound.freshness.status, 'fresh');
  assert.equal(bound.freshness.ageMs, 100);
  assert.equal(issued.freshness.ageMs, 100);
  for (const field of ['quoteId', 'quoteVersion', 'rate', 'receiveAmount', 'quoteExpiresAt']) {
    assert.equal(bound[field], issued[field]);
  }
  assert.equal(fxCacheService.getProviderFetchCount(), 1);

  reset();
  // The optional clock remains deterministic even when wall time is later.
  const fixed = quoteService.resolveForTransfer(PAYLOAD, { now: 12_000_000 });
  assert.equal(fixed.quoteCreatedAt, new Date(12_000_000).toISOString());
  assert.equal(fixed.freshness.ageMs, 0);
  assert.equal(fixed.stale, false);
});

test('transfer mint completion retains only the configured stale grace opt-in', (t) => {
  config.fx.allowStaleForTransfers = true;
  config.fx.quoteTtlMs = 10_000;
  const clock = delayedFxProvider(t, config.fx.cacheTtlMs);
  const transfer = transferService.createTransfer(PAYLOAD, 'req-delayed-allowed');
  assert.equal(transfer.rateStale, true);
  assert.equal(transfer.rate, RATES_TO_USD.USD / RATES_TO_USD.EUR);
  assert.equal(transfer.receiveAmount, 90.93);

  clock.delayMs = config.fx.cacheTtlMs + config.fx.staleGraceMs;
  const settlement = t.mock.method(require('../src/services/stellarService'), 'submitPayment');
  assert.throws(
    () => transferService.createTransfer(PAYLOAD, 'req-delayed-expired'),
    (err) => err instanceof ApiError && err.statusCode === 503 &&
      err.details.code === 'FX_PROVIDERS_DOWN'
  );
  assert.equal(settlement.mock.callCount(), 0);
  assert.equal(store.transfers.size, 1);
  assert.equal(fxCacheService.peek(clock.now).status, 'expired');
});

test('provider outage blocks transfer pricing rather than using silent stale rates', () => {
  // Regression for the original failure mode: outage must not price transfers
  // on an expired rate that looks "current" because freshness was invisible.
  const t0 = 11_000_000;
  fxCacheService.seed({
    fetchedAt: t0 - config.fx.cacheTtlMs - 1,
    expiresAt: t0 - 1,
    providerId: 'primary',
  });
  fxProviders.setProviderDown('primary', true);
  fxProviders.setProviderDown('fallback', true);

  assert.throws(
    () => transferService.createTransfer(PAYLOAD, 'req-outage'),
    (err) =>
      err instanceof ApiError &&
      (err.details.code === 'FX_PROVIDERS_DOWN' ||
        err.details.code === 'QUOTE_STALE' ||
        err.statusCode === 503)
  );
});

test('rate list surfaces freshness so stale data cannot be mistaken for current', () => {
  const listed = rateService.listRates({ now: 12_000_000 });
  assert.ok(Array.isArray(listed.rates));
  assert.ok(listed.rates.length > 0);
  assert.equal(listed.freshness.stale, false);
  assert.equal(listed.freshness.status, 'fresh');
  assert.equal(typeof listed.freshness.fetchedAt, 'string');
});
