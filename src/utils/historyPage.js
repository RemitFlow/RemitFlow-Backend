'use strict';

const config = require('../config');
const ApiError = require('./ApiError');
const { actorFingerprint, decodeCursor, encodeCursor, fingerprint } = require('./cursor');
const { parseHistoryPagination } = require('./pagination');

/**
 * Shared request handling for cursor-paginated history collections.
 *
 * Both history endpoints need the same six steps - parse and bound the
 * pagination parameters, fingerprint the actor and the filters, validate any
 * supplied cursor against both, run the indexed scan, mint the next cursor, and
 * shape the envelope. Keeping that in one place is what guarantees the two
 * endpoints cannot drift into subtly different cursor semantics.
 *
 * @param {object} params
 * @param {import('express').Request} params.req
 * @param {string} params.collection - fingerprint namespace, so a transfers
 *   cursor can never validate against the audit endpoint even under identical filters.
 * @param {object} params.filters - canonical (normalised) filter description.
 * @param {'asc'|'desc'} params.defaultOrder
 * @param {(args: { order: 'asc'|'desc', limit: number, afterSeq: number|null,
 *   skip: number, maxScan: number }) => object} params.query - indexed scan.
 * @param {() => number} params.countTotal - total matching records; only called
 *   in legacy offset mode, where the response contract promises a total.
 * @param {(seq: number) => (string|null)} params.resolvePosition - timestamp of the
 *   record at an index position, used to reject cursors that no longer describe
 *   the position they were minted for.
 * @returns {{ items: object[], envelope: object }}
 */
function buildHistoryPage({
  req,
  collection,
  filters,
  defaultOrder,
  query,
  countTotal,
  resolvePosition,
}) {
  const { maxScan } = config.pagination;
  const { mode, limit, order, cursor: rawCursor, offset } = parseHistoryPagination(
    req.query,
    { defaultOrder }
  );

  const actor = actorFingerprint(req);
  const filterPrint = fingerprint([collection, filters]);

  let afterSeq = null;
  let skip = 0;

  if (mode === 'cursor') {
    const position = decodeCursor(rawCursor, { order, filter: filterPrint, actor });

    // The cursor carries the timestamp of the record it was minted at. If the
    // position now holds a different record - the in-memory store was reset and
    // sequence numbers were reissued - resuming would silently return an
    // unrelated slice, so the cursor is rejected instead.
    if (resolvePosition(position.seq) !== position.key) {
      throw ApiError.badRequest(
        'Cursor no longer refers to a valid position; restart paging without a cursor',
        { code: 'STALE_CURSOR' }
      );
    }

    afterSeq = position.seq;
  } else if (offset > maxScan) {
    // Deep offsets are the failure this endpoint exists to fix: the server would
    // have to walk every skipped record on every request, and the window shifts
    // whenever a record is inserted. Refuse rather than do unbounded work.
    throw ApiError.badRequest(
      `offset may not exceed ${maxScan}; use cursor pagination for deep pages`,
      { code: 'OFFSET_TOO_DEEP', maxOffset: maxScan }
    );
  } else {
    skip = offset;
  }

  const page = query({ order, limit, afterSeq, skip, maxScan });

  // Position of the last record this scan examined. Present even when the page
  // is the last one, so an `order=asc` client can park here and pick up records
  // appended later without re-reading anything.
  const endCursor = page.last
    ? encodeCursor({ order, key: page.last.key, seq: page.last.seq, filter: filterPrint, actor })
    : rawCursor;

  const envelope = {
    count: page.items.length,
    limit,
    order,
    pageInfo: {
      hasMore: page.hasMore,
      nextCursor: page.hasMore ? endCursor : null,
      endCursor,
      scanned: page.scanned,
      // True when the work budget, not the end of the collection, ended the
      // page. The page is still gap-free: follow nextCursor to continue.
      scanTruncated: page.scanTruncated,
    },
  };

  if (mode === 'offset') {
    // Legacy fields. `total` costs a full filtered pass, which is precisely the
    // cost cursor mode avoids, so it is not offered there.
    envelope.total = countTotal();
    envelope.offset = offset;
  }

  return { items: page.items, envelope };
}

module.exports = { buildHistoryPage };
