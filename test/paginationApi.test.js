'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Must be set before any module reads config at require-time.
process.env.NODE_ENV = 'test';
process.env.PAGINATION_CURSOR_SECRET = 'api-test-cursor-secret';
// The suite walks many pages; the default 100 req/min limiter would trip.
process.env.RATE_LIMIT_MAX = '100000';

const createApp = require('../src/app');
const { reset: resetStore } = require('../src/store');
const transferService = require('../src/services/transferService');
const auditService = require('../src/services/auditService');

const ADMIN = 'test-token-admin';
const READONLY = 'test-token-readonly';

let server;
let baseUrl;

before(() => {
  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
});

beforeEach(() => {
  resetStore();
});

/**
 * GET a JSON endpoint with a bearer token.
 * @param {string} path
 * @param {string} [token]
 */
async function get(path, token = ADMIN) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Create `count` transfers named T0..T(count-1) in order.
 * Console output is suppressed because each creation emits a mock-Stellar debug line.
 * @param {number} count
 * @returns {object[]}
 */
function seedTransfers(count) {
  const original = console.log;
  console.log = () => {};
  try {
    const created = [];
    for (let i = 0; i < count; i += 1) {
      created.push(transferService.createTransfer({
        senderName: `T${i}`,
        recipientName: `R${i}`,
        amount: 10,
        from: 'USD',
        to: 'EUR',
      }));
    }
    return created;
  } finally {
    console.log = original;
  }
}

/** Sender names of the transfers in a response body. */
const names = (body) => body.transfers.map((t) => t.senderName);

/**
 * Walk every page of a collection with cursor pagination.
 * @param {string} path - endpoint plus filters, without cursor.
 * @param {object} [options]
 * @returns {Promise<{ items: object[], pages: number, requests: number }>}
 */
async function drainCursor(path, { token = ADMIN, key = 'transfers', onPage = null } = {}) {
  const items = [];
  let cursor = null;
  let pages = 0;

  for (;;) {
    const url = cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path;
    const { status, body } = await get(url, token);
    assert.equal(status, 200, `page ${pages} failed: ${JSON.stringify(body)}`);

    items.push(...body[key]);
    pages += 1;
    assert.ok(pages < 500, 'pagination did not terminate');

    if (onPage) await onPage(pages, body);
    if (!body.pageInfo.hasMore) {
      assert.equal(body.pageInfo.nextCursor, null);
      return { items, pages, last: body };
    }
    cursor = body.pageInfo.nextCursor;
    assert.ok(cursor, 'hasMore was true but no nextCursor was issued');
  }
}

// ─── Pagination contract ──────────────────────────────────────────────────────

test('cursor traversal returns every transfer exactly once, in order', async () => {
  seedTransfers(25);

  const { items, pages } = await drainCursor('/api/transfers?limit=4');

  assert.deepEqual(items.map((t) => t.senderName), [...Array(25).keys()].map((i) => `T${i}`));
  assert.equal(new Set(items.map((t) => t.id)).size, 25, 'no duplicates');
  assert.equal(pages, 7);
});

test('descending traversal is the exact reverse of ascending', async () => {
  seedTransfers(17);

  const ascending = await drainCursor('/api/transfers?limit=5&order=asc');
  const descending = await drainCursor('/api/transfers?limit=5&order=desc');

  assert.deepEqual(
    descending.items.map((t) => t.id),
    ascending.items.map((t) => t.id).reverse()
  );
});

test('a page smaller than the limit terminates the traversal', async () => {
  seedTransfers(3);
  const { status, body } = await get('/api/transfers?limit=10');

  assert.equal(status, 200);
  assert.equal(body.count, 3);
  assert.equal(body.limit, 10);
  assert.equal(body.order, 'asc');
  assert.equal(body.pageInfo.hasMore, false);
  assert.equal(body.pageInfo.nextCursor, null);
  assert.ok(body.pageInfo.endCursor, 'a terminal page still exposes a resume position');
});

test('an exactly-filled final page does not produce a trailing empty page', async () => {
  seedTransfers(8);
  const { pages, items } = await drainCursor('/api/transfers?limit=4');

  assert.equal(pages, 2);
  assert.equal(items.length, 8);
});

test('cursor pagination over an empty collection is well formed', async () => {
  const { status, body } = await get('/api/transfers?limit=5');

  assert.equal(status, 200);
  assert.deepEqual(body.transfers, []);
  assert.equal(body.count, 0);
  assert.equal(body.pageInfo.hasMore, false);
  assert.equal(body.pageInfo.nextCursor, null);
});

