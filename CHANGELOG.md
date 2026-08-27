# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## Release Process

When preparing a new release:
1. Review the `[Unreleased]` section and ensure all notable changes are documented.
2. Change the `[Unreleased]` heading to the new version number and current date (e.g., `## [1.0.0] - YYYY-MM-DD`).
3. Create a new empty `## [Unreleased]` section at the top of the file, with `### Added`, `### Changed`, `### Fixed`, etc., as needed.
4. Update the `version` field in `package.json` to match the new version.
5. Commit these changes with a conventional commit message (e.g., `chore: release v1.0.0`).
6. Tag the commit with the new version (e.g., `git tag v1.0.0`) and push the changes and tags to the repository.

## [Unreleased]

### Added

- Cursor pagination for `GET /api/transfers` and `GET /api/audit`. Pass
  `?cursor=` (with optional `?order=asc|desc`) to page by an indexed position
  instead of a row offset; responses carry a `pageInfo` block with
  `hasMore`, `nextCursor`, `endCursor`, `scanned` and `scanTruncated`.
  Cursors are HMAC-signed and bound to the API token, filter set and sort
  order they were issued for, so they cannot be replayed across actor scopes
  or filters. Signing key: `PAGINATION_CURSOR_SECRET`.
- Append-only ordered indexes behind transfer and audit history
  (`src/utils/orderedIndex.js`), giving both collections a deterministic total
  order and constant-cost page seeks regardless of how deep the page is. The
  audit log also gains a secondary index by `resourceId`.
- Per-request work budget for history queries (`PAGINATION_MAX_SCAN`,
  default `10000`), so a highly selective filter over a large history costs a
  bounded amount of work. A budget-truncated page is gap-free and resumable
  via its `nextCursor`.
- `PAGINATION_DEFAULT_LIMIT` and `PAGINATION_MAX_LIMIT` configuration.

### Changed

- **Breaking:** `GET /api/transfers` and `GET /api/audit` now reject a `limit`
  above `PAGINATION_MAX_LIMIT` (200) with `400 LIMIT_TOO_LARGE` instead of
  silently clamping it, and reject malformed `limit`/`offset`/`order` values
  instead of falling back to defaults. Silent clamping left callers unable to
  tell a truncated page from a complete one. Other collections
  (`GET /api/users`) keep the previous lenient behaviour.
- **Breaking:** `?offset=` beyond `PAGINATION_MAX_SCAN` is rejected with
  `400 OFFSET_TOO_DEEP`; deep pages must use `?cursor=`. `?cursor=` and
  `?offset=` cannot be combined.
- `?offset=` is deprecated on both history endpoints but otherwise unchanged:
  the `total`, `count`, `limit` and `offset` fields and the default ordering
  are all preserved, and offset responses now also carry a `nextCursor` so
  clients can migrate mid-walk. `total` is not returned in cursor mode,
  because computing it requires the full-collection pass that cursor
  pagination exists to avoid.

### Fixed

- Offset pagination over transfer and audit history repeated or skipped rows
  when records were written while a client was paging, because the window was
  defined by a row count rather than a position. Cursor pagination anchors to
  an immutable creation position instead, so concurrent writes cannot shift a
  page boundary.

### Added

- Error tracking integration hook (`src/services/errorTrackingService.js`)
  that captures every error through a replaceable transport (console by
  default) and enriches it with request context (id, method, url).
  Controlled via `ERROR_TRACKING_ENABLED` and `ERROR_TRACKING_LEVEL`
  environment variables.
- Liveness (`GET /api/health/live`) and readiness (`GET /api/health/ready`)
  probe endpoints.
- Single currency pair rate endpoint `GET /api/rates/:pair`.
- Aggregate transfer statistics endpoint `GET /api/transfers/stats`.
- Free-text name search on transfer listing via `?q=`.
- Security headers middleware (nosniff, frame, referrer, CSP).
- Request timeout middleware returning 503 when a handler stalls.
- Configurable JSON request body size limit (413 on overflow).
- Configurable maximum transfer amount with validation.
- `percentage` helper on the money util and a `strings` utility module, both
  covered by `node:test` suites.
- Numeric precision guards on money fields: `money.isSafeAmount` and
  `money.hasValidPrecision` reject non-finite/out-of-range amounts and
  amounts with more than 2 decimal places (sub-cent precision) on both
  `GET /api/quote` and `POST /api/transfers`, instead of silently rounding
  them away.
- `unprocessable` (422) and `serviceUnavailable` (503) `ApiError` factories.
- Structured key-value fields in request logs.
- Expanded demo seed data with additional users and transfers.

### Changed

- User validation now enforces a name length limit and a two-letter country
  code.
- Fee calculation reuses the shared `money.percentage` helper.

## [0.1.0]

- Initial RemitFlow backend: FX quotes, transfers, users, health, rates,
  in-memory store, rate limiting, request id correlation and pagination.
