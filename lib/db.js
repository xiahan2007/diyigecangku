'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.BLOG_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'blog.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  summary      TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '',
  published    INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  pinned       INTEGER NOT NULL DEFAULT 0,
  cover        TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admin (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  username  TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  salt      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  ip         TEXT,
  status     TEXT NOT NULL DEFAULT 'approved',
  reply      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS blocks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  title    TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  link     TEXT NOT NULL DEFAULT '',
  color    TEXT NOT NULL DEFAULT '',
  emoji    TEXT NOT NULL DEFAULT '',
  cover    TEXT NOT NULL DEFAULT '',
  size     TEXT NOT NULL DEFAULT 'normal',
  sort     INTEGER NOT NULL DEFAULT 0,
  enabled  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// lightweight migration: add a column if missing (for pre-existing DBs)
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function init() {
  ensureColumn('posts', 'pinned', "pinned INTEGER NOT NULL DEFAULT 0");
  ensureColumn('posts', 'cover', "cover TEXT NOT NULL DEFAULT ''");
  ensureColumn('posts', 'scheduled_at', 'scheduled_at TEXT');
  ensureColumn('comments', 'reply', "reply TEXT NOT NULL DEFAULT ''");
  ensureColumn('blocks', 'cover', "cover TEXT NOT NULL DEFAULT ''");
  ensureColumn('blocks', 'size', "size TEXT NOT NULL DEFAULT 'normal'");

  const defaults = {
    site_title: '我的博客',
    site_subtitle: '记录与分享',
    author: '',
    site_description: '',
    avatar_url: '',
    social_links: '',
    theme_color: '',
    footer_text: '',
    icp: '',
    announcement: '',
    comment_moderation: '0',
    nav_links: '',
    about_content: '## 关于我\n\n这里是“关于我”页面，可以用来写你的简介、简历或作品集。\n\n请登录后台 → 「关于页」，用 Markdown 编辑这段内容。'
  };
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) stmt.run(k, v);
  initBlocks();
}

function initBlocks() {
  const c = db.prepare('SELECT COUNT(*) c FROM blocks').get().c;
  if (c > 0) return;
  const sub = getSetting('site_subtitle') || 'Stay simple, stay naive.';
  const ins = db.prepare('INSERT INTO blocks (title, subtitle, link, color, emoji, cover, size, sort, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)');
  ins.run('关于我', sub, '/about', '#7c3aed', '👋', '', 'normal', 1);
  ins.run('博客', '记录技术 / 生活 / 随想', '/', '#2c3e50', '📝', '', 'normal', 2);
}

// lazy publish: flip scheduled posts that are now due (called on read paths)
function publishScheduled() {
  db.prepare("UPDATE posts SET published = 1, published_at = scheduled_at, scheduled_at = NULL WHERE scheduled_at IS NOT NULL AND scheduled_at <= datetime('now')").run();
}

function getBlocks() {
  return db.prepare('SELECT * FROM blocks ORDER BY sort ASC, id ASC').all();
}

function getPages() {
  return db.prepare('SELECT * FROM pages ORDER BY sort ASC, id ASC').all();
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function getAdmin() {
  return db.prepare('SELECT * FROM admin WHERE id = 1').get() || null;
}

function setAdmin(username, passHash, salt) {
  db.prepare('INSERT INTO admin (id, username, pass_hash, salt) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, pass_hash = excluded.pass_hash, salt = excluded.salt')
    .run(username, passHash, salt);
}

// Attach helpers directly to the Database instance
db.init = init;
db.publishScheduled = publishScheduled;
db.getSetting = getSetting;
db.setSetting = setSetting;
db.getAdmin = getAdmin;
db.setAdmin = setAdmin;
db.getBlocks = getBlocks;
db.getPages = getPages;

module.exports = db;
