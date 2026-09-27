/**
 * db.js — Unified async database layer for VMMUN 2026
 *
 * Dialect selection (automatic):
 *   - DATABASE_URL set  →  PostgreSQL (production on Render/Supabase)
 *   - DATABASE_URL unset →  SQLite / better-sqlite3 (local development)
 *
 * Exported interface (all async):
 *   query(sql, params)        → Promise<Array>        — SELECT many rows
 *   getOne(sql, params)       → Promise<object|null>  — SELECT one row
 *   run(sql, params)          → Promise<void>         — INSERT / UPDATE / DELETE
 *   transaction(fn)           → Promise<any>          — atomic block
 *   initialize()              → Promise<void>         — run schema + seed (call once on startup)
 *
 * SQL convention: always use ? for parameters.
 *   db.js converts ? → $1 $2 … automatically for PostgreSQL.
 *
 * Dialect helpers (exported for callers that must embed SQL):
 *   AGG      — 'STRING_AGG' (pg) | 'GROUP_CONCAT' (sqlite)
 *   NOW_SQL  — "NOW()::TEXT"     | "datetime('now')"
 *   USE_PG   — boolean
 */
'use strict';

const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

// ─── Dialect detection ────────────────────────────────────────────────────────
const USE_PG = !!process.env.DATABASE_URL;

if (process.env.NODE_ENV === 'production' && !USE_PG) {
  throw new Error('FATAL: DATABASE_URL is required in production; refusing to open SQLite.');
}

// SQL fragment constants (dialect-aware)
const AGG     = USE_PG ? 'STRING_AGG' : 'GROUP_CONCAT';
const NOW_SQL = USE_PG ? "NOW()::TEXT" : "datetime('now')";

// ─── PostgreSQL pool ──────────────────────────────────────────────────────────
let pgPool = null;

if (USE_PG) {
  const { Pool, types } = require('pg');

  // Parse PostgreSQL int8 (bigint) → JS number so COUNT(*) returns a number
  types.setTypeParser(20, val => parseInt(val, 10));

  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  console.log('✓ Database: PostgreSQL');
}

// ─── SQLite instance ──────────────────────────────────────────────────────────
let sqlite = null;

if (!USE_PG) {
// SQLite is a local-development dependency. Production uses PostgreSQL and
// intentionally omits optional dependencies during the Render build.
let Database;
  const DB_PATH  = process.env.DB_PATH || path.join(__dirname, '../data/vmmun.db');
  const dataDir  = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  console.log('✓ Database: SQLite at', DB_PATH);
}

// ─── Placeholder conversion ───────────────────────────────────────────────────
/**
 * Convert ? placeholders to $1, $2, … for PostgreSQL.
 * @param {string} sql
 * @returns {string}
 */
