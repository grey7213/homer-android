// 惑梦（Homer）离线调试保护层。
// 仅由本地开发代理注入；生产 HTML 不应直接引用此文件。
(() => {
  'use strict';

  if (window.__HOMER_OFFLINE_DEV__) return;

  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
  const TOAST_ID = 'homer-offline-dev-toast';
  let toastTimer = null;

  function isLoopbackHost(hostname) {
    const value = String(hostname || '').trim().toLowerCase();
    return LOOPBACK_HOSTS.has(value) || value.endsWith('.localhost');
  }

  function parseNavigationTarget(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.startsWith('#')) return null;
    try {
      return new URL(raw, location.href);
    } catch {
      return false;
    }
  }

  function isAllowedNavigation(value) {
    const url = parseNavigationTarget(value);
    if (url === null) return true;
    if (url === false) return false;

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.origin === location.origin || isLoopbackHost(url.hostname);
    }
    if (url.protocol === 'blob:') {
      return url.origin === location.origin || isLoopbackHost(url.hostname);
    }
    return url.protocol === 'about:' || url.protocol === 'data:';
  }

  function targetLabel(value) {
    const url = parseNavigationTarget(value);
    if (!url || url === false) return '无效地址';
    return url.hostname || url.protocol.replace(':', '') || '外部地址';
  }

  function mountIndicator() {
    if (!document.body) return;

    if (!document.querySelector('style[data-homer-offline-dev]')) {
      const style = document.createElement('style');
      style.setAttribute('data-homer-offline-dev', '');
      style.textContent = `
        #${TOAST_ID}{position:fixed;left:50%;bottom:48px;z-index:2147483647;max-width:min(420px,calc(100vw - 28px));padding:9px 12px;border-radius:9px;background:rgba(41,37,36,.95);box-shadow:0 8px 26px rgba(0,0,0,.24);color:#fff;font:500 12px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;text-align:center;opacity:0;transform:translate(-50%,8px);transition:opacity .16s ease,transform .16s ease;pointer-events:none}
        #${TOAST_ID}.is-visible{opacity:1;transform:translate(-50%,0)}
        @media(max-width:768px){#${TOAST_ID}{bottom:calc(112px + env(safe-area-inset-bottom))}}
        @media(prefers-reduced-motion:reduce){#${TOAST_ID}{transition:none}}
      `;
      document.head.appendChild(style);
    }

    if (!document.getElementById(TOAST_ID)) {
      const toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
  }

  function showBlocked(value) {
    mountIndicator();
    const label = targetLabel(value);
    const toast = document.getElementById(TOAST_ID);
    if (toast) {
      toast.textContent = `当前环境无法打开外部地址：${label}`;
      toast.classList.add('is-visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
    }
    console.warn(`[offline-dev] blocked external navigation: ${label}`);
  }

  function guardAnchorEvent(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const anchor = target?.closest?.('a[href]');
    if (!anchor || isAllowedNavigation(anchor.getAttribute('href'))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showBlocked(anchor.getAttribute('href'));
  }

  document.addEventListener('click', guardAnchorEvent, true);
  document.addEventListener('auxclick', guardAnchorEvent, true);
  document.addEventListener('submit', event => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    const action = form?.getAttribute('action') || location.href;
    if (!form || isAllowedNavigation(action)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showBlocked(action);
  }, true);

  const nativeOpen = window.open.bind(window);
  window.open = function guardedWindowOpen(url, target, features) {
    if (url == null || url === '' || isAllowedNavigation(url)) {
      return nativeOpen(url, target, features);
    }
    showBlocked(url);
    return null;
  };

  Object.defineProperty(window, '__HOMER_OFFLINE_DEV__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ enabled: true, isAllowedNavigation }),
  });
  document.documentElement.setAttribute('data-homer-offline-dev', '');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountIndicator, { once: true });
  } else {
    mountIndicator();
  }
})();
