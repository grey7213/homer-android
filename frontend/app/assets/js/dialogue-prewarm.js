const FRAME_ID = 'homer-warm-dialogue-frame';
const CHAT_PATH = '/app/chat.html';
const RUNTIME_PATH = '/module/dialogue/';
const HOST_CHANNEL = 'homer:dialogue-host:v1';
const LAST_TARGET_KEY = 'homer.dialogue.last-target.v1';

let installed = false;
let frame = null;
let runtimeReady = false;
let active = false;
let pendingActivation = null;
let preparedTarget = null;
let preparingTarget = null;
let sentTarget = null;
let lastMessageType = '';
let previousRootOverflow = '';
let previousBodyOverflow = '';

window.__homerDialoguePrewarm = {
  state: () => ({
    runtimeReady,
    active,
    pendingActivation,
    preparedTarget,
    preparingTarget,
    sentTarget,
    lastMessageType,
    frameUrl: frame?.contentWindow ? frame.contentWindow.location.href : '',
  }),
};

function normalizeTarget(value) {
  const appId = String(value?.appId || value?.app_id || '').trim();
  const conversationId = String(
    value?.conversationId || value?.conversation_id || value?.conv_id || '',
  ).trim();
  if (!appId && !conversationId) return null;
  const preview = Boolean(value?.preview || value?.previewOnly || value?.preview_only);
  return { appId, conversationId, preview };
}

function targetKey(value) {
  const target = normalizeTarget(value);
  return target ? `${target.appId}::${target.conversationId}` : '';
}

function sameTarget(left, right) {
  const a = normalizeTarget(left);
  const b = normalizeTarget(right);
  if (!a || !b) return false;
  if (a.conversationId && b.conversationId) return a.conversationId === b.conversationId;
  return Boolean(a.appId && b.appId && a.appId === b.appId);
}

function targetFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, location.href);
    if (url.origin !== location.origin || url.pathname !== CHAT_PATH) return null;
    return normalizeTarget({
      appId: url.searchParams.get('app_id'),
      conversationId: url.searchParams.get('conversation_id') || url.searchParams.get('conv_id'),
    });
  } catch {
    return null;
  }
}

function rememberTarget(target) {
  const normalized = normalizeTarget(target);
  if (!normalized) return;
  try {
    sessionStorage.setItem(LAST_TARGET_KEY, JSON.stringify(normalized));
  } catch {
    // Session storage may be disabled; prewarming still works for this page.
  }
}

function readRememberedTarget() {
  try {
    const target = normalizeTarget(JSON.parse(sessionStorage.getItem(LAST_TARGET_KEY) || 'null'));
    return target?.appId && target?.conversationId ? target : null;
  } catch {
    return null;
  }
}

function postToRuntime(type, payload = {}) {
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage({ type, ...payload }, location.origin);
}

function runtimeUrlForTarget(target) {
  const normalized = normalizeTarget(target);
  const url = new URL(RUNTIME_PATH, location.origin);
  if (normalized?.appId) url.searchParams.set('homer_app_id', normalized.appId);
  if (normalized?.conversationId) {
    url.searchParams.set('homer_conversation_id', normalized.conversationId);
  }
  url.searchParams.set('homer_site_origin', location.origin);
  url.searchParams.set('homer_embed', '1');
  url.searchParams.set('homer_host_channel', HOST_CHANNEL);
  url.searchParams.set('homer_prewarm', '1');
  return url.href;
}

