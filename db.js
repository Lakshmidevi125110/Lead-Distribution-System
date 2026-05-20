require('dotenv').config();
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db_state.json');

// Default initial database layout (matches seed.js)
function getDefaultDb() {
  const services = [
    { id: 1, name: 'Service 1' },
    { id: 2, name: 'Service 2' },
    { id: 3, name: 'Service 3' },
  ];

  const providers = [];
  for (let i = 1; i <= 8; i++) {
    providers.push({
      id: i,
      name: `Provider ${i}`,
      monthly_quota: 10,
      assigned_count: 0,
      remaining_quota: 10
    });
  }

  const provider_services = [
    // Service 1: Provider 1 mandatory, 2,3,4 pool
    { provider_id: 1, service_id: 1, is_mandatory: true,  pool_order: 0 },
    { provider_id: 2, service_id: 1, is_mandatory: false, pool_order: 1 },
    { provider_id: 3, service_id: 1, is_mandatory: false, pool_order: 2 },
    { provider_id: 4, service_id: 1, is_mandatory: false, pool_order: 3 },
    // Service 2: Provider 5 mandatory, 6,7,8 pool
    { provider_id: 5, service_id: 2, is_mandatory: true,  pool_order: 0 },
    { provider_id: 6, service_id: 2, is_mandatory: false, pool_order: 1 },
    { provider_id: 7, service_id: 2, is_mandatory: false, pool_order: 2 },
    { provider_id: 8, service_id: 2, is_mandatory: false, pool_order: 3 },
    // Service 3: Providers 1, 4 mandatory, 2,3,5,6,7,8 pool
    { provider_id: 1, service_id: 3, is_mandatory: true,  pool_order: 0 },
    { provider_id: 4, service_id: 3, is_mandatory: true,  pool_order: 0 },
    { provider_id: 2, service_id: 3, is_mandatory: false, pool_order: 1 },
    { provider_id: 3, service_id: 3, is_mandatory: false, pool_order: 2 },
    { provider_id: 5, service_id: 3, is_mandatory: false, pool_order: 3 },
    { provider_id: 6, service_id: 3, is_mandatory: false, pool_order: 4 },
    { provider_id: 7, service_id: 3, is_mandatory: false, pool_order: 5 },
    { provider_id: 8, service_id: 3, is_mandatory: false, pool_order: 6 },
  ];

  const allocation_state = [
    { service_id: 1, last_provider_index: 0, updated_at: new Date().toISOString() },
    { service_id: 2, last_provider_index: 0, updated_at: new Date().toISOString() },
    { service_id: 3, last_provider_index: 0, updated_at: new Date().toISOString() },
  ];

  return {
    version: 1,
    services,
    providers,
    provider_services,
    leads: [],
    lead_assignments: [],
    allocation_state,
    webhook_events: []
  };
}

let globalDbState = null;

function loadDb() {
  if (globalDbState) {
    return globalDbState;
  }
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      globalDbState = JSON.parse(data);
      return globalDbState;
    } catch (e) {
      console.error('[Mock Database Connection]: Fail reading state file, fall back to seed values:', e);
    }
  }
  globalDbState = getDefaultDb();
  saveDb(globalDbState);
  return globalDbState;
}

function saveDb(state) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[Mock Database Connection]: Error writing DB state file:', e);
  }
}

