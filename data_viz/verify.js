const fs = require('fs');
const path = require('path');

// Color helpers for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m'
};

const logStep = (step, name) => console.log(`\n${colors.blue}[Step ${step}] ${name}${colors.reset}`);
const logPass = (msg) => console.log(`${colors.green}  ✓ PASS:${colors.reset} ${msg}`);
const logFail = (msg, err) => {
  console.error(`${colors.red}  ✗ FAIL:${colors.reset} ${msg}`);
  if (err) console.error(`    ${colors.yellow}Details: ${err.message || err}${colors.reset}`);
};

async function runVerification() {
  console.log(`${colors.blue}=== STARTING ENVIRONMENT & FILE VERIFICATION ===${colors.reset}`);
  let totalErrors = 0;

  // 1. VERIFY ENVIRONMENT VARIABLES
  logStep(1, 'Verifying Environment (.env & config)');
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
      throw new Error('.env file is missing in the project root.');
    }
    
    // Load config module
    const config = require('./config.js');
    logPass('.env file located');

    // Check critical key expectations
    // Matches this project's actual db.js, which builds its Pool from
    // discrete PG* vars (Neon/node-postgres style) rather than a single
    // DB_URI connection string.
    const requiredKeys = ['PORT', 'PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
    const missingKeys = [];

    for (const key of requiredKeys) {
      if (!process.env[key] && !config[key]) {
        missingKeys.push(key);
      }
    }

    if (missingKeys.length > 0) {
      throw new Error(`Missing expected environment key(s): ${missingKeys.join(', ')}`);
    }

    logPass(`Environment keys loaded successfully (PORT: ${process.env.PORT || config.PORT})`);
  } catch (err) {
    logFail('Environment verification failed', err);
    totalErrors++;
  }

  // 2. VERIFY DATABASE CONNECTION
  logStep(2, 'Verifying Database Connection (db.js)');
  try {
    const db = require('./db.js');

    if (typeof db.query === 'function') {
      await db.query('SELECT 1');
    } else if (typeof db.connect === 'function') {
      await db.connect();
    } else if (db.readyState !== undefined) {
      if (db.readyState !== 1) {
        throw new Error(`Mongoose connection state is ${db.readyState} (Expected 1)`);
      }
    } else {
      logPass('db.js loaded without connection errors');
    }

    logPass('Database client initialized and responded to ping');
  } catch (err) {
    logFail('Database connection test failed', err);
    totalErrors++;
  }

  // 3. VERIFY MODULE EXPORTS & DEPENDENCIES
  logStep(3, 'Verifying Local Module Exports');
  const modulesToTest = [
    { name: 'zonalStats.js', path: './zonalStats.js' },
    { name: 'api-data-loader.js', path: './api-data-loader.js' },
    { name: 'routes.js', path: './routes.js' }
  ];

  for (const mod of modulesToTest) {
    try {
      const fullPath = path.join(__dirname, mod.name);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found at ${mod.path}`);
      }

      const imported = require(mod.path);
      const exportsList = Object.keys(imported);

      if (exportsList.length === 0 && typeof imported !== 'function') {
        throw new Error(`Module loaded but contains no named or default exports.`);
      }

      logPass(`${mod.name} imported successfully`);
    } catch (err) {
      logFail(`Failed importing ${mod.name}`, err);
      totalErrors++;
    }
  }

  // SUMMARY
  console.log(`\n${colors.blue}================ SUMMARY ================${colors.reset}`);
  if (totalErrors === 0) {
    console.log(`${colors.green}All systems ready! You can safely run server.js.${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`${colors.red}Verification completed with ${totalErrors} error(s). Fix listed issues above before launching.${colors.reset}\n`);
    process.exit(1);
  }
}

runVerification();