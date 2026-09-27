/**
 * auth.js — Admin authentication middleware using JWT + bcrypt
 *
 * Uses the unified async db interface from lib/db.js.
 * JWT_SECRET is enforced as a required env var in production.
 */
'use strict';

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db     = require('./db');
const { v4: uuidv4 } = require('uuid');

// ─── Fail fast in production if JWT_SECRET is weak or missing ────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'changeme')
) {
  throw new Error('FATAL: JWT_SECRET must be set to a strong random value in production. Server will not start.');
}

const JWT_EXPIRES = '8h';

// ─── Password helpers ─────────────────────────────────────────────────────────

/**
 * Hash a plain-text password (bcrypt, cost=10).
 */
async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

/**
 * Verify a plain-text password against a stored hash.
 */
async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ─── JWT ──────────────────────────────────────────────────────────────────────

/**
 * Generate a signed JWT for an admin session.
 */
function generateToken(admin) {
  return jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

/**
 * Express middleware — verifies the Authorization: Bearer <token> header.
 * Attaches req.admin on success; responds 401 on failure.
 * This middleware is synchronous (no DB calls needed for JWT verification).
 */
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired.' });
  }
}

// ─── Admin seed / sync ────────────────────────────────────────────────────────

/**
 * Ensure the admin from env vars exists in the database.
 * Called once at server startup; uses ADMIN_USERNAME + ADMIN_PASSWORD env vars.
 * If ADMIN_PASSWORD_HASH is set instead, it is used directly (pre-hashed bcrypt).
 */
async function ensureDefaultAdmin() {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();

  let hash = process.env.ADMIN_PASSWORD_HASH;
  if (process.env.ADMIN_PASSWORD) {
    hash = await hashPassword(process.env.ADMIN_PASSWORD.trim());
  } else if (!hash) {
    // Last resort fallback — only acceptable in local dev
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: ADMIN_PASSWORD or ADMIN_PASSWORD_HASH must be set in production.');
    }
    hash = await hashPassword('admin123');
  }

  const existing = await db.getOne('SELECT * FROM admins WHERE username = ?', [username]);
  if (existing) {
    await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, existing.id]);
  } else {
    const firstAdmin = await db.getOne('SELECT * FROM admins LIMIT 1', []);
    if (firstAdmin) {
      await db.run('UPDATE admins SET username = ?, password_hash = ? WHERE id = ?', [username, hash, firstAdmin.id]);
    } else {
      await db.run('INSERT INTO admins (id, username, password_hash) VALUES (?,?,?)', [uuidv4(), username, hash]);
    }
  }
  console.log(`✓ Admin user '${username}' synchronized.`);
}

module.exports = { hashPassword, verifyPassword, generateToken, requireAdmin, ensureDefaultAdmin };
