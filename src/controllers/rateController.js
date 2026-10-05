'use strict';

const rateService = require('../services/rateService');
const quoteService = require('../services/quoteService');
const ApiError = require('../utils/ApiError');

/**
 * Rate and quote controllers.
 */

/**
 * GET /api/rates
 * Returns the supported currencies and their USD rate, plus freshness.
 */
function getRates(req, res) {
  const listed = rateService.listRates();
  res.json({
    base: 'USD',
    rates: listed.rates,
    freshness: listed.freshness,
  });
}

/**
 * GET /api/rates/:pair
 * Returns the rate for a single pair given as "FROM-TO", e.g. "USD-INR".
 */
function getRatePair(req, res) {
  const parts = String(req.params.pair || '').split('-');
  if (parts.length !== 2) {
    throw ApiError.badRequest('pair must be in the form FROM-TO, e.g. USD-INR');
  }
  res.json(rateService.getPair(parts[0], parts[1]));
}

/**
 * GET /api/quote?amount=&from=&to=
 * Returns an FX quote including the fee breakdown, quote identity, and freshness.
 */
function getQuote(req, res) {
  const { amount, from, to } = req.query;
  const quote = quoteService.getQuote(amount, from, to);
  res.json(quote);
}

module.exports = {
  getRates,
  getRatePair,
  getQuote,
};