test('audit cursor traversal returns every entry exactly once, newest first', async () => {
  seedTransfers(12); // one transfer.created entry each

  const { items } = await drainCursor('/api/audit?limit=5', { key: 'entries' });

  assert.equal(items.length, 12);
  assert.equal(new Set(items.map((e) => e.id)).size, 12);
  assert.deepEqual(
    items.map((e) => e.resourceId),
    auditService.getEntries().map((e) => e.resourceId)
  );
});

// ─── Regression: the failure mode offset pagination has ───────────────────────

test('REGRESSION: offset paging duplicates a row when a transfer is inserted mid-walk', async () => {
  // This is the original defect, asserted directly so the fix cannot silently
  // regress into the offset behaviour.
  const seeded = seedTransfers(6);

  const first = await get('/api/transfers?order=desc&limit=3&offset=0');
  assert.deepEqual(names(first.body), ['T5', 'T4', 'T3']);

  seedTransfers(1); // a transfer arrives while the client is paging

  const second = await get('/api/transfers?order=desc&limit=3&offset=3');

  const overlap = names(second.body).filter((n) => names(first.body).includes(n));
  assert.deepEqual(overlap, ['T3'], 'offset paging is expected to repeat the boundary row');
  assert.equal(seeded.length, 6);
});

test('cursor paging shows no duplicate when a transfer is inserted mid-walk', async () => {
  seedTransfers(6);

  const first = await get('/api/transfers?order=desc&limit=3');
  assert.deepEqual(names(first.body), ['T5', 'T4', 'T3']);

  seedTransfers(1);

  const second = await get(
    `/api/transfers?order=desc&limit=3&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.deepEqual(names(second.body), ['T2', 'T1', 'T0']);
  assert.equal(second.body.pageInfo.hasMore, false);
});

test('REGRESSION: offset paging skips a row when one leaves the filtered set mid-walk', async () => {
  const seeded = seedTransfers(6);

  const first = await get('/api/transfers?limit=3&offset=0');
  assert.deepEqual(names(first.body), ['T0', 'T1', 'T2']);

  // Archiving removes T1 from the default result set, shifting the window left.
  transferService.archiveTransfer(seeded[1].id);

  const second = await get('/api/transfers?limit=3&offset=3');

  assert.ok(!names(second.body).includes('T3'), 'offset paging is expected to skip T3');
  assert.deepEqual(names(second.body), ['T4', 'T5']);
});

test('cursor paging skips nothing when a transfer leaves the filtered set mid-walk', async () => {
  const seeded = seedTransfers(6);

  const first = await get('/api/transfers?limit=3');
  assert.deepEqual(names(first.body), ['T0', 'T1', 'T2']);

  transferService.archiveTransfer(seeded[1].id);

  const second = await get(
    `/api/transfers?limit=3&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.deepEqual(names(second.body), ['T3', 'T4', 'T5']);
});

// ─── Concurrent inserts ───────────────────────────────────────────────────────

test('a full cursor walk with a write before every page has no duplicates or gaps', async () => {
  const snapshot = seedTransfers(30).map((t) => t.id);

  const { items } = await drainCursor('/api/transfers?limit=4', {
    onPage: async () => { seedTransfers(1); },
  });

  const ids = items.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'walk returned a duplicate');
  // Ascending order: every transfer present when the walk began must appear,
  // and the transfers created during the walk may appear at the tail.
  assert.deepEqual(ids.slice(0, 30), snapshot, 'walk lost or reordered a pre-existing transfer');
});

test('a descending cursor walk is unaffected by transfers created during the walk', async () => {
  const snapshot = seedTransfers(30).map((t) => t.id).reverse();

  const { items } = await drainCursor('/api/transfers?limit=4&order=desc', {
    onPage: async () => { seedTransfers(1); },
  });

  // Descending from a fixed starting position: newer records sort before the
  // start of the walk, so the walk sees exactly the original 30.
  assert.deepEqual(items.map((t) => t.id), snapshot);
});

test('an audit walk with entries appended between pages has no duplicates', async () => {
  seedTransfers(20);

  const { items } = await drainCursor('/api/audit?limit=3', {
    key: 'entries',
    onPage: async () => { auditService.addEntry({ action: 'noise.created', resourceId: 'noise' }); },
  });

  const ids = items.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'audit walk returned a duplicate');
  assert.ok(items.every((e) => e.action === 'transfer.created'),
    'a descending audit walk must not pick up entries appended after it started');
  assert.equal(items.length, 20);
});

