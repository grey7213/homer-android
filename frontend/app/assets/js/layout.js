import { installDialoguePrewarm } from '/app/assets/js/dialogue-prewarm.js?v=20260904-instant-history-v1';

const NAV_ITEMS = [
  { key: 'explore', label: '探索', href: '/app/explore.html', icon: 'M3 12l9-9 9 9M5 10v10h14V10' },
  { key: 'workshop', label: '创作工坊', href: '/app/workshop.html', icon: 'M12 5v14m7-7H5' },
  { key: 'histories', label: '历史会话', href: '/app/histories.html', icon: 'M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  { key: 'group', label: '群聊', href: '/app/group-chat.html', icon: 'M17 20h5v-2a4 4 0 00-4-4h-1M9 20H4v-2a4 4 0 014-4h1m0-4a4 4 0 118 0 4 4 0 01-8 0zm8 2a3 3 0 100-6' },
  { key: 'me', label: '我的', href: '/app/me.html', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM4 21a8 8 0 0116 0' },
  { key: 'favorites', label: '我的收藏', href: '/app/favorites.html', icon: 'M11.48 3.5l.52 1.06.52-1.06a5.5 5.5 0 017.78 7.78L12 20.08l-8.8-8.8a5.5 5.5 0 017.78-7.78z' },
  { key: 'image', label: '图片聊天', href: '/app/image-chat.html', icon: 'M4 16l4-4 3 3 5-6 4 7M4 6h16v12H4z' },
  { key: 'farm', label: '惑梦农场', href: '/app/farm.html', icon: 'M4 20h16M6 20V9l6-5 6 5v11M9 20v-6h6v6M3 10l9-7 9 7' },
  { key: 'rewards', label: '充值兑换', href: '/app/rewards.html', icon: 'M12 8c-1.7 0-3-.9-3-2s1.3-2 3-2 3 .9 3 2-1.3 2-3 2zm0 0v12m-7-8h14' },
  { key: 'logs', label: '操作记录', href: '/app/logs.html', icon: 'M7 8h10M7 12h10M7 16h6M5 4h14v16H5z' },
  { key: 'info', label: '信息中心', href: '/app/info.html', icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
];

const MOBILE_ITEMS = [
  { key: 'explore', label: '探索', href: '/app/explore.html', icon: NAV_ITEMS[0].icon },
  { key: 'group', label: '群聊', href: '/app/group-chat.html', icon: NAV_ITEMS[3].icon },
  { key: 'workshop', label: '创作', href: '/app/workshop.html', icon: NAV_ITEMS[1].icon },
  { key: 'histories', label: '历史对话', href: '/app/histories.html', icon: NAV_ITEMS[2].icon },
  { key: 'me', label: '我的', href: '/app/me.html', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM4 21a8 8 0 0116 0' },
];

const PULL_REFRESH_PATHS = new Set([
  '/app/',
  '/app/index.html',
  '/app/explore.html',
  '/app/histories.html',
  '/app/favorites.html',
  '/app/community.html',
  '/app/workshop.html',
  '/app/me.html',
  '/app/farm.html',
  '/app/info.html',
  '/app/rewards.html',
  '/app/logs.html',
]);
const PULL_REFRESH_ASSET = '/assets/img/brand/pull-refresh-';
const PULL_REFRESH_VERSION = '?v=20260901-persistent-pages';
const HOST_CHANNEL = 'homer:dialogue-host:v1';
const PREFETCH_ROUTES = ['/app/explore.html', '/app/favorites.html', '/app/workshop.html', '/app/me.html'];

let publicSiteSettingsPromise = null;

function normalizeUiSettings(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n');
  }
  if (Array.isArray(value)) return value.map(normalizeUiSettings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeUiSettings(item)]));
  }
  return value;
}

function svg(path) {
  return `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${path}"/></svg>`;
}

function navLabel(item, settings, mobile = false) {
  const labels = settings?.app?.[mobile ? 'mobile_nav_labels' : 'nav_labels'] || {};
  return escapeHtml(labels[item.key] || item.label);
}

