'use strict';

const currencyPolicy = require('../utils/currencyPolicy');

/**
 * Validate the body for POST /api/transfers.
 * Amount and currency rules come from the shared currency policy so the
 * HTTP layer rejects the same inputs that settlement would reject.
 * @param {import('express').Request} req
 * @returns {string[]} list of error messages.
 */
function validateCreateTransfer(req) {
  const errors = [];
  const body = req.body || {};
  const { senderName, recipientName, amount, from, to } = body;

  if (!senderName || typeof senderName !== 'string') {
    errors.push('senderName is required');
  }
  if (!recipientName || typeof recipientName !== 'string') {
    errors.push('recipientName is required');
  }

  errors.push(
    ...currencyPolicy.validateTransferPair(amount, from, to, { enforceMax: true })
  );

  return errors;
}

module.exports = {
  validateCreateTransfer,
};
