# Lead Distribution Engine (DATA_ENGINE_PRO)

A production-grade, transaction-safe lead distribution and allocation engine built with Node.js, Express, and PostgreSQL. It delivers strict double-submission protection, high-throughput round-robin and mandatory allocation logic, automated quota capping, real-time analytics broadcasting, and webhook audit trails.

---

## Architecture Overview

The Lead Distribution Engine is designed for high consistency, zero-leak allocations, and absolute correctness under concurrent load. Handled entirely server-side, it couples PostgreSQL database constraints with transactional logic to safely process, route, and audit operations.

```
Incoming Customer Lead
          │
          ▼
   Express Server (/api/leads)
          │
  ┌───────┴────────────────────────┐
  │ Begin SERIALIZABLE Transaction │
  ├────────────────────────────────┤
  │ 1. Validate Double Submission  │
  │    (Phone + Service Index)     │
  │                                │
  │ 2. Acquire locks:              │
  │    - allocation_state row      │
  │    - provider records          │
  │                                │
  │ 3. Allocate Providers:         │
  │    - Mandatory providers first  │
  │    - Additional slots via DB-   │
  │      tracked Round-Robin ptr   │
  │                                │
  │ 4. Update quotas and pointer   │
  │                                │
  │ 5. Log Assignment History      │
  └───────┬────────────────────────┘
          │
          ▼
   Commit & Broadcast Live Updates via SSE (Server-Sent Events)
```

### Core Components

1. **Transactional Allocator (`logic/allocator.js`)**: Encapsulates lead assignment within a single PostgreSQL transaction executing at the `SERIALIZABLE` isolation level. It implements automatic backoff-jitter retries for serialization conflicts (error `40001`).
2. **Real-time Event Bridge (`routes/sse.js`)**: Uses HTTP Server-Sent Events to stream allocation state, quota exhaustion, and incoming leads to the dashboard in real-time.
3. **Idempotency Auditor (`routes/webhook.js`)**: Processes external administrative events (such as `quota_reset`) with verified idempotency check logs to prevent replay exploits.
4. **Developer Workstation (`routes/testtools.js` & `public/test-tools.html`)**: A simulated testing environment that drives automated sequential, concurrent, and webhook-retry evaluation routines.

---

## Correctness & Transactional Guarantees

Many Lead Routing Systems suffer from race conditions, overrunning quotas, and duplicate distribution. This engine addresses these challenges with built-in database-level guarantees:

### 1. Zero-Leak Quota Allocations
Instead of checking quotas in-memory (which leads to double-allocation under load), the system performs **pessimistic row locking** (`FOR UPDATE` and `FOR UPDATE OF p`) when calculating eligible pools. Quota increments and remaining-limit decrements occur inside the active transaction. If a provider's database-level `remaining_quota` hits `0`, a CHECK constraint prevents any further allocations.

### 2. High-Concurrency Pointer Serialization
Multiple requests submitting leads for the same service are serialized at the database queue. The first transaction locks the `allocation_state` row for that `service_id`. Sequential or concurrent requests wait until the transaction commits, ensuring the round-robin pointer is advanced predictably.

### 3. PostgreSQL SERIALIZABLE Isolation with Jittered Retry
To prevent dirty reads, non-repeatable reads, or phantom reads, the entire sequence runs within `ISOLATION LEVEL SERIALIZABLE`. If the database identifies a serialization hazard, it rolls back gracefully, releases locks, waits for a randomized jitter (20ms – 100ms), and retries up to 3 times before returning an error.

### 4. Duplicate Submission Control
To eliminate double entries, the database maintains a unique constraint over `leads(phone, service_id)`. If the same customer tries to submit multiple requests for the same service, a database conflict aborts the transaction before any provider quota is reduced or allocated.

### 5. Webhook Idempotency Logs
All inbound webhook triggers require a unique transaction index (`event_id`). Before executing any reset actions, the processor checks the `webhook_events` table within a transaction. If the key exists, it rejects processing, guaranteeing exactly-once semantics.

---

## Database Schema

The database model is defined in `schema.sql` and consists of five core entities, relation bindings, and index optimizations:

*   **`services`**: Services supplied by the platform (e.g., Roofing, Plumbing, Solar installation).
*   **`providers`**: Registries of active partners carrying fixed allocations, assigned tracking counts, and active current quotas.
*   **`provider_services`**: Relationships binding specific partners to target services, detailing pool ordering, and prioritizing priority mandatories (`is_mandatory = TRUE`).
*   **`leads`**: Leads captured on customer submission. Features a multi-column unique constraint (`phone`, `service_id`).
*   **`lead_assignments`**: Dynamic logs linking assigned provider IDs to completed leads.
*   **`allocation_state`**: Stores the current round-robin array pointer offset index for each service.
*   **`webhook_events`**: Idempotency ledger storing webhook IDs and payloads.

