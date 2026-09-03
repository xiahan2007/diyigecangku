'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const db = require('../lib/db');
const auth = require('../lib/auth');
const { adminShell, flash } = require('../lib/layout');
const { esc, renderMarkdown, formatDate, shortSummary, makeUniqueSlug, nowUTC, isDarkColor } = require('../lib/util');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

/* time helpers: store UTC, edit in Asia/Shanghai local */
function toUTC(localStr) {
  if (!localStr) return null;
  const d = new Date(localStr + ':00+08:00');
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
function toLocal(utcStr) {
  if (!utcStr) return '';
  const s = String(utcStr).replace(' ', 'T');
  const d = new Date(s.endsWith('Z') || s.endsWith('+08:00') ? s : s + 'Z');
  if (isNaN(d.getTime())) return '';
  const d8 = new Date(d.getTime() + 8 * 3600 * 1000);
  return d8.toISOString().slice(0, 16);
}

/* compute publish state from form + optional schedule */
function computeSchedule(b) {
  const schedLocal = (b.scheduled_at || '').toString().trim();
  let scheduledAt = toUTC(schedLocal);
  let published = b.published === 'on';
  if (scheduledAt) {
    if (new Date(scheduledAt.replace(' ', 'T') + 'Z').getTime() <= Date.now()) {
      scheduledAt = null;
      published = true;
    } else {
      published = false;
    }
  }
  return { published, scheduledAt };
}

// ---- auth guard (except login) ----
router.use((req, res, next) => {
  if (req.path === '/login') return next();
  if (req.sessionValid) return next();
  const nextPath = req.originalUrl ? encodeURIComponent(req.originalUrl) : '';
  return res.redirect('/admin/login?next=' + nextPath);
});

function safeNext(p) {
  if (typeof p === 'string' && p.startsWith('/admin') && !p.includes('://')) return p;
  return '/admin';
}

/* ---------- login / logout ---------- */
router.get('/login', (req, res) => {
  if (req.sessionValid) return res.redirect('/admin');
  const body = `<div class="login-box">
    <h1>后台登录</h1>
    <form method="post" action="/admin/login">
      <input type="hidden" name="next" value="${esc(safeNext(req.query.next))}">
      <label>用户名</label>
      <input type="text" name="username" autocomplete="username" required autofocus>
      <label>密码</label>
      <input type="password" name="password" autocomplete="current-password" required>
      <button type="submit" class="btn-primary">登 录</button>
    </form>
    <p><a href="/">← 返回站点首页</a></p>
  </div>`;
  res.send(adminShell(site(), { title: '登录' }, body));
});

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (auth.checkLocked(ip)) {
    return res.status(429).send(adminShell(site(), { title: '登录' }, flash('失败次数过多，请 10 分钟后再试。')));
  }
  const { username, password, next } = req.body || {};
  const admin = db.getAdmin();
  const ok = admin && auth.scryptVerify(password || '', admin.salt, admin.pass_hash) &&
             String(admin.username) === String(username || '').trim();
  if (!ok) {
    auth.registerFail(ip);
    return res.status(401).send(adminShell(site(), { title: '登录' }, flash('用户名或密码错误。')));
  }
  auth.registerSuccess(ip);
  const token = auth.createSession();
  res.setHeader('Set-Cookie', auth.cookieFor(token));
  res.redirect(safeNext(next));
});

router.get('/logout', (req, res) => {
  if (req.sessionToken) auth.destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', auth.CLEAR_COOKIE);
  res.redirect('/admin/login');
});

/* ---------- dashboard (posts list + bulk) ---------- */
router.get('/', (req, res) => {
  const s = site();
  db.publishScheduled();
  const rows = db.prepare('SELECT * FROM posts ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC, id DESC').all();
  const msg = req.query.msg ? flash(req.query.msg) : '';
  const items = rows.map(p => {
    const tag = (p.tags || '').split(',').filter(Boolean).map(t => esc(t)).join(' ');
    const badges = [];
    if (p.pinned) badges.push('<span class="badge-pin">置顶</span>');
    if (p.scheduled_at) badges.push('<span class="badge-sched">定时</span>');
    else if (!p.published) badges.push('<span class="badge-draft">草稿</span>');
    return `<tr class="${p.published ? '' : 'row-draft'}">
      <td><input type="checkbox" name="ids" value="${p.id}"></td>
      <td>${badges.join(' ')}${esc(p.title)}</td>
      <td class="cell-date">${formatDate(p.published_at || p.created_at)}</td>
      <td class="cell-tags">${tag}</td>
      <td class="cell-actions">
        <a href="/post/${encodeURIComponent(p.slug)}" target="_blank">查看</a>
        <a href="/admin/edit/${p.id}">编辑</a>
        <a href="#" data-del="/admin/delete/${p.id}" class="del-link" onclick="return false">删除</a>
      </td>
    </tr>`;
  }).join('');
  const table = rows.length
    ? `<table class="admin-table"><thead><tr><th><input type="checkbox" id="checkAll"></th><th>标题</th><th>时间</th><th>标签</th><th>操作</th></tr></thead><tbody>${items}</tbody></table>`
    : '<p class="empty">还没有文章。</p>';
  const body = `${msg}
  <div class="admin-bar"><h1>文章管理</h1><a class="btn btn-primary" href="/admin/new">＋ 写文章</a></div>
  <form method="post" action="/admin/bulk" onsubmit="return confirm('确定执行选中操作吗？')">
    ${table}
    <div class="bulk-bar">
      <input type="text" name="newtag" placeholder="批量添加的标签（选“加标签”时生效）">
      <button type="submit" name="action" value="tag" class="btn">批量加标签</button>
      <button type="submit" name="action" value="delete" class="btn btn-danger">批量删除</button>
    </div>
  </form>
  <script>
  document.getElementById('checkAll').addEventListener('change',function(){document.querySelectorAll('input[name="ids"]').forEach(function(c){c.checked=this.checked;},this);});
  document.querySelectorAll('.del-link').forEach(function(a){a.addEventListener('click',function(){if(confirm('确定删除这篇文章？删除后不可恢复。'))location.href=a.dataset.del;});});
  </script>`;
  res.send(adminShell(s, { title: '文章管理' }, body));
});

