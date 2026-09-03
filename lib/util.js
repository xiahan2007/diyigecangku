'use strict';

const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SANITIZE_OPTS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'span', 'div', 'del', 'ins',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'kbd', 'pre', 'p'
  ]),
  allowedAttributes: Object.assign({}, sanitizeHtml.defaults.allowedAttributes, {
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['class']
  }),
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowProtocolRelative: false
};

function renderMarkdown(md) {
  if (!md) return '';
  const raw = marked.parse(String(md), { async: false, gfm: true, breaks: true });
  const clean = sanitizeHtml(raw, SANITIZE_OPTS);
  // make external links open in new tab safely
  return clean.replace(/<a href="(http[^"]*)"/g, '<a href="$1" target="_blank" rel="noopener noreferrer"');
}

function slugify(text) {
  const base = String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (base) return base;
  // For non-Latin titles (e.g. Chinese) produce a stable id-based slug
  return 'p-' + Date.now().toString(36);
}

function makeUniqueSlug(title, db, excludeId) {
  let slug = slugify(title);
  let candidate = slug;
  let n = 2;
  while (db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').get(candidate, excludeId || 0)) {
    candidate = `${slug}-${n++}`;
  }
  return candidate;
}

function formatDate(utcStr) {
  if (!utcStr) return '';
  // stored as SQLite datetime('now') in UTC "YYYY-MM-DD HH:MM:SS"
  const s = String(utcStr).replace(' ', 'T');
  const d = new Date(s.endsWith('Z') || s.endsWith('+08:00') ? s : s + 'Z');
  if (isNaN(d.getTime())) return utcStr;
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// Short dot date like 2026.05.18 (idealclover style, list rows)
function formatDateDot(utcStr) {
  if (!utcStr) return '';
  const s = String(utcStr).replace(' ', 'T');
  const d = new Date(s.endsWith('Z') || s.endsWith('+08:00') ? s : s + 'Z');
  if (isNaN(d.getTime())) return utcStr;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
}

function shortSummary(content, len) {
  const plain = String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > len ? plain.slice(0, len) + '…' : plain;
}

function nowUTC() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// whether a hex color is dark (for picking text color on colored cards)
function isDarkColor(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || '').trim());
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 150;
}

module.exports = { esc, renderMarkdown, slugify, makeUniqueSlug, formatDate, formatDateDot, shortSummary, nowUTC, isDarkColor };
