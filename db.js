require('dotenv').config();
const { Pool } = require('pg');

// Neon's pooled endpoint (PGHOST contains "-pooler") requires SSL.
// pg doesn't read PGSSLMODE itself, so we translate it into the ssl option.
// Neon uses a valid public CA, so we verify certificates properly (no relaxed mode).
const pool = new Pool({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: true } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error', err);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 500) console.warn(`[slow query ${ms}ms] ${text.slice(0, 120)}...`);
  return res;
}

module.exports = { pool, query };