test('a client can tail an ascending audit feed from endCursor without re-reading', async () => {
  seedTransfers(4);

  const first = await drainCursor('/api/audit?limit=10&order=asc', { key: 'entries' });
  assert.equal(first.items.length, 4);

  seedTransfers(3);

  const { status, body } = await get(
    `/api/audit?limit=10&order=asc&cursor=${encodeURIComponent(first.last.pageInfo.endCursor)}`
  );

  assert.equal(status, 200);
  assert.equal(body.count, 3, 'tailing returns only entries appended since the last page');
  const seen = new Set(first.items.map((e) => e.id));
  assert.ok(body.entries.every((e) => !seen.has(e.id)));
});

// ─── Actor scope binding ──────────────────────────────────────────────────────

test('a cursor minted for one token is rejected for another with 403', async () => {
  seedTransfers(10);

  const first = await get('/api/transfers?limit=3', ADMIN);
  const { status, body } = await get(
    `/api/transfers?limit=3&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`,
    READONLY
  );

  assert.equal(status, 403);
  assert.equal(body.error.details.code, 'CURSOR_ACTOR_MISMATCH');
});

test('cursor rejection is symmetric between tokens', async () => {
  seedTransfers(10);

  const first = await get('/api/transfers?limit=3', READONLY);
  const { status } = await get(
    `/api/transfers?limit=3&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`,
    ADMIN
  );

  assert.equal(status, 403);
});

test('each token can page the same collection with its own cursor', async () => {
  seedTransfers(10);

  const adminFirst = await get('/api/transfers?limit=3', ADMIN);
  const readonlyFirst = await get('/api/transfers?limit=3', READONLY);

  const adminSecond = await get(
    `/api/transfers?limit=3&cursor=${encodeURIComponent(adminFirst.body.pageInfo.nextCursor)}`,
    ADMIN
  );
  const readonlySecond = await get(
    `/api/transfers?limit=3&cursor=${encodeURIComponent(readonlyFirst.body.pageInfo.nextCursor)}`,
    READONLY
  );

  assert.equal(adminSecond.status, 200);
  assert.equal(readonlySecond.status, 200);
  assert.deepEqual(names(adminSecond.body), names(readonlySecond.body));
});

test('a transfers cursor is rejected by the audit endpoint', async () => {
  seedTransfers(10);

  const first = await get('/api/transfers?limit=3&order=desc');
  const { status, body } = await get(
    `/api/audit?limit=3&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'CURSOR_FILTER_MISMATCH');
});

test('a tampered cursor is rejected without revealing what was wrong', async () => {
  seedTransfers(10);

  const first = await get('/api/transfers?limit=3');
  const cursor = first.body.pageInfo.nextCursor;
  const [payload, signature] = cursor.split('.');
  const edited = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  edited.s = 0; // rewind to the start of the collection
  const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signature}`;

  const { status, body } = await get(`/api/transfers?limit=3&cursor=${encodeURIComponent(forged)}`);

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'INVALID_CURSOR');
});

test('a cursor from before a store reset is rejected as stale', async () => {
  seedTransfers(10);
  const first = await get('/api/transfers?limit=3');
  const cursor = first.body.pageInfo.nextCursor;

  resetStore();
  seedTransfers(10); // sequence numbers are reissued to different transfers

  const { status, body } = await get(`/api/transfers?limit=3&cursor=${encodeURIComponent(cursor)}`);

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'STALE_CURSOR');
});

test('reading a collection still requires the matching scope', async () => {
  seedTransfers(3);
  const { status } = await get('/api/audit?limit=3', 'test-token-transfers');
  assert.equal(status, 403);
});

// ─── Filter binding ───────────────────────────────────────────────────────────

test('a cursor is rejected when the status filter changes', async () => {
  const seeded = seedTransfers(10);
  transferService.claimTransfer(seeded[0].id);

  const first = await get('/api/transfers?limit=3&status=pending');
  const { status, body } = await get(
    `/api/transfers?limit=3&status=claimed&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'CURSOR_FILTER_MISMATCH');
});

test('a cursor is rejected when the search filter changes', async () => {
  seedTransfers(10);

  // Both needles match every seeded transfer, so the two queries differ only in
  // their filter fingerprint - not in the rows they would return.
  const first = await get('/api/transfers?limit=2&q=T');
  const { status, body } = await get(
    `/api/transfers?limit=2&q=R&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'CURSOR_FILTER_MISMATCH');
});

