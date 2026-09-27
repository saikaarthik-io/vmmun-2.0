-- ─────────────────────────────────────────────────────────────────────────────
-- schema.sql — PostgreSQL schema for VMMUN 2026 backend
--
-- Run this ONCE against your production Supabase / PostgreSQL database.
-- All statements use IF NOT EXISTS / ON CONFLICT DO NOTHING — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- Committees (one row per committee; independent portfolio matrix per committee)
CREATE TABLE IF NOT EXISTS committees (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  capacity    INTEGER DEFAULT 0,
  is_active   INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (NOW()::TEXT)
);

-- Portfolios — scoped strictly to a committee (UNIQUE per committee + name)
CREATE TABLE IF NOT EXISTS portfolios (
  id            TEXT PRIMARY KEY,
  committee_id  TEXT NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT DEFAULT 'country',   -- 'country' | 'leader' | 'press'
  capacity      INTEGER DEFAULT 1,
  is_active     INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (NOW()::TEXT),
  UNIQUE(committee_id, name)
);

-- Registrations — one per delegate; committee/portfolio assigned after payment
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
  created_at          TEXT DEFAULT (NOW()::TEXT),
  confirmed_at        TEXT
);

-- Payments — tracks Razorpay order/payment lifecycle
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
  created_at            TEXT DEFAULT (NOW()::TEXT),
  paid_at               TEXT,
  UNIQUE(razorpay_order_id)
);

-- Portfolio reservations (optional / future use)
CREATE TABLE IF NOT EXISTS portfolio_reservations (
  id              TEXT PRIMARY KEY,
  portfolio_id    TEXT NOT NULL REFERENCES portfolios(id),
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  expires_at      TEXT NOT NULL,
  is_confirmed    INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (NOW()::TEXT),
  UNIQUE(portfolio_id, registration_id)
);

-- Audit log — immutable record of every significant action
CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY,
  action          TEXT NOT NULL,
  admin_id        TEXT,
  registration_id TEXT,
  old_value       TEXT,
  new_value       TEXT,
  notes           TEXT,
  created_at      TEXT DEFAULT (NOW()::TEXT)
);

-- Admins — bcrypt-hashed credentials; synced from env on startup
CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT DEFAULT (NOW()::TEXT)
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_registrations_email          ON registrations(email);
CREATE INDEX IF NOT EXISTS idx_registrations_status         ON registrations(registration_status);
CREATE INDEX IF NOT EXISTS idx_registrations_payment_status ON registrations(payment_status);
CREATE INDEX IF NOT EXISTS idx_registrations_order_id       ON registrations(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id            ON payments(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_id          ON payments(razorpay_payment_id);
CREATE INDEX IF NOT EXISTS idx_reservations_portfolio       ON portfolio_reservations(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_audit_registration           ON audit_log(registration_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_committee         ON portfolios(committee_id);
