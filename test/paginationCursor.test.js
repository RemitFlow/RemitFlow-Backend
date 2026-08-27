'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// A fixed signing key keeps encoded cursors reproducible within the file and
// documents the production requirement to pin one across instances.
process.env.PAGINATION_CURSOR_SECRET = 'unit-test-cursor-secret';

const { OrderedIndex } = require('../src/utils/orderedIndex');
const {
  actorFingerprint,
  decodeCursor,
  encodeCursor,
  fingerprint,
  MAX_CURSOR_LENGTH,
} = require('../src/utils/cursor');
const { parseHistoryPagination, parsePagination } = require('../src/utils/pagination');

// ─── OrderedIndex ─────────────────────────────────────────────────────────────

/** Build an index of `count` items, all sharing one timestamp by default. */
function buildIndex(count, { at = '2024-01-01T00:00:00.000Z', groupOf = null } = {}) {
  const index = new OrderedIndex({
    sortKeyOf: (item) => item.at,
    groupKeyOf: groupOf ? (item) => groupOf(item) : null,
  });
  for (let i = 0; i < count; i += 1) {
    index.append({ n: i, at: typeof at === 'function' ? at(i) : at });
  }
  return index;
}

/** Walk every page of an index, returning the items and the page sizes. */
function drain(index, { order, limit, group = null, match = null, maxScan = 1e9 }) {
  const items = [];
  const pages = [];
  let afterSeq = null;
  let guard = 0;

  for (;;) {
    const page = index.scan({ afterSeq, order, limit, group, match, maxScan });
    items.push(...page.items);
    pages.push(page.items.length);
    if (!page.hasMore) break;
    assert.ok(page.last, 'a page reporting hasMore must expose a resume position');
    afterSeq = page.last.seq;
    guard += 1;
    assert.ok(guard < 10000, 'pagination did not terminate');
  }

  return { items, pages };
}

test('OrderedIndex assigns dense, strictly increasing sequence numbers', () => {
  const index = buildIndex(5);
  assert.deepEqual(index.records.map((r) => r.seq), [0, 1, 2, 3, 4]);
  assert.equal(index.size, 5);
});

test('OrderedIndex orders records that share a timestamp deterministically', () => {
  // Every record has the same millisecond, so the timestamp alone cannot order
  // them. The sequence tie-breaker still yields insertion order both ways.
  const index = buildIndex(20);

  const ascending = drain(index, { order: 'asc', limit: 3 });
  const descending = drain(index, { order: 'desc', limit: 3 });

  assert.deepEqual(ascending.items.map((i) => i.n), [...Array(20).keys()]);
  assert.deepEqual(descending.items.map((i) => i.n), [...Array(20).keys()].reverse());
});

test('OrderedIndex pages are exclusive of the cursor record in both directions', () => {
  const index = buildIndex(10);

  for (const order of ['asc', 'desc']) {
    const first = index.scan({ order, limit: 4, maxScan: 1e9 });
    const second = index.scan({ afterSeq: first.last.seq, order, limit: 4, maxScan: 1e9 });

    const firstSeqs = first.items.map((i) => i.n);
    const secondSeqs = second.items.map((i) => i.n);
    const overlap = firstSeqs.filter((n) => secondSeqs.includes(n));

    assert.deepEqual(overlap, [], `pages overlapped for order=${order}`);
  }
});

test('OrderedIndex reports hasMore only while records remain', () => {
  const index = buildIndex(9);
  const { pages } = drain(index, { order: 'asc', limit: 4 });
  assert.deepEqual(pages, [4, 4, 1]);

  const exact = drain(buildIndex(8), { order: 'asc', limit: 4 });
  assert.deepEqual(exact.pages, [4, 4], 'an exactly-filled last page must not yield an empty page');
});

test('OrderedIndex applies a residual filter without losing or repeating records', () => {
  const index = buildIndex(50);
  const match = (item) => item.n % 7 === 0;

  const { items } = drain(index, { order: 'asc', limit: 2, match });

  assert.deepEqual(items.map((i) => i.n), [0, 7, 14, 21, 28, 35, 42, 49]);
});

test('OrderedIndex pages a secondary-index group without scanning other groups', () => {
  const index = buildIndex(300, { groupOf: (item) => `g${item.n % 3}` });

  const page = index.scan({ group: 'g1', order: 'asc', limit: 5, maxScan: 1e9 });

  assert.deepEqual(page.items.map((i) => i.n), [1, 4, 7, 10, 13]);
  // 5 returned plus 1 lookahead: the 200 records in the other groups are never touched.
  assert.equal(page.scanned, 6);
});

test('OrderedIndex group paging is exclusive and complete', () => {
  const index = buildIndex(300, { groupOf: (item) => `g${item.n % 3}` });

  const { items } = drain(index, { order: 'desc', limit: 7, group: 'g2' });
  const expected = [...Array(300).keys()].filter((n) => n % 3 === 2).reverse();

  assert.deepEqual(items.map((i) => i.n), expected);
  assert.equal(new Set(items.map((i) => i.n)).size, items.length, 'no duplicates');
});

