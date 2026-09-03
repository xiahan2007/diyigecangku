'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = 'xlm_blog_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// In-memory session store. Single-process app, acceptable for a personal blog.
const sessions = new Map();

function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function scryptVerify(password, salt, expectedHash) {
  if (!expectedHash || !salt) return false;
  const actual = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  // opportunistic cleanup
  for (const [t, ts] of sessions) {
    if (Date.now() - ts > SESSION_TTL_MS) sessions.delete(t);
  }
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function validSession(token) {
  if (!token) return false;
  const ts = sessions.get(token);
  if (!ts) return false;
  if (Date.now() - ts > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function cookieFor(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// middleware: populate req.sessionValid / req.clearSessionCookie if invalid
function sessionMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  req.sessionToken = token;
  req.sessionValid = validSession(token);
  next();
}

function requireAdmin(req, res, next) {
  if (req.sessionValid) return next();
  const q = req.originalUrl ? encodeURIComponent(req.originalUrl) : '';
  return res.redirect('/admin/login?next=' + q);
}

// Login brute-force protection (in-memory, per IP)
const loginAttempts = new Map(); // ip -> { count, firstTs, lockedUntil }
const MAX_ATTEMPTS = 6;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;

function checkLocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
  return false;
}

function registerFail(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, firstTs: now, lockedUntil: 0 };
  if (now - rec.firstTs > WINDOW_MS) {
    rec.count = 0;
    rec.firstTs = now;
    rec.lockedUntil = 0;
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedUntil = now + LOCK_MS;
  loginAttempts.set(ip, rec);
}

function registerSuccess(ip) {
  loginAttempts.delete(ip);
}

module.exports = {
  SESSION_COOKIE,
  scryptHash,
  scryptVerify,
  createSession,
  destroySession,
  cookieFor,
  CLEAR_COOKIE,
  sessionMiddleware,
  requireAdmin,
  checkLocked,
  registerFail,
  registerSuccess
};
