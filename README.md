# RemitFlow Backend

Node.js + Express backend for **RemitFlow**, a Stellar-powered cross-border
remittance demo. It exposes a small REST API for FX quotes and transfers and
uses an in-memory store, so no database is required. Anything Stellar-related
is mocked.

## Tech stack

- Node.js + Express
- In-memory store (data is lost on restart)
- `cors`, `dotenv`, `morgan`, `uuid`

## Getting started

```bash
npm install
cp .env.example .env
npm start
```

The server listens on `PORT` (default `3000`).

## Configuration

The application is configured using environment variables (typically defined in a `.env` file). The following variables are supported:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | The port the server listens on | `3000` |
| `NODE_ENV` | Application environment (`development`, `production`, `test`) | `development` |
| `DEFAULT_BASE_CURRENCY` | Default base currency for rates | `USD` |
| `TRANSFER_FEE_PERCENT` | Percentage fee charged per transfer | `1.5` |
| `TRANSFER_FEE_FLAT` | Flat fee charged per transfer | `0.30` |
| `MAX_TRANSFER_AMOUNT` | Maximum single transfer amount accepted | `50000` |
| `STELLAR_NETWORK` | Stellar network environment (`testnet`, `public`) | `testnet` |
| `CORS_ORIGIN` | Allowed CORS origin | `*` |
| `RATE_LIMIT_WINDOW_MS` | Time window for rate limiting (ms) | `60000` |
| `RATE_LIMIT_MAX` | Max requests per window | `100` |
| `BODY_LIMIT` | Max JSON request body size | `100kb` |
| `REQUEST_TIMEOUT_MS` | Request timeout before returning 503 (ms) | `15000` |
| `DB_POOL_MIN` | Minimum database connections in pool | `2` |
| `DB_POOL_MAX` | Maximum database connections in pool | `10` |
| `DB_POOL_IDLE_TIMEOUT_MS` | How long a connection can be idle before being closed (ms) | `30000` |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | Time to wait for a connection before timing out (ms) | `2000` |
| `CACHE_DEFAULT_POLICY` | Default cache policy for endpoints (`no-store`, `public`, `private`) | `no-store` |
| `CACHE_RATES_MAX_AGE_SECONDS` | Cache duration for rates endpoints (seconds) | `10` |
| `API_TOKENS` | JSON object mapping API tokens to their allowed scopes (see [Authentication](#authentication)) | *(demo tokens)* |


## Authentication

All write endpoints and most read endpoints require a valid **Bearer token** in
the `Authorization` header:

```
Authorization: Bearer <token>
```

### Scopes

| Scope | Grants access to |
|-------|-----------------|
| `transfers:read` | `GET /api/transfers`, `GET /api/transfers/stats`, `GET /api/transfers/:id` |
| `transfers:write` | `POST /api/transfers`, `POST /api/transfers/:id/claim`, `POST /api/transfers/:id/cancel`, `POST /api/transfers/:id/archive`, `POST /api/transfers/:id/unarchive` |
| `users:read` | `GET /api/users`, `GET /api/users/:id` |
| `users:write` | `POST /api/users` |
| `audit:read` | `GET /api/audit` |

### Public endpoints (no token required)

`GET /api/health`, `GET /api/health/live`, `GET /api/health/ready`,
`GET /api/version`, `GET /api/rates`, `GET /api/rates/:pair`, `GET /api/quote`

### Configuring tokens

Set the `API_TOKENS` environment variable to a JSON object mapping token
strings to their scope arrays:

```bash
API_TOKENS='{"my-production-token":["transfers:read","transfers:write","users:read","users:write","audit:read"],"reporting-token":["transfers:read","audit:read"]}'
```

If `API_TOKENS` is not set, the server starts with three **demo tokens** (safe
for local development only — rotate before deploying):

| Demo token | Scopes |
|------------|--------|
| `test-token-admin` | all scopes |
| `test-token-readonly` | `transfers:read`, `users:read`, `audit:read` |
| `test-token-transfers` | `transfers:read`, `transfers:write` |

### Error responses

| Status | Meaning |
|--------|---------|
| `401 Unauthorized` | `Authorization` header is missing, malformed, or the token is not recognised |
| `403 Forbidden` | Token is valid but lacks the required scope for this endpoint |



## Project layout

```
src/
  config/       configuration and mock FX rates
  controllers/  HTTP request handlers
  middleware/   logging, validation, error handling
  routes/       Express routers
  services/     business logic (rates, quotes, transfers, users, error tracking)
  store/        in-memory store and seed data
  utils/        logger, ids, money, ApiError, asyncHandler
  validators/   request validators
  app.js        Express app assembly
  index.js      server bootstrap
```

## API overview

See the endpoint reference below. All responses are JSON. Errors use a
consistent envelope:

```json
{ "error": { "message": "...", "status": 400, "details": { }, "requestId": "...", "at": "..." } }
```

Every response carries an `X-Request-Id` header (echoed from the request when
supplied) so logs and errors can be correlated.

### Caching and headers

The API implements Cache-Control response headers for security and efficiency:
- **Default policy**: All endpoints (such as transfers, users, quotes, and health check probes) are non-cacheable by default (`Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0`).
- **Rates (`GET /api/rates`, `GET /api/rates/:pair`)**: Cached publicly with a short duration (default 10 seconds, configured via `CACHE_RATES_MAX_AGE_SECONDS`).
- **Version (`GET /api/version`)**: Cached publicly for 1 hour (`max-age=3600`).

## Endpoints

### Health

- `GET /api/health` — service health snapshot (version, uptime, env).
- `GET /api/health/live` — liveness probe.
- `GET /api/health/ready` — readiness probe with dependency checks.
- `GET /api/version` — service name and version.

### Rates & quotes

- `GET /api/rates` — list supported currencies and their USD rate.
- `GET /api/rates/:pair` — rate for one pair, e.g. `/api/rates/USD-INR`.
- `GET /api/quote?amount=&from=&to=` — FX quote with fee breakdown.

All `amount` fields (quotes and transfers) are guarded for numeric
precision: values must be finite, within a safe numeric range, and have
at most 2 decimal places (e.g. `100.129` is rejected with a 400). This
prevents floating-point/sub-cent precision loss from being silently
rounded away.

### Transfers

- `POST /api/transfers` — create a transfer.
  Body: `{ senderName, recipientName, amount, from, to }`
  Requires an `Idempotency-Key` header (see below).
- `GET /api/transfers` — list transfers. Supports `?status=`, `?q=` (name
  search), `?archived=` (true/false/all), and `?limit=`/`?offset=` pagination.
  Archived transfers are excluded from results by default.
- `GET /api/transfers/stats` — aggregate counts and volume by currency.
- `GET /api/transfers/:id` — fetch one transfer.
- `POST /api/transfers/:id/claim` — recipient claims the transfer.
- `POST /api/transfers/:id/cancel` — sender cancels a pending transfer.
- `POST /api/transfers/:id/archive` — archive a transfer, hiding it from default list results.
- `POST /api/transfers/:id/unarchive` — unarchive a transfer, restoring it to default list results.

#### Idempotency

`POST /api/transfers` requires an `Idempotency-Key` header. The endpoint moves
money, so a client that omits the header is not opting out of protection, it is
unaware it needs it; the request is rejected with 400 rather than risking a
duplicate.

For a given (API token, key) pair the operation runs at most once:

- **Retry with the same payload** replays the stored transfer, answering 201
  with the original body. The quote is not recomputed, so a moved rate cannot
  change the answer, and no second payment is submitted.
- **Reuse with a different payload** answers 409. The fingerprint covers the
  fields that determine the transfer, so property order, an amount sent as a
  string, and unrelated extra fields all still count as the same request.
- **A retry arriving while the first is still in flight** answers 409 rather
  than starting a second settlement.
- **A provider failure releases the key**, so retrying with the same key can
  succeed once the provider recovers.

Keys are scoped to the API token: two callers using the same key get two
independent transfers, and neither can reach the other's.

Records live in the same store as the transfers, so with the in-memory store
that backs this demo a restart clears both together. That keeps them
consistent: a surviving reservation would replay a transfer that no longer
exists.

### Users

- `GET /api/users` — list users.
- `GET /api/users/:id` — fetch one user.
- `POST /api/users` — create a user. Body: `{ name, email, country? }`

## Transfer lifecycle

```
pending ──▶ claimed
   │
   └──────▶ cancelled
```

A transfer starts as `pending` and can move to either `claimed` or
`cancelled`. Terminal states cannot transition further.

**Archival:** Transfers can be archived independently of their lifecycle status.
Archived transfers are excluded from default list results but remain queryable
via `?archived=true`. Use `/api/transfers/:id/archive` to archive and
`/api/transfers/:id/unarchive` to restore a transfer.

## Examples

```bash
# Public endpoints — no token required
curl "http://localhost:3000/api/quote?amount=100&from=USD&to=INR"
curl "http://localhost:3000/api/rates"
curl "http://localhost:3000/api/health"

# Set your token once (use a demo token for local dev, or your own via API_TOKENS)
TOKEN="test-token-admin"

# Create a transfer  (requires transfers:write)
curl -X POST http://localhost:3000/api/transfers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"senderName":"Alice","recipientName":"Bob","amount":100,"from":"USD","to":"INR"}'

# Claim a transfer  (requires transfers:write)
curl -X POST http://localhost:3000/api/transfers/<id>/claim \
  -H "Authorization: Bearer $TOKEN"

# Search transfers by name and view aggregate stats  (requires transfers:read)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/transfers?q=alice"
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/transfers/stats"

# Archive and unarchive transfers  (requires transfers:write)
curl -X POST http://localhost:3000/api/transfers/<id>/archive \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:3000/api/transfers/<id>/unarchive \
  -H "Authorization: Bearer $TOKEN"

# List only archived transfers  (requires transfers:read)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/transfers?archived=true"

# List users  (requires users:read)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/users"

# View audit log  (requires audit:read)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/audit"
```
