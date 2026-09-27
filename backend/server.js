/**
 * server.js — VMMUN 2026 Secure Registration Backend
 *
 * Implements:
 *   - Committee-Specific Country / Portfolio Matrices (AIPPM, TNLA, UNGA, UNHRC, ECOSOC, UNSC, IP, IPJ)
 *   - Secure Razorpay Order Creation & HMAC Verification
 *   - Webhook Support for asynchronous payment confirmation
 *   - Race-Condition Protected Atomic Portfolio Allocation (pg FOR UPDATE / SQLite EXCLUSIVE tx)
 *   - Admin Authentication, Override, Audit Logs & Management APIs
 *   - Production CORS: restricted to FRONTEND_ORIGIN
 *   - Health-check endpoint: GET /health
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
const Razorpay  = require('razorpay');
const { v4: uuidv4 } = require('uuid');

const db  = require('./lib/db');
const { allocatePortfolioInTx, getCommitteeAllocation } = require('./lib/allocation');
const { sendAdminNotification, sendDelegateConfirmation } = require('./lib/email');
const { verifyPassword, generateToken, requireAdmin, ensureDefaultAdmin } = require('./lib/auth');

const app  = express();
const PORT = process.env.PORT || 3001;
const FEE_PAISE = Number(process.env.REGISTRATION_FEE_PAISE || 50000);

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── Allowed origins (production: only the Vercel frontend) ───────────────────
const allowedOrigins = [
  process.env.FRONTEND_ORIGIN,     // https://vmmun-20.vercel.app  (set in production .env)
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no Origin header (server-to-server, Razorpay webhooks, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin '${origin}' not allowed.`), false);
  },
  credentials: true,
}));

app.use(helmet());

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter       = rateLimit({ windowMs: 60_000, max: 60,  standardHeaders: true, legacyHeaders: false });
const strictLimiter = rateLimit({ windowMs: 60_000, max: 15,  standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// ─── Webhook must read raw body BEFORE express.json() ─────────────────────────
app.post('/api/webhook/razorpay', express.raw({ type: 'application/json' }), asyncHandler(handleWebhook));

app.use(express.json());

// ─── Async error wrapper ─────────────────────────────────────────────────────
// Catches unhandled promise rejections in route handlers and forwards to Express.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─── Health check ─────────────────────────────────────────────────────────────
// Used by Render/Railway uptime checks and production monitoring.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now(), db: db.USE_PG ? 'postgresql' : 'sqlite' });
});

// ─── Public: Committee Matrices & Portfolios ──────────────────────────────────
app.get('/api/committees', asyncHandler(async (req, res) => {
  const committees = await db.query(
    'SELECT id, code, name, category, capacity FROM committees WHERE is_active = 1 ORDER BY code',
    []
  );
  res.json(committees);
}));

app.get('/api/committees/:id/portfolios', asyncHandler(async (req, res) => {
  const committee = await db.getOne(
    'SELECT * FROM committees WHERE (id = ? OR UPPER(code) = UPPER(?)) AND is_active = 1',
    [req.params.id, req.params.id]
  );
  if (!committee) return res.status(404).json({ error: 'Committee not found.' });

  const portfolios = await db.query(`
    SELECT p.id,
           p.name,
           p.type,
           p.capacity,
           COALESCE(a.taken, 0) AS allocated,
           CASE
             WHEN COALESCE(a.taken, 0) >= p.capacity THEN 'full'
             ELSE 'available'
           END AS availability
    FROM portfolios p
    LEFT JOIN (
      SELECT allocated_portfolio, COUNT(*) AS taken
      FROM registrations
      WHERE allocated_committee = ?
        AND registration_status IN ('payment_verified', 'confirmed')
      GROUP BY allocated_portfolio
    ) a ON a.allocated_portfolio = p.id
    WHERE p.committee_id = ? AND p.is_active = 1
    ORDER BY p.name ASC
  `, [committee.id, committee.id]);

  res.json({ committee, portfolios });
}));

// ─── Public: Check Registration Status ───────────────────────────────────────
app.get('/api/registration/:id', asyncHandler(async (req, res) => {
  const reg = await db.getOne(`
    SELECT r.id, r.registration_number, r.name, r.email,
           r.payment_status, r.registration_status,
           r.allocated_committee, r.allocated_portfolio,
           c.code AS committee_code, c.name AS committee_name,
           p.name AS portfolio_name, p.type AS portfolio_type,
           r.confirmed_at, r.created_at
    FROM registrations r
    LEFT JOIN committees c ON c.id = r.allocated_committee
    LEFT JOIN portfolios p ON p.id = r.allocated_portfolio
    WHERE r.id = ?
  `, [req.params.id]);

  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  res.json(reg);
}));

// ─── Public: Create Registration & Razorpay Order ────────────────────────────
app.post('/api/register', strictLimiter, asyncHandler(async (req, res) => {
  const {
    name, email, phone, school, city, delegate_type, country_preferred,
    committee_pref_1, committee_pref_2, committee_pref_3,
    portfolio_pref_1, portfolio_pref_2, portfolio_pref_3, portfolio_pref_4, portfolio_pref_5,
  } = req.body;

  // Validate required fields
  if (!name || !email || !phone || !school || !city || !delegate_type) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (!/^[0-9+() -]{7,}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }
  if (committee_pref_1 && committee_pref_2 && committee_pref_3) {
    if (new Set([committee_pref_1, committee_pref_2, committee_pref_3]).size !== 3) {
      return res.status(400).json({ error: 'Committee preferences must all be different.' });
    }
    for (const code of [committee_pref_1, committee_pref_2, committee_pref_3]) {
      const c = await db.getOne(
        'SELECT id FROM committees WHERE UPPER(code) = UPPER(?) AND is_active = 1',
        [code]
      );
      if (!c) return res.status(400).json({ error: `Unknown committee: ${code}` });
    }
  }

  // Return existing pending registration if one exists (prevents order spam)
  const existingPending = await db.getOne(`
    SELECT id, razorpay_order_id, payment_status FROM registrations
    WHERE email = ? AND registration_status = 'pending_payment'
    ORDER BY created_at DESC LIMIT 1
  `, [email]);

  if (existingPending) {
    const existingPayment = await db.getOne(
      'SELECT razorpay_order_id FROM payments WHERE registration_id = ?',
      [existingPending.id]
    );
    if (existingPayment) {
      return res.json({
        registration_id:   existingPending.id,
        razorpay_order_id: existingPayment.razorpay_order_id,
        razorpay_key_id:   process.env.RAZORPAY_KEY_ID,
        amount_paise:      FEE_PAISE,
        name,
        email,
      });
    }
  }

  // Prevent duplicate confirmed registration from same email
  const alreadyConfirmed = await db.getOne(`
    SELECT id, registration_number FROM registrations
    WHERE email = ? AND registration_status = 'confirmed'
  `, [email]);
  if (alreadyConfirmed) {
    return res.status(409).json({
      error: 'This email is already registered and confirmed for VMMUN 2026.',
      registration_number: alreadyConfirmed.registration_number,
    });
  }

  // Create Razorpay order (server-side)
  const receipt = `vmmun_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  let order;
  try {
    order = await razorpay.orders.create({
      amount:   FEE_PAISE,
      currency: 'INR',
      receipt,
      notes: { name, email, phone },
    });
  } catch (err) {
    console.error('Razorpay order creation error:', err);
    return res.status(500).json({ error: 'Failed to initiate payment order with gateway.' });
  }

  const regId = uuidv4();
  const now   = new Date().toISOString();

  // Persist registration record
  await db.run(`
    INSERT INTO registrations (
      id, name, email, phone, school, city, delegate_type, country_preferred,
      committee_pref_1, committee_pref_2, committee_pref_3,
      portfolio_pref_1, portfolio_pref_2, portfolio_pref_3,
      portfolio_pref_4, portfolio_pref_5,
      payment_status, registration_status, razorpay_order_id, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    regId, name, email, phone, school, city, delegate_type, country_preferred || null,
    committee_pref_1 || null, committee_pref_2 || null, committee_pref_3 || null,
    portfolio_pref_1 || null, portfolio_pref_2 || null, portfolio_pref_3 || null,
    portfolio_pref_4 || null, portfolio_pref_5 || null,
    'pending', 'pending_payment', order.id, now,
  ]);

  // Persist payment tracking record
  await db.run(`
    INSERT INTO payments (id, registration_id, razorpay_order_id, amount_paise, status, created_at)
    VALUES (?,?,?,?,'pending',?)
  `, [uuidv4(), regId, order.id, FEE_PAISE, now]);

  await logAudit('registration_initiated', null, regId, null, order.id, `email=${email}`);

  res.json({
    registration_id:   regId,
    razorpay_order_id: order.id,
    razorpay_key_id:   process.env.RAZORPAY_KEY_ID,
    amount_paise:      FEE_PAISE,
    name,
    email,
  });
}));

// ─── Public: Verify Payment Signature Server-Side ─────────────────────────────
app.post('/api/payment/verify', strictLimiter, asyncHandler(async (req, res) => {
  const { registration_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!registration_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields.' });
  }

  const reg = await db.getOne('SELECT * FROM registrations WHERE id = ?', [registration_id]);
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  if (reg.razorpay_order_id !== razorpay_order_id) {
    return res.status(400).json({ error: 'Order ID mismatch.' });
  }
  if (reg.registration_status === 'confirmed') {
    return res.json({ already_confirmed: true, registration_number: reg.registration_number });
  }

  // Verify Razorpay HMAC signature
  const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
  hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
  const expected = hmac.digest('hex');

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(razorpay_signature, 'hex')
    );
  } catch (_) {
    isValid = false;
  }

  if (!isValid) {
    await logAudit('payment_verification_failed', null, registration_id, null, null, `payment_id=${razorpay_payment_id}`);
    return res.status(400).json({ error: 'Payment signature verification failed.' });
  }

  // Atomically confirm registration + allocate portfolio
  await confirmRegistration(registration_id, razorpay_payment_id, razorpay_order_id, razorpay_signature);

  const updated = await db.getOne(`
    SELECT r.*, c.code AS allocated_committee_code, p.name AS allocated_portfolio_name
    FROM registrations r
    LEFT JOIN committees c ON c.id = r.allocated_committee
    LEFT JOIN portfolios p ON p.id = r.allocated_portfolio
    WHERE r.id = ?
  `, [registration_id]);

  res.json({
    success:             true,
    registration_number: updated.registration_number,
    allocated_committee: updated.allocated_committee_code,
    allocated_portfolio: updated.allocated_portfolio_name,
  });
}));

// ─── Razorpay Webhook ─────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const signature     = req.headers['x-razorpay-signature'];
  const body          = req.body;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (webhookSecret) {
    const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
    let valid = false;
    try {
      valid = crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature || '', 'hex')
      );
    } catch (_) { valid = false; }
    if (!valid) return res.status(400).json({ error: 'Webhook signature invalid.' });
  }

  let event;
  try {
    event = JSON.parse(body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const orderId  = payment.order_id;
    const paymentId = payment.id;

    const reg = await db.getOne(
      'SELECT * FROM registrations WHERE razorpay_order_id = ?',
      [orderId]
    );
    if (reg && reg.registration_status !== 'confirmed') {
      await confirmRegistration(reg.id, paymentId, orderId, null);
    }
  }

  res.json({ received: true });
}

// ─── Core: Confirm Registration & Allocate Committee Portfolio ────────────────
// Single atomic transaction:
//   1. Mark payment as paid and record Razorpay IDs.
//   2. Allocate committee-scoped portfolio (FOR UPDATE in pg; EXCLUSIVE tx in sqlite).
//   3. Set registration_status = 'confirmed'.
// On completion: send admin + delegate notification emails (non-blocking).
async function confirmRegistration(registrationId, paymentId, orderId, signature) {
  const reg = await db.getOne('SELECT * FROM registrations WHERE id = ?', [registrationId]);
  if (!reg || reg.registration_status === 'confirmed') return;

  // Registration number — idempotent counter
  const countRow = await db.getOne(
    'SELECT COUNT(*) AS c FROM registrations WHERE registration_number IS NOT NULL',
    []
  );
  const regNumber = `MUN2026-${String(parseInt(String(countRow.c), 10) + 1).padStart(4, '0')}`;
  const now       = new Date().toISOString();

  await db.transaction(async (tx) => {
    // 1. Mark registration as payment_verified + assign registration number
    await tx.run(`
      UPDATE registrations
      SET payment_status      = 'paid',
          registration_status = 'payment_verified',
          razorpay_payment_id = ?,
          registration_number = ?
      WHERE id = ?
    `, [paymentId, regNumber, registrationId]);

    // 2. Update payments record
    await tx.run(`
      UPDATE payments
      SET razorpay_payment_id   = ?,
          razorpay_signature    = ?,
          status                = 'paid',
          verification_status   = 'verified',
          paid_at               = ?
      WHERE razorpay_order_id = ?
    `, [paymentId, signature || null, now, orderId]);

    // 3. Allocate committee-specific portfolio (within same transaction — no nesting)
    try {
      const alloc = await allocatePortfolioInTx(registrationId, tx);
      if (alloc) {
        await tx.run(`
          INSERT INTO audit_log (id, action, admin_id, registration_id, old_value, new_value, notes, created_at)
          VALUES (?,?,?,?,?,?,?,?)
        `, [uuidv4(), 'portfolio_allocated', null, registrationId, null,
            `${alloc.committee_code} / ${alloc.portfolio_name}`, null, now]);
      }
    } catch (e) {
      console.error('Portfolio allocation error:', e.message);
      // Non-fatal: registration still confirms; admin can manually assign
    }

    // 4. Set confirmed
    await tx.run(`
      UPDATE registrations
      SET registration_status = 'confirmed',
          confirmed_at        = ?
      WHERE id = ?
    `, [now, registrationId]);

    await tx.run(`
      INSERT INTO audit_log (id, action, admin_id, registration_id, old_value, new_value, notes, created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `, [uuidv4(), 'payment_confirmed', null, registrationId, null, regNumber, null, now]);
  });

  // Fetch full registration for email (outside transaction — read-only)
  const fullReg = await db.getOne(`
    SELECT r.*, c.code AS allocated_committee_code, p.name AS allocated_portfolio_name
    FROM registrations r
    LEFT JOIN committees c ON c.id = r.allocated_committee
    LEFT JOIN portfolios p ON p.id = r.allocated_portfolio
    WHERE r.id = ?
  `, [registrationId]);

  sendAdminNotification(fullReg).catch(err => console.error('Admin email error:', err));
  sendDelegateConfirmation(fullReg).catch(err => console.error('Delegate email error:', err));
}

// ─── Admin: Authentication ────────────────────────────────────────────────────
app.post('/api/admin/login', strictLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const admin = await db.getOne('SELECT * FROM admins WHERE username = ?', [username]);
  if (!admin) return res.status(401).json({ error: 'Invalid credentials.' });

  const ok = await verifyPassword(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

  const token = generateToken(admin);
  res.json({ token, username: admin.username });
}));

// ─── Admin: Dashboard Stats ───────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, asyncHandler(async (req, res) => {
  const stats = await db.getOne(`
    SELECT
       COUNT(*)                                                        AS total_registrations,
       SUM(CASE WHEN payment_status      = 'paid'      THEN 1 ELSE 0 END) AS paid,
       SUM(CASE WHEN payment_status      = 'pending'   THEN 1 ELSE 0 END) AS pending_payment,
       SUM(CASE WHEN payment_status      = 'failed'    THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN registration_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
    FROM registrations
  `, []);

  const portfolioStats = await db.getOne(`
    SELECT
       COUNT(*)                                                               AS total_portfolios,
       SUM(CASE WHEN COALESCE(a.taken,0) >= p.capacity THEN 1 ELSE 0 END)   AS full_portfolios,
       SUM(CASE WHEN COALESCE(a.taken,0) <  p.capacity THEN 1 ELSE 0 END)   AS available_portfolios
    FROM portfolios p
    LEFT JOIN (
      SELECT allocated_portfolio, COUNT(*) AS taken
      FROM registrations
      WHERE registration_status IN ('payment_verified','confirmed')
      GROUP BY allocated_portfolio
    ) a ON a.allocated_portfolio = p.id
    WHERE p.is_active = 1
  `, []);

  res.json({ ...stats, ...portfolioStats });
}));

// ─── Admin: Registrations Management ─────────────────────────────────────────
app.get('/api/admin/registrations', requireAdmin, asyncHandler(async (req, res) => {
  const { search, committee, payment_status, registration_status, page = 1, per_page = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(per_page);

  let where  = '1=1';
  const params = [];

  if (search) {
    where += ' AND (r.name LIKE ? OR r.email LIKE ? OR r.registration_number LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (committee)          { where += ' AND c.code = ?';                params.push(committee); }
  if (payment_status)     { where += ' AND r.payment_status = ?';      params.push(payment_status); }
  if (registration_status){ where += ' AND r.registration_status = ?'; params.push(registration_status); }

  const totalRow = await db.getOne(`
    SELECT COUNT(*) AS c
    FROM registrations r
    LEFT JOIN committees c ON c.id = r.allocated_committee
    WHERE ${where}
  `, params);

  const rows = await db.query(`
    SELECT r.id, r.registration_number, r.name, r.email, r.school, r.city,
           r.payment_status, r.registration_status, r.created_at,
           c.code AS committee_code, p.name AS portfolio_name
    FROM registrations r
    LEFT JOIN committees c ON c.id = r.allocated_committee
    LEFT JOIN portfolios p ON p.id = r.allocated_portfolio
    WHERE ${where}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `, [...params, Number(per_page), offset]);

  res.json({ total: parseInt(String(totalRow.c), 10), page: Number(page), data: rows });
}));

app.get('/api/admin/registrations/:id', requireAdmin, asyncHandler(async (req, res) => {
  const reg = await db.getOne(`
    SELECT r.*, c.code AS committee_code, c.name AS committee_name,
           p.name AS portfolio_name, p.type AS portfolio_type
    FROM registrations r
    LEFT JOIN committees c ON c.id = r.allocated_committee
    LEFT JOIN portfolios p ON p.id = r.allocated_portfolio
    WHERE r.id = ?
  `, [req.params.id]);

  if (!reg) return res.status(404).json({ error: 'Not found.' });

  const payment = await db.getOne(
    'SELECT * FROM payments WHERE registration_id = ? ORDER BY created_at DESC LIMIT 1',
    [req.params.id]
  );
  res.json({ registration: reg, payment: payment || null });
}));

app.patch('/api/admin/registrations/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { committee_id, portfolio_id, registration_status, notes } = req.body;
  const reg = await db.getOne('SELECT * FROM registrations WHERE id = ?', [req.params.id]);
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });

  const updates = [];
  const params  = [];
  if (committee_id         !== undefined) { updates.push('allocated_committee = ?'); params.push(committee_id); }
  if (portfolio_id         !== undefined) { updates.push('allocated_portfolio = ?'); params.push(portfolio_id); }
  if (registration_status !== undefined) {
    updates.push('registration_status = ?');
    params.push(registration_status);
    if (registration_status === 'confirmed' && !reg.confirmed_at) {
      updates.push('confirmed_at = ?');
      params.push(new Date().toISOString());
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  params.push(req.params.id);
  await db.run(`UPDATE registrations SET ${updates.join(', ')} WHERE id = ?`, params);
  await logAudit('admin_override', req.admin.id, req.params.id, null, JSON.stringify(req.body), notes || null);

  res.json({ success: true });
}));

// ─── Admin: Committee Management ──────────────────────────────────────────────
app.get('/api/admin/committees', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.query(`
    SELECT c.*,
           COUNT(DISTINCT r.id)  AS delegate_count,
           COUNT(DISTINCT p.id)  AS portfolio_count
    FROM committees c
    LEFT JOIN registrations r ON r.allocated_committee = c.id
      AND r.registration_status IN ('payment_verified', 'confirmed')
    LEFT JOIN portfolios p ON p.committee_id = c.id AND p.is_active = 1
    GROUP BY c.id, c.code, c.name, c.category, c.capacity, c.is_active, c.created_at
    ORDER BY c.code ASC
  `, []);
  res.json(rows);
}));

app.post('/api/admin/committees', requireAdmin, asyncHandler(async (req, res) => {
  const { code, name, category, capacity = 0 } = req.body;
  if (!code || !name || !category) return res.status(400).json({ error: 'code, name, category required.' });

  const id = uuidv4();
  await db.run(
    'INSERT INTO committees (id,code,name,category,capacity) VALUES (?,?,?,?,?)',
    [id, code.toUpperCase(), name, category.toUpperCase(), capacity]
  );
  await logAudit('committee_created', req.admin.id, null, null, code.toUpperCase(), null);
  res.json({ id });
}));

app.patch('/api/admin/committees/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { name, category, capacity, is_active } = req.body;
  const c = await db.getOne('SELECT * FROM committees WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found.' });

  const updates = [];
  const params  = [];
  if (name      !== undefined) { updates.push('name = ?');      params.push(name); }
  if (category  !== undefined) { updates.push('category = ?');  params.push(category); }
  if (capacity  !== undefined) { updates.push('capacity = ?');  params.push(capacity); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  params.push(req.params.id);
  await db.run(`UPDATE committees SET ${updates.join(', ')} WHERE id = ?`, params);
  await logAudit('committee_updated', req.admin.id, null, null, req.params.id, null);
  res.json({ success: true });
}));

// ─── Admin: Committee-Specific Portfolio Matrices ────────────────────────────
app.get('/api/admin/portfolios/:committeeId', requireAdmin, asyncHandler(async (req, res) => {
  const committee = await db.getOne(
    'SELECT * FROM committees WHERE id = ? OR UPPER(code) = UPPER(?)',
    [req.params.committeeId, req.params.committeeId]
  );
  if (!committee) return res.status(404).json({ error: 'Committee not found.' });

  const rows = await db.query(`
    SELECT p.*,
           COALESCE(alloc.taken, 0) AS allocated,
           CASE
             WHEN COALESCE(alloc.taken, 0) >= p.capacity THEN 'full'
             ELSE 'available'
           END AS status,
           alloc.delegates
    FROM portfolios p
    LEFT JOIN (
      SELECT r.allocated_portfolio,
             COUNT(DISTINCT r.id) AS taken,
             ${db.AGG}(r.name || ' (' || COALESCE(r.registration_number, '—') || ')', '; ') AS delegates
      FROM registrations r
      WHERE r.allocated_committee = ?
        AND r.registration_status IN ('payment_verified', 'confirmed')
      GROUP BY r.allocated_portfolio
    ) alloc ON alloc.allocated_portfolio = p.id
    WHERE p.committee_id = ?
    ORDER BY p.name ASC
  `, [committee.id, committee.id]);

  res.json({ committee, portfolios: rows });
}));

app.post('/api/admin/portfolios', requireAdmin, asyncHandler(async (req, res) => {
  const { committee_id, name, capacity = 1, type } = req.body;
  if (!committee_id || !name) return res.status(400).json({ error: 'committee_id and name required.' });

  const c = await db.getOne(
    'SELECT id, category FROM committees WHERE id = ? OR UPPER(code) = UPPER(?)',
    [committee_id, committee_id]
  );
  if (!c) return res.status(404).json({ error: 'Committee not found.' });

  const portType = type || (
    c.category.includes('POLITICS') || c.category.includes('ASSEMBLY') ? 'leader' : 'country'
  );
  const id = uuidv4();

  try {
    await db.run(
      'INSERT INTO portfolios (id,committee_id,name,type,capacity) VALUES (?,?,?,?,?)',
      [id, c.id, name.trim(), portType, capacity]
    );
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Portfolio '${name}' already exists in this committee.` });
    }
    throw err;
  }

  await logAudit('portfolio_created', req.admin.id, null, null, `${name.trim()} (${c.id})`, null);
  res.json({ id });
}));

app.patch('/api/admin/portfolios/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { name, type, capacity, is_active } = req.body;
  const p = await db.getOne('SELECT * FROM portfolios WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found.' });

  const updates = [];
  const params  = [];
  if (name      !== undefined) { updates.push('name = ?');      params.push(name.trim()); }
  if (type      !== undefined) { updates.push('type = ?');      params.push(type); }
  if (capacity  !== undefined) { updates.push('capacity = ?');  params.push(capacity); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  params.push(req.params.id);
  await db.run(`UPDATE portfolios SET ${updates.join(', ')} WHERE id = ?`, params);
  await logAudit('portfolio_updated', req.admin.id, null, null, req.params.id, null);
  res.json({ success: true });
}));

// ─── Admin: Audit Log ─────────────────────────────────────────────────────────
app.get('/api/admin/audit', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200', []);
  res.json(rows);
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function logAudit(action, adminId, registrationId, oldValue, newValue, notes) {
  await db.run(`
    INSERT INTO audit_log (id, action, admin_id, registration_id, old_value, new_value, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `, [
    uuidv4(), action,
    adminId        || null,
    registrationId || null,
    oldValue  ? String(oldValue)  : null,
    newValue  ? String(newValue)  : null,
    notes     || null,
    new Date().toISOString(),
  ]);
}

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Server startup ───────────────────────────────────────────────────────────
async function start() {
  await db.initialize();       // schema + committee seed
  await ensureDefaultAdmin();  // sync admin credentials from env
  app.listen(PORT, () => {
    console.log(`✓ VMMUN backend running on port ${PORT}`);
    console.log(`  Allowed origins: ${allowedOrigins.join(', ')}`);
    console.log(`  Registration fee: ₹${FEE_PAISE / 100}`);
    console.log(`  Razorpay key: ${process.env.RAZORPAY_KEY_ID}`);
  });
}

start().catch(err => {
  console.error('Startup error:', err.message || err);
  process.exit(1);
});
