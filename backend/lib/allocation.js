/**
 * allocation.js — Committee-Specific Atomic Portfolio Allocation
 *
 * CORE RULES:
 *  1. Portfolio availability is strictly scoped to (committee_id + portfolio).
 *  2. The same country/leader/press exists independently in every committee matrix.
 *  3. Allocating 'India' in UNGA has ZERO effect on 'India' in UNHRC or ECOSOC.
 *  4. Race-condition safety:
 *       PostgreSQL — SELECT … FOR UPDATE on the committee row serialises
 *                    concurrent allocations for the same committee.
 *       SQLite     — BEGIN EXCLUSIVE lock (set by db.transaction) provides the
 *                    same guarantee for local development.
 *
 * Exported functions:
 *   allocatePortfolio(registrationId)          — standalone (owns its transaction)
 *   allocatePortfolioInTx(registrationId, tx)  — must be called inside an
 *                                                 existing db.transaction() block
 */
'use strict';

const db = require('./db');

// ─── In-transaction allocation (shared by both exports) ──────────────────────

/**
 * Attempt to allocate a portfolio using the provided transaction helpers.
 * Must be called inside a db.transaction() block.
 *
 * Strategy:
 *  For each preferred committee (in preference order):
 *    1. Lock the committee row (PostgreSQL FOR UPDATE; SQLite — already in exclusive tx).
 *    2. Try each portfolio preference in this committee.
 *    3. If none are free, fall back to any free portfolio in the same committee.
 *
 * @param {string} registrationId
 * @param {{ getOne, query, run }} tx  — transaction helpers from db.transaction()
 * @returns {Promise<object|null>}  allocation result or null if no slot found
 */
async function allocatePortfolioInTx(registrationId, tx) {
  const reg = await tx.getOne('SELECT * FROM registrations WHERE id = ?', [registrationId]);
  if (!reg) throw new Error('Registration not found: ' + registrationId);

  // Ordered committee preferences
  const committeeCodes = [reg.committee_pref_1, reg.committee_pref_2, reg.committee_pref_3]
    .map(c => c && c.trim())
    .filter(Boolean);

  // Deduplicated portfolio preferences (case-insensitive, order preserved)
  const rawPrefs = [
    reg.country_preferred,
    reg.portfolio_pref_1, reg.portfolio_pref_2, reg.portfolio_pref_3,
    reg.portfolio_pref_4, reg.portfolio_pref_5,
  ];
  const seen = new Set();
  const portfolioPrefs = [];
  for (const p of rawPrefs) {
    if (p && typeof p === 'string' && p.trim()) {
      const clean = p.trim();
      if (!seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        portfolioPrefs.push(clean);
      }
    }
  }

  // FOR UPDATE clause — locks the committee row in PostgreSQL to serialise
  // concurrent allocations. SQLite uses BEGIN EXCLUSIVE (set by db.transaction).
  const FOR_UPDATE = db.USE_PG ? 'FOR UPDATE' : '';

  for (const committeeCode of committeeCodes) {
    // Lock committee row for this allocation attempt
    const committee = await tx.getOne(
      `SELECT * FROM committees WHERE UPPER(code) = UPPER(?) AND is_active = 1 ${FOR_UPDATE}`,
      [committeeCode]
    );
    if (!committee) continue;

    // ── Step 1: Try each portfolio preference within this committee ──────────
    for (const prefName of portfolioPrefs) {
      const portfolio = await tx.getOne(`
        SELECT * FROM portfolios
        WHERE committee_id = ?
          AND (LOWER(TRIM(name)) = LOWER(TRIM(?)) OR LOWER(TRIM(name)) LIKE LOWER(?))
          AND is_active = 1
        LIMIT 1
      `, [committee.id, prefName, `%${prefName}%`]);

      if (!portfolio) continue;

      // Check how many confirmed delegates already hold this portfolio in this committee
      const countRow = await tx.getOne(`
        SELECT COUNT(*) AS taken FROM registrations
        WHERE allocated_committee = ?
          AND allocated_portfolio = ?
          AND registration_status IN ('payment_verified', 'confirmed')
      `, [committee.id, portfolio.id]);

      const taken = parseInt(String(countRow.taken), 10) || 0;

      if (taken < portfolio.capacity) {
        await tx.run(
          'UPDATE registrations SET allocated_committee = ?, allocated_portfolio = ? WHERE id = ?',
          [committee.id, portfolio.id, registrationId]
        );
        return {
          committee_id:   committee.id,
          committee_code: committee.code,
          portfolio_id:   portfolio.id,
          portfolio_name: portfolio.name,
          portfolio_type: portfolio.type || 'delegate',
        };
      }
    }

    // ── Step 2: Fallback — any free portfolio in this committee ──────────────
    const freeRows = await tx.query(`
      SELECT p.*
      FROM portfolios p
      LEFT JOIN (
        SELECT allocated_portfolio, COUNT(*) AS taken
        FROM registrations
        WHERE allocated_committee = ?
          AND registration_status IN ('payment_verified', 'confirmed')
        GROUP BY allocated_portfolio
      ) alloc ON alloc.allocated_portfolio = p.id
      WHERE p.committee_id = ?
        AND p.is_active = 1
        AND (alloc.taken IS NULL OR alloc.taken < p.capacity)
      ORDER BY p.name ASC
      LIMIT 1
    `, [committee.id, committee.id]);

    const freePortfolio = freeRows[0] || null;

    if (freePortfolio) {
      await tx.run(
        'UPDATE registrations SET allocated_committee = ?, allocated_portfolio = ? WHERE id = ?',
        [committee.id, freePortfolio.id, registrationId]
      );
      return {
        committee_id:   committee.id,
        committee_code: committee.code,
        portfolio_id:   freePortfolio.id,
        portfolio_name: freePortfolio.name,
        portfolio_type: freePortfolio.type || 'delegate',
      };
    }
  }

  // No slot found in any preferred committee
  return null;
}

// ─── Standalone allocation (creates its own transaction) ─────────────────────

/**
 * Allocate a portfolio for a registration.
 * Creates its own atomic transaction — do NOT call from inside another
 * db.transaction() block; use allocatePortfolioInTx() instead.
 *
 * @param {string} registrationId
 * @returns {Promise<object|null>}
 */
async function allocatePortfolio(registrationId) {
  return db.transaction(tx => allocatePortfolioInTx(registrationId, tx));
}

// ─── Allocation report for admin dashboard ────────────────────────────────────

/**
 * Return current allocation counts per portfolio for one committee.
 * Scoped strictly to that committee — independent of other committees.
 *
 * @param {string} committeeId
 * @returns {Promise<Array>}
 */
async function getCommitteeAllocation(committeeId) {
  return db.query(`
    SELECT p.id,
           p.name,
           p.type,
           p.capacity,
           p.is_active,
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
  `, [committeeId, committeeId]);
}

module.exports = { allocatePortfolio, allocatePortfolioInTx, getCommitteeAllocation };
