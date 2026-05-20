DROP TABLE IF EXISTS webhook_events CASCADE;
DROP TABLE IF EXISTS lead_assignments CASCADE;
DROP TABLE IF EXISTS allocation_state CASCADE;
DROP TABLE IF EXISTS leads CASCADE;
DROP TABLE IF EXISTS provider_services CASCADE;
DROP TABLE IF EXISTS providers CASCADE;
DROP TABLE IF EXISTS services CASCADE;

CREATE TABLE services (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE providers (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL UNIQUE,
  monthly_quota   INTEGER NOT NULL DEFAULT 10,
  assigned_count  INTEGER NOT NULL DEFAULT 0,
  remaining_quota INTEGER NOT NULL DEFAULT 10,
  CONSTRAINT remaining_quota_non_negative CHECK (remaining_quota >= 0),
  CONSTRAINT assigned_count_non_negative  CHECK (assigned_count  >= 0)
);

-- Explicit provider-to-service relationship (replaces hardcoded JS pools)
CREATE TABLE provider_services (
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
  pool_order   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, service_id)
);

CREATE TABLE leads (
  id            SERIAL PRIMARY KEY,
  customer_name VARCHAR(255) NOT NULL,
  phone         VARCHAR(30)  NOT NULL,
  city          VARCHAR(100) NOT NULL,
  service_id    INTEGER NOT NULL REFERENCES services(id),
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Database-level constraint: same phone cannot submit the same service twice
CREATE UNIQUE INDEX idx_leads_phone_service ON leads(phone, service_id);

CREATE TABLE lead_assignments (
  id          SERIAL PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_lead_provider UNIQUE(lead_id, provider_id)
);

-- Allocation state: one row per service, persists round-robin pointer
-- Locked FOR UPDATE during every allocation to serialize concurrent requests
CREATE TABLE allocation_state (
  service_id          INTEGER PRIMARY KEY REFERENCES services(id),
  last_provider_index INTEGER NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook idempotency log
CREATE TABLE webhook_events (
  event_id     VARCHAR(255) PRIMARY KEY,
  event_type   VARCHAR(100) NOT NULL,
  payload      JSONB,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_assignments_provider ON lead_assignments(provider_id);
CREATE INDEX idx_assignments_lead     ON lead_assignments(lead_id);
CREATE INDEX idx_leads_created        ON leads(created_at DESC);
CREATE INDEX idx_provider_services_service ON provider_services(service_id);
