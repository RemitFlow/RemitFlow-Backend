# Scope matrix

Canonical scope strings live in `src/config/scopes.js` (`SCOPES`, `SCOPE_MATRIX`).
Route middleware (`requireScope` / `adminAuth`) is the first gate. HTTP controllers
pass an explicit auth context to the service helpers in `src/utils/authz.js`, which
re-check the same scopes. New request handlers must preserve both steps; see
[Service integration](#service-integration).

| Method | Path | Required scopes | Surface |
|--------|------|-----------------|---------|
| GET | `/api/transfers` | `transfers:read` | list |
| GET | `/api/transfers/stats` | `transfers:read` | direct |
| GET | `/api/transfers/:id` | `transfers:read` | direct |
| POST | `/api/transfers` | `transfers:write` | direct |
| POST | `/api/transfers/bulk` | `transfers:write` | bulk |
| POST | `/api/transfers/:id/claim` | `transfers:write` | direct |
| POST | `/api/transfers/:id/cancel` | `transfers:write` | direct |
| POST | `/api/transfers/:id/archive` | `transfers:write` | direct |
| POST | `/api/transfers/:id/unarchive` | `transfers:write` | direct |
| GET | `/api/users` | `users:read` | list |
| GET | `/api/users/:id` | `users:read` | direct |
| POST | `/api/users` | `users:write` | direct |
| GET | `/api/audit` | `audit:read` | list |
| GET | `/api/admin/diagnostics` | `admin:read` | admin |

## Service integration

Service checks run when an `auth` context is supplied. `assertScopes(auth, required)`
deliberately returns without checking when `auth` is `null` or `undefined`, so
trusted internal callers such as seed code retain their existing behavior.
Omitting the argument is not an anonymous-request denial.

For every HTTP adapter, keep the route's `requireScope` / `adminAuth` middleware
and derive the service context with `authFromRequest(req)`. This copies the
middleware-populated `req.tokenScopes`; a request with no scope array produces
an explicit empty array and is rejected by the service with
`403 Insufficient token scopes`. Do not substitute client-supplied body or query
fields for that context.

Pass the context in the operation's existing argument position. For example,
the archive controller calls:

```js
const { authFromRequest } = require('../utils/authz');

const transfer = transferService.archiveTransfer(
  req.params.id,
  authFromRequest(req)
);
```

The create controller instead passes it as the fourth argument, after the
payload, request ID and idempotency descriptor. Follow the corresponding
controller in `src/controllers/transferController.js` when adding an adapter.
The service guard therefore protects a missing route scope check only when
the adapter still supplies an explicit request context; it is not a replacement
for request authentication.

## Admin credentials

`GET /api/admin/diagnostics` accepts either:

1. `Authorization: Bearer <api-token>` whose catalog entry includes `admin:read`, or
2. Legacy `X-Admin-Token: <ADMIN_API_KEY>` / `Authorization: Bearer <ADMIN_API_KEY>`,
   which is mapped onto `[admin:read]` so the path stays scope-gated.

A recognized API bearer token is checked first. If it lacks `admin:read`, the
request returns `403` even when a valid legacy `X-Admin-Token` is also present.
Choose the intended credential instead of combining both authentication modes.

## Non-enumeration

Transfer lookups (direct and bulk) return the same `404 Transfer not found`
envelope for malformed ids and for unknown well-formed ids. Bulk per-id failures
use a stable `error.code` of `not_found` in both cases.

## Bulk mutations

```http
POST /api/transfers/bulk
Authorization: Bearer <token with transfers:write>
Content-Type: application/json

{ "action": "claim" | "cancel" | "archive" | "unarchive", "ids": ["txn_…", …] }
```

Up to 50 ids per call. The response is `{ results: [{ id, ok, transfer? | error? }] }`.