function appText(settings, key, fallback = '') {
  return settings?.app?.[key] || fallback;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

function sidebarUtilityHtml(settings = null) {
  const app = settings?.app || {};
  return `
    <div class="app-shell-links">
      <a href="/app/workshop.html">${escapeHtml(app.shell_workshop_link || '创作')}</a>
      <a href="/app/histories.html">${escapeHtml(app.shell_history_link || '历史')}</a>
      <a href="/app/favorites.html">${escapeHtml(app.shell_favorites_link || '收藏')}</a>
    </div>
    <div class="app-shell-tools" aria-label="快捷工具">
      <a href="/app/info.html" title="${escapeHtml(app.shell_notice_title || '公告')}">${svg('M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z')}</a>
      <a href="/app/logs.html" title="${escapeHtml(app.shell_logs_title || '记录')}">${svg('M7 8h10M7 12h10M7 16h6M5 4h14v16H5z')}</a>
      <a href="/app/rewards.html" title="${escapeHtml(app.shell_rewards_title || '奖励')}">${svg('M12 8c-1.7 0-3-.9-3-2s1.3-2 3-2 3 .9 3 2-1.3 2-3 2zm0 0v12m-7-8h14')}</a>
      <button type="button" data-shell-action="pictureless" title="${escapeHtml(app.shell_pictureless_title || '无图模式')}">${svg('M4 16l4-4 3 3 5-6 4 7M4 6h16v12H4z')}</button>
      <button type="button" data-shell-action="theme" title="${escapeHtml(app.shell_theme_title || '明暗模式')}">${svg('M20.4 15.2A8 8 0 118.8 3.6a6.5 6.5 0 0011.6 11.6z')}</button>
      <a href="/app/me.html" title="${escapeHtml(app.shell_profile_title || '我的')}">${svg('M16 7a4 4 0 11-8 0 4 4 0 018 0zM4 21a8 8 0 0116 0')}</a>
    </div>`;
}

export function sidebarHtml(active = 'home', settings = null) {
  const nav = NAV_ITEMS.map(item => `
    <a href="${item.href}" class="app-nav__item ${item.key === active ? 'is-active' : ''}">
      ${svg(item.icon)}<span>${navLabel(item, settings)}</span>
    </a>`).join('');
  return `
    <a href="/app/" class="app-sidebar__brand">
      <img src="/assets/img/logo-256.png?v=20260901-persistent-pages" alt="">
      <span class="name">惑梦（Homer）</span>
    </a>
    <nav class="app-nav">${nav}</nav>
    <a class="app-sidebar__user" href="/app/me.html" x-show="user" title="${escapeHtml(appText(settings, 'shell_profile_title', '进入我的'))}">
      <div class="avatar">
        <img :src="user?.avatar_url || user?.avatar || '/assets/img/apk/default_avatar.png?v=20260901-persistent-pages'" @error="$el.src='/assets/img/apk/default_avatar.png?v=20260901-persistent-pages'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">
      </div>
      <div class="meta">
        <div class="nick truncate" x-text="user?.name || ${escapeHtml(jsString(appText(settings, 'shell_guest_name', '旅人')))}"></div>
        <div class="pts"><span x-text="points || 0"></span> ${escapeHtml(appText(settings, 'shell_points_suffix', '积分'))}</div>
      </div>
    </a>
    ${sidebarUtilityHtml(settings)}`;
}

export function bottomNavHtml(active = 'home', settings = null) {
  return MOBILE_ITEMS.map(item => `
    <a href="${item.href}" class="${item.key === active ? 'is-active' : ''}">
      ${svg(item.icon)}<span>${navLabel(item, settings, true)}</span>
    </a>`).join('');
}

function safeHref(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('/') || text.startsWith('#') || text.startsWith('https://') || text.startsWith('http://')) {
    return text;
  }
  return '';
}

export async function loadPublicSiteSettings() {
  if (!publicSiteSettingsPromise) {
    publicSiteSettingsPromise = fetch('/console/api/public/site-settings', {
      headers: { Accept: 'application/json' },
    })
      .then(res => (res.ok ? res.json() : null))
      .then(data => normalizeUiSettings(data?.data || data || null))
      .catch(() => null);
  }
  return publicSiteSettingsPromise;
}

