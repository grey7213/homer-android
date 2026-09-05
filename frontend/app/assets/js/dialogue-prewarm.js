// Preload the lightweight host document, never a second full dialogue runtime.
// Android retains page WebViews; hidden runtimes in each page would also remain
// alive and compete with the active conversation for CPU, memory and sync.
let installed = false;
const prefetched = new Set();

function prefetchChat(event) {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname !== '/app/chat.html') return;
  if (!url.searchParams.get('app_id')
      || !(url.searchParams.get('conversation_id') || url.searchParams.get('conv_id'))) return;
  if (prefetched.has(url.href) || prefetched.size >= 2) return;
  prefetched.add(url.href);
  const preload = document.createElement('link');
  preload.rel = 'prefetch';
  preload.as = 'document';
  preload.href = url.href;
  document.head.append(preload);
}

export function installDialoguePrewarm() {
  if (installed || location.pathname === '/app/chat.html' || location.pathname === '/app/login.html') return;
  installed = true;
  document.addEventListener('pointerover', prefetchChat, { passive: true });
  document.addEventListener('focusin', prefetchChat);
  document.addEventListener('touchstart', prefetchChat, { passive: true });
  // Navigation remains under the app's normal router. No preventDefault,
  // iframe activation or session-creation request is needed for prefetching.
}