function requestPreparation(target, activateWhenReady = false) {
  const normalized = normalizeTarget(target);
  // Warming an app without a concrete conversation asks the dialogue session
  // endpoint to create one.  Character pages create their conversation only
  // after the user presses "开始聊天", so an app-only warm-up would leave a
  // second, partially initialized archive behind.
  if (!normalized?.appId || !normalized?.conversationId) return;
  normalized.preview = Boolean(!activateWhenReady && normalized.appId && !normalized.conversationId);
  if (activateWhenReady) pendingActivation = normalized;
  if (preparedTarget && sameTarget(preparedTarget, normalized)) {
    if (activateWhenReady && preparedTarget.preview) {
      preparedTarget = null;
      preparingTarget = null;
      sentTarget = null;
    } else {
      if (activateWhenReady) activateFrame(preparedTarget);
      return;
    }
  }
  if (preparingTarget && sameTarget(preparingTarget, normalized)) {
    if (!runtimeReady || (sentTarget && sameTarget(sentTarget, normalized))) return;
  }
  preparingTarget = normalized;
  sentTarget = normalized;
  // The main project's bridge accepts launch parameters at document start.
  // Navigating the hidden frame keeps the warm path compatible with the
  // complete bridge without relying on a reduced test-only message API.
  const nextUrl = runtimeUrlForTarget(normalized);
  if (frame.src !== nextUrl) {
    frame.src = nextUrl;
  }
}

function publicChatUrl(target) {
  const normalized = normalizeTarget(target);
  const url = new URL(CHAT_PATH, location.origin);
  if (normalized?.appId) url.searchParams.set('app_id', normalized.appId);
  if (normalized?.conversationId) url.searchParams.set('conversation_id', normalized.conversationId);
  return url;
}

function activateFrame(target, roleName = '') {
  const normalized = normalizeTarget(target);
  if (!frame || !normalized) return;
  const wasActive = active;
  rememberTarget(normalized);
  preparedTarget = normalized;
  preparingTarget = null;
  pendingActivation = null;
  if (!wasActive) {
    history.pushState({ homerWarmDialogue: true }, '', publicChatUrl(normalized));
  } else {
    history.replaceState({ homerWarmDialogue: true }, '', publicChatUrl(normalized));
  }
  active = true;
  frame.hidden = false;
  frame.removeAttribute('aria-hidden');
  frame.classList.add('is-active');
  document.documentElement.classList.add('homer-dialogue-active');
  document.body.classList.add('homer-dialogue-active');
  if (!wasActive) {
    previousRootOverflow = document.documentElement.style.overflow;
    previousBodyOverflow = document.body.style.overflow;
  }
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  if (roleName) document.title = `${roleName} · 惑梦（Homer）`;
  frame.focus({ preventScroll: true });
  performance.mark('homer:warm:activated');
}

function hideFrame() {
  if (!frame || !active) return;
  active = false;
  frame.classList.remove('is-active');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  document.documentElement.classList.remove('homer-dialogue-active');
  document.body.classList.remove('homer-dialogue-active');
  document.documentElement.style.overflow = previousRootOverflow;
  document.body.style.overflow = previousBodyOverflow;
}

function nearestChatTarget(root = document) {
  const links = [...root.querySelectorAll('a[href]')]
    .map(link => targetFromUrl(link.href))
    .filter(target => target?.appId && target?.conversationId);
  return links[0] || readRememberedTarget();
}