function pgify(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ─── Async query interface ────────────────────────────────────────────────────

/**
 * SELECT — returns all rows.
 */
async function query(sql, params = []) {
  if (USE_PG) {
    const result = await pgPool.query(pgify(sql), params);
    return result.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

/**
 * SELECT — returns the first row or null.
 */
async function getOne(sql, params = []) {
  if (USE_PG) {
    const result = await pgPool.query(pgify(sql), params);
    return result.rows[0] || null;
  }
  return sqlite.prepare(sql).get(...params) || null;
}

/**
 * INSERT / UPDATE / DELETE — returns nothing meaningful.
 */
async function run(sql, params = []) {
  if (USE_PG) {
    await pgPool.query(pgify(sql), params);
} else {
  Database = require('better-sqlite3');
    sqlite.prepare(sql).run(...params);
  }
}

/**
 * Execute fn inside an atomic transaction.
 *
 * fn receives { query, getOne, run } helpers that share the same connection.
 * For PostgreSQL: uses a dedicated client with BEGIN/COMMIT/ROLLBACK.
 * For SQLite:     uses manual BEGIN EXCLUSIVE / COMMIT / ROLLBACK so that
 *                 the async fn can use await (await on sync values resolves
 *                 immediately; the SQLite exclusive lock prevents concurrent writes).
 *
 * @param {(tx: {query, getOne, run}) => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function transaction(fn) {
  if (USE_PG) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        query:  async (sql, params = []) => { const r = await client.query(pgify(sql), params); return r.rows; },
        getOne: async (sql, params = []) => { const r = await client.query(pgify(sql), params); return r.rows[0] || null; },
        run:    async (sql, params = []) => { await client.query(pgify(sql), params); },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    // SQLite: BEGIN EXCLUSIVE serializes writes; busy_timeout handles contention.
    sqlite.prepare('BEGIN EXCLUSIVE').run();
    try {
      const tx = {
        query:  (sql, params = []) => sqlite.prepare(sql).all(...params),
        getOne: (sql, params = []) => sqlite.prepare(sql).get(...params) || null,
        run:    (sql, params = []) => { sqlite.prepare(sql).run(...params); },
      };
      // fn may be async; await on sync return values resolves immediately.
      const result = await fn(tx);
      sqlite.prepare('COMMIT').run();
      return result;
    } catch (err) {
      try { sqlite.prepare('ROLLBACK').run(); } catch (_) {}
      throw err;
    }
  }
}

// ─── Schema initialization ────────────────────────────────────────────────────

async function initSchema() {
  if (USE_PG) {
    const schemaPath = path.join(__dirname, '../schema.sql');
    const schemaSql  = fs.readFileSync(schemaPath, 'utf-8');
    // Strip SQL comment lines before splitting. Filtering whole chunks would
    // accidentally discard the first CREATE statement when the schema starts
    // with a comment header.
    const statements = schemaSql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pgPool.query(stmt);
    }
    console.log('✓ PostgreSQL schema initialized.');
  } else {
    // SQLite inline schema (mirrors schema.sql)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS committees (
        id          TEXT PRIMARY KEY,
        code        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        category    TEXT NOT NULL,
        capacity    INTEGER DEFAULT 0,
        is_active   INTEGER DEFAULT 1,
        created_at  TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS portfolios (
        id            TEXT PRIMARY KEY,
        committee_id  TEXT NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        type          TEXT DEFAULT 'country',
        capacity      INTEGER DEFAULT 1,
        is_active     INTEGER DEFAULT 1,
        created_at    TEXT DEFAULT (datetime('now')),
        UNIQUE(committee_id, name)
      );
      CREATE TABLE IF NOT EXISTS registrations (
        id                  TEXT PRIMARY KEY,
        registration_number TEXT UNIQUE,
        name                TEXT NOT NULL,
        email               TEXT NOT NULL,
        phone               TEXT NOT NULL,
        school              TEXT NOT NULL,
        city                TEXT NOT NULL,
        delegate_type       TEXT NOT NULL,
        country_preferred   TEXT,
        committee_pref_1    TEXT,
        committee_pref_2    TEXT,
        committee_pref_3    TEXT,
        portfolio_pref_1    TEXT,
        portfolio_pref_2    TEXT,
        portfolio_pref_3    TEXT,
        portfolio_pref_4    TEXT,
        portfolio_pref_5    TEXT,
        allocated_committee TEXT REFERENCES committees(id),
        allocated_portfolio TEXT REFERENCES portfolios(id),
        payment_status      TEXT DEFAULT 'pending'
                            CHECK(payment_status IN ('pending','paid','failed','cancelled','refunded')),
        registration_status TEXT DEFAULT 'pending_payment'
                            CHECK(registration_status IN ('pending_payment','payment_verified','confirmed','cancelled')),
        razorpay_order_id   TEXT,
        razorpay_payment_id TEXT,
        created_at          TEXT DEFAULT (datetime('now')),
        confirmed_at        TEXT
      );
      CREATE TABLE IF NOT EXISTS payments (
        id                    TEXT PRIMARY KEY,
        registration_id       TEXT NOT NULL REFERENCES registrations(id),
        razorpay_order_id     TEXT NOT NULL,
        razorpay_payment_id   TEXT,
        razorpay_signature    TEXT,
        amount_paise          INTEGER NOT NULL,
        currency              TEXT DEFAULT 'INR',
        status                TEXT DEFAULT 'pending'
                              CHECK(status IN ('pending','paid','failed','cancelled','refunded')),
        verification_status   TEXT DEFAULT 'unverified'
                              CHECK(verification_status IN ('unverified','verified','failed')),
        created_at            TEXT DEFAULT (datetime('now')),
        paid_at               TEXT,
        UNIQUE(razorpay_order_id)
      );
      CREATE TABLE IF NOT EXISTS portfolio_reservations (
        id              TEXT PRIMARY KEY,
        portfolio_id    TEXT NOT NULL REFERENCES portfolios(id),
        registration_id TEXT NOT NULL REFERENCES registrations(id),
        expires_at      TEXT NOT NULL,
        is_confirmed    INTEGER DEFAULT 0,
        created_at      TEXT DEFAULT (datetime('now')),
        UNIQUE(portfolio_id, registration_id)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id              TEXT PRIMARY KEY,
        action          TEXT NOT NULL,
        admin_id        TEXT,
        registration_id TEXT,
        old_value       TEXT,
        new_value       TEXT,
        notes           TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS admins (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_registrations_email          ON registrations(email);
      CREATE INDEX IF NOT EXISTS idx_registrations_status         ON registrations(registration_status);
      CREATE INDEX IF NOT EXISTS idx_registrations_payment_status ON registrations(payment_status);
      CREATE INDEX IF NOT EXISTS idx_registrations_order_id       ON registrations(razorpay_order_id);
      CREATE INDEX IF NOT EXISTS idx_payments_order_id            ON payments(razorpay_order_id);
      CREATE INDEX IF NOT EXISTS idx_payments_payment_id          ON payments(razorpay_payment_id);
      CREATE INDEX IF NOT EXISTS idx_reservations_portfolio       ON portfolio_reservations(portfolio_id);
      CREATE INDEX IF NOT EXISTS idx_audit_registration           ON audit_log(registration_id);
      CREATE INDEX IF NOT EXISTS idx_portfolios_committee         ON portfolios(committee_id);
    `);
    // Migrate: add 'type' column if missing (existing databases)
    try { sqlite.exec("ALTER TABLE portfolios ADD COLUMN type TEXT DEFAULT 'country'"); } catch (_) {}
    console.log('✓ SQLite schema initialized.');
  }
}

// ─── Committee & portfolio seed data ─────────────────────────────────────────
// These definitions are the source of truth for all committee matrices.
// Adding/changing a portfolio here is reflected on the next server restart.

const committeeDefinitions = [
  {
    code: 'AIPPM', name: 'All India Political Parties Meet', category: 'INDIAN POLITICS', type: 'leader',
    portfolios: [
      'Narendra Modi','Amit Shah','Rahul Gandhi','Mallikarjun Kharge','Arvind Kejriwal',
      'M.K. Stalin','Mamata Banerjee','Akhilesh Yadav','Nirmala Sitharaman','S. Jaishankar',
      'Edappadi K. Palaniswami','D. Raja','BJP','INC','AAP','DMK','AIADMK','CPI(M)','TDP','SP',
    ],
  },
  {
    code: 'TNLA', name: 'Tamil Nadu Legislative Assembly', category: 'STATE ASSEMBLY', type: 'leader',
    portfolios: [
      'M.K. Stalin','Edappadi K. Palaniswami','Udhayanidhi Stalin','Durai Murugan',
      'K. Annamalai','Seeman','O. Panneerselvam','Premallatha Vijayakanth','M. Appavu',
      'K. Ponmudy','Thol. Thirumavalavan','Vanathi Srinivasan','DMK','AIADMK',
      'Congress (TN)','BJP (TN)','PMK','VCK','NTK',
    ],
  },
  {
    code: 'UNGA', name: 'United Nations General Assembly', category: 'GLOBAL ASSEMBLY', type: 'country',
    portfolios: [
      'India','United States','United Kingdom','France','Germany','Japan','Brazil','China',
      'Russia','South Africa','Canada','Australia','Mexico','Argentina','Indonesia',
      'Egypt','Saudi Arabia','Nigeria','Italy','South Korea',
    ],
  },
  {
    code: 'UNHRC', name: 'United Nations Human Rights Council', category: 'HUMAN RIGHTS', type: 'country',
    portfolios: [
      'India','United States','United Kingdom','France','Germany','Japan','Brazil',
      'South Africa','Argentina','Chile','Mexico','Netherlands','Switzerland','Austria',
      'Denmark','Bangladesh','Qatar','Costa Rica','Ghana','Morocco',
    ],
  },
  {
    code: 'ECOSOC', name: 'Economic and Social Council', category: 'ECONOMIC FORUM', type: 'country',
    portfolios: [
      'India','United States','United Kingdom','France','Germany','Japan','Brazil',
      'Canada','Italy','Netherlands','Sweden','Norway','Australia','South Korea',
      'China','Colombia','Kenya','Mauritius','Poland','Greece',
    ],
  },
  {
    code: 'UNSC', name: 'United Nations Security Council', category: 'SECURITY COUNCIL', type: 'country',
    portfolios: [
      'USA (P5)','UK (P5)','France (P5)','China (P5)','Russia (P5)',
      'India','Japan','Germany','Brazil','South Africa',
      'Algeria','Guyana','Sierra Leone','Slovenia','Switzerland',
    ],
  },
  {
    code: 'IP', name: 'Indian Press', category: 'INDIAN PRESS', type: 'press',
    portfolios: [
      'The Hindu','Times of India','Hindustan Times','Indian Express','NDTV',
      'Republic TV','The Wire','Scroll.in','Press Trust of India','ANI',
    ],
  },
  {
    code: 'IPJ', name: 'International Press Journal', category: 'JOURNALISM', type: 'press',
    portfolios: ['BBC','Reuters','Al Jazeera','The Guardian','Washington Post','New York Times','CNN','AFP','AP','DW'],
  },
];

async function syncMatrices() {
  for (const c of committeeDefinitions) {
    let commRow = await getOne('SELECT id FROM committees WHERE code = ?', [c.code]);
    let commId;
    if (!commRow) {
      commId = uuidv4();
      await run(
        'INSERT INTO committees (id, code, name, category, capacity) VALUES (?, ?, ?, ?, 0)',
        [commId, c.code, c.name, c.category]
      );
    } else {
      commId = commRow.id;
    }

    for (const pName of c.portfolios) {
      const portRow = await getOne(
        'SELECT id FROM portfolios WHERE committee_id = ? AND name = ?',
        [commId, pName]
      );
      if (!portRow) {
        await run(
          'INSERT INTO portfolios (id, committee_id, name, type, capacity) VALUES (?, ?, ?, ?, 1)',
          [uuidv4(), commId, pName, c.type]
        );
      } else {
        // Keep type in sync with the definition
        await run('UPDATE portfolios SET type = ? WHERE id = ?', [c.type, portRow.id]);
      }
    }
  }
  console.log('✓ Committee matrices and portfolios synchronized.');
}

/**
 * Initialize the database. Must be called once before accepting requests.
 * Runs schema DDL (idempotent) then seeds/syncs committee matrices.
 */
async function initialize() {
  await initSchema();
  await syncMatrices();
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = { query, getOne, run, transaction, initialize, AGG, NOW_SQL, USE_PG };