function executeQuery(state, sql, params = []) {
  const s = sql.trim().replace(/\s+/g, ' ');

  // 1. Transactions & timeouts
  if (/^BEGIN/i.test(s)) return { rows: [] };
  if (/^COMMIT/i.test(s)) return { rows: [] };
  if (/^ROLLBACK/i.test(s)) return { rows: [] };
  if (/^SET LOCAL/i.test(s)) return { rows: [] };

  // 2. Load providers list
  if (/SELECT.*FROM\s+providers\s+ORDER BY\s+id/i.test(s)) {
    const list = [...state.providers].sort((a, b) => a.id - b.id);
    return { rows: list };
  }

  // 3. Count leads
  if (/COUNT\(\*\)/i.test(s) && /FROM\s+leads/i.test(s)) {
    return { rows: [{ count: state.leads.length }] };
  }

  // 4. Load allocation states
  if (/SELECT\s+ast\.service_id/i.test(s)) {
    const list = state.allocation_state.map(ast => {
      const srv = state.services.find(x => x.id === ast.service_id);
      return {
        service_id: ast.service_id,
        service_name: srv ? srv.name : `Service ${ast.service_id}`,
        last_provider_index: ast.last_provider_index,
        updated_at: ast.updated_at
      };
    }).sort((a, b) => a.service_id - b.service_id);
    return { rows: list };
  }

  // 5. Query last 10 general leads list
  if (/SELECT\s+l\.id,\s*l\.customer_name,\s*l\.phone,\s*l\.city,\s*s\.name/i.test(s)) {
    const list = state.leads.map(l => {
      const srv = state.services.find(x => x.id === l.service_id);
      return {
        id: l.id,
        customer_name: l.customer_name,
        phone: l.phone,
        city: l.city,
        service_name: srv ? srv.name : `Service ${l.service_id}`,
        created_at: l.created_at
      };
    }).sort((a, b) => {
      const timeA = new Date(a.created_at).getTime();
      const timeB = new Date(b.created_at).getTime();
      if (timeA !== timeB) return timeB - timeA;
      return b.id - a.id;
    }).slice(0, 10);
    return { rows: list };
  }

  // 6. Query assignments per provider (last 5)
  if (/WHERE\s+la\.provider_id\s*=\s*\$1/i.test(s) && /ORDER BY\s+la\.assigned_at DESC/i.test(s)) {
    const pId = Number(params[0]);
    const filtered = state.lead_assignments.filter(la => la.provider_id === pId);
    filtered.sort((a, b) => {
      const timeA = new Date(a.assigned_at).getTime();
      const timeB = new Date(b.assigned_at).getTime();
      if (timeA !== timeB) return timeB - timeA;
      return b.id - a.id;
    });
    const limited = filtered.slice(0, 5);
    const rows = limited.map(la => {
      const lead = state.leads.find(l => l.id === la.lead_id);
      const srv = lead ? state.services.find(x => x.id === lead.service_id) : null;
      return {
        lead_id: la.lead_id,
        customer_name: lead ? lead.customer_name : 'Load Test Lead',
        service_name: srv ? srv.name : 'Unknown Service',
        assigned_at: la.assigned_at,
        city: lead ? lead.city : 'Standard Area'
      };
    });
    return { rows };
  }

  // 7. Webhook event duplicate lookup
  if (/FROM\s+webhook_events\s+WHERE\s+event_id/i.test(s)) {
    const evtId = params[0];
    const found = state.webhook_events.filter(e => e.event_id === evtId);
    return { rows: found.map(e => ({ event_id: e.event_id })) };
  }

  // 8. Select allocations state per service
  if (/FROM\s+allocation_state\s+WHERE\s+service_id/i.test(s)) {
    const serviceId = Number(params[0]);
    const found = state.allocation_state.filter(ast => ast.service_id === serviceId);
    return { rows: found.map(ast => ({ service_id: ast.service_id, last_provider_index: ast.last_provider_index })) };
  }

  // 9. Load mandatory provider relation rows
  if (/WHERE\s+ps\.service_id\s*=\s*\$1.*ps\.is_mandatory\s*=\s*TRUE/i.test(s)) {
    const serviceId = Number(params[0]);
    const filteredRelations = state.provider_services.filter(ps => ps.service_id === serviceId && ps.is_mandatory === true);
    const mapped = filteredRelations.map(rel => {
      const prov = state.providers.find(p => p.id === rel.provider_id);
      return {
        id: rel.provider_id,
        name: prov ? prov.name : `Provider ${rel.provider_id}`,
        remaining_quota: prov ? prov.remaining_quota : 0,
        pool_order: rel.pool_order
      };
    }).sort((a, b) => {
      if (a.pool_order !== b.pool_order) return a.pool_order - b.pool_order;
      return a.id - b.id;
    });
    return { rows: mapped.map(x => ({ id: x.id, name: x.name, remaining_quota: x.remaining_quota })) };
  }

  // 10. Load pool (non-mandatory) provider relation rows
  if (/WHERE\s+ps\.service_id\s*=\s*\$1.*ps\.is_mandatory\s*=\s*FALSE/i.test(s)) {
    const serviceId = Number(params[0]);
    const filteredRelations = state.provider_services.filter(ps => ps.service_id === serviceId && ps.is_mandatory === false);
    const mapped = filteredRelations.map(rel => {
      const prov = state.providers.find(p => p.id === rel.provider_id);
      return {
        id: rel.provider_id,
        name: prov ? prov.name : `Provider ${rel.provider_id}`,
        remaining_quota: prov ? prov.remaining_quota : 0,
        pool_order: rel.pool_order
      };
    }).sort((a, b) => {
      if (a.pool_order !== b.pool_order) return a.pool_order - b.pool_order;
      return a.id - b.id;
    });
    return { rows: mapped.map(x => ({ id: x.id, name: x.name, remaining_quota: x.remaining_quota })) };
  }

  // 11. Lock provider for update
  if (/id,\s*remaining_quota\s+FROM\s+providers\s+WHERE\s+id/i.test(s)) {
    const pId = Number(params[0]);
    const prov = state.providers.find(p => p.id === pId);
    return { rows: prov ? [{ id: prov.id, remaining_quota: prov.remaining_quota }] : [] };
  }

  // 12. Update provider allocation count and quota
  if (/UPDATE\s+providers\s+SET\s+assigned_count.*remaining_quota/i.test(s) && /WHERE\s+id\s*=\s*\$1/i.test(s)) {
    const pId = Number(params[0]);
    const prov = state.providers.find(p => p.id === pId);
    if (prov) {
      if (prov.remaining_quota <= 0) {
        throw new Error(`remaining_quota_non_negative constraint violation on provider ${prov.name}`);
      }
      prov.assigned_count += 1;
      prov.remaining_quota -= 1;
    }
    return { rows: [] };
  }

  // 13. System reset: Quotas restore
  if (/UPDATE\s+providers/i.test(s) && /remaining_quota/i.test(s) && /monthly_quota/i.test(s)) {
    state.providers.forEach(p => {
      p.assigned_count = 0;
      p.remaining_quota = p.monthly_quota;
    });
    return { rows: [] };
  }

  // 15. System reset: Advance indices reset
  if (/UPDATE\s+allocation_state/i.test(s) && /last_provider_index\s*=\s*0/i.test(s)) {
    state.allocation_state.forEach(ast => {
      ast.last_provider_index = 0;
      ast.updated_at = new Date().toISOString();
    });
    return { rows: [] };
  }

  // 16. Webhook events insert
  if (/INSERT\s+INTO\s+webhook_events/i.test(s)) {
    const [eventId, eventType, payloadJson] = params;
    const existing = state.webhook_events.find(e => e.event_id === eventId);
    if (existing) {
      const err = new Error(`duplicate key value violates unique constraint on webhook_events`);
      err.code = '23505';
      throw err;
    }
    state.webhook_events.push({
      event_id: eventId,
      event_type: eventType,
      payload: JSON.parse(payloadJson || '{}'),
      processed_at: new Date().toISOString()
    });
    return { rows: [] };
  }

  // 17. Bind assignment to lead and provider
  if (/INSERT\s+INTO\s+lead_assignments/i.test(s)) {
    const [leadId, providerId] = params.map(Number);
    const existing = state.lead_assignments.find(la => la.lead_id === leadId && la.provider_id === providerId);
    if (existing) {
      const err = new Error(`duplicate key violates unique constraint on lead_assignments`);
      err.code = '23505';
      throw err;
    }
    state.lead_assignments.push({
      id: state.lead_assignments.length + 1,
      lead_id: leadId,
      provider_id: providerId,
      assigned_at: new Date().toISOString()
    });
    return { rows: [] };
  }

  // 18. Save pointer updates
  if (/UPDATE\s+allocation_state.*last_provider_index.*service_id/i.test(s)) {
    const [idx, serviceId] = params.map(Number);
    const ast = state.allocation_state.find(a => a.service_id === serviceId);
    if (ast) {
      ast.last_provider_index = idx;
      ast.updated_at = new Date().toISOString();
    }
    return { rows: [] };
  }

  // 19. Capture new service lead
  if (/INSERT\s+INTO\s+leads.*RETURNING\s+id/i.test(s)) {
    const [name, phone, city, serviceIdStr, description] = params;
    const serviceId = Number(serviceIdStr);
    
    // Unique indexing protection matches duplicates check
    const duplicate = state.leads.find(l => l.phone === phone && l.service_id === serviceId);
    if (duplicate) {
      const err = new Error('duplicate key violates unique index constraint on customer phone and service');
      err.code = '23505'; // Postgres exception code
      throw err;
    }

    const nextId = state.leads.length > 0 ? Math.max(...state.leads.map(l => l.id)) + 1 : 1;
    state.leads.push({
      id: nextId,
      customer_name: name,
      phone,
      city,
      service_id: serviceId,
      description: description || null,
      created_at: new Date().toISOString()
    });
    return { rows: [{ id: nextId }] };
  }

  // 20. Rollback deletion cleans components
  if (/DELETE\s+FROM\s+leads\s+WHERE\s+id/i.test(s)) {
    const leadId = Number(params[0]);
    state.leads = state.leads.filter(l => l.id !== leadId);
    state.lead_assignments = state.lead_assignments.filter(la => la.lead_id !== leadId);
    return { rows: [] };
  }

  if (/DELETE\s+FROM\s+lead_assignments/i.test(s)) {
    state.lead_assignments = [];
    return { rows: [] };
  }

  // 21. Select services list
  if (/SELECT\s+id\s+FROM\s+services/i.test(s)) {
    const sorted = state.services.map(srv => ({ id: srv.id })).sort((a, b) => a.id - b.id);
    return { rows: sorted };
  }

  // Fallbacks for direct inputs
  return { rows: [] };
}

