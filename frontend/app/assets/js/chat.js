import { api, ApiError } from '/app/assets/js/app-core.js?v=20260729-dialogue-runtime';

const HOST_CHANNEL = 'homer:dialogue-host:v1';
const DEFAULT_RUNTIME_PATH = '/module/dialogue/';
const LEGACY_RUNTIME_PATH = '/dialogue-core/';
const READY_TIMEOUT_MS = 150_000;
const PREVIEW_CACHE_PREFIX = 'homer.dialogue.preview.v2:';
const HISTORY_CACHE_KEY = 'homer.dialogue.history.v2';
const SETTINGS_CACHE_PREFIX = 'homer.dialogue.settings.v1:';

const frame = document.querySelector('#dialogue-frame');
const launcher = document.querySelector('.launcher');
const title = document.querySelector('#launcher-title');
const detail = document.querySelector('#launcher-detail');
const retry = document.querySelector('#launcher-retry');
const launcherVisual = document.querySelector('#launcher-visual');
const announcer = document.querySelector('#dialogue-announcer');
const previewTitle = document.querySelector('#preview-title');
const previewStatus = document.querySelector('#preview-status');
const previewAvatar = document.querySelector('#preview-avatar');
const previewMessages = document.querySelector('#preview-messages');
const previewComposer = document.querySelector('#preview-composer');
const previewInput = document.querySelector('#preview-input');
const previewSend = document.querySelector('#preview-send');
const menuButton = document.querySelector('#preview-menu');
const settingsButton = document.querySelector('#preview-settings');
const leftDrawer = document.querySelector('#preview-left-drawer');
const rightDrawer = document.querySelector('#preview-settings-drawer');
const leftClose = document.querySelector('#preview-left-close');
const rightClose = document.querySelector('#preview-settings-close');
const scrim = document.querySelector('#preview-scrim');
const historyList = document.querySelector('#preview-history-list');
const historyCount = document.querySelector('#preview-history-count');
const toast = document.querySelector('#preview-toast');
const networkDetail = document.querySelector('#preview-network-detail');
const networkRetry = document.querySelector('#preview-network-retry');
const modelButton = document.querySelector('#preview-model-settings');
const modelSummary = document.querySelector('#preview-model-summary');
const modelDialog = document.querySelector('#preview-model-dialog');
const modelForm = document.querySelector('#preview-model-form');
const modelSelect = document.querySelector('#preview-model-select');
const modelClose = document.querySelector('#preview-model-close');
const modelCancel = document.querySelector('#preview-model-cancel');

let readyTimer = 0;
let toastTimer = 0;
let activeTarget = null;
let activeAppId = '';
let activeConversationId = '';
let previewRequestId = 0;
let runtimeReady = false;
let runtimeState = null;
let history = [];
let pendingDraft = '';
const pendingCommands = [];

