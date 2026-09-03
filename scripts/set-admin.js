'use strict';

// Usage: node scripts/set-admin.js <username> <password>
// Creates or updates the admin account (id=1) with a salted scrypt hash.
const db = require('../lib/db');
const { scryptHash } = require('../lib/auth');

db.init();

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('Usage: node scripts/set-admin.js <username> <password>');
  process.exit(1);
}
if (String(password).length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const { salt, hash } = scryptHash(password);
db.setAdmin(String(username).trim(), hash, salt);
console.log(`Admin account "${String(username).trim()}" set successfully.`);
process.exit(0);
