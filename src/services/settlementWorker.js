'use strict';

const { store } = require('../store');
const stellarService = require('./stellarService');
const ApiError = require('../utils/ApiError');

/**
 * Idempotent settlement worker for terminal claim operations.
 *
 * Provider work is keyed by a stable operation id. Retries — including after a
 * worker-module reload that shares the same process store — return the first
 * settlement receipt instead of creating a second claimable balance.
 *
 * Receipts live in the shared store so their lifetime matches transfers: a
 * restart that clears transfers also clears receipts, keeping the two
 * consistent. When the store becomes durable, keep receipts on the same
 * boundary as the transfer row that commits the claim.
 */

/**
 * Settle a claim against the payment provider exactly once for `operationId`.
 * @param {string} operationId - stable id spanning retries of one claim attempt
 * @returns {{ operationId: string, claimableBalanceId: string, settledAt: string }}
 */
function settleClaim(operationId) {
  if (typeof operationId !== 'string' || operationId.trim() === '') {
    throw new Error('settlementWorker.settleClaim requires a non-empty operationId');
  }

  const existing = store.settlementReceipts.get(operationId);
  if (existing) {
    return existing;
  }

  const claimableBalanceId = stellarService.createClaimableBalanceId(operationId);
  // A fulfilled adapter call is not a completed settlement without its ID.
  // Reject before caching so the lifecycle stays pending and the same stable
  // provider operation can be retried after recovery. Do not coerce or expose
  // an unexpected provider payload.
  if (typeof claimableBalanceId !== 'string' || claimableBalanceId.trim() === '') {
    throw ApiError.serviceUnavailable('Payment provider returned an invalid settlement receipt', {
      code: 'SETTLEMENT_RECEIPT_INVALID',
    });
  }
  const receipt = {
    operationId,
    claimableBalanceId,
    settledAt: new Date().toISOString(),
  };
  store.settlementReceipts.set(operationId, receipt);
  return receipt;
}

/**
 * Look up a prior settlement receipt without contacting the provider.
 * @param {string} operationId
 * @returns {object|null}
 */
function getReceipt(operationId) {
  return store.settlementReceipts.get(operationId) || null;
}

module.exports = {
  settleClaim,
  getReceipt,
};
