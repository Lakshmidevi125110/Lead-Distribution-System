const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PG_DATA_DIR = path.join(__dirname, 'pg_data');
const PORT = 5432;
const DB_NAME = 'lead_distribution';

function log(msg) {
  console.log(`[Database Bootstrap] ${msg}`);
  try {
    fs.appendFileSync(path.join(__dirname, 'bootstrap.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

function runCommand(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', ...options }).trim();
  } catch (err) {
    return null;
  }
}

async function main() {
  log('Starting database diagnostic check...');

  // 1. Check if postgres binary exists
  const hasPg = runCommand('which postgres');
  const hasInitDb = runCommand('which initdb');
  
  if (!hasPg || !hasInitDb) {
    log('PostgreSQL binaries not found in this environment paths.');
    log('Checking alternative directories...');
    // In some environments, postgres might be in /usr/lib/postgresql/XX/bin/
    const alternativePaths = [
      '/usr/lib/postgresql/16/bin',
      '/usr/lib/postgresql/15/bin',
      '/usr/lib/postgresql/14/bin'
    ];
    let foundPath = null;
    for (const p of alternativePaths) {
      if (fs.existsSync(path.join(p, 'postgres'))) {
        foundPath = p;
        break;
      }
    }
    
    if (foundPath) {
      log(`Found PostgreSQL binaries in: ${foundPath}`);
      process.env.PATH = `${foundPath}:${process.env.PATH}`;
    } else {
      log('WARNING: PostgreSQL is not installed in the container environment.');
      log('If this is a Cloud Run environment, a DATABASE_URL should be set in the environment variables.');
      return;
    }
  }

  // 2. Initialize database cluster if pg_data doesn't exist
  if (!fs.existsSync(PG_DATA_DIR)) {
    log(`Initializing database cluster at: ${PG_DATA_DIR}`);
    fs.mkdirSync(PG_DATA_DIR, { recursive: true });
    
    // Run initdb
    const initResult = runCommand(`initdb -D "${PG_DATA_DIR}" -U postgres --auth=trust`);
    if (initResult === null) {
      log('Failed to initialize database cluster.');
      return;
    }
    log('Database cluster initialized successfully.');
  } else {
    log('Database cluster already initialized.');
  }

  // 3. Start PostgreSQL service in the background if not already running on port 5432
  const pgRunning = runCommand(`pg_isready -p ${PORT}`);
  if (pgRunning && pgRunning.includes('accepting connections')) {
    log(`PostgreSQL is already running and accepting connections on port ${PORT}.`);
  } else {
    log(`Starting PostgreSQL background process on port ${PORT}...`);
    
    // Spawn postgres process
    const pgProcess = spawn('postgres', [
      '-D', PG_DATA_DIR,
      '-p', PORT,
      '-h', '127.0.0.1'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    
    pgProcess.unref();

    // Wait until server is ready
    let attempts = 0;
    let ready = false;
    while (attempts < 20 && !ready) {
      const check = runCommand(`pg_isready -p ${PORT}`);
      if (check && check.includes('accepting connections')) {
        ready = true;
        break;
      }
      log('Waiting for database server to start...');
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }

    if (!ready) {
      log('Database server failed to start within the timeout period.');
      return;
    }
    log('PostgreSQL background process started successfully.');
  }

  // 4. Create Database if it doesn't exist
  const dbList = runCommand(`psql -h 127.0.0.1 -p ${PORT} -U postgres -lqt`);
  if (dbList && dbList.includes(DB_NAME)) {
    log(`Database "${DB_NAME}" already exists.`);
  } else {
    log(`Creating database "${DB_NAME}"...`);
    const createResult = runCommand(`createdb -h 127.0.0.1 -p ${PORT} -U postgres ${DB_NAME}`);
    if (createResult === null) {
      log(`Failed to create database "${DB_NAME}".`);
      return;
    }
    log(`Database "${DB_NAME}" created successfully.`);

    // 5. Apply schema and seed if created fresh
    log('Applying database schema.sql...');
    const schemaFile = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaFile)) {
      runCommand(`psql -h 127.0.0.1 -p ${PORT} -U postgres -d ${DB_NAME} -f "${schemaFile}"`);
      log('Database schema applied.');
    }

    log('Running database seed.js...');
    const seedFile = path.join(__dirname, 'seed.js');
    if (fs.existsSync(seedFile)) {
      try {
        execSync(`node "${seedFile}"`, { env: { ...process.env, DATABASE_URL: `postgresql://postgres@127.0.0.1:${PORT}/${DB_NAME}` }, stdio: 'inherit' });
        log('Database seeding complete.');
      } catch (err) {
        log(`Seeding failed: ${err.message}`);
      }
    }
  }

  // 6. Set DATABASE_URL if not already present
  if (!process.env.DATABASE_URL) {
    const dbUrl = `postgresql://postgres@127.0.0.1:${PORT}/${DB_NAME}`;
    log(`Writing default DATABASE_URL to .env: ${dbUrl}`);
    fs.writeFileSync(path.join(__dirname, '.env'), `DATABASE_URL=${dbUrl}\nPORT=3000\nBASE_URL=http://localhost:3000\nADMIN_TOKEN=your-secret-admin-token-here\nNODE_ENV=development\n`);
  }
}

if (require.main === module) {
  main().catch(err => console.error(err));
}
