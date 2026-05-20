const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { validateLead } = require('../middleware/validate');
const { assignProviders } = require('../logic/allocator');
const { broadcast } = require('./sse');

// Rate limiter: Max 10 requests per IP per 15 minutes
const leadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many lead submissions from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting if valid admin credentials are sent in request headers
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      return token === process.env.ADMIN_TOKEN;
    }
    return false;
  }
});

// POST /api/leads
router.post('/leads', leadRateLimiter, validateLead, async (req, res) => {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(2, 11);
  const { name, phone, city, service_id, description } = req.body;

  let leadId = null;
  const client = await pool.connect();

  try {
    // Insert lead using SERIALIZABLE isolation to handle concurrent duplicate phone+service checks strictly
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    const insertResult = await client.query(
      `INSERT INTO leads (customer_name, phone, city, service_id, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, phone, city, service_id, description || null]
    );

    leadId = insertResult.rows[0].id;
    await client.query('COMMIT');

  } catch (err) {
    await client.query('ROLLBACK');

    const durationMs = Date.now() - startTime;
    console.error(`[Lead Post Error] Request: ${requestId}, Duration: ${durationMs}ms, Error: ${err.message}`);

    // Check for unique database constraint error (idx_leads_phone_service)
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'A lead with this phone number and service already exists.',
        code: 'DUPLICATE_LEAD'
      });
    }

    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  // Assign the exactly 3 providers using the allocator which manages its own db transaction
  try {
    const assignedProviderIds = await assignProviders(leadId, service_id, pool);
    const durationMs = Date.now() - startTime;

    console.log(`[Lead Post Success] Request: ${requestId}, Lead ID: ${leadId}, Service ID: ${service_id}, Assigned: [${assignedProviderIds.join(', ')}], Duration: ${durationMs}ms`);

    // Broadcast update via Server-Sent Events
    broadcast({
      type: 'lead_assigned',
      leadId,
      serviceId: service_id,
      assignedProviderIds
    });

    return res.status(201).json({
      success: true,
      lead_id: leadId,
      assigned_providers: assignedProviderIds,
      message: 'Lead successfully submitted and assigned to 3 providers.'
    });

  } catch (err) {
    // If provider allocation fails, we must clean up the unallocated lead
    // so we don't end up with phantom or unassigned leads in the database.
    try {
      await pool.query('DELETE FROM leads WHERE id = $1', [leadId]);
    } catch (deleteErr) {
      console.error(`[Rollback Lead Delete Failed] Lead ID: ${leadId}, Error: ${deleteErr.message}`);
    }

    const durationMs = Date.now() - startTime;
    console.error(`[Allocation Failure] Request: ${requestId}, Lead ID: ${leadId}, Duration: ${durationMs}ms, Error: ${err.message}`);

    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