function nativeCall(name, ...args) {
  try {
    const bridge = window.HomerNative;
    // The method must be invoked with the injected object as receiver. A
    // detached reference throws "Java bridge method can't be invoked on a
    // non-injected object", which silently turned every native cache read and
    // write into undefined — so conversation_cache never got a single row.
    return typeof bridge?.[name] === 'function' ? bridge[name](...args) : undefined;
  } catch {
    return undefined;
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function setStatus(nextTitle, nextDetail) {
  title.textContent = nextTitle;
  detail.textContent = nextDetail;
  previewStatus.textContent = nextDetail;
  announcer.textContent = `${nextTitle}。${nextDetail}`;
}

function showToast(message, duration = 1800) {
  const text = String(message || '').trim();
  if (!text) return;
  window.clearTimeout(toastTimer);
  toast.textContent = text;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, duration);
}

function clearReadyTimer() {
  if (!readyTimer) return;
  window.clearTimeout(readyTimer);
  readyTimer = 0;
}

function setDocumentTitle(roleName = '') {
  const clean = String(roleName || '').trim().slice(0, 120);
  document.title = clean ? `${clean} · 惑梦` : '对话 · 惑梦';
}

function closeDrawers() {
  document.body.classList.remove('shell-left-open', 'shell-right-open');
  leftDrawer.setAttribute('aria-hidden', 'true');
  rightDrawer.setAttribute('aria-hidden', 'true');
  scrim.hidden = true;
}

function openDrawer(side) {
  closeDrawers();
  const left = side === 'left';
  document.body.classList.add(left ? 'shell-left-open' : 'shell-right-open');
  (left ? leftDrawer : rightDrawer).setAttribute('aria-hidden', 'false');
  scrim.hidden = false;
}

function postRuntimeCommand(type, payload = {}, { queue = true } = {}) {
  const command = { channel: HOST_CHANNEL, version: 1, type, ...payload };
  if (runtimeReady && frame?.contentWindow) {
    frame.contentWindow.postMessage(command, location.origin);
    return true;
  }
  if (queue) pendingCommands.push(command);
  return false;
}

function flushRuntimeCommands() {
  if (!runtimeReady || !frame?.contentWindow) return;
  while (pendingCommands.length) frame.contentWindow.postMessage(pendingCommands.shift(), location.origin);
}

function markReady(roleName = '') {
  clearReadyTimer();
  runtimeReady = true;
  setDocumentTitle(roleName);
  flushRuntimeCommands();
  postRuntimeCommand('request-state', {}, { queue: false });
  document.body.classList.remove('is-error');
  launcherVisual.src = '/assets/img/brand/launch-loading-1080x1920.png?v=20260901-persistent-pages';
  launcher.setAttribute('aria-busy', 'false');
  window.setTimeout(() => {
    closeDrawers();
    modelDialog?.close();
    document.body.classList.remove('has-preview');
    document.body.classList.add('is-ready');
  }, 80);
  announcer.textContent = roleName ? `已进入与${roleName}的对话。` : '对话已准备完成。';
}

function visiblePreviewText(value) {
  const input = String(value || '').trim().slice(0, 60_000);
  if (!input || /<!doctype\s+html|<html[\s>]/i.test(input)) return '';
  const withoutComponents = input
    .replace(/```(?:homer-ui|homer_component)[^\r\n]*\r?\n[\s\S]*?```/gi, '')
    .replace(/\[(?:FLOAT|SIDEBAR|POPUP|BGM|SCENE):[^\]]+\]/gi, '');
  const fragment = new DOMParser().parseFromString(withoutComponents, 'text/html');
  fragment.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(node => node.remove());
  return String(fragment.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12_000);
}

function safePreviewImage(value) {
  try {
    const source = String(value || '').trim();
    if (!source) return '';
    const target = new URL(source, location.href);
    return ['http:', 'https:'].includes(target.protocol) ? target.href : '';
  } catch {
    return '';
  }
}

function normalizeMessage(message, index = 0) {
  const content = visiblePreviewText(message?.content ?? message?.text ?? message?.mes);
  if (!content || message?.role === 'system' || message?.is_system === true) return null;
  return {
    id: String(message?.id || message?.extra?.homer_message_id || `local-${index}`).slice(0, 180),
    role: message?.role === 'user' || message?.is_user === true ? 'user' : 'assistant',
    content,
    created_at: Number(message?.created_at || message?.extra?.homer_created_at || 0),
  };
}

function conversationSnapshot(payload) {
  const data = payload?.data || payload || {};
  const conversation = data?.conversation || {};
  const rawMessages = Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.list) ? data.list : [];
  return {
    conversation_id: String(data?.conversation_id || conversation?.id || activeConversationId).trim().slice(0, 160),
    app_id: String(data?.app_id || conversation?.app_id || activeAppId).trim().slice(0, 160),
    title: String(data?.title || conversation?.app_name || conversation?.title || '角色对话').trim().slice(0, 120),
    avatar: safePreviewImage(data?.avatar || conversation?.app_icon),
    messages: rawMessages.map(normalizeMessage).filter(Boolean).slice(-120),
    updated_at: Date.now(),
  };
}

