'use strict';

const config = require('../config');
const { store } = require('../store');
const rateService = require('./rateService');
const stellarService = require('./stellarService');
const { createProbePool } = require('./inFlightProbe');
const probePool = createProbePool();

/**
 * Dependency-aware readiness diagnostics.
 *
 * Separates process liveness from traffic readiness by probing the store
 * (database stand-in), payment provider (Stellar), and FX rate table with
 * a per-check time budget. Failures surface as stable, redacted reason
 * codes — never raw messages, stacks, or connection material — and completed
 * probes are re-evaluated on the next request so recovery does not require
 * a process restart.
 */

/** Stable dependency names exposed on the readiness payload. */
const DEPENDENCIES = Object.freeze(['store', 'payments', 'fx']);

/** Reason codes returned to callers. Keep these stable for monitors. */
const REASON = Object.freeze({
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  STORE_TIMEOUT: 'STORE_TIMEOUT',
  PAYMENTS_UNAVAILABLE: 'PAYMENTS_UNAVAILABLE',
  PAYMENTS_TIMEOUT: 'PAYMENTS_TIMEOUT',
  FX_UNAVAILABLE: 'FX_UNAVAILABLE',
  FX_TIMEOUT: 'FX_TIMEOUT',
  CHECK_ERROR: 'CHECK_ERROR',
});

/**
 * Test-only overrides. A Map of dependency name -> override descriptor:
 *   { mode: 'fail', reason?: string }
 *   { mode: 'timeout', delayMs?: number }
 *   { mode: 'throw', message?: string }  // message is redacted from responses
 * Cleared between tests so forced failures never stick across process life.
 * @type {Map<string, {mode: string, reason?: string, delayMs?: number, message?: string}>}
 */
const forcedStates = new Map();

/**
 * Default probe implementations. Each returns a Promise that resolves on
 * success or rejects with an Error carrying a `reasonCode`.
 */
const defaultProbes = Object.freeze({
  async store() {
    if (!store || !(store.users instanceof Map) || !(store.transfers instanceof Map)) {
      const err = new Error('store unavailable');
      err.reasonCode = REASON.STORE_UNAVAILABLE;
      throw err;
    }
    // Touch the maps so a corrupted store surfaces as unavailable.
    void store.users.size;
    void store.transfers.size;
    return { ok: true };
  },

  async payments(ping = stellarService.ping) {
    const result = await ping.call(stellarService);
    if (!result || result.ok !== true) {
      const err = new Error('payments unavailable');
      err.reasonCode = REASON.PAYMENTS_UNAVAILABLE;
      throw err;
    }
    return { ok: true };
  },

  async fx(ping = rateService.ping) {
    const result = await ping.call(rateService);
    if (!result || result.ok !== true) {
      const err = new Error('fx unavailable');
      err.reasonCode = REASON.FX_UNAVAILABLE;
      throw err;
    }
    return { ok: true };
  },
});

/** Active probes — start as defaults; tests may replace individual ones. */
const probes = {
  store: defaultProbes.store,
  payments: defaultProbes.payments,
  fx: defaultProbes.fx,
};

/**
 * Resolve the per-check timeout budget in milliseconds.
 * @returns {number}
 */
function checkTimeoutMs() {
  return normaliseTimeoutMs(config.health && config.health.checkTimeoutMs, 1000);
}

/** Keep the advertised budget equal to a representable Node timer delay. */
function normaliseTimeoutMs(raw, fallback) {
  const n = Number(raw);
  // Node turns overflowing delays into 1 ms instead of waiting longer.
  return Number.isFinite(n) && n > 0 && n <= 2147483647
    ? Math.max(1, Math.trunc(n)) : fallback;
}

/**
 * Race a probe against a hard deadline. The original promise is not
 * cancelled (Node has no Abort for plain promises), but readiness never
 * waits longer than the budget.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {string} timeoutReason
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms, timeoutReason) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('dependency check timed out');
      err.reasonCode = timeoutReason;
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
    // Do not keep the process alive solely for a readiness timer.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Map an arbitrary failure to a redacted reason code. Raw messages and
 * stacks never leave this function.
 * @param {string} name
 * @param {unknown} err
 * @returns {string}
 */
function redactReason(name, err) {
  const code = err && typeof err === 'object' ? err.reasonCode : undefined;
  const codeMatchesDependency =
    code === REASON.CHECK_ERROR ||
    (name === 'store' &&
      (code === REASON.STORE_UNAVAILABLE || code === REASON.STORE_TIMEOUT)) ||
    (name === 'payments' &&
      (code === REASON.PAYMENTS_UNAVAILABLE || code === REASON.PAYMENTS_TIMEOUT)) ||
    (name === 'fx' &&
      (code === REASON.FX_UNAVAILABLE || code === REASON.FX_TIMEOUT));
  if (codeMatchesDependency) {
    return code;
  }

  const timeouts = {
    store: REASON.STORE_TIMEOUT,
    payments: REASON.PAYMENTS_TIMEOUT,
    fx: REASON.FX_TIMEOUT,
  };
  if (err && typeof err === 'object' && err.code === 'TIMEOUT') {
    return timeouts[name] || REASON.CHECK_ERROR;
  }

  const unavailable = {
    store: REASON.STORE_UNAVAILABLE,
    payments: REASON.PAYMENTS_UNAVAILABLE,
    fx: REASON.FX_UNAVAILABLE,
  };
  return unavailable[name] || REASON.CHECK_ERROR;
}

