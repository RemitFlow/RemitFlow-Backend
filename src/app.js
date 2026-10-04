'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const routes = require('./routes');
const securityHeaders = require('./middleware/securityHeaders');
const cacheControl = require('./middleware/cacheControl');
const requestTimeout = require('./middleware/requestTimeout');
const requestId = require('./middleware/requestId');
const requestLogger = require('./middleware/requestLogger');
const rateLimit = require('./middleware/rateLimit');
const maintenanceMode = require('./middleware/maintenanceMode');
const jsonError = require('./middleware/jsonError');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { resolveClientIp } = require('./utils/clientIdentity');

/**
 * Build and configure the Express application.
 * Kept separate from the server bootstrap so it can be imported
 * for testing without binding to a port.
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  // Only honour X-Forwarded-* when explicitly configured. Blind trust lets
  // clients rotate forged IPs and evade the global abuse budget.
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  // Core middleware.
  app.use(securityHeaders);
  app.use(cacheControl({ policy: config.cache.defaultPolicy }));
  app.use(cors({ origin: config.corsOrigin }));

  // Assign/propagate a correlation id before logging.
  app.use(requestId);

  // HTTP request logging (morgan in dev, custom logger always).
  if (config.env !== 'test') {
    app.use(morgan('dev'));
  }
  app.use(requestLogger);

  // Apply the API budget before body parsing so invalid bodies cannot bypass it.
  app.use(
    '/api',
    rateLimit({
      name: 'global',
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      maxKeys: config.rateLimit.maxKeys,
      trustProxy: config.trustProxy,
      keyGenerator(req) {
        return resolveClientIp(req, { trustProxy: config.trustProxy });
      },
    })
  );

  app.use(express.json({ limit: config.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));
  app.use(jsonError);

  // Fail slow handlers instead of hanging the connection.
  app.use(requestTimeout({ ms: config.requestTimeoutMs }));

  // Block all non-health API traffic while maintenance mode is active.
  app.use(maintenanceMode);

  // API routes.
  app.use('/api', routes);

  // Root welcome route.
  app.get('/', (req, res) => {
    res.json({ name: 'RemitFlow API', docs: '/api/health' });
  });

  // 404 + error handling (must be last).
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