function readCachedConversation(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const native = parseJson(nativeCall('readConversationSnapshot', id), null);
  if (native?.conversation_id && Array.isArray(native.messages)) return native;
  try {
    const cached = parseJson(localStorage.getItem(`${PREVIEW_CACHE_PREFIX}${id}`), null);
    if (cached?.conversation_id) return cached;
    const legacy = parseJson(localStorage.getItem(`homer.dialogue.preview.v1:${id}`), null)
      || parseJson(nativeCall('readLegacySnapshot'), null);
    if (legacy && Array.isArray(legacy.messages)) {
      return {
        conversation_id: id,
        app_id: activeAppId,
        title: String(legacy.title || legacy.roleName || '角色对话'),
        avatar: safePreviewImage(legacy.avatar),
        messages: legacy.messages.map(normalizeMessage).filter(Boolean),
        updated_at: Number(legacy.updated_at || 0),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCachedConversation(snapshot) {
  if (!snapshot?.conversation_id) return;
  const payload = JSON.stringify({ ...snapshot, updated_at: Date.now() });
  nativeCall('saveConversationSnapshot', payload);
  try {
    localStorage.setItem(`${PREVIEW_CACHE_PREFIX}${snapshot.conversation_id}`, payload);
  } catch {
    // Android SQLite remains available when browser storage is full.
  }
}

function readCachedHistory() {
  const native = parseJson(nativeCall('readConversationHistory'), []);
  let local = [];
  try { local = parseJson(localStorage.getItem(HISTORY_CACHE_KEY), []); } catch { local = []; }
  const merged = new Map();
  for (const item of [...(Array.isArray(native) ? native : []), ...(Array.isArray(local) ? local : [])]) {
    const id = String(item?.id || item?.conversation_id || '');
    if (!id) continue;
    const existing = merged.get(id);
    if (!existing || Number(item?.updated_at || 0) >= Number(existing?.updated_at || 0)) merged.set(id, item);
  }
  return [...merged.values()].sort((a, b) => Number(b?.updated_at || 0) - Number(a?.updated_at || 0));
}

function writeCachedHistory(items) {
  try { localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(items.slice(0, 100))); } catch {}
}

function renderMessages(messages, { pending = '' } = {}) {
  previewMessages.replaceChildren();
  for (const message of messages) {
    const normalized = normalizeMessage(message);
    if (!normalized) continue;
    const bubble = document.createElement('article');
    bubble.className = `preview-message${normalized.role === 'user' ? ' is-user' : ''}`;
    bubble.dataset.messageId = normalized.id;
    bubble.textContent = normalized.content;
    previewMessages.append(bubble);
  }
  if (pending) {
    const bubble = document.createElement('article');
    bubble.className = 'preview-message is-user is-pending';
    bubble.textContent = pending;
    previewMessages.append(bubble);
  }
  if (!previewMessages.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'preview-empty';
    empty.textContent = '这段会话还没有消息。';
    previewMessages.append(empty);
  }
  requestAnimationFrame(() => { previewMessages.scrollTop = previewMessages.scrollHeight; });
}

function renderConversation(payload, { save = true } = {}) {
  const snapshot = payload?.conversation_id && Array.isArray(payload?.messages) ? payload : conversationSnapshot(payload);
  if (!snapshot.conversation_id) snapshot.conversation_id = activeConversationId;
  if (!snapshot.app_id) snapshot.app_id = activeAppId;
  activeConversationId = snapshot.conversation_id || activeConversationId;
  activeAppId = snapshot.app_id || activeAppId;
  previewTitle.textContent = snapshot.title || '角色对话';
  setDocumentTitle(snapshot.title);
  if (snapshot.avatar) previewAvatar.src = snapshot.avatar;
  renderMessages(snapshot.messages || [], { pending: pendingDraft });
  if (save) writeCachedConversation(snapshot);
  const current = history.find(item => String(item?.id || '') === activeConversationId);
  if (current) {
    current.title = snapshot.title;
    current.app_name = snapshot.title;
    current.app_icon = snapshot.avatar;
    current.last_message = snapshot.messages?.at(-1)?.content || current.last_message || '';
    current.updated_at = Date.now();
  }
  renderHistory();
}

function renderHistory() {
  historyCount.textContent = String(history.length);
  historyList.replaceChildren();
  for (const conversation of history) {
    const id = String(conversation?.id || conversation?.conversation_id || '');
    const appId = String(conversation?.app_id || '');
    if (!id || !appId) continue;
    const roleName = String(conversation?.app_name || conversation?.title || '角色对话');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `preview-history-button${id === activeConversationId ? ' is-active' : ''}`;
    button.dataset.conversationId = id;
    button.dataset.appId = appId;
    const avatar = document.createElement('span');
    avatar.className = 'preview-history-avatar';
    const image = safePreviewImage(conversation?.app_icon) || new URL('/assets/img/apk/avatar.webp?v=20260901-persistent-pages', location.href).href;
    avatar.style.backgroundImage = `url("${image.replaceAll('"', '%22')}")`;
    const strong = document.createElement('strong');
    strong.textContent = roleName;
    const small = document.createElement('small');
    small.textContent = String(conversation?.last_message || '这段会话还没有消息。').slice(0, 50);
    button.append(avatar, strong, small);
    historyList.append(button);
  }
}

function renderCachedConversation(conversationId) {
  const cached = readCachedConversation(conversationId);
  if (!cached) return false;
  renderConversation(cached, { save: false });
  return true;
}

async function loadQuickPreview(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const requestId = ++previewRequestId;
  renderCachedConversation(id);
  try {
    const response = await api.messages(id, { limit: 120 });
    if (requestId !== previewRequestId) return;
    renderConversation(response);
  } catch {
    // Local cache stays usable without the network.
  }
}

function showShell() {
  document.body.classList.remove('is-ready', 'is-error');
  document.body.classList.add('has-preview');
  launcher.setAttribute('aria-busy', 'false');
}

function showConversationSwitchShell(message) {
  const appId = String(message?.app_id || '').trim();
  const conversationId = String(message?.conversation_id || '').trim();
  if (!appId || !conversationId) return;
  clearReadyTimer();
  runtimeReady = false;
  pendingDraft = '';
  previewSend.disabled = false;
  closeDrawers();
  updateVisibleConversationUrl(appId, conversationId);
  showShell();
  const cached = renderCachedConversation(conversationId);
  if (!cached) {
    const target = history.find(item => String(item?.id || item?.conversation_id || '') === conversationId);
    renderConversation({
      conversation_id: conversationId,
      app_id: appId,
      title: String(message?.role_name || target?.app_name || target?.title || '角色对话'),
      avatar: target?.app_icon || '',
      messages: [],
    }, { save: false });
  }
  void loadQuickPreview(conversationId);
}

function fail(error) {
  clearReadyTimer();
  runtimeReady = false;
  console.error('对话能力启动失败', error);
  showShell();
  document.body.classList.add('is-error');
  launcherVisual.src = '/assets/img/brand/network-error-512.png?v=20260901-persistent-pages';
  networkDetail.textContent = error?.message || '本地会话仍可阅读，恢复网络后可以继续对话。';
  if (error instanceof ApiError && Number(error.code) === 401) {
    const next = location.pathname + location.search + location.hash;
    location.replace('/app/login.html?next=' + encodeURIComponent(next));
    return;
  }
  showToast(error?.message || '对话能力暂时无法连接，本地历史仍可使用。', 3200);
}

async function readPublicSettings() {
  const response = await fetch('/console/api/public/site-settings', { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`站点设置读取失败（${response.status}）`);
  const body = await response.json();
  return body?.data || body || {};
}

function normalizeRuntimeUrl(value) {
  const target = new URL(String(value || DEFAULT_RUNTIME_PATH), location.href);
  if (target.origin !== location.origin) throw new Error('对话服务必须通过站点内部地址访问。');
  if (target.pathname === LEGACY_RUNTIME_PATH.slice(0, -1) || target.pathname.startsWith(LEGACY_RUNTIME_PATH)) target.pathname = DEFAULT_RUNTIME_PATH;
  if (!target.pathname.endsWith('/')) target.pathname += '/';
  return target;
}

function runtimeTarget(appId, conversationId, runtimePath = DEFAULT_RUNTIME_PATH) {
  const target = normalizeRuntimeUrl(runtimePath);
  target.searchParams.set('homer_app_id', appId);
  target.searchParams.set('homer_conversation_id', conversationId);
  target.searchParams.set('homer_site_origin', location.origin);
  target.searchParams.set('homer_embed', '1');
  target.searchParams.set('homer_host_channel', HOST_CHANNEL);
  return target;
}

function updateVisibleConversationUrl(appId, conversationId) {
  const safeAppId = String(appId || '').trim().slice(0, 160);
  const safeConversationId = String(conversationId || '').trim().slice(0, 160);
  if (!safeAppId || !safeConversationId) return;
  activeAppId = safeAppId;
  activeConversationId = safeConversationId;
  const next = new URL(location.href);
  next.searchParams.set('app_id', safeAppId);
  next.searchParams.set('conversation_id', safeConversationId);
  next.searchParams.delete('conv_id');
  window.history.replaceState({ app_id: safeAppId, conversation_id: safeConversationId }, '', next);
}

async function loadHistory() {
  history = readCachedHistory();
  renderHistory();
  try {
    const response = await api.conversations();
    const list = response?.data?.list || response?.list || [];
    if (Array.isArray(list)) {
      history = list.slice(0, 100);
      writeCachedHistory(history);
      renderHistory();
    }
  } catch {
    // Cached history stays available.
  }
}

async function resolveLaunchTarget() {
  const params = new URLSearchParams(location.search);
  let appId = String(params.get('app_id') || '').trim();
  let conversationId = String(params.get('conversation_id') || params.get('conv_id') || '').trim();
  if (appId && conversationId) {
    updateVisibleConversationUrl(appId, conversationId);
    void loadQuickPreview(conversationId);
    return runtimeTarget(appId, conversationId);
  }
  const [settings] = await Promise.all([readPublicSettings(), api.profile()]);
  if (!appId) {
    const response = await api.conversations();
    const conversations = response?.data?.list || response?.list || [];
    const selected = conversationId ? conversations.find(item => String(item?.id || '') === conversationId) : conversations[0];
    appId = String(selected?.app_id || '').trim();
    conversationId = String(selected?.id || conversationId || '').trim();
  }
  if (!appId) throw new Error('还没有可进入的角色会话，请先从探索页选择一张角色卡。');
  const response = await api.dialogueSession(appId, conversationId, { launchOnly: true });
  const payload = response?.data || response || {};
  const launch = payload?.launch;
  if (!launch?.app_id || !launch?.conversation_id) throw new Error('后端没有返回可启动的角色会话。');
  updateVisibleConversationUrl(String(launch.app_id), String(launch.conversation_id));
  void loadQuickPreview(String(launch.conversation_id));
  return runtimeTarget(String(launch.app_id), String(launch.conversation_id), settings?.runtime?.dialogue_url || payload?.runtime?.public_url || DEFAULT_RUNTIME_PATH);
}

function allowedNavigationPath(value) {
  try {
    const target = new URL(String(value || ''), location.href);
    if (target.origin !== location.origin) return '';
    // 运行时抽屉的导航项现在改发 navigate 消息而不是自己跳转（主站是
    // frame-ancestors 'none'，在 dialogue iframe 里加载 /dashboard.html 会被浏览器
    // 拒绝、直接黑屏）。所以这里必须接住整站两个非 /app/ 页面。
    const appPage = target.pathname === '/app' || target.pathname.startsWith('/app/');
    const standalonePage = ['/dashboard.html', '/admin.html'].includes(target.pathname);
    return appPage || standalonePage ? target.pathname + target.search + target.hash : '';
  } catch {
    return '';
  }
}

function cacheRuntimeState(state) {
  runtimeState = state;
  const snapshot = conversationSnapshot(state);
  if (snapshot.messages.some(item => item.role === 'user' && item.content === pendingDraft)) {
    pendingDraft = '';
    previewSend.disabled = false;
  }
  writeCachedConversation(snapshot);
  if (Array.isArray(state?.conversations) && state.conversations.length) {
    history = state.conversations;
    writeCachedHistory(history);
  }
  try {
    localStorage.setItem(`${SETTINGS_CACHE_PREFIX}${snapshot.conversation_id}`, JSON.stringify({
      models: state?.models || [],
      model_default_id: state?.model_default_id || '',
      model_settings: state?.model_settings || {},
    }));
  } catch {}
  if (!document.body.classList.contains('is-ready')) renderConversation(snapshot, { save: false });
  renderHistory();
  updateModelSummary(state);
}

function handleRuntimeMessage(event) {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
  const message = event.data;
  if (!message || message.channel !== HOST_CHANNEL || message.version !== 1) return;
  if (message.type === 'ready') {
    updateVisibleConversationUrl(message.app_id, message.conversation_id);
    markReady(message.role_name || message.title || '');
    return;
  }
  if (message.type === 'conversation-switching') {
    showConversationSwitchShell(message);
    return;
  }
  if (message.type === 'state') {
    cacheRuntimeState(message.state || {});
    return;
  }
  if (message.type === 'title') {
    setDocumentTitle(message.role_name || message.title || '');
    return;
  }
  if (message.type === 'conversation') {
    updateVisibleConversationUrl(message.app_id, message.conversation_id);
    return;
  }
  if (message.type === 'navigate') {
    const target = allowedNavigationPath(message.target);
    if (target) location.assign(target);
    return;
  }
  if (message.type === 'command-error') {
    showToast(message.message || '操作失败');
    return;
  }
  if (message.type === 'error') fail(new Error(String(message.message || '对话模块启动失败。')));
}

function modelData() {
  if (runtimeState?.models) return runtimeState;
  try { return parseJson(localStorage.getItem(`${SETTINGS_CACHE_PREFIX}${activeConversationId}`), {}); } catch { return {}; }
}

function updateModelSummary(state = modelData()) {
  const settings = state?.model_settings || {};
  const selected = (state?.models || []).find(item => String(item?.id || '') === String(settings.model_id || ''));
  modelSummary.textContent = String(selected?.name || selected?.model || '当前会话模型');
}

function openModelDialog() {
  closeDrawers();
  const data = modelData();
  const settings = { temperature: 1, top_p: 1, frequency_penalty: 0, presence_penalty: 0, ...(data?.model_settings || {}) };
  modelSelect.replaceChildren();
  for (const model of data?.models || []) {
    const option = document.createElement('option');
    option.value = String(model?.id || '');
    option.textContent = String(model?.name || model?.model || model?.id || '未命名模型');
    modelSelect.append(option);
  }
  if (!modelSelect.options.length) {
    const option = document.createElement('option');
    option.value = String(settings.model_id || '');
    option.textContent = '使用网站当前模型';
    modelSelect.append(option);
  }
  modelSelect.value = String(settings.model_id || modelSelect.options[0]?.value || '');
  for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
    const number = modelForm.querySelector(`[data-model-number="${key}"]`);
    const range = modelForm.querySelector(`[data-model-range="${key}"]`);
    number.value = String(settings[key]);
    range.value = String(settings[key]);
  }
  modelDialog.showModal();
}

async function switchConversation(appId, conversationId) {
  if (!appId || !conversationId || conversationId === activeConversationId) {
    closeDrawers();
    return;
  }
  closeDrawers();
  pendingDraft = '';
  previewSend.disabled = false;
  const wasReady = runtimeReady;
  updateVisibleConversationUrl(appId, conversationId);
  showShell();
  renderCachedConversation(conversationId);
  void loadQuickPreview(conversationId);
  if (wasReady) {
    postRuntimeCommand('switch-conversation', { app_id: appId, conversation_id: conversationId });
    runtimeReady = false;
    return;
  }
  activeTarget = runtimeTarget(appId, conversationId);
  frame.src = activeTarget.href;
}

async function start() {
  clearReadyTimer();
  runtimeReady = false;
  launcherVisual.src = '/assets/img/brand/launch-loading-1080x1920.png?v=20260901-persistent-pages';
  showShell();
  history = readCachedHistory();
  renderHistory();
  void loadHistory();
  const params = new URLSearchParams(location.search);
  activeAppId = String(params.get('app_id') || '').trim();
  activeConversationId = String(params.get('conversation_id') || params.get('conv_id') || '').trim();
  if (activeConversationId) renderCachedConversation(activeConversationId);
  frame.removeAttribute('src');
  try {
    activeTarget = await resolveLaunchTarget();
    frame.src = activeTarget.href;
    readyTimer = window.setTimeout(() => fail(new Error('后台对话能力连接超时，本地历史仍可使用。')), READY_TIMEOUT_MS);
  } catch (error) {
    fail(error);
  }
}

window.addEventListener('message', handleRuntimeMessage);
frame.addEventListener('error', () => fail(new Error('对话能力连接失败。')));
retry.addEventListener('click', () => void start());
networkRetry.addEventListener('click', () => void start());
previewAvatar.addEventListener('error', () => {
  const fallback = new URL('/assets/img/apk/avatar.webp?v=20260901-persistent-pages', location.href).href;
  if (previewAvatar.src !== fallback) previewAvatar.src = fallback;
});
menuButton.addEventListener('click', () => openDrawer('left'));
settingsButton.addEventListener('click', () => openDrawer('right'));
leftClose.addEventListener('click', closeDrawers);
rightClose.addEventListener('click', closeDrawers);
scrim.addEventListener('click', closeDrawers);
historyList.addEventListener('click', event => {
  const button = event.target.closest('[data-conversation-id]');
  if (!button) return;
  void switchConversation(button.dataset.appId, button.dataset.conversationId);
});
modelButton.addEventListener('click', openModelDialog);
modelClose.addEventListener('click', () => modelDialog.close());
modelCancel.addEventListener('click', () => modelDialog.close());
for (const section of document.querySelectorAll('[data-runtime-section]')) {
  section.addEventListener('click', () => {
    closeDrawers();
    postRuntimeCommand('open-settings', { section: section.dataset.runtimeSection });
    if (runtimeReady) document.body.classList.add('is-ready');
  });
}
for (const range of modelForm.querySelectorAll('[data-model-range]')) {
  range.addEventListener('input', () => {
    modelForm.querySelector(`[data-model-number="${range.dataset.modelRange}"]`).value = range.value;
  });
}
for (const number of modelForm.querySelectorAll('[data-model-number]')) {
  number.addEventListener('input', () => {
    modelForm.querySelector(`[data-model-range="${number.dataset.modelNumber}"]`).value = number.value;
  });
}
modelForm.addEventListener('submit', event => {
  event.preventDefault();
  const settings = { model_id: modelSelect.value };
  for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
    settings[key] = Number(modelForm.querySelector(`[data-model-number="${key}"]`).value);
  }
  const data = modelData();
  data.model_settings = settings;
  runtimeState = { ...(runtimeState || {}), ...data };
  try { localStorage.setItem(`${SETTINGS_CACHE_PREFIX}${activeConversationId}`, JSON.stringify(data)); } catch {}
  postRuntimeCommand('model-settings', { settings });
  updateModelSummary(data);
  modelDialog.close();
  showToast('模型参数已保存到本次会话');
});
previewComposer.addEventListener('submit', event => {
  event.preventDefault();
  const content = String(previewInput.value || '').trim().slice(0, 10_000);
  if (!content || pendingDraft) return;
  pendingDraft = content;
  previewInput.value = '';
  previewSend.disabled = true;
  const cached = readCachedConversation(activeConversationId) || conversationSnapshot({});
  renderMessages(cached.messages || [], { pending: content });
  writeCachedConversation({ ...cached, messages: cached.messages || [] });
  postRuntimeCommand('draft', { content, submit: true });
});
previewInput.addEventListener('input', () => {
  previewInput.style.height = 'auto';
  previewInput.style.height = `${Math.min(128, previewInput.scrollHeight)}px`;
});

// The local conversation shell is already fully interactive at this point.
// Tell the Android container to reveal it now; the heavier dialogue runtime
// continues warming in the background and reports its own readiness later.
document.documentElement.dataset.homerShellReady = 'true';
nativeCall('notifyShellReady', location.href);

void start();
