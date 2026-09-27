/**
 * set-admin.js — CLI tool to set or reset admin credentials.
 *
 * Usage:
 *   node set-admin.js <username> <password>
 * Example:
 *   node set-admin.js admin admin123
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { hashPassword } = require('./lib/auth');
const db = require('./lib/db');
const { v4: uuidv4 } = require('uuid');

async function main() {
  const [,, username, password] = process.argv;
  if (!username || !password) {
    console.log('Usage: node set-admin.js <username> <password>');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const existing = await db.getOne('SELECT * FROM admins WHERE username = ?', [username]);

  if (existing) {
    await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, existing.id]);
    console.log(`✓ Password updated for admin user '${username}'.`);
  } else {
    await db.run('INSERT INTO admins (id, username, password_hash) VALUES (?,?,?)', [uuidv4(), username, hash]);
    console.log(`✓ Admin user '${username}' created with the specified password.`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
