'use strict';

const { esc } = require('./util');

function themeStyle(themeColor) {
  if (!themeColor) return '';
  const c = esc(themeColor);
  return `<style>:root{--accent:${c};--accent-strong:color-mix(in srgb,${c},#000 16%);--accent-soft:color-mix(in srgb,${c},#fff 88%);--accent-line:color-mix(in srgb,${c},#fff 68%);}</style>`;
}

function head(title, site, desc) {
  const d = desc || site.site_description || site.site_subtitle || '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${title && title !== site.site_title ? ' · ' + esc(site.site_title) : ''}</title>
<meta name="description" content="${esc(d)}">
${themeStyle(site.theme_color)}
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<div class="progress-bar" id="progressBar"></div>
<button class="back-top" id="backTop" aria-label="返回顶部" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
<script>
(function(){
  var bar=document.getElementById('progressBar');
  function onScroll(){
    var h=document.documentElement;
    var sc=h.scrollTop, max=h.scrollHeight-h.clientHeight;
    if(max>0) bar.style.width=(sc/max*100)+'%';
    document.getElementById('backTop').classList.toggle('show', sc>400);
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  onScroll();
  document.getElementById('backTop').addEventListener('click', function(){ window.scrollTo({top:0, behavior:'smooth'}); });
})();
</script>`;
}

/* parse social_links raw text: one per line "名称|链接|颜色" */
function parseSocial(raw) {
  const out = [];
  String(raw || '').split('\n').forEach(line => {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length >= 2 && parts[0] && parts[1]) out.push({ name: parts[0], url: parts[1], color: parts[2] || '' });
  });
  return out;
}

/* parse nav_links raw text: one per line "名称|链接" */
function parseNav(raw, pages) {
  const out = [];
  String(raw || '').split('\n').forEach(line => {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length >= 2 && parts[0] && parts[1]) out.push({ name: parts[0], url: parts[1] });
  });
  if (out.length) return out;
  out.push({ name: '首页', url: '/' });
  (pages || []).forEach(p => out.push({ name: p.title, url: '/page/' + encodeURIComponent(p.slug) }));
  out.push({ name: '关于', url: '/about' });
  return out;
}

function navHtml(items) {
  return `<nav class="topnav">${items.map(i => `<a href="${esc(i.url)}">${esc(i.name)}</a>`).join('')}</nav>`;
}

function announcementBar(site) {
  if (!site.announcement) return '';
  return `<div class="announcement">${esc(site.announcement)}</div>`;
}

function footer(site) {
  const parts = [];
  if (site.footer_text) parts.push(esc(site.footer_text).replace(/\r?\n/g, '<br>'));
  if (site.icp) parts.push(site.icp);
  parts.push(`${site.author ? esc(site.author) + ' · ' : ''}Powered by ${esc(site.site_title)}`);
  return parts.join(' · ');
}

/* ---------- bento personal-homepage shell ---------- */
function bentoShell(site, body) {
  const avatar = site.avatar_url
    ? `<img class="bento-avatar" src="${esc(site.avatar_url)}" alt="${esc(site.site_title)}">`
    : `<div class="bento-avatar bento-avatar-letter">${esc((site.site_title || '博').charAt(0))}</div>`;
  const social = parseSocial(site.social_links);
  const socialRow = social.length
    ? `<div class="bento-side-social">${social.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>`).join('')}</div>`
    : '';
  return `${head(site.site_title, site)}
${announcementBar(site)}
<div class="bento">
  <aside class="bento-side rise rise-1">
    ${avatar}
    <h1 class="bento-name">${esc(site.site_title)}</h1>
    <p class="bento-tag">${esc(site.site_subtitle || '')}</p>
    ${socialRow}
  </aside>
  <main class="bento-main rise rise-2">
    ${body}
    <footer class="bento-foot">${footer(site)}</footer>
  </main>
</div>
</body>
</html>`;
}

/* ---------- normal page shell ---------- */
function pageShell(site, opts, body) {
  const { title, q, desc, pages } = opts;
  const searchVal = q ? esc(q) : '';
  const items = parseNav(site.nav_links, pages);
  const header = `<header class="page-header">
    <div class="wrap page-header-inner">
      <a class="page-brand" href="/">${esc(site.site_title)}</a>
      <form class="search" action="/search" method="get" role="search">
        <svg class="search-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
        <input type="search" name="q" value="${searchVal}" placeholder="搜索文章…" aria-label="搜索文章" maxlength="100">
      </form>
      ${navHtml(items)}
    </div>
  </header>`;
  return `${head(title, site, desc)}
${announcementBar(site)}
${header}
<main class="wrap page-main rise">${body}</main>
<footer class="site-foot wrap">${footer(site)}</footer>
</body>
</html>`;
}

/* ---------- admin shell ---------- */
function adminShell(site, opts, body) {
  const title = opts.title || '管理后台';
  const header = `<header class="page-header">
    <div class="wrap page-header-inner">
      <a class="page-brand" href="/admin">${esc(site.site_title)} <em class="brand-tag">后台</em></a>
      <nav class="topnav">
        <a href="/admin">文章</a>
        <a href="/admin/new">写文章</a>
        <a href="/admin/blocks">板块</a>
        <a href="/admin/pages">页面</a>
        <a href="/admin/comments">评论</a>
        <a href="/admin/media">素材库</a>
        <a href="/admin/settings">设置</a>
        <a href="/admin/logout" onclick="return confirm('确定退出登录吗？')">退出</a>
      </nav>
    </div>
  </header>`;
  return `${head(title, site)}
${header}
<main class="wrap page-main rise">${body}</main>
<footer class="site-foot wrap">${footer(site)}</footer>
</body>
</html>`;
}

function flash(msg) {
  return `<div class="flash">${esc(msg)}</div>`;
}

module.exports = { bentoShell, pageShell, adminShell, flash, parseSocial, parseNav };
