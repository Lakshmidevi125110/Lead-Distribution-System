require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Services
    await client.query(`
      INSERT INTO services (name) VALUES
        ('Service 1'), ('Service 2'), ('Service 3')
      ON CONFLICT (name) DO NOTHING
    `);

    // Providers (8 total, quota 10 each)
    for (let i = 1; i <= 8; i++) {
      await client.query(`
        INSERT INTO providers (name, monthly_quota, assigned_count, remaining_quota)
        VALUES ($1, 10, 0, 10)
        ON CONFLICT (name) DO NOTHING
      `, [`Provider ${i}`]);
    }

    // provider_services:
    // Service 1: Provider 1 mandatory; Providers 2,3,4 in pool (order 1,2,3)
    // Service 2: Provider 5 mandatory; Providers 6,7,8 in pool (order 1,2,3)
    // Service 3: Providers 1,4 mandatory; Providers 2,3,5,6,7,8 in pool
    const providerServices = [
      // Service 1
      { provider_name: 'Provider 1', service_name: 'Service 1', is_mandatory: true,  pool_order: 0 },
      { provider_name: 'Provider 2', service_name: 'Service 1', is_mandatory: false, pool_order: 1 },
      { provider_name: 'Provider 3', service_name: 'Service 1', is_mandatory: false, pool_order: 2 },
      { provider_name: 'Provider 4', service_name: 'Service 1', is_mandatory: false, pool_order: 3 },
      // Service 2
      { provider_name: 'Provider 5', service_name: 'Service 2', is_mandatory: true,  pool_order: 0 },
      { provider_name: 'Provider 6', service_name: 'Service 2', is_mandatory: false, pool_order: 1 },
      { provider_name: 'Provider 7', service_name: 'Service 2', is_mandatory: false, pool_order: 2 },
      { provider_name: 'Provider 8', service_name: 'Service 2', is_mandatory: false, pool_order: 3 },
      // Service 3
      { provider_name: 'Provider 1', service_name: 'Service 3', is_mandatory: true,  pool_order: 0 },
      { provider_name: 'Provider 4', service_name: 'Service 3', is_mandatory: true,  pool_order: 0 },
      { provider_name: 'Provider 2', service_name: 'Service 3', is_mandatory: false, pool_order: 1 },
      { provider_name: 'Provider 3', service_name: 'Service 3', is_mandatory: false, pool_order: 2 },
      { provider_name: 'Provider 5', service_name: 'Service 3', is_mandatory: false, pool_order: 3 },
      { provider_name: 'Provider 6', service_name: 'Service 3', is_mandatory: false, pool_order: 4 },
      { provider_name: 'Provider 7', service_name: 'Service 3', is_mandatory: false, pool_order: 5 },
      { provider_name: 'Provider 8', service_name: 'Service 3', is_mandatory: false, pool_order: 6 },
    ];

    for (const ps of providerServices) {
      await client.query(`
        INSERT INTO provider_services (provider_id, service_id, is_mandatory, pool_order)
        SELECT p.id, s.id, $3, $4
        FROM providers p, services s
        WHERE p.name = $1 AND s.name = $2
        ON CONFLICT (provider_id, service_id) DO NOTHING
      `, [ps.provider_name, ps.service_name, ps.is_mandatory, ps.pool_order]);
    }

    // Allocation state
    const services = await client.query('SELECT id FROM services ORDER BY id');
    for (const row of services.rows) {
      await client.query(`
        INSERT INTO allocation_state (service_id, last_provider_index)
        VALUES ($1, 0)
        ON CONFLICT (service_id) DO NOTHING
      `, [row.id]);
    }

    await client.query('COMMIT');
    console.log('✓ Seed complete. 3 services, 8 providers, allocation state initialized.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
