const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const checkAdminToken = require('../middleware/auth');

// Helper to determine base URL
function getBaseUrl() {
  const port = process.env.PORT || 3000;
  return process.env.BASE_URL || `http://localhost:${port}`;
}

// Helper for delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// All routes are protected by admin auth
router.use(checkAdminToken);

// POST /api/test/reset-quotas
router.post('/test/reset-quotas', async (req, res) => {
  const eventId = uuidv4();
  const baseUrl = getBaseUrl();
  const token = process.env.ADMIN_TOKEN;

  try {
    const response = await fetch(`${baseUrl}/api/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        event_id: eventId,
        event_type: 'quota_reset',
        payload: { triggered_by: 'test_tools' }
      })
    });

    const data = await response.json();
    return res.status(response.status).json({
      event_id: eventId,
      webhook_response: data
    });
  } catch (err) {
    return res.status(500).json({ error: `Internal fetch failed: ${err.message}` });
  }
});

// POST /api/test/trigger-webhook
router.post('/test/trigger-webhook', async (req, res) => {
  const eventId = uuidv4();
  const baseUrl = getBaseUrl();
  const token = process.env.ADMIN_TOKEN;
  const results = [];

  try {
    // Fire the same event_id 5 times sequentially
    for (let i = 1; i <= 5; i++) {
      try {
        const response = await fetch(`${baseUrl}/api/webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            event_id: eventId,
            event_type: 'quota_reset',
            payload: { attempt: i }
          })
        });

        const data = await response.json();
        results.push({
          attempt: i,
          status: response.status,
          data
        });
      } catch (innerErr) {
        results.push({
          attempt: i,
          status: 500,
          error: innerErr.message
        });
      }
    }

    const processed = results.filter(r => r.status === 200 && r.data && !r.data.duplicate).length;
    const ignored = results.filter(r => r.status === 200 && r.data && r.data.duplicate).length;

    return res.status(200).json({
      event_id: eventId,
      results,
      summary: { processed, ignored }
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed running webhooks task: ${err.message}` });
  }
});

// POST /api/test/generate-leads
router.post('/test/generate-leads', async (req, res) => {
  const baseUrl = getBaseUrl();
  const servicesCycle = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1];
  const results = [];
  const token = process.env.ADMIN_TOKEN;

  let successful = 0;
  let failed = 0;

  try {
    for (let i = 0; i < servicesCycle.length; i++) {
      const serviceId = servicesCycle[i];
      // Generate unique phone suffix to avoid DUPLICATE_LEAD checks
      const randSuffix = Math.floor(100000 + Math.random() * 900000);
      const phone = `+447111${randSuffix}`;

      try {
        const response = await fetch(`${baseUrl}/api/leads`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Send token to skip rate limits if configured (else limit is 10)
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            name: `Load Test Customer ${i + 1}`,
            phone,
            city: ['London', 'Birmingham', 'Leeds', 'Manchester', 'Glasgow'][i % 5],
            service_id: serviceId,
            description: `Auto generated test lead number ${i + 1}`
          })
        });

        const data = await response.json();
        if (response.status === 201) {
          successful++;
        } else {
          failed++;
        }

        results.push({
          lead_num: i + 1,
          service_id: serviceId,
          status: response.status,
          data
        });

      } catch (innerErr) {
        failed++;
        results.push({
          lead_num: i + 1,
          service_id: serviceId,
          status: 500,
          error: innerErr.message
        });
      }

      await delay(30); // 30ms delay
    }

    return res.status(200).json({
      total: servicesCycle.length,
      successful,
      failed,
      results
    });
  } catch (err) {
    return res.status(500).json({ error: `Sequential generation task failed: ${err.message}` });
  }
});

// POST /api/test/concurrent-leads
router.post('/test/concurrent-leads', async (req, res) => {
  const baseUrl = getBaseUrl();
  const token = process.env.ADMIN_TOKEN;
  const promises = [];

  // Generate 5 simultaneous requests with random unique phones for Service 1
  for (let i = 1; i <= 5; i++) {
    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const phone = `+447222552${randSuffix}`;

    const promise = fetch(`${baseUrl}/api/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        name: `Concurrent Cust ${i}`,
        phone,
        city: 'Bristol',
        service_id: 1, // Focus testing on Service 1
        description: 'Concurrency stress test lead'
      })
    }).then(async (res) => {
      const data = await res.json();
      return { status: res.status, data };
    }).catch((err) => {
      return { status: 500, error: err.message };
    });

    promises.push(promise);
  }

  try {
    const settleResults = await Promise.allSettled(promises);
    const results = settleResults.map((r, idx) => {
      if (r.status === 'fulfilled') {
        return { attempt: idx + 1, ...r.value };
      }
      return { attempt: idx + 1, status: 500, error: r.reason };
    });

    const successful = results.filter(r => r.status === 201).length;
    const failed = results.filter(r => r.status !== 201).length;

    return res.status(200).json({
      total_fired: 5,
      successful,
      failed,
      results
    });
  } catch (err) {
    return res.status(500).json({ error: `Concurrency task failed: ${err.message}` });
  }
});

module.exports = router;