/**
 * Apply a test override before the real probe, if one is set.
 * @param {string} name
 * @returns {Promise<unknown>|null} a substitute promise, or null to run the real probe
 */
function applyForcedState(name) {
  const forced = forcedStates.get(name);
  if (!forced) return null;

  if (forced.mode === 'fail') {
    const err = new Error('forced failure');
    err.reasonCode =
      forced.reason ||
      ({
        store: REASON.STORE_UNAVAILABLE,
        payments: REASON.PAYMENTS_UNAVAILABLE,
        fx: REASON.FX_UNAVAILABLE,
      }[name] || REASON.CHECK_ERROR);
    return Promise.reject(err);
  }

  if (forced.mode === 'timeout') {
    const delay = Number(forced.delayMs) > 0 ? Number(forced.delayMs) : checkTimeoutMs() * 5;
    return new Promise((resolve) => {
      const t = setTimeout(resolve, delay);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  if (forced.mode === 'throw') {
    // Deliberately include sensitive-looking content so redaction tests can
    // assert it never reaches the HTTP response.
    const err = new Error(
      forced.message ||
        'postgres://user:super-secret@db.internal:5432/remitflow leaked'
    );
    return Promise.reject(err);
  }

  return null;
}

/**
 * Run a single named dependency check under the shared time budget.
 * @param {string} name
 * @param {number} [timeoutMs]
 * @returns {Promise<{name: string, status: 'ok'|'error', reason?: string, latencyMs: number}>}
 */
async function runCheck(name, timeoutMs = checkTimeoutMs()) {
  timeoutMs = normaliseTimeoutMs(timeoutMs, checkTimeoutMs());
  const started = Date.now();
  const timeoutReason = {
    store: REASON.STORE_TIMEOUT,
    payments: REASON.PAYMENTS_TIMEOUT,
    fx: REASON.FX_TIMEOUT,
  }[name] || REASON.CHECK_ERROR;

  try {
    const forced = applyForcedState(name);
    const probe = typeof probes[name] === 'function' ? probes[name] : null;
    if (!probe && !forced) {
      const err = new Error('unknown dependency');
      err.reasonCode = REASON.CHECK_ERROR;
      throw err;
    }
    // Replacing an adapter must not keep joining its predecessor's hung call.
    // Capture that method now, including its receiver, before deferred execution.
    const adapter = probe === defaultProbes.payments ? stellarService.ping
      : probe === defaultProbes.fx ? rateService.ping : probe;
    const invoke = probe === defaultProbes.payments || probe === defaultProbes.fx
      ? () => probe(adapter) : probe;
    const subscription = forced ? null : probePool.acquire(name, invoke, adapter);
    try {
      await withTimeout(forced || subscription.promise, timeoutMs, timeoutReason);
    } finally {
      if (subscription) subscription.release();
    }
    return {
      name,
      status: 'ok',
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      name,
      status: 'error',
      reason: redactReason(name, err),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Evaluate every dependency. Overlapping requests share only unfinished
 * probes; each caller keeps its own deadline and completed checks are not cached.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{
 *   ready: boolean,
 *   status: 'ready'|'not_ready',
 *   checks: Record<string, {status: string, reason?: string, latencyMs: number}>,
 *   timeoutMs: number
 * }>}
 */
async function evaluateReadiness(options = {}) {
  const timeoutMs = normaliseTimeoutMs(options.timeoutMs, checkTimeoutMs());
  const results = await Promise.all(DEPENDENCIES.map((name) => runCheck(name, timeoutMs)));

  /** @type {Record<string, {status: string, reason?: string, latencyMs: number}>} */
  const checks = {};
  let ready = true;
  for (const result of results) {
    const entry = { status: result.status, latencyMs: result.latencyMs };
    if (result.reason) entry.reason = result.reason;
    checks[result.name] = entry;
    if (result.status !== 'ok') ready = false;
  }

  return {
    ready,
    status: ready ? 'ready' : 'not_ready',
    checks,
    timeoutMs,
  };
}

/**
 * Force a dependency into a known bad state for tests. Cleared with
 * `clearForcedStates` so readiness can recover without a restart.
 * @param {string} name
 * @param {{mode: 'fail'|'timeout'|'throw', reason?: string, delayMs?: number, message?: string}} state
 */
function forceDependencyState(name, state) {
  if (!DEPENDENCIES.includes(name)) {
    throw new Error(`unknown dependency: ${name}`);
  }
  forcedStates.set(name, state);
}

/** Remove every test override so subsequent probes hit the real path. */
function clearForcedStates() {
  forcedStates.clear();
}

/**
 * Replace a probe implementation (tests only). Pass `null` to restore default.
 * @param {string} name
 * @param {null|(() => Promise<unknown>)} fn
 */
function setProbeForTests(name, fn) {
  if (!DEPENDENCIES.includes(name)) {
    throw new Error(`unknown dependency: ${name}`);
  }
  probes[name] = typeof fn === 'function' ? fn : defaultProbes[name];
}

/** Restore default probes and clear forced states (tests only). */
function resetForTests() {
  probePool.clear();
  for (const name of DEPENDENCIES) {
    probes[name] = defaultProbes[name];
  }
  forcedStates.clear();
}

module.exports = {
  DEPENDENCIES,
  REASON,
  evaluateReadiness,
  runCheck,
  forceDependencyState,
  clearForcedStates,
  setProbeForTests,
  resetForTests,
  checkTimeoutMs,
};
