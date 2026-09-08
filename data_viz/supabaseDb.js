require('dotenv').config();
const { Pool } = require('pg');

// Separate connection pool for the Supabase-hosted `gold` schema (grid_cell).
// This is a distinct Postgres instance from the local `nairobifdb` database
// used everywhere else (see db.js), so it gets its own pool rather than
// trying to query across databases in one SQL statement (Postgres can't do
// that without postgres_fdw, which is more setup than three summary numbers
// need).
//
// Supabase's pooler endpoint requires SSL and uses a valid public CA, so by
// default we verify certificates normally (no relaxed/rejectUnauthorized:false).
//
// DIAGNOSTIC-ONLY ESCAPE HATCH: if you're seeing
//   "self-signed certificate in certificate chain"
// that means something between this machine and Supabase (very commonly
// antivirus like Kaspersky/ESET/Norton, or a corporate/network security
// proxy) is doing TLS inspection and re-signing the connection with its own
// root CA, which Node doesn't trust out of the box. That's a local
// network/trust-store problem, not a bug in this app or in Supabase.
//
// Setting SUPABASE_SSL_INSECURE=true in .env skips certificate verification
// so you can confirm that's the cause and keep developing locally. This is
// NOT a real fix and NOT safe for anything beyond local dev — once
// confirmed, the proper fix is to either:
//   1. Export the intercepting proxy/AV's root CA and point Node at it via
//      NODE_EXTRA_CA_CERTS=/path/to/that-ca.pem, so the real chain
//      validates normally, or
//   2. Add an exclusion for this app / Supabase's host in whatever software
//      is doing the interception.
// Remove SUPABASE_SSL_INSECURE from .env once one of those is in place.
const insecureSSL = process.env.SUPABASE_SSL_INSECURE === 'true';
if (insecureSSL) {
  console.warn(
    '[supabaseDb] SUPABASE_SSL_INSECURE=true — certificate verification is ' +
    'DISABLED for the Supabase connection. Diagnostic use only; do not leave ' +
    'this on beyond confirming the cause of a TLS chain error.'
  );
}

const pool = new Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: !insecureSSL },
  max: 5,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Unexpected Supabase pool error', err);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 500) console.warn(`[slow supabase query ${ms}ms] ${text.slice(0, 120)}...`);
  return res;
}

module.exports = { pool, query };