'use strict';

const express = require('express');
const db = require('../lib/db');
const { bentoShell, pageShell, parseSocial } = require('../lib/layout');
const { esc, renderMarkdown, formatDate, formatDateDot, isDarkColor } = require('../lib/util');

const router = express.Router();
const PER_PAGE = 8;

// simple in-memory comment rate limit: max 5 comments / 10 min per IP
const commentLog = new Map();
function commentAllowed(ip) {
  const now = Date.now();
  const rec = commentLog.get(ip) || { ts: now, count: 0 };
  if (now - rec.ts > 10 * 60 * 1000) { rec.ts = now; rec.count = 0; }
  if (rec.count >= 5) return false;
  rec.count += 1;
  commentLog.set(ip, rec);
  return true;
}

function site() {
  return {
    site_title: db.getSetting('site_title'),
    site_subtitle: db.getSetting('site_subtitle'),
    author: db.getSetting('author'),
    site_description: db.getSetting('site_description'),
    avatar_url: db.getSetting('avatar_url'),
    social_links: db.getSetting('social_links'),
    theme_color: db.getSetting('theme_color'),
    footer_text: db.getSetting('footer_text'),
    icp: db.getSetting('icp'),
    announcement: db.getSetting('announcement'),
    nav_links: db.getSetting('nav_links'),
    comment_moderation: db.getSetting('comment_moderation')
  };
}

/* wrap pageShell with pages injected for nav */
function page(s, opts, body) {
  opts.pages = db.getPages();
  return pageShell(s, opts, body);
}