test('a cursor is rejected when the archived filter changes', async () => {
  const seeded = seedTransfers(10);
  transferService.archiveTransfer(seeded[9].id);

  const first = await get('/api/transfers?limit=3');
  const { status, body } = await get(
    `/api/transfers?limit=3&archived=all&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'CURSOR_FILTER_MISMATCH');
});

test('a cursor is rejected when the sort order changes', async () => {
  seedTransfers(10);

  const first = await get('/api/transfers?limit=3&order=asc');
  const { status, body } = await get(
    `/api/transfers?limit=3&order=desc&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'CURSOR_ORDER_MISMATCH');
});

test('filters that normalise to the same query share cursors', async () => {
  seedTransfers(10);

  // archived is false by default, and search is trimmed and lowercased.
  const first = await get('/api/transfers?limit=3&q=T');
  assert.ok(first.body.pageInfo.nextCursor, 'expected more than one page');

  const { status, body } = await get(
    `/api/transfers?limit=3&q=%20t%20&archived=false&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(names(body), ['T3', 'T4', 'T5']);
});

test('a filtered cursor walk returns only matching rows, with no gaps', async () => {
  const seeded = seedTransfers(30);
  for (let i = 0; i < 30; i += 3) transferService.claimTransfer(seeded[i].id);

  const { items } = await drainCursor('/api/transfers?limit=4&status=claimed');

  assert.equal(items.length, 10);
  assert.ok(items.every((t) => t.status === 'claimed'));
  assert.deepEqual(
    items.map((t) => t.senderName),
    [0, 3, 6, 9, 12, 15, 18, 21, 24, 27].map((i) => `T${i}`)
  );
});

test('the audit resourceId filter pages through its own index', async () => {
  const [first] = seedTransfers(5);
  transferService.claimTransfer(first.id);
  seedTransfers(5);

  const { items } = await drainCursor(
    `/api/audit?limit=1&resourceId=${encodeURIComponent(first.id)}`,
    { key: 'entries' }
  );

  assert.equal(items.length, 2);
  assert.ok(items.every((e) => e.resourceId === first.id));
  assert.deepEqual(items.map((e) => e.action), ['transfer.claimed', 'transfer.created']);
});

test('an audit cursor is rejected when the resourceId filter changes', async () => {
  const seeded = seedTransfers(4);
  for (const t of seeded) transferService.claimTransfer(t.id);

  const first = await get(`/api/audit?limit=1&resourceId=${encodeURIComponent(seeded[0].id)}`);
  const { status, body } = await get(
    `/api/audit?limit=1&resourceId=${encodeURIComponent(seeded[1].id)}`
    + `&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'CURSOR_FILTER_MISMATCH');
});

test('an invalid status filter is still rejected', async () => {
  const { status, body } = await get('/api/transfers?status=teleported');
  assert.equal(status, 400);
  assert.match(body.error.message, /Invalid status filter/);
});

// ─── Bounded queries ──────────────────────────────────────────────────────────

test('an oversized limit is rejected rather than silently truncated', async () => {
  seedTransfers(5);

  for (const path of ['/api/transfers?limit=5000', '/api/audit?limit=5000']) {
    const { status, body } = await get(path);
    assert.equal(status, 400, path);
    assert.equal(body.error.details.code, 'LIMIT_TOO_LARGE');
    assert.equal(body.error.details.maxLimit, 200);
  }
});

test('malformed limit, offset and order values are rejected', async () => {
  for (const query of ['limit=0', 'limit=-5', 'limit=abc', 'offset=-1', 'offset=x', 'order=up']) {
    const { status } = await get(`/api/transfers?${query}`);
    assert.equal(status, 400, `accepted ${query}`);
  }
});

test('a deep offset is refused and points the caller at cursors', async () => {
  const { status, body } = await get('/api/transfers?offset=999999');

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'OFFSET_TOO_DEEP');
  assert.match(body.error.message, /cursor pagination/);
});

