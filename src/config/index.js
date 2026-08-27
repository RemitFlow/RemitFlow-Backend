'use strict';

require('dotenv').config();

/**
 * Centralized application configuration.
 * Values are read from environment variables with sensible defaults
 * so the app can boot even without a .env file present.
 */
const config = {
  env: process.env.NODE_ENV || 'development',
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

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
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