function tagList() {
  const rows = db.prepare("SELECT tags FROM posts WHERE published = 1 AND tags != ''").all();
  const map = {};
  rows.forEach(r => String(r.tags || '').split(',').map(s => s.trim()).filter(Boolean)
    .forEach(t => { map[t] = (map[t] || 0) + 1; }));
  return Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

function escapeLike(str) {
  return String(str).replace(/[\\%_]/g, '\\$&');
}

function pager(total, page, makeUrl) {
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (totalPages <= 1) return '';
  let parts = '';
  for (let i = 1; i <= totalPages; i++) {
    parts += `<a class="pager-btn${i === page ? ' active' : ''}" href="${makeUrl(i)}">${i}</a>`;
  }
  return `<div class="pager">${parts}</div>`;
}

/* one article row: optional cover + pin badge, title left, date right */
function postRow(p) {
  const cover = p.cover ? `<span class="post-row-cover"><img src="${esc(p.cover)}" alt="" loading="lazy"></span>` : '';
  const pin = p.pinned ? '<span class="pin-badge">置顶</span>' : '';
  return `<a class="post-row${p.cover ? ' has-cover' : ''}" href="/post/${encodeURIComponent(p.slug)}">
    ${cover}
    <span class="post-row-title">${pin}${esc(p.title)}</span>
    <span class="post-row-date">${formatDateDot(p.published_at || p.created_at)}</span>
  </a>`;
}

function tabsHtml(activeTag) {
  const tags = tagList();
  let out = `<a class="tab${!activeTag ? ' active' : ''}" href="/">最新</a>`;
  for (const t of tags) {
    out += `<a class="tab${activeTag === t.name ? ' active' : ''}" href="/?tag=${encodeURIComponent(t.name)}">${esc(t.name)}</a>`;
  }
  return `<div class="tabs">${out}</div>`;
}

function renderBlock(b) {
  const style = b.color ? ` style="background:${esc(b.color)}"` : '';
  const dark = isDarkColor(b.color);
  const sizeCls = b.size && b.size !== 'normal' ? ` block-${esc(b.size)}` : '';
  const cls = `bento-card card-custom${sizeCls}${dark ? '' : ' card-light'}`;
  const emoji = b.emoji ? `<span class="card-emoji">${esc(b.emoji)}</span>` : '';
  const cover = b.cover ? `<span class="card-cover"><img src="${esc(b.cover)}" alt="" loading="lazy"></span>` : '';
  const subtitle = (b.subtitle || '').split('\n').map(esc).join('<br>');
  const btn = b.link ? `<div class="card-action"><span class="card-btn">了解更多</span></div>` : '';
  const href = b.link || '#';
  return `<a class="${cls}" href="${esc(href)}"${style}>
    ${cover}
    <div class="card-body">
      ${emoji}<h2 class="card-title">${esc(b.title)}</h2>
      ${subtitle ? `<p class="card-desc">${subtitle}</p>` : ''}
      ${btn}
    </div>
  </a>`;
}

/* ---------- bento homepage ---------- */
router.get('/', (req, res) => {
  const s = site();
  db.publishScheduled();
  const tag = (req.query.tag || '').toString().trim();
  const pageN = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (pageN - 1) * PER_PAGE;

  const orderBy = 'ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC, id DESC';
  let total, posts;
  if (tag) {
    total = db.prepare("SELECT COUNT(*) c FROM posts WHERE published = 1 AND (',' || tags || ',') LIKE ?").get(`%,${tag},%`).c;
    posts = db.prepare(`SELECT * FROM posts WHERE published = 1 AND (',' || tags || ',') LIKE ? ${orderBy} LIMIT ? OFFSET ?`)
      .all(`%,${tag},%`, PER_PAGE, offset);
  } else {
    total = db.prepare('SELECT COUNT(*) c FROM posts WHERE published = 1').get().c;
    posts = db.prepare(`SELECT * FROM posts WHERE published = 1 ${orderBy} LIMIT ? OFFSET ?`).all(PER_PAGE, offset);
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const rowsHtml = posts.length ? posts.map(postRow).join('\n') : `<p class="panel-empty">${tag ? `还没有“${esc(tag)}”分类下的文章。` : '还没有文章，去后台写第一篇吧。'}</p>`;
  const nav = pager(total, pageN, (i) => tag ? `/?tag=${encodeURIComponent(tag)}&page=${i}` : `/?page=${i}`);
  const moreLink = !tag && totalPages > 1 ? `<a class="more-link" href="/?page=2">查看更多</a>` : '';

  const blocks = db.getBlocks().filter(b => b.enabled);
  const blockCards = blocks.map(renderBlock).join('\n');

  const social = parseSocial(s.social_links);
  const socialCards = social.map(sc => {
    const style = sc.color ? ` style="background:${esc(sc.color)}"` : '';
    return `<a class="bento-card card-social${isDarkColor(sc.color) ? '' : ' card-light'}" href="${esc(sc.url)}" target="_blank" rel="noopener noreferrer"${style}>
      <div class="card-body"><h2 class="card-title">${esc(sc.name)}</h2></div>
    </a>`;
  }).join('\n');

  const postsSection = `<section class="bento-card card-posts">
    <div class="posts-head">
      <h2 class="section-title">📝 博客文章</h2>
      <span class="panel-count">共 ${total} 篇</span>
    </div>
    ${tabsHtml(tag)}
    <div class="post-rows">${rowsHtml}</div>
    ${nav}${moreLink}
  </section>`;

  const body = `<div class="bento-grid-top">${blockCards}${socialCards}</div>
  ${postsSection}`;
  res.send(bentoShell(s, body));
});

/* ---------- search ---------- */
router.get('/search', (req, res) => {
  const s = site();
  const q = (req.query.q || '').toString().trim();
  const pageN = Math.max(1, parseInt(req.query.page, 10) || 1);

  if (!q) {
    const body = `<section class="panel"><div class="panel-head"><span class="panel-title">🔍 搜索</span></div>
      <p class="panel-empty">输入关键词，按标题或标签搜索文章。</p></section>`;
    return res.send(page(s, { title: '搜索' }, body));
  }

  const pat = `%${escapeLike(q)}%`;
  const offset = (pageN - 1) * PER_PAGE;
  const total = db.prepare("SELECT COUNT(*) c FROM posts WHERE published = 1 AND (title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')").get(pat, pat).c;
  const posts = db.prepare("SELECT * FROM posts WHERE published = 1 AND (title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC LIMIT ? OFFSET ?")
    .all(pat, pat, PER_PAGE, offset);

  const rowsHtml = posts.length ? posts.map(postRow).join('\n') : `<p class="panel-empty">没有找到与“${esc(q)}”相关的文章。</p>`;
  const nav = pager(total, pageN, (i) => `/search?q=${encodeURIComponent(q)}&page=${i}`);

  const body = `<section class="panel">
    <div class="panel-head"><span class="panel-title">🔍 搜索“${esc(q)}”</span><span class="panel-count">共 ${total} 篇</span></div>
    <div class="post-rows">${rowsHtml}</div>
    ${nav}
  </section>`;
  res.send(page(s, { title: '搜索：' + q, q }, body));
});

/* ---------- about ---------- */
router.get('/about', (req, res) => {
  const s = site();
  const content = db.getSetting('about_content') || '';
  const html = renderMarkdown(content);
  const body = `<section class="panel">
    <div class="panel-head"><span class="panel-title">👋 关于</span></div>
    <div class="post-content about-content">${html || '<p>作者还没有填写关于页面。</p>'}</div>
  </section>`;
  res.send(page(s, { title: '关于' }, body));
});

/* ---------- custom pages ---------- */
router.get('/page/:slug', (req, res) => {
  const s = site();
  const p = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
  if (!p) return res.status(404).send(page(s, { title: '未找到' }, '<section class="panel"><h1>404</h1><p>页面不存在。</p><p><a href="/">返回首页</a></p></section>'));
  const html = renderMarkdown(p.content);
  const body = `<section class="panel"><h1>${esc(p.title)}</h1><div class="post-content">${html}</div></section>`;
  res.send(page(s, { title: p.title, desc: '' }, body));
});

/* ---------- single post + comments ---------- */
function textToHtml(text) {
  return esc(text).replace(/\r?\n/g, '<br>');
}

function commentItem(c) {
  const reply = c.reply ? `<div class="comment-reply"><strong>博主回复：</strong>${textToHtml(c.reply)}</div>` : '';
  return `<div class="comment" id="comment-${c.id}">
    <div class="comment-head">
      <span class="comment-author">${esc(c.author)}</span>
      <span class="comment-time">${formatDate(c.created_at)}</span>
    </div>
    <div class="comment-body">${textToHtml(c.content)}</div>
    ${reply}
  </div>`;
}

router.get('/post/:slug', (req, res) => {
  const s = site();
  const p = db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!p) return res.status(404).send(page(s, { title: '未找到' }, '<section class="panel"><h1>404</h1><p>文章不存在或未发布。</p><p><a href="/">返回首页</a></p></section>'));

  const tags = (p.tags || '').split(',').filter(Boolean);
  const tagHtml = tags.length
    ? `<div class="post-tags">${tags.map(t => `<a class="tag tag-link" href="/?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>`
    : '';
  const html = renderMarkdown(p.content);

  const comments = db.prepare("SELECT * FROM comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at ASC, id ASC").all(p.id);
  const items = comments.map(commentItem).join('\n');
  let note = '';
  if (req.query.cok) note = `<div class="flash">评论发表成功，感谢参与。</div>`;
  else if (req.query.cok === 'pending') note = `<div class="flash">评论已提交，审核通过后显示。</div>`;
  else if (req.query.cerr) note = `<div class="flash flash-err">${esc(String(req.query.cerr))}</div>`;

  const commentPanel = `<section class="panel comments-panel" id="comments">
    <div class="panel-head"><span class="panel-title">💬 评论</span><span class="panel-count">${comments.length}</span></div>
    ${note}
    ${items ? `<div class="comment-list">${items}</div>` : '<p class="panel-empty">还没有评论，来抢沙发～</p>'}
    <form class="comment-form" method="post" action="/post/${encodeURIComponent(p.slug)}/comment#comments">
      <div class="comment-form-row">
        <input type="text" name="name" required maxlength="40" placeholder="昵称 *">
        <input type="email" name="email" maxlength="200" placeholder="邮箱（选填，不公开）">
      </div>
      <textarea name="content" required maxlength="2000" rows="4" placeholder="友善评论，理性发言…"></textarea>
      <input type="text" name="hp" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="comment-form-foot">
        <span class="comment-hint">内容支持纯文本，换行自动分段</span>
        <button type="submit" class="btn btn-primary">发表评论</button>
      </div>
    </form>
  </section>`;

  const body = `<article class="panel post-panel">
    <h1 class="post-title">${esc(p.title)}</h1>
    <div class="post-meta">${formatDate(p.published_at || p.created_at)}</div>
    ${tagHtml}
    <div class="post-content">${html}</div>
  </article>
  ${commentPanel}
  <p class="back-link"><a href="/">← 返回首页</a></p>`;
  res.send(page(s, { title: p.title, desc: p.summary }, body));
});

/* ---------- submit comment ---------- */
router.post('/post/:slug/comment', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!p) return res.status(404).send('Not found');

  const slug = encodeURIComponent(p.slug);
  const anchor = '#comments';
  if (req.body && req.body.hp) return res.redirect(`/post/${slug}${anchor}`); // honeypot: bots only

  const ip = req.ip || 'unknown';
  const author = (req.body && req.body.name || '').toString().trim();
  const email = (req.body && req.body.email || '').toString().trim();
  const content = (req.body && req.body.content || '').toString().trim();

  let err = null;
  if (!author || author.length > 40) err = '请填写昵称（40 字以内）。';
  else if (!content || content.length > 2000) err = '评论内容需在 1-2000 字之间。';
  else if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) err = '邮箱格式不正确（选填）。';
  else if (!commentAllowed(ip)) err = '评论太频繁了，请 10 分钟后再试。';

  if (err) return res.redirect(`/post/${slug}?cerr=${encodeURIComponent(err)}${anchor}`);

  const moderation = db.getSetting('comment_moderation') === '1';
  const status = moderation ? 'pending' : 'approved';
  db.prepare('INSERT INTO comments (post_id, author, email, content, ip, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.id, author, email, content, ip, status);
  res.redirect(`/post/${slug}?cok=${moderation ? 'pending' : '1'}${anchor}`);
});

module.exports = router;