async function prepareRecentConversationIfNeeded() {
  if (preparingTarget || preparedTarget) return;
  const hinted = nearestChatTarget();
  if (hinted) {
    requestPreparation(hinted);
    return;
  }
  try {
    const response = await fetch('/console/api/web/conversations', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const payload = await response.json();
    const conversations = payload?.data?.list || payload?.list || [];
    const recent = conversations[0];
    requestPreparation({ appId: recent?.app_id, conversationId: recent?.id });
  } catch {
    // Prewarming is opportunistic and must never disrupt the current page.
  }
}

function onRuntimeMessage(event) {
  if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
  const message = event.data && typeof event.data === 'object' ? event.data : {};
  if (message.channel !== HOST_CHANNEL || message.version !== 1) return;
  lastMessageType = String(message.type || '');
  if (message.type === 'runtime-ready') {
    runtimeReady = true;
    const target = preparingTarget || nearestChatTarget();
    if (target) requestPreparation(target, Boolean(pendingActivation));
    else void prepareRecentConversationIfNeeded();
    return;
  }
  if (message.type === 'conversation-shell') {
    const target = normalizeTarget(message);
    if (target) preparingTarget = target;
    return;
  }
  if (message.type === 'conversation-ready' || message.type === 'ready') {
    // The embedded bridge reports its usable state as `ready`; older runtime
    // builds used `runtime-ready`. Treat both as a warmed frame so a later
    // history click can activate it without another navigation.
    runtimeReady = true;
    const target = normalizeTarget(message);
    if (!target) return;
    preparedTarget = target;
    preparingTarget = null;
    sentTarget = null;
    if (!target.preview) rememberTarget(target);
    if (pendingActivation && sameTarget(pendingActivation, target)) {
      if (target.preview) requestPreparation(pendingActivation, true);
      else activateFrame(target, String(message.roleName || ''));
    }
    return;
  }
  if (message.type === 'navigate-site' || message.type === 'navigate') {
    try {
      const target = new URL(String(message.href || message.target || ''), location.origin);
      if (target.origin === location.origin && target.pathname.startsWith('/app/')) {
        location.assign(target.href);
      }
    } catch {
      // Ignore malformed navigation requests from embedded content.
    }
  }
}

function createFrame() {
  if (frame || document.getElementById(FRAME_ID)) return;
  frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  frame.name = 'homer-dialogue-runtime';
  frame.title = '角色对话';
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  frame.setAttribute('fetchpriority', 'high');
  frame.src = runtimeUrlForTarget(readRememberedTarget() || {});
  Object.assign(frame.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100dvh',
    border: '0',
    background: '#0a0909',
    zIndex: '2147483000',
  });
  document.body.append(frame);
}

function onDocumentClick(event) {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  const target = targetFromUrl(link.href);
  if (!target || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  // A cold or still-loading warm frame must never hold the navigation hostage.
  // Let the normal chat page open immediately; its local conversation shell
  // renders cached messages and keeps the composer usable while the runtime
  // finishes in the background.  Reuse the hidden frame only when this exact
  // conversation is already ready.
  if (!runtimeReady || !preparedTarget || preparedTarget.preview || !sameTarget(preparedTarget, target)) {
    performance.mark('homer:warm:navigation-fallback');
    // Android keeps the histories WebView alive after switching to chat.  Park
    // an unfinished warm frame so it does not continue downloading a second
    // dialogue runtime behind the newly opened local-first chat page.
    if (frame && !active) frame.src = 'about:blank';
    runtimeReady = false;
    preparingTarget = null;
    preparedTarget = null;
    sentTarget = null;
    pendingActivation = null;
    return;
  }
  event.preventDefault();
  performance.mark('homer:warm:activation-requested');
  activateFrame(preparedTarget);
}

function onTargetIntent(event) {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  const target = targetFromUrl(link.href);
  if (target) requestPreparation(target);
}

function observeDialogueTargets() {
  const observer = new MutationObserver(() => {
    if (!preparingTarget && !preparedTarget) {
      const target = nearestChatTarget();
      if (target) requestPreparation(target);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
}

export function installDialoguePrewarm() {
  if (installed || location.pathname === CHAT_PATH || location.pathname === '/app/login.html') return;
  installed = true;
  window.addEventListener('message', onRuntimeMessage);
  window.addEventListener('popstate', () => {
    if (location.pathname !== CHAT_PATH) hideFrame();
    else if (preparedTarget && frame) {
      active = true;
      frame.hidden = false;
      frame.removeAttribute('aria-hidden');
      frame.classList.add('is-active');
      document.documentElement.classList.add('homer-dialogue-active');
      document.body.classList.add('homer-dialogue-active');
      previousRootOverflow = document.documentElement.style.overflow;
      previousBodyOverflow = document.body.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    }
  });
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('pointerover', onTargetIntent, true);
  document.addEventListener('focusin', onTargetIntent, true);
  document.addEventListener('touchstart', onTargetIntent, { capture: true, passive: true });
  observeDialogueTargets();
  // Start warming as soon as the shell exists so a history click can reuse a
  // ready runtime instead of waiting for an idle callback first.
  performance.mark('homer:warm:preload-start');
  createFrame();
}