function removeAnnouncement() {
  document.querySelectorAll('[data-app-announcement]').forEach(node => node.remove());
}

function renderAnnouncement(settings) {
  removeAnnouncement();
  const app = settings?.app || {};
  if (!app.announcement_enabled || !String(app.announcement_text || '').trim()) return;
  const main = document.querySelector('.app-main');
  if (!main) return;
  const topbar = main.querySelector('.app-topbar');

  const wrap = document.createElement('div');
  wrap.setAttribute('data-app-announcement', '1');
  wrap.className = 'app-page-pad max-w-6xl mx-auto !pb-0';

  const panel = document.createElement('div');
  panel.className = 'form-panel !py-4 border-violet-300/25 bg-violet-500/10';
  const row = document.createElement('div');
  row.className = 'flex flex-col md:flex-row md:items-center gap-2 md:gap-4';

  const content = document.createElement('div');
  content.className = 'min-w-0 grow';
  const title = document.createElement('div');
  title.className = 'text-sm font-semibold text-violet-100';
  title.textContent = app.announcement_title || '站内公告';
  const text = document.createElement('div');
  text.className = 'text-sm text-slate-300 mt-1';
  text.textContent = app.announcement_text || '';
  content.appendChild(title);
  content.appendChild(text);
  row.appendChild(content);

  const href = safeHref(app.announcement_link_href);
  if (href && app.announcement_link_text) {
    const link = document.createElement('a');
    link.className = 'xy-btn xy-btn-ghost text-sm shrink-0';
    link.href = href;
    link.textContent = app.announcement_link_text;
    row.appendChild(link);
  }

  panel.appendChild(row);
  wrap.appendChild(panel);
  if (topbar?.nextSibling) main.insertBefore(wrap, topbar.nextSibling);
  else main.prepend(wrap);
}

function applyShellPreferences() {
  const theme = localStorage.getItem('ai_xingyue_shell_theme') || '';
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  document.body?.classList.toggle('no-img', localStorage.getItem('ai_xingyue_pictureless') === '1');
}

function bindShellUtilities(root = document) {
  root.querySelectorAll('[data-shell-action="pictureless"]').forEach(button => {
    button.onclick = () => {
      const enabled = !document.body.classList.contains('no-img');
      document.body.classList.toggle('no-img', enabled);
      localStorage.setItem('ai_xingyue_pictureless', enabled ? '1' : '0');
    };
  });
  root.querySelectorAll('[data-shell-action="theme"]').forEach(button => {
    button.onclick = () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? '' : 'dark';
      if (next) document.documentElement.setAttribute('data-theme', next);
      else document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('ai_xingyue_shell_theme', next);
    };
  });
}

function installEmbeddedTopNavigation() {
  if (window.parent === window || document.documentElement.dataset.homerTopNavigation === '1') return;
  document.documentElement.dataset.homerTopNavigation = '1';
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    let target;
    try { target = new URL(anchor.href, location.href); } catch { return; }
    if (target.origin !== location.origin) return;
    if (!(target.pathname.startsWith('/app/') || ['/dashboard.html', '/admin.html'].includes(target.pathname))) return;
    event.preventDefault();
    window.parent.postMessage({
      channel: HOST_CHANNEL,
      version: 1,
      type: 'navigate',
      target: target.pathname + target.search + target.hash,
    }, location.origin);
  }, true);
}

function prefetchPrimaryRoutes() {
  if (document.documentElement.dataset.homerPrimaryPrefetch === '1') return;
  document.documentElement.dataset.homerPrimaryPrefetch = '1';
  const schedule = window.requestIdleCallback || (callback => window.setTimeout(callback, 120));
  schedule(() => {
    for (const href of PREFETCH_ROUTES) {
      if (href === location.pathname || document.head.querySelector(`link[rel="prefetch"][href="${href}"]`)) continue;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = 'document';
      link.href = href;
      document.head.append(link);
    }
  });
}