test('OrderedIndex caps work at maxScan and stays resumable', () => {
  const index = buildIndex(1000);
  // Matches only the very last record, so an uncapped scan would walk all 1000.
  const match = (item) => item.n === 999;

  const page = index.scan({ order: 'asc', limit: 10, match, maxScan: 100 });

  assert.deepEqual(page.items, []);
  assert.equal(page.scanned, 100);
  assert.equal(page.scanTruncated, true);
  assert.equal(page.hasMore, true, 'a truncated scan must not claim the collection is exhausted');

  // Resuming from the truncated frontier eventually reaches the record.
  const { items } = drain(index, { order: 'asc', limit: 10, match, maxScan: 100 });
  assert.deepEqual(items.map((i) => i.n), [999]);
});

test('OrderedIndex maxScan does not flag truncation when the page is full', () => {
  const index = buildIndex(1000);
  const page = index.scan({ order: 'asc', limit: 10, maxScan: 10 });

  assert.equal(page.items.length, 10);
  assert.equal(page.hasMore, true);
  assert.equal(page.scanTruncated, false);
});

test('OrderedIndex recordAt resolves positions in the index and in a group', () => {
  const index = buildIndex(30, {
    at: (i) => `2024-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
    groupOf: (item) => `g${item.n % 2}`,
  });

  assert.equal(index.recordAt(7).item.n, 7);
  assert.equal(index.recordAt(7, 'g1').item.n, 7);
  assert.equal(index.recordAt(7, 'g0'), null, 'seq 7 is not in group g0');
  assert.equal(index.recordAt(999), null);
});

test('OrderedIndex reset clears records, groups and the sequence counter', () => {
  const index = buildIndex(5, { groupOf: () => 'g' });
  index.reset();

  assert.equal(index.size, 0);
  assert.equal(index.nextSeq, 0);
  assert.deepEqual(index.recordsFor('g'), []);
});

test('OrderedIndex scanning an empty index yields an empty terminal page', () => {
  const page = buildIndex(0).scan({ order: 'desc', limit: 10, maxScan: 100 });
  assert.deepEqual(page.items, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.last, null);
});

// ─── Cursor codec ─────────────────────────────────────────────────────────────

const BOUND = { order: 'desc', filter: 'filter-a', actor: 'actor-a' };

function mint(overrides = {}) {
  return encodeCursor({ key: '2024-01-01T00:00:00.000Z', seq: 42, ...BOUND, ...overrides });
}

test('encodeCursor round-trips through decodeCursor', () => {
  const decoded = decodeCursor(mint(), BOUND);
  assert.deepEqual(decoded, { order: 'desc', key: '2024-01-01T00:00:00.000Z', seq: 42 });
});

test('cursors are opaque and URL-safe', () => {
  const cursor = mint();
  assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(encodeURIComponent(cursor), cursor);
});

test('decodeCursor rejects a cursor whose payload was edited', () => {
  const cursor = mint();
  const [payload, signature] = cursor.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  decoded.s = 0;
  const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

  assert.throws(() => decodeCursor(forged, BOUND), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.details.code, 'INVALID_CURSOR');
    return true;
  });
});

test('decodeCursor rejects a cursor with a re-signed payload from an unknown key', () => {
  const crypto = require('crypto');
  const payload = Buffer.from(
    JSON.stringify({ v: 1, o: 'desc', k: 'x', s: 0, f: 'filter-a', a: 'actor-a' })
  ).toString('base64url');
  const forged = `${payload}.${crypto.createHmac('sha256', 'wrong-key').update(payload).digest('base64url')}`;

  assert.throws(() => decodeCursor(forged, BOUND), /malformed/);
});

test('decodeCursor rejects structurally invalid input', () => {
  for (const bad of [null, undefined, '', 'nodot', '.sig', 'payload.', 'x'.repeat(MAX_CURSOR_LENGTH + 1)]) {
    assert.throws(() => decodeCursor(bad, BOUND), /malformed/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('decodeCursor rejects a cursor issued to a different actor with 403', () => {
  assert.throws(
    () => decodeCursor(mint(), { ...BOUND, actor: 'actor-b' }),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.details.code, 'CURSOR_ACTOR_MISMATCH');
      return true;
    }
  );
});

test('decodeCursor checks the actor before the filter', () => {
  // A caller must not be able to learn anything about another actor's cursor by
  // varying filters until the error message changes.
  assert.throws(
    () => decodeCursor(mint(), { order: 'asc', filter: 'filter-z', actor: 'actor-b' }),
    (err) => {
      assert.equal(err.details.code, 'CURSOR_ACTOR_MISMATCH');
      return true;
    }
  );
});

test('decodeCursor rejects a cursor issued for a different filter set', () => {
  assert.throws(() => decodeCursor(mint(), { ...BOUND, filter: 'filter-b' }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.details.code, 'CURSOR_FILTER_MISMATCH');
    return true;
  });
});

test('decodeCursor rejects a cursor issued for a different sort order', () => {
  assert.throws(() => decodeCursor(mint(), { ...BOUND, order: 'asc' }), (err) => {
    assert.equal(err.details.code, 'CURSOR_ORDER_MISMATCH');
    return true;
  });
});

test('decodeCursor rejects a cursor from an incompatible format version', () => {
  const crypto = require('crypto');
  const payload = Buffer.from(
    JSON.stringify({ v: 99, o: 'desc', k: 'x', s: 0, f: 'filter-a', a: 'actor-a' })
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', process.env.PAGINATION_CURSOR_SECRET)
    .update(payload)
    .digest('base64url');

  assert.throws(() => decodeCursor(`${payload}.${signature}`, BOUND), /incompatible API version/);
});

test('fingerprint is stable across key ordering and distinguishes different filters', () => {
  assert.equal(
    fingerprint({ status: 'pending', archived: false }),
    fingerprint({ archived: false, status: 'pending' })
  );
  assert.notEqual(
    fingerprint({ status: 'pending', archived: false }),
    fingerprint({ status: 'pending', archived: true })
  );
  assert.notEqual(fingerprint(['transfers', {}]), fingerprint(['audit', {}]));
});

test('actorFingerprint derives from the token and never contains it', () => {
  const print = actorFingerprint({ token: 'test-token-admin' });
  assert.notEqual(print, actorFingerprint({ token: 'test-token-readonly' }));
  assert.equal(print, actorFingerprint({ token: 'test-token-admin' }));
  assert.notEqual(print, actorFingerprint({}), 'a token must not fingerprint as anonymous');
  assert.ok(!print.includes('test-token'));
});

test('actorFingerprint is keyed, not a plain hash of the token', () => {
  // A leaked cursor must not let an attacker confirm a guessed token offline.
  const crypto = require('crypto');
  const plainHash = crypto.createHash('sha256').update('token:test-token-admin').digest('hex');
  assert.notEqual(actorFingerprint({ token: 'test-token-admin' }), plainHash.slice(0, 16));
});

test('getEntriesForResource does not treat a missing id as "all resources"', () => {
  const auditService = require('../src/services/auditService');
  auditService.reset();
  auditService.addEntry({ action: 'transfer.created', resourceId: 'txn-1' });

  assert.deepEqual(auditService.getEntriesForResource(undefined), []);
  assert.deepEqual(auditService.getEntriesForResource(null), []);
  assert.deepEqual(auditService.getEntriesForResource(''), []);
  assert.equal(auditService.getEntriesForResource('txn-1').length, 1);
});

// ─── Query parameter parsing ──────────────────────────────────────────────────

test('parseHistoryPagination applies defaults', () => {
  assert.deepEqual(parseHistoryPagination({}, { defaultOrder: 'asc' }), {
    mode: 'offset',
    limit: 50,
    order: 'asc',
    cursor: null,
    offset: 0,
  });
});

test('parseHistoryPagination rejects an oversized limit rather than clamping it', () => {
  assert.throws(() => parseHistoryPagination({ limit: '5000' }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.details.code, 'LIMIT_TOO_LARGE');
    assert.equal(err.details.maxLimit, 200);
    return true;
  });
});

test('parseHistoryPagination rejects limits that are not positive integers', () => {
  for (const limit of ['0', '-1', 'abc', '1.5', '1e3', '  ']) {
    assert.throws(() => parseHistoryPagination({ limit }), /limit/, `accepted limit=${limit}`);
  }
});

test('parseHistoryPagination rejects negative and non-integer offsets', () => {
  for (const offset of ['-1', 'abc', '2.5']) {
    assert.throws(() => parseHistoryPagination({ offset }), /offset/, `accepted offset=${offset}`);
  }
  assert.equal(parseHistoryPagination({ offset: '10' }).offset, 10);
});

test('parseHistoryPagination rejects an unknown order', () => {
  assert.throws(() => parseHistoryPagination({ order: 'sideways' }), (err) => {
    assert.equal(err.details.code, 'INVALID_ORDER');
    return true;
  });
});

test('parseHistoryPagination rejects cursor and offset used together', () => {
  assert.throws(() => parseHistoryPagination({ cursor: 'abc', offset: '10' }), (err) => {
    assert.equal(err.details.code, 'CONFLICTING_PAGINATION');
    return true;
  });
  // offset=0 is the default and does not conflict.
  assert.equal(parseHistoryPagination({ cursor: 'abc', offset: '0' }).mode, 'cursor');
});

test('parsePagination remains lenient for the collections still using it', () => {
  assert.deepEqual(parsePagination({ limit: '5000', offset: '-3' }), { limit: 200, offset: 0 });
  assert.deepEqual(parsePagination({}), { limit: 50, offset: 0 });
});
