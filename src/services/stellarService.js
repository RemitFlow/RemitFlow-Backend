'use strict';

const config = require('../config');
const { prefixedId } = require('../utils/ids');
const logger = require('../utils/logger');

/**
 * Mock Stellar integration.
 * Real RemitFlow would submit path payments to the Stellar network.
 * Here we just fabricate deterministic-looking identifiers so the
 * rest of the app can pretend a settlement happened.
 */

/**
 * Lightweight payment-provider probe used by readiness checks.
 * Validates that the Stellar network configuration is present so a
 * misconfigured process fails readiness instead of reporting healthy.
 * @returns {{ ok: true, network: string }}
 */
function ping() {
  const network = config.stellar && config.stellar.network;
  if (typeof network !== 'string' || network.trim() === '') {
    const err = new Error('stellar network not configured');
    err.reasonCode = 'PAYMENTS_UNAVAILABLE';
    throw err;
  }
  return { ok: true, network };
}

/**
 * Pretend to submit a payment to the Stellar network.
 * @param {object} params
 * @param {number} params.amount
 * @param {string} params.currency
 * @returns {{ txHash: string, network: string, ledger: number }}
 */
function submitPayment({ amount, currency }) {
  logger.debug(`Submitting mock Stellar payment of ${amount} ${currency}`);
  return {
    txHash: prefixedId('stellar').replace('stellar_', ''),
    network: config.stellar.network,
    ledger: Math.floor(Date.now() / 1000),
  };
}

/**
 * Generate a mock claimable-balance id used when a recipient claims funds.
 * @returns {string}
 */
function createClaimableBalanceId() {
  return prefixedId('cb');
}

module.exports = {
  ping,
  submitPayment,
  createClaimableBalanceId,
};