---

## Configuration & Environment Variables

Create a `.env` file in the root directory targeting your specific runtime environment. Refer to `.env.example` as a template:

```ini
DATABASE_URL=postgresql://postgres:password@localhost:5432/lead_distribution
PORT=3000
BASE_URL=http://localhost:3000
ADMIN_TOKEN=your-secret-admin-token-here
NODE_ENV=development
```

---

## Setup & Detailed Instructions

Follow these steps to initialize and start the server:

### 1. Install Dependencies
```bash
npm install
```

### 2. Database Provisioning & Population
Verify PostgreSQL is running and your `DATABASE_URL` is configured correctly. Migrate and seed:

```bash
# Execute Schema Creation
npm run db:init

# Seed initial Services, Providers, and Allocation Pointers
npm run seed
```

### 3. Launching the Server

*   **Development Mode** (with hot reload watching server entries):
    ```bash
    npm run dev
    ```
*   **Production Execution**:
    ```bash
    npm run start
    ```

The service will output operational endpoints on port `3000`.

---

## API Specifications

All endpoints are authenticated where applicable and interface using JSON payloads.

### 1. Inbound Leads Controller
Submit a customer service lead to the system and trigger automated allocation.

*   **Endpoint**: `POST /api/leads`
*   **Headers**: `Content-Type: application/json`
*   **Body Schema**:
    ```json
    {
      "customer_name": "Liam Sterling",
      "phone": "+15550198811",
      "city": "Seattle",
      "service_name": "Roofing",
      "description": "Looking for residential slate inspection."
    }
    ```
*   **Response (Success - 201 Created)**:
    ```json
    {
      "message": "Lead allocated and distributed successfully",
      "lead_id": 41,
      "assigned_providers": [1, 3, 5]
    }
    ```

### 2. Monitoring Dashboard Feed
Retrieves the aggregated cluster state, partner lists, remaining quotas, active allocations, and historical leads.

*   **Endpoint**: `GET /api/dashboard`
*   **Headers**: `Authorization: Bearer <ADMIN_TOKEN>`
*   **Response (200 OK)**:
    ```json
    {
      "total_leads": 145,
      "providers": [
        {
          "id": 1,
          "name": "Apex Roofing",
          "monthly_quota": 20,
          "assigned_count": 12,
          "remaining_quota": 8,
          "recent_leads": [
            { "lead_id": 41, "customer_name": "Liam Sterling", "city": "Seattle" }
          ]
        }
      ],
      "allocation_state": [
        { "service_id": 1, "service_name": "Roofing", "last_provider_index": 2, "updated_at": "2026-05-20T03:40:00Z" }
      ],
      "recent_leads": [
        { "id": 41, "customer_name": "Liam Sterling", "service_name": "Roofing", "city": "Seattle", "created_at": "2026-05-20T03:40:00Z" }
      ]
    }
    ```

### 3. Command Webhook Receiver
Idempotent webhook integration to perform systems reset (e.g., automated monthly quota replenishment).

*   **Endpoint**: `POST /api/webhook`
*   **Headers**: `Content-Type: application/json`
*   **Body Schema**:
    ```json
    {
      "event_id": "evt_reset_2026_05",
      "event_type": "quota_reset",
      "payload": {}
    }
    ```
*   **Response (Success - 200 OK)**:
    ```json
    {
      "success": true,
      "message": "Quotas reset back to default ceilings safely."
    }
    ```

### 4. Real-Time Streaming (SSE)
Establishes a persistent Server-Sent Events stream to receive instant visual updates.

*   **Endpoint**: `GET /api/events`
*   **Response Header**: `Content-Type: text/event-stream`

---

## Interactive Testing Workflow

The application packages a fully sandboxed **Developer Testing Suite** to evaluate high-throughput stress, race conditions, and error recovery:

### Accessing the Workbench
Navigate to `http://localhost:3000/test-tools` or click **Developer Test Workbench** in the bottom footer of the monitoring panel. Provide your `ADMIN_TOKEN` when prompted to authorize test executions.

### Integrated Test Suites

1.  **Sequential Pipeline Check**: Submits a list of test leads in linear order, showing real-time allocation state, pointer movements, and standard round-robin rotation.
2.  **Concurrent Race Condition Simulation**: Fires multiple overlapping requests simultaneously. This allows devs to test and verify transaction isolation levels, row locks, and auto-retry sequences directly inside the terminal window.
3.  **Webhook Idempotency & Retry Test**: Simulates webhook traffic sending multiple identical event IDs. It verifies that identical payloads are processed exactly once, while sequential new actions execute correctly.
4.  **Force Quota Reset**: Fast-triggers the Reset Webhook simulator to replenish all provider quotas, reviving exhausted channels instantly.