test('cursor and offset cannot be combined', async () => {
  seedTransfers(5);
  const first = await get('/api/transfers?limit=2');
  const { status, body } = await get(
    `/api/transfers?limit=2&offset=2&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 400);
  assert.equal(body.error.details.code, 'CONFLICTING_PAGINATION');
});

// ─── Large fixture: cost of a page does not grow with history ────────────────

test('a deep cursor page costs the same as a shallow one over a large history', async () => {
  seedTransfers(20000);

  const shallow = await get('/api/transfers?limit=50');
  assert.equal(shallow.status, 200);
  assert.equal(shallow.body.count, 50);
  // 50 returned plus one lookahead record: no dependence on collection size.
  assert.equal(shallow.body.pageInfo.scanned, 51);

  // Jump ~19 000 records deep by chaining cursors at a large page size.
  let cursor = shallow.body.pageInfo.nextCursor;
  let deep = shallow;
  for (let i = 0; i < 95; i += 1) {
    deep = await get(`/api/transfers?limit=200&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(deep.status, 200);
    cursor = deep.body.pageInfo.nextCursor;
  }

  const started = process.hrtime.bigint();
  const deepPage = await get(`/api/transfers?limit=50&cursor=${encodeURIComponent(cursor)}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(deepPage.status, 200);
  assert.equal(deepPage.body.count, 50);
  assert.equal(deepPage.body.pageInfo.scanned, 51,
    'a page 19 000 records deep must examine no more records than a first page');
  assert.ok(elapsedMs < 250, `deep page took ${elapsedMs.toFixed(1)}ms`);
});

test('a selective filter over a large history is capped by the scan budget', async () => {
  const seeded = seedTransfers(20000);
  // Exactly one match, sitting at the far end of the index.
  transferService.claimTransfer(seeded[19999].id);

  const { status, body } = await get('/api/transfers?limit=10&status=claimed');

  assert.equal(status, 200);
  assert.equal(body.pageInfo.scanned, 10000, 'the scan must stop at the configured budget');
  assert.equal(body.pageInfo.scanTruncated, true);
  assert.equal(body.pageInfo.hasMore, true,
    'a budget-truncated page must not report the collection as exhausted');

  // Following the cursor still reaches the match: bounded, not lossy.
  const { items } = await drainCursor('/api/transfers?limit=10&status=claimed');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, seeded[19999].id);
});

test('a full cursor walk of a large history returns every record exactly once', async () => {
  const seeded = seedTransfers(5000);

  const { items } = await drainCursor('/api/transfers?limit=200');

  assert.equal(items.length, 5000);
  assert.deepEqual(items.map((t) => t.id), seeded.map((t) => t.id));
});

// ─── Backwards compatibility ──────────────────────────────────────────────────

test('the legacy offset response contract is unchanged', async () => {
  seedTransfers(5);

  const { status, body } = await get('/api/transfers?limit=2&offset=1');

  assert.equal(status, 200);
  assert.equal(body.total, 5);
  assert.equal(body.count, 2);
  assert.equal(body.limit, 2);
  assert.equal(body.offset, 1);
  assert.deepEqual(names(body), ['T1', 'T2']);
});

test('the legacy audit offset response contract is unchanged', async () => {
  seedTransfers(5);

  const { status, body } = await get('/api/audit?limit=2&offset=1');

  assert.equal(status, 200);
  assert.equal(body.total, 5);
  assert.equal(body.count, 2);
  assert.equal(body.offset, 1);
  assert.equal(body.entries.length, 2);
});

test('offset mode still issues a cursor so clients can migrate mid-walk', async () => {
  seedTransfers(9);

  const offsetPage = await get('/api/transfers?limit=3&offset=3');
  assert.deepEqual(names(offsetPage.body), ['T3', 'T4', 'T5']);

  const { status, body } = await get(
    `/api/transfers?limit=3&cursor=${encodeURIComponent(offsetPage.body.pageInfo.nextCursor)}`
  );

  assert.equal(status, 200);
  assert.deepEqual(names(body), ['T6', 'T7', 'T8']);
});

test('cursor mode omits total, which offset mode still pays for', async () => {
  seedTransfers(5);

  const offsetPage = await get('/api/transfers?limit=2');
  assert.equal(offsetPage.body.total, 5);

  const cursorPage = await get(
    `/api/transfers?limit=2&cursor=${encodeURIComponent(offsetPage.body.pageInfo.nextCursor)}`
  );
  assert.equal(cursorPage.body.total, undefined);
  assert.equal(cursorPage.body.offset, undefined);
});

test('default listing behaviour is untouched for callers that pass no parameters', async () => {
  const seeded = seedTransfers(3);
  transferService.archiveTransfer(seeded[1].id);

  const { status, body } = await get('/api/transfers');

  assert.equal(status, 200);
  assert.equal(body.limit, 50);
  assert.equal(body.offset, 0);
  assert.equal(body.total, 2);
  assert.deepEqual(names(body), ['T0', 'T2']);
});
