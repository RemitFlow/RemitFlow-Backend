'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const routes = require('./routes');
const healthController = require('./controllers/healthController');
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

/**
 * Build and configure the Express application.
 * Kept separate from the server bootstrap so it can be imported
 * for testing without binding to a port.
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  // Core middleware.
  app.use(securityHeaders);
  app.use(cacheControl({ policy: config.cache.defaultPolicy }));
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));
  app.use(jsonError);

  // Fail slow requests instead of hanging the connection.
  app.use(requestTimeout({ ms: config.requestTimeoutMs }));

  // Assign/propagate a correlation id before logging.
  app.use(requestId);

  // HTTP request logging (morgan in dev, custom logger always).
  if (config.env !== 'test') {
    app.use(morgan('dev'));
  }
  app.use(requestLogger);

  // Process liveness must not consume or depend on the business API budget.
  // Express also serves HEAD through this GET route; other paths/methods
  // continue through the normal API middleware below.
  app.get('/api/health/live', healthController.getLiveness);

  // Basic abuse protection on the API surface.
  app.use('/api', rateLimit(config.rateLimit));

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