router.post('/bulk', (req, res) => {
  let ids = (req.body && req.body.ids) ? req.body.ids : [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(x => parseInt(x, 10)).filter(Number.isInteger);
  const action = req.body && req.body.action;
  if (!ids.length) return res.redirect('/admin?msg=' + encodeURIComponent('未选中任何文章。'));
  if (action === 'delete') {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM posts WHERE id IN (${ph})`).run(...ids);
    res.redirect('/admin?msg=' + encodeURIComponent(`已删除 ${ids.length} 篇文章。`));
  } else if (action === 'tag') {
    const tag = (req.body.newtag || '').toString().trim().replace(/，/g, ',').replace(/\s*,\s*/g, ',').replace(/^,|,$/g, '');
    if (!tag) return res.redirect('/admin?msg=' + encodeURIComponent('请填写要添加的标签。'));
    const upd = db.prepare("UPDATE posts SET tags = CASE WHEN tags = '' THEN ? ELSE tags || ',' || ? END WHERE id = ?");
    ids.forEach(id => upd.run(tag, tag, id));
    res.redirect('/admin?msg=' + encodeURIComponent(`已为 ${ids.length} 篇文章添加标签「${tag}」。`));
  } else {
    res.redirect('/admin');
  }
});

/* ---------- editor ---------- */
function editorForm({ p, isNew, err }) {
  const action = isNew ? '/admin/new' : `/admin/edit/${p.id}`;
  const heading = isNew ? '写文章' : '编辑文章';
  const errHtml = err ? `<div class="flash flash-err">${esc(err)}</div>` : '';
  const title = p ? p.title : '';
  const slug = p ? p.slug : '';
  const summary = p ? (p.summary || '') : '';
  const content = p ? (p.content || '') : '';
  const tags = p ? (p.tags || '') : '';
  const cover = p ? (p.cover || '') : '';
  const pinned = p && p.pinned ? 'checked' : '';
  const pubChecked = !p || p.published ? 'checked' : '';
  const scheduled = p ? toLocal(p.scheduled_at) : '';
  return `${errHtml}
  <h1>${heading}</h1>
  <form class="editor" method="post" action="${action}">
    <label>标题 *</label>
    <input type="text" name="title" required maxlength="200" value="${esc(title)}" placeholder="文章标题">
    <label>固定链接（slug，可选）</label>
    <input type="text" name="slug" maxlength="200" value="${esc(slug)}" placeholder="留空自动生成，如 my-first-post">
    <label>摘要（可选）</label>
    <input type="text" name="summary" maxlength="300" value="${esc(summary)}" placeholder="留空则自动截取正文">
    <label>标签（用英文逗号分隔，可选）</label>
    <input type="text" name="tags" maxlength="200" value="${esc(tags)}" placeholder="生活, 技术, 随笔">
    <label>封面图链接（可选，用于首页卡片缩略图）</label>
    <input type="text" name="cover" maxlength="500" value="${esc(cover)}" placeholder="https://…/cover.jpg">
    <label>正文（Markdown）</label>
    <div class="md-toolbar">
      <span>支持 Markdown 语法</span>
      <span class="upload-widget">
        <input type="file" id="imageFile" accept="image/jpeg,image/png,image/gif,image/webp,image/avif" hidden>
        <button type="button" id="uploadBtn" class="btn">上传图片</button>
        <button type="button" id="previewBtn" class="btn">预览正文</button>
      </span>
    </div>
    <textarea name="content" id="mdInput" rows="18" required placeholder="用 Markdown 书写正文……">${esc(content)}</textarea>
    <div id="previewBox" class="preview-box" hidden></div>
    <label>定时发布（可选，填了则到点自动上线）</label>
    <input type="datetime-local" name="scheduled_at" value="${esc(scheduled)}">
    <div class="editor-actions">
      <label class="chk"><input type="checkbox" name="published" ${pubChecked}> 发布</label>
      <label class="chk"><input type="checkbox" name="pinned" ${pinned}> 置顶</label>
      <button type="submit" class="btn btn-primary">保存</button>
      <a class="btn" href="/admin">取消</a>
    </div>
  </form>
  <script>
  (function(){
    var file=document.getElementById('imageFile'), up=document.getElementById('uploadBtn'),
        prev=document.getElementById('previewBtn'), box=document.getElementById('previewBox'),
        md=document.getElementById('mdInput');
    up.addEventListener('click',function(){file.click();});
    file.addEventListener('change',function(){
      if(!file.files.length)return;
      var fd=new FormData();fd.append('image',file.files[0]);
      up.disabled=true;up.textContent='上传中…';
      fetch('/admin/upload',{method:'POST',body:fd}).then(function(r){return r.json();}).then(function(j){
        if(j.ok){
          var img='![]('+j.url+')';
          var s=md.selectionStart||md.value.length;md.value=md.value.slice(0,s)+'\\n'+img+'\\n'+md.value.slice(md.selectionEnd||s);
        }else{alert(j.error||'上传失败');}
        up.disabled=false;up.textContent='上传图片';
      }).catch(function(){alert('上传失败');up.disabled=false;up.textContent='上传图片';});
      file.value='';
    });
    prev.addEventListener('click',function(){
      prev.disabled=true;
      fetch('/admin/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({md:md.value})})
        .then(function(r){return r.json();}).then(function(j){
          box.innerHTML=j.html||'';box.hidden=false;
        }).catch(function(){alert('预览失败');})
        .finally(function(){prev.disabled=false;});
    });
  })();
  </script>`;
}

/* ---------- new / edit / delete ---------- */
router.get('/new', (req, res) => {
  res.send(adminShell(site(), { title: '写文章' }, editorForm({ isNew: true })));
});

router.post('/new', (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').toString().trim();
  const content = (b.content || '').toString();
  if (!title || !content.trim()) {
    return res.status(400).send(adminShell(site(), { title: '写文章' }, editorForm({ isNew: true, err: '标题和正文不能为空。' })));
  }
  const tags = (b.tags || '').toString().trim().replace(/，/g, ',').replace(/\s*,\s*/g, ',').replace(/^,|,$/g, '');
  let slug = (b.slug || '').toString().trim() || makeUniqueSlug(title, db);
  const { published, scheduledAt } = computeSchedule(b);
  const ts = nowUTC();
  const info = db.prepare('INSERT INTO posts (title, slug, summary, content, tags, published, published_at, created_at, updated_at, pinned, cover, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(title, slug, shortSummary(content, 160), content, tags, published ? 1 : 0, published ? ts : null, ts, ts,
         b.pinned === 'on' ? 1 : 0, (b.cover || '').toString().trim(), scheduledAt);
  res.redirect(`/admin/edit/${info.lastInsertRowid}?msg=${encodeURIComponent('已保存。')}`);
});

router.get('/edit/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Not found');
  res.send(adminShell(site(), { title: '编辑文章' }, editorForm({ p, isNew: false })));
});

router.post('/edit/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Not found');
  const b = req.body || {};
  const title = (b.title || '').toString().trim();
  const content = (b.content || '').toString();
  if (!title || !content.trim()) {
    return res.status(400).send(adminShell(site(), { title: '编辑文章' }, editorForm({ p, isNew: false, err: '标题和正文不能为空。' })));
  }
  const slugRaw = (b.slug || '').toString().trim();
  let slug = slugRaw || makeUniqueSlug(title, db, p.id);
  if (slugRaw) {
    const dup = db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').get(slug, p.id);
    if (dup) {
      return res.status(400).send(adminShell(site(), { title: '编辑文章' }, editorForm({ p, isNew: false, err: '该固定链接已被其他文章占用，请换一个。' })));
    }
  }
  const { published, scheduledAt } = computeSchedule(b);
  const wasPublished = !!p.published;
  const ts = nowUTC();
  let publishedAt = p.published_at;
  if (published && !wasPublished) publishedAt = ts;
  db.prepare('UPDATE posts SET title=?, slug=?, summary=?, content=?, tags=?, published=?, published_at=?, updated_at=?, pinned=?, cover=?, scheduled_at=? WHERE id=?')
    .run(title, slug, shortSummary(content, 160), content,
         (b.tags || '').toString().trim().replace(/，/g, ',').replace(/\s*,\s*/g, ',').replace(/^,|,$/g, ''),
         published ? 1 : 0, publishedAt, ts,
         b.pinned === 'on' ? 1 : 0, (b.cover || '').toString().trim(), scheduledAt, p.id);
  res.redirect(`/admin/edit/${p.id}?msg=${encodeURIComponent('已保存。')}`);
});

router.post('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.redirect('/admin?msg=' + encodeURIComponent('已删除。'));
});

/* ---------- image upload ---------- */
const ALLOW_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif'
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOW_MIME[file.mimetype] || '.img';
    cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOW_MIME[file.mimetype]) return cb(null, true);
    cb(new Error('仅支持 jpg/png/gif/webp/avif 图片'));
  }
});

router.post('/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || '上传失败' });
    if (!req.file) return res.status(400).json({ ok: false, error: '没有收到文件' });
    res.json({ ok: true, url: '/uploads/' + req.file.filename });
  });
});

router.post('/preview', (req, res) => {
  const md = (req.body && req.body.md) || '';
  res.json({ html: renderMarkdown(md) });
});

/* ---------- media library ---------- */
router.get('/media', (req, res) => {
  const s = site();
  const msg = req.query.msg ? flash(req.query.msg) : '';
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => /\.(jpe?g|png|gif|webp|avif)$/i.test(f))
    .map(f => {
      const st = fs.statSync(path.join(UPLOAD_DIR, f));
      return { name: f, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const grid = files.map(f => `
    <div class="media-item">
      <div class="media-thumb"><img src="/uploads/${esc(f.name)}" alt="" loading="lazy"></div>
      <div class="media-name" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="media-url"><input type="text" readonly value="/uploads/${esc(f.name)}" onclick="this.select()"></div>
      <form method="post" action="/admin/media/delete/${esc(encodeURIComponent(f.name))}" onsubmit="return confirm('确定删除这张图片吗？')">
        <button type="submit" class="btn btn-danger btn-sm">删除</button>
      </form>
    </div>`).join('');
  const body = `${msg}
  <div class="admin-bar"><h1>素材库</h1><span class="muted">共 ${files.length} 张图片</span></div>
  <p class="muted">这里集中管理所有上传过的图片，点击链接框即可复制 URL。</p>
  ${files.length ? `<div class="media-grid">${grid}</div>` : '<p class="panel-empty">还没有上传过图片。</p>'}`;
  res.send(adminShell(s, { title: '素材库' }, body));
});

router.post('/media/delete/:name', (req, res) => {
  const name = req.params.name;
  if (/^[a-z0-9\-_.]+\.(jpe?g|png|gif|webp|avif)$/i.test(name)) {
    const fp = path.join(UPLOAD_DIR, name);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  res.redirect('/admin/media?msg=' + encodeURIComponent('已删除。'));
});

/* ---------- data backup / export ---------- */
router.get('/export/markdown', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts WHERE published = 1 ORDER BY COALESCE(published_at, created_at) DESC').all();
  let md = posts.map(p => `# ${p.title}\n\n${p.tags ? '标签：' + p.tags + '\n\n' : ''}${p.content}\n`).join('\n\n---\n\n');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="blog-posts.md"');
  res.send(md);
});

router.get('/export/db', (req, res) => {
  const tmp = path.join(os.tmpdir(), 'blog-backup-' + Date.now() + '.db');
  db.backup(tmp)
    .then(() => {
      res.download(tmp, 'blog.db', () => fs.unlink(tmp, () => {}));
    })
    .catch(() => res.status(500).send('导出失败'));
});

/* ---------- settings ---------- */
function settingsPage(msg) {
  const s = site();
  const m = msg ? flash(msg) : '';
  const modChecked = s.comment_moderation === '1' ? 'checked' : '';
  const swatches = ['#6d28d9', '#2563eb', '#0ea5e9', '#16a34a', '#f59e0b', '#ef4444', '#ec4899', '#2c3e50'].map(c => `<button type="button" class="color-swatch" data-target="theme_color" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
  return `${m}
  <h1>站点设置</h1>
  <form class="settings" method="post" action="/admin/settings">
    <label>网站标题</label>
    <input type="text" name="site_title" maxlength="100" value="${esc(s.site_title || '')}">
    <label>副标题 / 一句话签名</label>
    <input type="text" name="site_subtitle" maxlength="200" value="${esc(s.site_subtitle || '')}">
    <label>作者署名</label>
    <input type="text" name="author" maxlength="100" value="${esc(s.author || '')}">
    <label>站点描述（用于 SEO meta）</label>
    <input type="text" name="site_description" maxlength="300" value="${esc(s.site_description || '')}">
    <label>头像图片链接</label>
    <input type="text" name="avatar_url" maxlength="500" value="${esc(s.avatar_url || '')}" placeholder="https://…/avatar.png，留空则显示首字">
    <label>主题色（留空用默认紫色）</label>
    <div class="color-field">
      <input type="text" name="theme_color" id="theme_color" maxlength="20" value="${esc(s.theme_color || '')}" placeholder="#6d28d9">
      <div class="swatches">${swatches}</div>
    </div>
    <label>社交链接（每行一条：名称|链接|颜色，颜色可选）</label>
    <textarea name="social_links" rows="4" class="social-links-ta" placeholder="GitHub|https://github.com/xxx|#181717
Bilibili|https://space.bilibili.com/xxx|#FB7299">${esc(s.social_links || '')}</textarea>
    <label>导航菜单（每行一条：名称|链接，留空用默认）</label>
    <textarea name="nav_links" rows="3" class="social-links-ta" placeholder="首页|/
关于|/about
我的项目|/page/projects">${esc(s.nav_links || '')}</textarea>
    <label>网站公告（可选，显示在页面顶部）</label>
    <input type="text" name="announcement" maxlength="300" value="${esc(s.announcement || '')}" placeholder="例如：欢迎来到我的博客～">
    <label>页脚文字（可选，支持换行）</label>
    <textarea name="footer_text" rows="2">${esc(s.footer_text || '')}</textarea>
    <label>备案号（可选）</label>
    <input type="text" name="icp" maxlength="100" value="${esc(s.icp || '')}" placeholder="例如：京ICP备12345678号">
    <label class="chk"><input type="checkbox" name="comment_moderation" ${modChecked}> 评论先审后发（开启后新评论需你在后台审核）</label>
    <button type="submit" class="btn btn-primary">保存设置</button>
  </form>
  <script>
  document.querySelectorAll('.color-swatch').forEach(function(b){b.addEventListener('click',function(){document.getElementById(b.dataset.target).value=b.dataset.color;});});
  </script>
  <hr>
  <h2>数据备份</h2>
  <div class="backup-row">
    <a class="btn" href="/admin/export/markdown">导出文章 Markdown</a>
    <a class="btn" href="/admin/export/db">下载数据库</a>
  </div>
  <hr>
  <h2>修改登录密码</h2>
  <form class="settings" method="post" action="/admin/password">
    <label>当前密码</label>
    <input type="password" name="cur" autocomplete="current-password" required>
    <label>新密码</label>
    <input type="password" name="pw1" autocomplete="new-password" minlength="8" required>
    <label>再次输入新密码</label>
    <input type="password" name="pw2" autocomplete="new-password" minlength="8" required>
    <button type="submit" class="btn btn-primary">更新密码</button>
  </form>`;
}

router.get('/settings', (req, res) => {
  res.send(adminShell(site(), { title: '站点设置' }, settingsPage(req.query.msg)));
});

router.post('/settings', (req, res) => {
  const b = req.body || {};
  for (const k of ['site_title', 'site_subtitle', 'author', 'site_description', 'avatar_url', 'social_links', 'theme_color', 'footer_text', 'icp', 'announcement', 'nav_links']) {
    db.setSetting(k, ((b[k] || '')).toString().trim());
  }
  db.setSetting('comment_moderation', b.comment_moderation === 'on' ? '1' : '0');
  res.redirect('/admin/settings?msg=' + encodeURIComponent('设置已保存。'));
});

router.post('/password', (req, res) => {
  const b = req.body || {};
  const admin = db.getAdmin();
  const curOk = admin && auth.scryptVerify(b.cur || '', admin.salt, admin.pass_hash);
  if (!curOk) {
    return res.send(adminShell(site(), { title: '站点设置' }, settingsPage('当前密码不正确。')));
  }
  if (!b.pw1 || b.pw1 !== b.pw2 || String(b.pw1).length < 8) {
    return res.send(adminShell(site(), { title: '站点设置' }, settingsPage('两次输入的新密码不一致或长度不足 8 位。')));
  }
  const { salt, hash } = auth.scryptHash(b.pw1);
  db.setAdmin(admin.username, hash, salt);
  res.send(adminShell(site(), { title: '站点设置' }, settingsPage('密码已更新，下次登录请使用新密码。')));
});

/* ---------- comments management (approve / reply / delete) ---------- */
router.get('/comments', (req, res) => {
  const s = site();
  const msg = req.query.msg ? flash(req.query.msg) : '';
  const rows = db.prepare(`
    SELECT c.*, p.title AS post_title, p.slug AS post_slug
    FROM comments c LEFT JOIN posts p ON p.id = c.post_id
    ORDER BY (c.status = 'pending') DESC, c.created_at DESC, c.id DESC LIMIT 300`).all();
  const cards = rows.length ? rows.map(c => {
    const pendingBadge = c.status === 'pending' ? '<span class="badge-sched">待审核</span>' : '';
    const approveBtn = c.status === 'pending'
      ? `<form method="post" action="/admin/comments/approve/${c.id}"><button type="submit" class="btn btn-sm">通过</button></form>`
      : '';
    const replyForm = `<form class="reply-form" method="post" action="/admin/comments/reply/${c.id}">
        <input type="text" name="reply" maxlength="500" value="${esc(c.reply || '')}" placeholder="博主回复…">
        <button type="submit" class="btn btn-sm">${c.reply ? '更新回复' : '回复'}</button>
      </form>`;
    return `<div class="admin-comment">
      <div class="admin-comment-head">
        <strong>${esc(c.author)}</strong>
        ${pendingBadge}
        ${c.email ? `<span class="muted">${esc(c.email)}</span>` : ''}
        <span class="muted">${formatDate(c.created_at)}</span>
        <span class="muted">${c.post_title ? '于《' + esc(c.post_title) + '》' : '（文章已删除）'}</span>
      </div>
      <div class="admin-comment-body">${esc(c.content).replace(/\r?\n/g, '<br>')}</div>
      <div class="admin-comment-actions">
        <span>${c.post_slug ? `<a href="/post/${encodeURIComponent(c.post_slug)}" target="_blank">查看原文</a>` : ''} ${approveBtn}</span>
        <form method="post" action="/admin/comments/delete/${c.id}" onsubmit="return confirm('确定删除这条评论吗？')">
          <button type="submit" class="btn btn-danger btn-sm">删除</button>
        </form>
      </div>
      ${replyForm}
    </div>`;
  }).join('')
    : '<p class="empty">还没有收到任何评论。</p>';
  const body = `${msg}
  <div class="admin-bar"><h1>评论管理</h1><span class="muted">共 ${rows.length} 条</span></div>
  <div class="comment-admin-list">${cards}</div>`;
  res.send(adminShell(s, { title: '评论管理' }, body));
});

router.post('/comments/approve/:id', (req, res) => {
  db.prepare("UPDATE comments SET status = 'approved' WHERE id = ?").run(req.params.id);
  res.redirect('/admin/comments?msg=' + encodeURIComponent('评论已通过。'));
});

router.post('/comments/reply/:id', (req, res) => {
  const reply = (req.body && req.body.reply || '').toString().trim();
  db.prepare('UPDATE comments SET reply = ? WHERE id = ?').run(reply, req.params.id);
  res.redirect('/admin/comments?msg=' + encodeURIComponent('回复已保存。'));
});

router.post('/comments/delete/:id', (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  res.redirect('/admin/comments?msg=' + encodeURIComponent('评论已删除。'));
});

/* ---------- about page editor ---------- */
function aboutPage(msg) {
  const content = db.getSetting('about_content') || '';
  const m = msg ? flash(msg) : '';
  return `${m}
  <h1>关于页面</h1>
  <p class="muted">这个页面展示在 <a href="/about" target="_blank">/about</a>，可以写你的个人简介、简历或作品集。支持 Markdown。</p>
  <form class="settings" method="post" action="/admin/about">
    <label>页面内容（Markdown）</label>
    <textarea name="content" rows="24" class="about-textarea">${esc(content)}</textarea>
    <button type="submit" class="btn btn-primary">保存关于页</button>
  </form>`;
}

router.get('/about', (req, res) => {
  res.send(adminShell(site(), { title: '关于页面' }, aboutPage(req.query.msg)));
});

router.post('/about', (req, res) => {
  const content = (req.body && req.body.content || '').toString();
  db.setSetting('about_content', content);
  res.redirect('/admin/about?msg=' + encodeURIComponent('关于页已保存。'));
});

/* ---------- blocks management ---------- */
const PRESET_COLORS = ['#7c3aed', '#2c3e50', '#0275d2', '#fb7299', '#181717', '#ffe411', '#3da88b', '#f1995a', '#ef4444', '#16a34a', '#0ea5e9', '#f59e0b'];

function blockForm({ b, isNew, err }) {
  const action = isNew ? '/admin/blocks/new' : `/admin/blocks/edit/${b.id}`;
  const title = b ? b.title : '';
  const subtitle = b ? b.subtitle : '';
  const link = b ? b.link : '';
  const color = b ? b.color : '';
  const emoji = b ? b.emoji : '';
  const cover = b ? b.cover : '';
  const size = b ? b.size : 'normal';
  const enabled = !b || b.enabled ? 'checked' : '';
  const errHtml = err ? `<div class="flash flash-err">${esc(err)}</div>` : '';
  const swatches = PRESET_COLORS.map(c => `<button type="button" class="color-swatch" data-target="colorInput" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
  const sizeOpts = ['normal', 'small', 'large', 'full'].map(s => `<option value="${s}"${size === s ? ' selected' : ''}>${({ normal: '普通（默认）', small: '小卡', large: '大卡', full: '通栏' })[s]}</option>`).join('');
  return `${errHtml}
  <h1>${isNew ? '新增板块' : '编辑板块'}</h1>
  <form class="settings" method="post" action="${action}">
    <label>标题 *</label>
    <input type="text" name="title" required maxlength="60" value="${esc(title)}" placeholder="例如：我的项目">
    <label>图标（emoji，可选）</label>
    <input type="text" name="emoji" maxlength="12" value="${esc(emoji)}" placeholder="例如：🚀 或 📁">
    <label>描述（可选，可多行）</label>
    <textarea name="subtitle" rows="3" placeholder="一句话介绍，可换行">${esc(subtitle)}</textarea>
    <label>链接（可选，点击整张卡片跳转）</label>
    <input type="text" name="link" maxlength="500" value="${esc(link)}" placeholder="https://… 或 /about 或 /post/xxx">
    <label>封面图链接（可选，显示在卡片上）</label>
    <input type="text" name="cover" maxlength="500" value="${esc(cover)}" placeholder="https://…/cover.jpg">
    <label>卡片尺寸</label>
    <select name="size">${sizeOpts}</select>
    <label>背景颜色（可选，留空用默认紫色）</label>
    <div class="color-field">
      <input type="text" name="color" id="colorInput" maxlength="20" value="${esc(color)}" placeholder="#7c3aed">
      <div class="swatches">${swatches}<button type="button" class="color-clear">清除</button></div>
    </div>
    <label class="chk"><input type="checkbox" name="enabled" ${enabled}> 启用（在首页显示）</label>
    <div class="editor-actions">
      <button type="submit" class="btn btn-primary">保存</button>
      <a class="btn" href="/admin/blocks">取消</a>
    </div>
  </form>
  <script>
  document.querySelectorAll('.color-swatch').forEach(function(b){b.addEventListener('click',function(){document.getElementById(b.dataset.target).value=b.dataset.color;});});
  var clr=document.querySelector('.color-clear');if(clr){clr.addEventListener('click',function(){document.getElementById('colorInput').value='';});}
  </script>`;
}

router.get('/blocks', (req, res) => {
  const s = site();
  const msg = req.query.msg ? flash(req.query.msg) : '';
  const blocks = db.getBlocks();
  const rows = blocks.map((b, i) => {
    const style = b.color ? ` style="background:${esc(b.color)}"` : '';
    const light = b.color && !isDarkColor(b.color) ? ' card-light' : '';
    const moveUp = i === 0 ? '' : `<a href="/admin/blocks/move/${b.id}/up" title="上移">↑</a>`;
    const moveDown = i === blocks.length - 1 ? '' : `<a href="/admin/blocks/move/${b.id}/down" title="下移">↓</a>`;
    const toggle = b.enabled
      ? `<form method="post" action="/admin/blocks/toggle/${b.id}"><button type="submit" class="btn btn-sm">停用</button></form>`
      : `<form method="post" action="/admin/blocks/toggle/${b.id}"><button type="submit" class="btn btn-sm">启用</button></form>`;
    return `<div class="block-item">
      <div class="block-preview${light}"${style}>${esc(b.emoji ? b.emoji + ' ' : '')}${esc(b.title)}</div>
      <div class="block-info">
        <div class="block-title">${esc(b.title)} ${b.enabled ? '' : '<span class="badge-draft">已停用</span>'}</div>
        <div class="muted">${esc(b.link || '（无链接）')} · ${({ normal: '普通', small: '小卡', large: '大卡', full: '通栏' })[b.size] || '普通'} · 排序 ${i + 1}</div>
      </div>
      <div class="block-actions">
        <a href="/admin/blocks/edit/${b.id}">编辑</a>
        ${moveUp}${moveDown}
        ${toggle}
        <form method="post" action="/admin/blocks/delete/${b.id}" onsubmit="return confirm('确定删除这个板块吗？')"><button type="submit" class="btn btn-danger btn-sm">删除</button></form>
      </div>
    </div>`;
  }).join('');
  const body = `${msg}
  <div class="admin-bar"><h1>板块管理</h1><a class="btn btn-primary" href="/admin/blocks/new">＋ 新增板块</a></div>
  <p class="muted">这些彩色卡片显示在首页顶部。可自定义标题、图标、描述、封面图、链接、颜色和尺寸，用 ↑↓ 调整顺序。</p>
  ${blocks.length ? rows : '<p class="panel-empty">还没有板块，点右上角新增。</p>'}`;
  res.send(adminShell(s, { title: '板块管理' }, body));
});

router.get('/blocks/new', (req, res) => {
  res.send(adminShell(site(), { title: '新增板块' }, blockForm({ isNew: true })));
});

router.post('/blocks/new', (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').toString().trim();
  if (!title) return res.send(adminShell(site(), { title: '新增板块' }, blockForm({ isNew: true, err: '标题不能为空。' })));
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM blocks').get().m;
  db.prepare('INSERT INTO blocks (title, subtitle, link, color, emoji, cover, size, sort, enabled) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(title, (b.subtitle || '').toString(), (b.link || '').toString().trim(),
         (b.color || '').toString().trim(), (b.emoji || '').toString().trim(),
         (b.cover || '').toString().trim(), (b.size || 'normal').toString().trim(),
         maxSort + 1, b.enabled === 'on' ? 1 : 0);
  res.redirect('/admin/blocks?msg=' + encodeURIComponent('板块已新增。'));
});

router.get('/blocks/edit/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM blocks WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).send('Not found');
  res.send(adminShell(site(), { title: '编辑板块' }, blockForm({ b, isNew: false })));
});

router.post('/blocks/edit/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM blocks WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).send('Not found');
  const f = req.body || {};
  const title = (f.title || '').toString().trim();
  if (!title) return res.send(adminShell(site(), { title: '编辑板块' }, blockForm({ b, isNew: false, err: '标题不能为空。' })));
  db.prepare('UPDATE blocks SET title=?, subtitle=?, link=?, color=?, emoji=?, cover=?, size=?, enabled=? WHERE id=?')
    .run(title, (f.subtitle || '').toString(), (f.link || '').toString().trim(),
         (f.color || '').toString().trim(), (f.emoji || '').toString().trim(),
         (f.cover || '').toString().trim(), (f.size || 'normal').toString().trim(),
         f.enabled === 'on' ? 1 : 0, b.id);
  res.redirect('/admin/blocks?msg=' + encodeURIComponent('板块已保存。'));
});

router.post('/blocks/delete/:id', (req, res) => {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(req.params.id);
  res.redirect('/admin/blocks?msg=' + encodeURIComponent('板块已删除。'));
});

router.post('/blocks/toggle/:id', (req, res) => {
  db.prepare('UPDATE blocks SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  res.redirect('/admin/blocks');
});

router.get('/blocks/move/:id/:dir', (req, res) => {
  const blocks = db.getBlocks();
  const idx = blocks.findIndex(x => x.id === parseInt(req.params.id, 10));
  if (idx === -1) return res.redirect('/admin/blocks');
  const swap = req.params.dir === 'up' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= blocks.length) return res.redirect('/admin/blocks');
  const a = blocks[idx], b = blocks[swap];
  db.prepare('UPDATE blocks SET sort = ? WHERE id = ?').run(b.sort, a.id);
  db.prepare('UPDATE blocks SET sort = ? WHERE id = ?').run(a.sort, b.id);
  res.redirect('/admin/blocks');
});

/* ---------- custom pages ---------- */
function pageForm({ p, isNew, err }) {
  const action = isNew ? '/admin/pages/new' : `/admin/pages/edit/${p.id}`;
  const title = p ? p.title : '';
  const slug = p ? p.slug : '';
  const content = p ? p.content : '';
  const errHtml = err ? `<div class="flash flash-err">${esc(err)}</div>` : '';
  return `${errHtml}
  <h1>${isNew ? '新增页面' : '编辑页面'}</h1>
  <form class="settings" method="post" action="${action}">
    <label>页面标题 *</label>
    <input type="text" name="title" required maxlength="100" value="${esc(title)}" placeholder="例如：友链">
    <label>固定链接（slug，可选，英文）</label>
    <input type="text" name="slug" maxlength="100" value="${esc(slug)}" placeholder="例如：friends，留空自动生成">
    <label>页面内容（Markdown）</label>
    <textarea name="content" rows="18" class="about-textarea">${esc(content)}</textarea>
    <div class="editor-actions">
      <button type="submit" class="btn btn-primary">保存</button>
      <a class="btn" href="/admin/pages">取消</a>
    </div>
  </form>`;
}

router.get('/pages', (req, res) => {
  const s = site();
  const msg = req.query.msg ? flash(req.query.msg) : '';
  const pages = db.getPages();
  const rows = pages.map((p, i) => `
    <div class="block-item">
      <div class="block-info">
        <div class="block-title">${esc(p.title)}</div>
        <div class="muted">/page/${esc(p.slug)} · 排序 ${i + 1}</div>
      </div>
      <div class="block-actions">
        <a href="/page/${encodeURIComponent(p.slug)}" target="_blank">查看</a>
        <a href="/admin/pages/edit/${p.id}">编辑</a>
        ${i > 0 ? `<a href="/admin/pages/move/${p.id}/up" title="上移">↑</a>` : ''}
        ${i < pages.length - 1 ? `<a href="/admin/pages/move/${p.id}/down" title="下移">↓</a>` : ''}
        <form method="post" action="/admin/pages/delete/${p.id}" onsubmit="return confirm('确定删除这个页面吗？')"><button type="submit" class="btn btn-danger btn-sm">删除</button></form>
      </div>
    </div>`).join('');
  const body = `${msg}
  <div class="admin-bar"><h1>自定义页面</h1><a class="btn btn-primary" href="/admin/pages/new">＋ 新增页面</a></div>
  <p class="muted">自定义页面会生成 <code>/page/固定链接</code> 的地址（如友链、归档）。可填入顶部导航或板块链接。</p>
  ${pages.length ? rows : '<p class="panel-empty">还没有自定义页面。</p>'}`;
  res.send(adminShell(s, { title: '自定义页面' }, body));
});

router.get('/pages/new', (req, res) => {
  res.send(adminShell(site(), { title: '新增页面' }, pageForm({ isNew: true })));
});

router.post('/pages/new', (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').toString().trim();
  if (!title) return res.send(adminShell(site(), { title: '新增页面' }, pageForm({ isNew: true, err: '标题不能为空。' })));
  let slug = (b.slug || '').toString().trim() || makeUniqueSlug(title, db);
  const dup = db.prepare('SELECT id FROM pages WHERE slug = ?').get(slug);
  if (dup) return res.send(adminShell(site(), { title: '新增页面' }, pageForm({ isNew: true, err: '该固定链接已被占用，请换一个。' })));
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM pages').get().m;
  db.prepare('INSERT INTO pages (slug, title, content, sort) VALUES (?,?,?,?)')
    .run(slug, title, (b.content || '').toString(), maxSort + 1);
  res.redirect('/admin/pages?msg=' + encodeURIComponent('页面已新增。'));
});

router.get('/pages/edit/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Not found');
  res.send(adminShell(site(), { title: '编辑页面' }, pageForm({ p, isNew: false })));
});

