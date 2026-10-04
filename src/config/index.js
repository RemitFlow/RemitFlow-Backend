'use strict';

require('dotenv').config();

/**
 * Parse a positive integer env var with a fallback.
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function intEnv(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Centralized application configuration.
 * Values are read from environment variables with sensible defaults
 * so the app can boot even without a .env file present.
 */
const env = process.env.NODE_ENV || 'development';
const isTest = env === 'test';

const config = {
  env,
  port: parseInt(process.env.PORT, 10) || 3000,

  baseCurrency: process.env.DEFAULT_BASE_CURRENCY || 'USD',

  fee: {
    percent: parseFloat(process.env.TRANSFER_FEE_PERCENT) || 1.5,
    flat: parseFloat(process.env.TRANSFER_FEE_FLAT) || 0.3,
  },

  // Largest single transfer amount accepted (in the source currency).
  maxTransferAmount: parseFloat(process.env.MAX_TRANSFER_AMOUNT) || 50000,

  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
  },

  // CORS origin; "*" allows any origin (fine for a public demo API).
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // Maximum accepted JSON request body size (passed to express.json).
  bodyLimit: process.env.BODY_LIMIT || '100kb',

  // Per-request time budget before a 503 is returned.
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 15 * 1000,

  /**
   * Whether to trust `X-Forwarded-For` when resolving the client IP.
   * Off by default so untrusted clients cannot rotate IPs to bypass limits.
   * Enable only behind a reverse proxy that strips/forges the header safely.
   */
  trustProxy: process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1',

  rateLimit: {
    windowMs: intEnv(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
    max: intEnv(process.env.RATE_LIMIT_MAX, isTest ? 10_000 : 100),
    maxKeys: intEnv(process.env.RATE_LIMIT_MAX_KEYS, 10_000),
  },

  /**
   * Stricter per-actor budgets for mutation / expensive routes.
   * Defaults are deliberately higher than a single integration test suite
   * needs, while still bounding automated abuse of provider-backed paths.
   */
  mutationRateLimit: {
    maxKeys: intEnv(process.env.MUTATION_RATE_LIMIT_MAX_KEYS, 10_000),
    transfers: {
      windowMs: intEnv(process.env.MUTATION_RATE_LIMIT_TRANSFERS_WINDOW_MS, 60 * 1000),
      // Generous under test so the suite does not trip the abuse budget; production
      // defaults stay tight enough to bound provider-quota exhaustion.
      max: intEnv(process.env.MUTATION_RATE_LIMIT_TRANSFERS_MAX, isTest ? 10_000 : 30),
    },
    users: {
      windowMs: intEnv(process.env.MUTATION_RATE_LIMIT_USERS_WINDOW_MS, 60 * 1000),
      max: intEnv(process.env.MUTATION_RATE_LIMIT_USERS_MAX, isTest ? 10_000 : 20),
    },
    quote: {
      windowMs: intEnv(process.env.MUTATION_RATE_LIMIT_QUOTE_WINDOW_MS, 60 * 1000),
      max: intEnv(process.env.MUTATION_RATE_LIMIT_QUOTE_MAX, isTest ? 10_000 : 60),
    },
    admin: {
      windowMs: intEnv(process.env.MUTATION_RATE_LIMIT_ADMIN_WINDOW_MS, 60 * 1000),
      max: intEnv(process.env.MUTATION_RATE_LIMIT_ADMIN_MAX, isTest ? 10_000 : 30),
    },
  },

  errorTracking: {
    enabled: process.env.ERROR_TRACKING_ENABLED !== 'false',
    level: process.env.ERROR_TRACKING_LEVEL || 'error',
  },

  adminApiKey: process.env.ADMIN_API_KEY || 'admin-secret-dev',
  db: {
    pool: {
      min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
      max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
      idleTimeoutMs: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 10) || 30000,
      connectionTimeoutMs: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 10) || 2000,
    },
  },

  cache: {
    defaultPolicy: process.env.CACHE_DEFAULT_POLICY || 'no-store',
    ratesMaxAge: parseInt(process.env.CACHE_RATES_MAX_AGE_SECONDS, 10) || 10,
  },

  pagination: {
    // Page size used when a request does not ask for one.
    defaultLimit: parseInt(process.env.PAGINATION_DEFAULT_LIMIT, 10) || 50,
    // Hard ceiling on a single page. Larger requests are rejected, not clamped.
    maxLimit: parseInt(process.env.PAGINATION_MAX_LIMIT, 10) || 200,
    // Ceiling on records a single history query may examine. Bounds the cost of
    // a highly selective filter (or a deep offset) over a large history.
    maxScan: parseInt(process.env.PAGINATION_MAX_SCAN, 10) || 10000,
  },

  apiTokens: (() => {
    try {
      if (process.env.API_TOKENS) {
        return JSON.parse(process.env.API_TOKENS);
      }
    } catch (err) {
      console.warn('Failed to parse API_TOKENS env var, falling back to defaults');
    }
    // Default tokens for demo purposes
    return {
      'test-token-admin': ['transfers:read', 'transfers:write', 'users:read', 'users:write', 'audit:read'],
      'test-token-readonly': ['transfers:read', 'users:read', 'audit:read'],
      'test-token-transfers': ['transfers:read', 'transfers:write']
    };
  })(),
};

module.exports = config;
