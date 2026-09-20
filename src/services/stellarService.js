'use strict';

const config = require('../config');
const { prefixedId } = require('../utils/ids');
const logger = require('../utils/logger');

// Mock provider receipts live outside application transfer state. A real
// payment provider offers the same property through idempotency keys: retrying
// an ambiguous request returns the first settlement artifact.
const paymentReceipts = new Map();
const claimableBalanceReceipts = new Map();

/**
 * Mock Stellar integration.
 * Real RemitFlow would submit path payments to the Stellar network.
 * Here we just fabricate deterministic-looking identifiers so the
 * rest of the app can pretend a settlement happened.
 */

/**
 * Pretend to submit a payment to the Stellar network.
 * @param {object} params
 * @param {number} params.amount
 * @param {string} params.currency
 * @returns {{ txHash: string, network: string, ledger: number }}
 */
function submitPayment({ amount, currency, idempotencyKey }) {
  if (idempotencyKey && paymentReceipts.has(idempotencyKey)) {
    return paymentReceipts.get(idempotencyKey);
  }

  logger.debug(`Submitting mock Stellar payment of ${amount} ${currency}`);
  const result = {
    txHash: prefixedId('stellar').replace('stellar_', ''),
    network: config.stellar.network,
    ledger: Math.floor(Date.now() / 1000),
  };
  if (idempotencyKey) {
    paymentReceipts.set(idempotencyKey, result);
  }
  return result;
}

/**
 * Generate a mock claimable-balance id used when a recipient claims funds.
 * @returns {string}
 */
function createClaimableBalanceId(operationId) {
  if (operationId && claimableBalanceReceipts.has(operationId)) {
    return claimableBalanceReceipts.get(operationId);
  }

  const id = prefixedId('cb');
  if (operationId) {
    claimableBalanceReceipts.set(operationId, id);
  }
  return id;
}

module.exports = {
  submitPayment,
  createClaimableBalanceId,
};
