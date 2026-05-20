const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const checkAdminToken = require('../middleware/auth');
const { validateWebhook } = require('../middleware/validate');
const { broadcast } = require('./sse');

// Webhook rate limiter: Max 30 requests per IP per minute
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many webhook requests. Rate limit is 30/min.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/webhook
router.post('/webhook', checkAdminToken, webhookRateLimiter, validateWebhook, async (req, res) => {
  const { event_id, event_type, payload } = req.body;
  const client = await pool.connect();

  try {
    // Start transaction with repeatable read / serializable isolation to handle concurrent idempotency checks
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    // 1. Idempotency Check using primary key from DB
    const duplicateResult = await client.query(
      `SELECT event_id FROM webhook_events WHERE event_id = $1`,
      [event_id]
    );

    if (duplicateResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: `Webhook event ${event_id} has already been processed.`
      });
    }

    if (event_type === 'quota_reset') {
      // 2. Perform Quota Resets
      await client.query(`
        UPDATE providers 
        SET assigned_count = 0, 
            remaining_quota = monthly_quota
      `);

      // 3. Reset Round-Robin pointers
      await client.query(`
        UPDATE allocation_state 
        SET last_provider_index = 0, 
            updated_at = NOW()
      `);

      // 4. Save Event to DB (Idempotency log)
      await client.query(
        `INSERT INTO webhook_events (event_id, event_type, payload) 
         VALUES ($1, $2, $3)`,
        [event_id, event_type, JSON.stringify(payload || {})]
      );

      await client.query('COMMIT');

      // 5. Broadcast SSE event
      broadcast({ type: 'quota_reset' });

      return res.status(200).json({
        success: true,
        duplicate: false,
        message: 'Quotas successfully reset. Round robin pointers updated.'
      });

    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Unsupported event type: ${event_type}` });
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Webhook Process Error]: ${err.message}`);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