function installPullRefresh() {
  if (document.documentElement.dataset.homerPullRefresh === '1') return;
  if (!PULL_REFRESH_PATHS.has(location.pathname)) return;
  document.documentElement.dataset.homerPullRefresh = '1';

  const indicator = document.createElement('div');
  indicator.className = 'homer-pull-refresh';
  indicator.setAttribute('aria-hidden', 'true');
  const image = document.createElement('img');
  image.alt = '';
  image.src = `${PULL_REFRESH_ASSET}ready-64.png${PULL_REFRESH_VERSION}`;
  indicator.append(image);
  document.body.append(indicator);

  const completionKey = 'homer.pullRefreshComplete.v1';
  if (sessionStorage.getItem(completionKey) === location.pathname + location.search) {
    sessionStorage.removeItem(completionKey);
    image.src = `${PULL_REFRESH_ASSET}complete-64.png${PULL_REFRESH_VERSION}`;
    indicator.classList.add('is-visible');
    indicator.style.transform = 'translate(-50%, 8px) scale(1)';
    window.setTimeout(() => {
      indicator.classList.remove('is-visible');
      indicator.style.transform = 'translate(-50%, -84px) scale(.88)';
    }, 720);
  }

  let tracking = false;
  let startX = 0;
  let startY = 0;
  let distance = 0;
  let armed = false;

  const reset = () => {
    tracking = false;
    distance = 0;
    armed = false;
    indicator.classList.remove('is-visible', 'is-refreshing');
    indicator.style.transform = 'translate(-50%, -84px) scale(.88)';
    image.src = `${PULL_REFRESH_ASSET}ready-64.png${PULL_REFRESH_VERSION}`;
  };

  window.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) return;
    if ((document.scrollingElement?.scrollTop || window.scrollY || 0) > 0) return;
    if (event.target.closest('input,textarea,select,[contenteditable="true"],dialog')) return;
    tracking = true;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
  }, { passive: true });

  window.addEventListener('touchmove', event => {
    if (!tracking || event.touches.length !== 1) return;
    const deltaX = event.touches[0].clientX - startX;
    const deltaY = event.touches[0].clientY - startY;
    if (deltaY <= 0 || Math.abs(deltaX) > deltaY) {
      if (deltaY < -8) reset();
      return;
    }
    distance = Math.min(104, deltaY * .52);
    if (distance < 5) return;
    event.preventDefault();
    armed = distance >= 62;
    indicator.classList.add('is-visible');
    indicator.style.transform = `translate(-50%, ${Math.round(distance - 52)}px) scale(${(.9 + Math.min(distance, 72) / 720).toFixed(3)})`;
    image.src = `${PULL_REFRESH_ASSET}${armed ? 'active' : 'ready'}-64.png${PULL_REFRESH_VERSION}`;
  }, { passive: false });

  const finish = () => {
    if (!tracking) return;
    if (!armed) {
      reset();
      return;
    }
    tracking = false;
    indicator.classList.add('is-visible', 'is-refreshing');
    indicator.style.transform = 'translate(-50%, 8px) scale(1)';
    image.src = `${PULL_REFRESH_ASSET}active-64.png${PULL_REFRESH_VERSION}`;
    sessionStorage.setItem(completionKey, location.pathname + location.search);
    window.setTimeout(() => location.reload(), 180);
  };
  window.addEventListener('touchend', finish, { passive: true });
  window.addEventListener('touchcancel', reset, { passive: true });
}

export function injectLayout(active = 'home') {
  applyShellPreferences();
  installEmbeddedTopNavigation();
  prefetchPrimaryRoutes();
  installDialoguePrewarm();
  installPullRefresh();
  const sidebar = document.querySelector('[data-app-sidebar]');
  if (sidebar) sidebar.innerHTML = sidebarHtml(active);
  const bottom = document.querySelector('[data-app-bottom-nav]');
  if (bottom) bottom.innerHTML = bottomNavHtml(active);
  bindShellUtilities(document);
  loadPublicSiteSettings().then(settings => {
    renderAnnouncement(settings);
    if (settings) {
      if (sidebar) sidebar.innerHTML = sidebarHtml(active, settings);
      if (bottom) bottom.innerHTML = bottomNavHtml(active, settings);
      bindShellUtilities(document);
    }
  }).catch(() => {});
}
