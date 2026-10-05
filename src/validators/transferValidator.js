'use strict';

const money = require('../utils/money');
const config = require('../config');

/**
 * Validate the body for POST /api/transfers.
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
  if (amount === undefined) {
    errors.push('amount is required');
  } else if (!money.isPositiveAmount(amount)) {
    errors.push('amount must be a positive number');
  } else if (!money.isSafeAmount(amount)) {
    errors.push('amount is outside the supported numeric range');
  } else if (!money.hasValidPrecision(amount)) {
    errors.push(`amount must have at most ${money.DECIMALS} decimal places`);
  } else if (Number(amount) > config.maxTransferAmount) {
    errors.push(`amount must not exceed ${config.maxTransferAmount}`);
  }
  if (!from) {
    errors.push('from currency is required');
  }
  if (!to) {
    errors.push('to currency is required');
  }
  if (from && to && from === to) {
    errors.push('from and to currencies must differ');
  }
  if (body.quoteId != null && (typeof body.quoteId !== 'string' || body.quoteId.trim() === '')) {
    errors.push('quoteId must be a non-empty string when provided');
  }

  return errors;
}

module.exports = {
  validateCreateTransfer,
};
