require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db');

const leadsRouter = require('./routes/leads');
const dashboardRouter = require('./routes/dashboard');
const webhookRouter = require('./routes/webhook');
const testtoolsRouter = require('./routes/testtools');
const sse = require('./routes/sse');

const app = express();
const port = process.env.PORT || 3000;

// Enable 'trust proxy' to correctly identify client IPs behind nginx or Cloud Run reverse proxy.
// This resolves the express-rate-limit unexpected X-Forwarded-For warning.
app.set('trust proxy', 1);

// Parse JSON request bodies
app.use(express.json());

// Serve static assets from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Mount API routes
app.use('/api', leadsRouter);
app.use('/api', dashboardRouter);
app.use('/api', webhookRouter);
app.use('/api', testtoolsRouter);
app.use('/api', sse.router);

// Serve Static HTML Pages
app.get('/request-service', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'request-service.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/test-tools', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test-tools.html'));
});

// Root route redirect
app.get('/', (req, res) => {
  res.redirect('/request-service');
});

// 404 handler for routes that aren't matched
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Global Server Error]:', err.stack || err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    status: err.status || 500
  });
});

// Start listening
const server = app.listen(port, () => {
  console.log(`===================================================`);
  console.log(`🚀 LEAD DISTRIBUTION ENGINE IS RUNNING`);
  console.log(`Port: ${port}`);
  console.log(`Node Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`Access Endpoints:`);
  console.log(`  - Customer Lead Submission: http://localhost:${port}/request-service`);
  console.log(`  - Admin & Allocation Dashboard: http://localhost:${port}/dashboard`);
  console.log(`  - Developer Testing Suite: http://localhost:${port}/test-tools`);
  console.log(`===================================================`);
});

// Graceful Shutdown Handler
let isShuttingDown = false;

async function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 Received ${signal}. Initializing graceful shutdown sequence...`);

  // 1. Notify SSE clients about server shutting down before stopping listeners
  try {
    if (sse && typeof sse.broadcast === 'function') {
      console.log('📢 Broadcasting shutdown notice to active SSE streams...');
      sse.broadcast({ type: 'shutdown', message: 'Server is restarting or shutting down...' });
    }
  } catch (err) {
    console.error('⚠️ Failed to broadcast SSE shutdown signal:', err.message);
  }

  // 2. Stop accepting new connection requests
  server.close(() => {
    console.log('✔ HTTP server closed, no longer accepting new connections.');
  });

  // 3. Close & drain client PostgreSQL connection pool
  try {
    await pool.end();
    console.log('✔ PostgreSQL connection pool has been closed cleanly.');
  } catch (err) {
    console.error('✗ Error during PostgreSQL pool closure:', err);
  }

  console.log('✔ Graceful shutdown process complete. Halting process.');
  process.exit(0);
}

// Attach listeners for standard process termination signals
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
