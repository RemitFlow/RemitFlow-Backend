'use strict';

const config = require('../config');
const rateLimit = require('./rateLimit');
const { resolveActorKey } = require('../utils/clientIdentity');

/**
 * Route-family mutation rate limiters.
 *
 * Applied after authentication so the actor key is a token fingerprint
 * (never the raw secret). Quote stays IP-keyed because it is public.
 * Each limiter is independently bounded so one hot route cannot starve
 * another family's budget, and the shared maxKeys cap keeps memory finite.
 */

function buildLimiter(family, overrides = {}) {
  const settings = config.mutationRateLimit[family] || {};
  const trustProxy = config.trustProxy;

  return rateLimit({
    name: `mutation:${family}`,
    windowMs: overrides.windowMs || settings.windowMs,
    max: overrides.max || settings.max,
    maxKeys: overrides.maxKeys || config.mutationRateLimit.maxKeys,
    trustProxy,
    forceInTest: Boolean(overrides.forceInTest),
    keyGenerator(req) {
      return `${family}:${resolveActorKey(req, { trustProxy })}`;
    },
  });
}

const transfers = buildLimiter('transfers');
const users = buildLimiter('users');
const quote = buildLimiter('quote');
const admin = buildLimiter('admin');

/**
 * Reset every mutation limiter. Intended for tests only.
 */
function resetAll() {
  transfers.reset();
  users.reset();
  quote.reset();
  admin.reset();
}

module.exports = {
  transfers,
  users,
  quote,
  admin,
  resetAll,
  buildLimiter,
};