router.post('/pages/edit/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Not found');
  const b = req.body || {};
  const title = (b.title || '').toString().trim();
  if (!title) return res.send(adminShell(site(), { title: '编辑页面' }, pageForm({ p, isNew: false, err: '标题不能为空。' })));
  let slug = (b.slug || '').toString().trim() || makeUniqueSlug(title, db);
  const dup = db.prepare('SELECT id FROM pages WHERE slug = ? AND id != ?').get(slug, p.id);
  if (dup) return res.send(adminShell(site(), { title: '编辑页面' }, pageForm({ p, isNew: false, err: '该固定链接已被占用，请换一个。' })));
  db.prepare('UPDATE pages SET slug=?, title=?, content=?, updated_at=datetime(\'now\') WHERE id=?')
    .run(slug, title, (b.content || '').toString(), p.id);
  res.redirect('/admin/pages?msg=' + encodeURIComponent('页面已保存。'));
});

router.post('/pages/delete/:id', (req, res) => {
  db.prepare('DELETE FROM pages WHERE id = ?').run(req.params.id);
  res.redirect('/admin/pages?msg=' + encodeURIComponent('页面已删除。'));
});

router.get('/pages/move/:id/:dir', (req, res) => {
  const pages = db.getPages();
  const idx = pages.findIndex(x => x.id === parseInt(req.params.id, 10));
  if (idx === -1) return res.redirect('/admin/pages');
  const swap = req.params.dir === 'up' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= pages.length) return res.redirect('/admin/pages');
  const a = pages[idx], b = pages[swap];
  db.prepare('UPDATE pages SET sort = ? WHERE id = ?').run(b.sort, a.id);
  db.prepare('UPDATE pages SET sort = ? WHERE id = ?').run(a.sort, b.id);
  res.redirect('/admin/pages');
});

module.exports = router;