class Client extends EventEmitter {
  constructor(pool) {
    super();
    this.pool = pool;
    this.inTransaction = false;
    this.startVersion = 0;
    this.transactionState = null;
  }

  async query(sql, params = []) {
    const dbState = loadDb();
    const s = sql.trim().replace(/\s+/g, ' ');

    if (/^BEGIN/i.test(s)) {
      this.inTransaction = true;
      this.startVersion = dbState.version;
      this.transactionState = JSON.parse(JSON.stringify(dbState));
      return { rows: [] };
    }

    if (/^COMMIT/i.test(s)) {
      if (!this.inTransaction) {
        throw new Error('No transaction in progress');
      }
      if (dbState.version > this.startVersion) {
        const err = new Error('Could not serialize access due to concurrent update (concurrency block)');
        err.code = '40001'; // Serializable conflict code
        throw err;
      }
      this.inTransaction = false;
      this.transactionState.version += 1;
      globalDbState = this.transactionState;
      saveDb(globalDbState);
      this.transactionState = null;
      return { rows: [] };
    }

    if (/^ROLLBACK/i.test(s)) {
      this.inTransaction = false;
      this.transactionState = null;
      return { rows: [] };
    }

    if (this.inTransaction) {
      if (dbState.version > this.startVersion) {
        const err = new Error('Could not serialize access due to concurrent update (concurrency block)');
        err.code = '40001';
        throw err;
      }
      return executeQuery(this.transactionState, sql, params);
    } else {
      const res = executeQuery(dbState, sql, params);
      const isRead = /^\s*SELECT/i.test(s) || /^\s*SHOW/i.test(s);
      if (!isRead) {
        dbState.version += 1;
        saveDb(dbState);
      }
      return res;
    }
  }

  release() {
    this.pool.releaseClient(this);
  }
}

class Pool extends EventEmitter {
  constructor() {
    super();
    this.clients = [];
  }

  async connect() {
    const client = new Client(this);
    this.clients.push(client);
    return client;
  }

  releaseClient(client) {
    this.clients = this.clients.filter(c => c !== client);
  }

  async query(sql, params = []) {
    const client = new Client(this);
    try {
      const res = await client.query(sql, params);
      return res;
    } finally {
      client.release();
    }
  }

  async end() {
    // Graceful closing completes immediately
  }
}

const poolInstance = new Pool();

module.exports = poolInstance;
module.exports.Pool = Pool;
