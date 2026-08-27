'use strict';

/**
 * Append-only ordered index.
 *
 * Backs cursor pagination for the history collections (transfers, audit log).
 * Records are appended in creation order and never moved or removed, which
 * gives every record a dense, immutable, strictly increasing sequence number.
 *
 * Why sequence numbers rather than raw timestamps:
 *   - `createdAt` / `at` only have millisecond resolution, so several records
 *     routinely share a timestamp. A cursor built on the timestamp alone
 *     cannot resume deterministically inside such a tie.
 *   - The sequence number is assigned in insertion order, so ordering by
 *     `seq` is identical to ordering by `(timestamp, insertion order)` without
 *     depending on the wall clock being monotonic.
 *
 * The timestamp is still carried on each record so a cursor can be validated
 * against the position it claims to point at.
 *
 * Cost model (n = records in the index, m = records in a group):
 *   append                     O(1)
 *   seek to a cursor position  O(1) ungrouped, O(log m) grouped
 *   scan                       O(records examined), hard-capped by `maxScan`
 */
class OrderedIndex {
  /**
   * @param {object} options
   * @param {(item: object) => string} options.sortKeyOf  - extracts the timestamp sort key.
   * @param {(item: object) => (string|null)} [options.groupKeyOf] - optional secondary
   *   index key, so an equality filter on that field can be paged without
   *   scanning unrelated records.
   */
  constructor({ sortKeyOf, groupKeyOf = null } = {}) {
    if (typeof sortKeyOf !== 'function') {
      throw new TypeError('OrderedIndex: sortKeyOf must be a function');
    }
    this.sortKeyOf = sortKeyOf;
    this.groupKeyOf = groupKeyOf;
    /** @type {Array<{ seq: number, key: string, item: object }>} */
    this.records = [];
    /** @type {Map<string, Array<{ seq: number, key: string, item: object }>>} */
    this.groups = new Map();
    this.nextSeq = 0;
  }

  /** Number of records held by the index. */
  get size() {
    return this.records.length;
  }

  /**
   * Append an item, assigning it the next sequence number.
   * @param {object} item
   * @returns {{ seq: number, key: string, item: object }} the stored record.
   */
  append(item) {
    const record = { seq: this.nextSeq++, key: String(this.sortKeyOf(item)), item };
    this.records.push(record);

    if (this.groupKeyOf) {
      const groupKey = this.groupKeyOf(item);
      if (groupKey != null) {
        const bucket = this.groups.get(groupKey);
        if (bucket) {
          bucket.push(record);
        } else {
          this.groups.set(groupKey, [record]);
        }
      }
    }

    return record;
  }

  /** Drop every record. Used by store resets and tests. */
  reset() {
    this.records.length = 0;
    this.groups.clear();
    this.nextSeq = 0;
  }

  /**
   * The record array a query should walk: the whole index, or one group.
   * @param {string|null} group
   * @returns {Array<{ seq: number, key: string, item: object }>}
   */
  recordsFor(group) {
    if (group == null) return this.records;
    return this.groups.get(group) || [];
  }

  /**
   * Look up the record carrying a given sequence number.
   * @param {number} seq
   * @param {string|null} [group]
   * @returns {{ seq: number, key: string, item: object }|null}
   */
  recordAt(seq, group = null) {
    const records = this.recordsFor(group);
    if (group == null) {
      // The ungrouped index is dense, so seq is the array position.
      return records[seq] || null;
    }
    const position = lowerBound(records, seq);
    const record = records[position];
    return record && record.seq === seq ? record : null;
  }

  /**
   * Page through the index.
   *
   * Walks from the position just past `afterSeq` in the requested direction,
   * returning at most `limit` items that satisfy `match`. The walk examines at
   * most `maxScan` records, so a highly selective filter over a large index
   * costs a bounded amount of work per request instead of a full table scan.
   *
   * @param {object} options
   * @param {number|null} [options.afterSeq] - exclusive start position; null starts at the edge.
   * @param {'asc'|'desc'} [options.order]
   * @param {string|null} [options.group] - restrict to a secondary-index group.
   * @param {number} options.limit - maximum items to return.
   * @param {number} options.maxScan - maximum records to examine.
   * @param {(item: object) => boolean} [options.match] - residual filter predicate.
   * @param {number} [options.skip] - drop this many matching items before collecting
   *   (used only by the legacy offset path; counts against `maxScan`).
   * @returns {{
   *   items: object[],
   *   last: ({ seq: number, key: string, item: object }|null),
   *   hasMore: boolean,
   *   scanned: number,
   *   scanTruncated: boolean,
   *   skipped: number
   * }}
   */
  scan({
    afterSeq = null,
    order = 'desc',
    group = null,
    limit,
    maxScan,
    match = null,
    skip = 0,
  }) {
    const records = this.recordsFor(group);
    const step = order === 'asc' ? 1 : -1;

    let position = startPosition(records, afterSeq, order, group);

    const items = [];
    let scanned = 0;
    let skipped = 0;
    let hasMore = false;
    let scanTruncated = false;
    // The record the next cursor should point at: the last one examined, so a
    // budget-truncated page resumes exactly where this one stopped.
    let frontier = null;

    while (position >= 0 && position < records.length) {
      if (scanned >= maxScan) {
        // Out of budget before reaching the end of the index. Report more data
        // is available and, when the page came up short, that the shortfall is
        // a budget artefact rather than the end of the collection.
        scanTruncated = items.length < limit;
        hasMore = true;
        break;
      }

      const record = records[position];
      position += step;
      scanned += 1;

      if (match && !match(record.item)) {
        // A skipped non-match still advances the frontier: resuming from it
        // cannot lose a matching record, because non-matches are stable for a
        // fixed filter.
        frontier = record;
        continue;
      }

      if (skipped < skip) {
        skipped += 1;
        frontier = record;
        continue;
      }

      if (items.length === limit) {
        // One matching record beyond the page proves there is a next page.
        hasMore = true;
        break;
      }

      items.push(record.item);
      frontier = record;
    }

    return { items, last: frontier, hasMore, scanned, scanTruncated, skipped };
  }
}

/**
 * First array position whose record has `seq >= target`.
 * @param {Array<{ seq: number }>} records
 * @param {number} target
 * @returns {number}
 */
function lowerBound(records, target) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (records[mid].seq < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Resolve the array position a scan should start at, exclusive of `afterSeq`.
 * @param {Array<{ seq: number }>} records
 * @param {number|null} afterSeq
 * @param {'asc'|'desc'} order
 * @param {string|null} group
 * @returns {number}
 */
function startPosition(records, afterSeq, order, group) {
  if (afterSeq == null) {
    return order === 'asc' ? 0 : records.length - 1;
  }

  // Ascending resumes at the first record after the cursor; descending resumes
  // at the last record before it. Both are exclusive of the cursor itself, which
  // is what makes pages non-overlapping.
  // The ungrouped index is dense (seq === array position), so the binary search
  // is only needed for group buckets.
  if (order === 'asc') {
    return group == null
      ? Math.min(Math.max(afterSeq, -1) + 1, records.length)
      : lowerBound(records, afterSeq + 1);
  }

  return group == null
    ? Math.min(afterSeq, records.length) - 1
    : lowerBound(records, afterSeq) - 1;
}

module.exports = { OrderedIndex };
