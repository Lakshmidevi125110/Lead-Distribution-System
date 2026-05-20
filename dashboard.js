const express = require('express');
const router = express.Router();
const pool = require('../db');
const checkAdminToken = require('../middleware/auth');

// GET /api/dashboard
router.get('/dashboard', checkAdminToken, async (req, res) => {
  try {
    // 1. Fetch all providers
    const providersResult = await pool.query(
      `SELECT id, name, monthly_quota, assigned_count, remaining_quota 
       FROM providers 
       ORDER BY id`
    );
    const providers = providersResult.rows;

    // 2. Fetch last 5 assignments for each provider
    for (const provider of providers) {
      const assignmentsResult = await pool.query(
        `SELECT la.lead_id, l.customer_name, s.name as service_name, la.assigned_at, l.city
         FROM lead_assignments la
         JOIN leads l ON l.id = la.lead_id
         JOIN services s ON s.id = l.service_id
         WHERE la.provider_id = $1
         ORDER BY la.assigned_at DESC, la.id DESC
         LIMIT 5`,
        [provider.id]
      );
      provider.recent_leads = assignmentsResult.rows;
    }

    // 3. Fetch total leads count
    const totalLeadsResult = await pool.query(`SELECT COUNT(*)::int as count FROM leads`);
    const totalLeads = totalLeadsResult.rows[0].count;

    // 4. Fetch last 10 leads generally
    const recentLeadsResult = await pool.query(
      `SELECT l.id, l.customer_name, l.phone, l.city, s.name as service_name, l.created_at
       FROM leads l
       JOIN services s ON s.id = l.service_id
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 10`
    );
    const recentLeads = recentLeadsResult.rows;

    // 5. Fetch allocation state
    const allocationResult = await pool.query(
      `SELECT ast.service_id, s.name as service_name, ast.last_provider_index, ast.updated_at
       FROM allocation_state ast
       JOIN services s ON s.id = ast.service_id
       ORDER BY ast.service_id`
    );
    const allocationState = allocationResult.rows;

    return res.status(200).json({
      providers,
      total_leads: totalLeads,
      recent_leads: recentLeads,
      allocation_state: allocationState
    });

  } catch (err) {
    console.error(`[Dashboard Fetch Error]: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
