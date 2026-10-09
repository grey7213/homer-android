import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function section(begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, `actual shipping section ${begin}`);
  return source.slice(start, finish);
}

// Actual retained-document routing and readiness methods; only shell painting,
// canonical responses, and the frame are synthetic. No API or engine is started.
function fixture(search = '', completeInitialTarget = true) {
  const listeners = new Map(), posts = [], coldStarts = [], srcWrites = [], toasts = [], flushes = [], orientationRefreshes = [];
  let syntheticOwner = 'synthetic-owner-a';
  const initialSearch = completeInitialTarget ? `?app_id=card-a&conversation_id=chat-a${search}` : `?${search.replace(/^&/, '')}`;
  const noop = () => {};
  const classes = new Set();
  const node = { textContent: '', value: '', disabled: false, inert: false,
    setAttribute: noop, close: noop, classList: {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value),
      toggle(value, force) {
        const enabled = force === undefined ? !classes.has(value) : force;
        if (enabled) classes.add(value); else classes.delete(value);
        return enabled;
      },
    } };
  const window = { addEventListener: (name, handler) => listeners.set(name, handler), clearTimeout: noop,
    history: { replaceState: (_state, _title, url) => { context.location.href = String(url); context.location.search = new URL(url).search; } } };
  window.HomerNative = { refreshArchiveOrientation(url) {
    assert.equal(this, window.HomerNative, 'Injected bridge receiver must be preserved');
    orientationRefreshes.push(url);
  } };
  const frameWindow = { postMessage: (data, origin) => posts.push({ data: plain(data), origin }) };
  const frame = { contentWindow: frameWindow, inert: false };
  Object.defineProperty(frame, 'src', { set(value) { srcWrites.push(value); } });
  const context = vm.createContext({ URL, URLSearchParams, window, frame,
    location: { href: `https://synthetic.invalid/app/chat.html${initialSearch}`, origin: 'https://synthetic.invalid', search: initialSearch },
    document: { body: node, querySelector: () => node },
    HOST_CHANNEL: 'homer:dialogue-host:v1',
    activeAppId: 'card-a', activeConversationId: 'chat-a', adminPreview: false, pendingAdminCard: '', adminBindPending: false,
    runtimeReady: true, runtimeBound: true, runtimeColdPending: false, runtimeColdFailed: false, prewarming: false,
    runtimeAccountBlocked: false, runtimeAccountEpoch: 0, runtimeState: null, runtimeOverlayActive: false,
    runtimeEngineToken: '', runtimeColdFlight: null, coreReady: true, bridgeAvailable: true, runtimePriorDocument: null,
    launchRequestId: 0, previewRequestId: 0, pendingCommands: [], pendingDraft: '', pendingTool: null,
    insetsSignature: '', switchShellScope: '', composerDraftDirty: false, composerInputScope: '', composerUi: null,
    previewInput: node, previewSend: node, previewTitle: node, launcherVisual: {}, launcher: node, announcer: node,
    readyHandoffTimer: 0, history: [], appearance: { refresh: noop }, settledPreviewQueue: { clear: noop },
    clearReadyTimer: noop, syncHostInsets: noop, setDocumentTitle: noop,
    canUseIdleHostDisplay: () => false, adoptRuntimeControls: () => false, closeDrawers: noop,
    scopedKey: value => value, renderCachedConversation: () => true, renderConversation: noop,
    updateModelSummary: noop, loadQuickPreview: noop, showToast: value => toasts.push(value),
    startColdRuntime: () => coldStarts.push('start'), bindPreparedConversation: noop, resetColdRuntimeBinding: noop,
    runtimeBindingOwner: () => syntheticOwner,
    consumeColdRuntimeReady: () => false, openAdminPreview: noop, prepareAdminCard: noop, prepareColdRuntimeTarget: noop,
    resolveLaunchTarget: () => new Promise(() => {}),
    historyReadPreparation: { flush: noop }, cacheRuntimeState: noop, nativeCall: noop, performance: { mark: noop },
    flushOptionalHostDisplayCache: () => flushes.push('flush'),
  });
  vm.runInContext([
    section('let requestedPresentation =', 'let insetsSignature ='),
    section('function setRuntimeOverlay(', 'function syncHostInsets('),
    section("window.addEventListener('homer-native-visibility'", "window.addEventListener('homer-account-cleared'"),
    section("window.addEventListener('homer-account-cleared'", 'const uiReady ='),
    section('function postRuntimeCommand(', 'function canUseIdleHostDisplay('),
    section('function showShell(', 'function fail('),
    section('function updateVisibleConversationUrl(', 'async function loadHistory('),
    section('function acceptsRuntimeTransition(', 'function modelData('),
    section('async function switchConversation(', 'async function start('),
    section('let navigationPending =', "frame.addEventListener('error'"),
  ].join('\n'), context);
  function navigate(app, chat, presentation = '', view = 'stage', gameId = '') {
    const url = new URL('/app/chat.html', context.location.origin);
    url.searchParams.set('app_id', app); if (chat) url.searchParams.set('conversation_id', chat);
    if (presentation) { url.searchParams.set('presentation', presentation); url.searchParams.set('vn_view', view); }
    if (gameId) url.searchParams.set('vn_game', gameId);
    let prevented = false;
    listeners.get('homer:navigate-conversation')({ detail: { url: url.href }, preventDefault() { prevented = true; } });
    return prevented;
  }
  const message = data => context.handleRuntimeMessage({ source: frameWindow, origin: context.location.origin,
    data: { channel: context.HOST_CHANNEL, version: 1, admin_preview: false, ...data } });
  return { context, posts, coldStarts, srcWrites, toasts, navigate, message, listeners, flushes, classes, orientationRefreshes,
    setOwner(value) { syntheticOwner = value; },
    visibility: visible => listeners.get('homer-native-visibility')({ detail: { visible } }),
    visibilityPosts: () => posts.filter(item => item.data.type === 'presentation-visibility').map(item => item.data),
    modes: () => posts.filter(item => item.data.type === 'presentation-mode').map(item => item.data) };
}

test('ordinary initial readiness has no implicit VN mode or cold engine activation', () => {
  const h = fixture(); h.context.markReady();
  assert.deepEqual(h.modes(), []); assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('only a bound game hides ordinary chat chrome; visual readers and invalid IDs do not', () => {
  for (const search of ['', '&presentation=archive_vn', '&presentation=archive_vn&vn_game=bad%2Fid', '&vn_game=story-a',
    '&presentation=archive_vn&vn_game=story-a&vn_game=story-b', '&presentation=archive_vn&presentation=tavern&vn_game=story-a']) {
    const h = fixture(search); h.context.markReady(); h.context.setRuntimeOverlay(true);
    assert.equal(h.classes.has('has-archive-game'), false);
  }
  const h = fixture('&presentation=archive_vn&vn_game=story-a');
  h.context.runtimeReady = false; h.context.setRuntimeOverlay(false);
  assert.equal(h.classes.has('has-archive-game'), false, 'Cold shell remains usable until the game is ready');
  h.context.markReady(); h.context.setRuntimeOverlay(true);
  assert.equal(h.classes.has('has-archive-game'), true);
  assert.equal(h.orientationRefreshes.at(-1), h.context.location.href);
  assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('retained game stage/talk routing refreshes native rotation without replacing the engine', () => {
  const h = fixture();
  h.navigate('card-a', 'chat-a', 'archive_vn', 'stage', 'story-a');
  assert.equal(h.classes.has('has-archive-game'), true);
  h.navigate('card-a', 'chat-a', 'archive_vn', 'talk', 'story-a');
  assert.equal(new URL(h.orientationRefreshes.at(-1)).searchParams.get('vn_view'), 'talk');
  assert.equal(h.classes.has('has-archive-game'), true);
  assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('explicit game exit and ordinary target switching release fullscreen chrome and native rotation', async () => {
  const h = fixture('&presentation=archive_vn&vn_game=story-a');
  h.context.markReady();
  assert.equal(h.classes.has('has-archive-game'), true);
  assert.equal(h.context.clearVisibleGameRequest(), true);
  assert.equal(h.classes.has('has-archive-game'), false);
  assert.equal(new URL(h.orientationRefreshes.at(-1)).searchParams.has('vn_game'), false);
  const other = fixture('&presentation=archive_vn&vn_game=story-b'); other.context.markReady();
  await other.context.switchConversation('card-c', 'chat-c');
  assert.equal(other.classes.has('has-archive-game'), false);
  assert.equal(new URL(other.orientationRefreshes.at(-1)).searchParams.has('presentation'), false);
  assert.deepEqual(other.coldStarts, []); assert.deepEqual(other.srcWrites, []);
});

test('initial query presentation intent binds exact canonical IDs and is consumed only once', () => {
  const h = fixture('&presentation=archive_vn&vn_view=talk'); h.context.markReady(); h.context.markReady();
  assert.equal(h.modes().length, 1);
  assert.equal(h.modes()[0].app_id, 'card-a'); assert.equal(h.modes()[0].conversation_id, 'chat-a');
  assert.equal(h.modes()[0].mode, 'archive_vn'); assert.equal(h.modes()[0].view, 'talk');
  assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('an initial mode query without a complete canonical target does not adopt unrelated ready IDs', () => {
  const h = fixture('&presentation=archive_vn&app_id=card-b', false); h.context.markReady();
  assert.deepEqual(h.modes(), []);
});

test('same canonical conversation stage/talk requests reuse the ready frame without switching or cold starting', () => {
  const h = fixture(); h.navigate('card-a', 'chat-a', 'archive_vn', 'stage'); h.navigate('card-a', 'chat-a', 'archive_vn', 'talk');
  assert.deepEqual(h.modes().map(item => item.view), ['stage', 'talk']);
  assert.ok(h.modes().every(item => item.app_id === 'card-a' && item.conversation_id === 'chat-a'));
  assert.equal(h.posts.filter(item => item.data.type === 'switch-conversation').length, 0);
  assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('different canonical conversation requests keep the existing bound engine and wait for target readiness', () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn', 'talk');
  assert.deepEqual(h.modes(), []);
  assert.equal(h.posts.filter(item => item.data.type === 'switch-conversation').length, 1);
  h.message({ type: 'ready', app_id: 'card-a', conversation_id: 'chat-a' });
  assert.deepEqual(h.modes(), []);
  h.message({ type: 'ready', app_id: 'card-b', conversation_id: 'chat-b' });
  assert.equal(h.modes().length, 1); assert.equal(h.modes()[0].conversation_id, 'chat-b');
  assert.equal(h.modes()[0].view, 'talk'); assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('account clearing cancels the old presentation intent even if the new login reuses the same IDs', () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn');
  h.listeners.get('homer-account-cleared')(); h.context.runtimeAccountBlocked = false;
  h.context.runtimeColdPending = false; h.context.markReady();
  assert.deepEqual(h.modes(), []);
});

test('pending mode intent cannot cross an owner change even if the canonical IDs match', () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn'); h.setOwner('synthetic-owner-b');
  h.message({ type: 'ready', app_id: 'card-b', conversation_id: 'chat-b' });
  assert.deepEqual(h.modes(), []);
});

test('pending mode intent cannot cross a same-owner new login epoch', () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn'); h.context.runtimeAccountEpoch++;
  h.message({ type: 'ready', app_id: 'card-b', conversation_id: 'chat-b' });
  assert.deepEqual(h.modes(), []);
});

test('a stale failure for an older navigation does not cancel the newest matching VN target', () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn'); h.navigate('card-c', 'chat-c', 'archive_vn', 'talk');
  h.message({ type: 'conversation-switch-failed', failed_app_id: 'card-b', failed_conversation_id: 'chat-b', app_id: 'card-a', conversation_id: 'chat-a' });
  assert.equal(h.context.activeConversationId, 'chat-c');
  h.message({ type: 'ready', app_id: 'card-c', conversation_id: 'chat-c' });
  assert.equal(h.modes().length, 1); assert.equal(h.modes()[0].conversation_id, 'chat-c'); assert.equal(h.modes()[0].view, 'talk');
});

test('failed VN target switching does not transfer that target presentation request to the restored original conversation', () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn', 'talk');
  h.message({ type: 'conversation-switch-failed', failed_app_id: 'card-b', failed_conversation_id: 'chat-b',
    app_id: 'card-a', conversation_id: 'chat-a' });
  assert.equal(h.context.activeConversationId, 'chat-a');
  assert.deepEqual(h.modes(), [], 'A request for chat-b may not be re-signed with chat-a canonical IDs');
});

test('a pending launch-target resolution cannot apply its VN intent to an older still-ready conversation', () => {
  const h = fixture(); h.navigate('card-b', '', 'archive_vn', 'talk');
  h.message({ type: 'ready', app_id: 'card-a', conversation_id: 'chat-a' });
  assert.deepEqual(h.modes(), [], 'Until card-b launch resolves, chat-a readiness cannot consume card-b intent');
});

test('a later ordinary history switch does not inherit an earlier target VN request', async () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn');
  await h.context.switchConversation('card-c', 'chat-c');
  h.message({ type: 'ready', app_id: 'card-c', conversation_id: 'chat-c' });
  assert.deepEqual(h.modes(), [], 'The latest ordinary navigation did not request VN');
  assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('rapid explicit stage/talk navigation applies only the newest target mode without creating an engine', () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn', 'stage'); h.navigate('card-c', 'chat-c', 'archive_vn', 'talk');
  h.message({ type: 'ready', app_id: 'card-b', conversation_id: 'chat-b' }); assert.deepEqual(h.modes(), []);
  h.message({ type: 'ready', app_id: 'card-c', conversation_id: 'chat-c' });
  assert.equal(h.modes().length, 1); assert.equal(h.modes()[0].conversation_id, 'chat-c');
  assert.equal(h.modes()[0].view, 'talk'); assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('ordinary switching clears the previous target VN URL so cold reopening cannot inherit it', async () => {
  const h = fixture('&presentation=archive_vn&vn_view=talk&unrelated=keep'); h.context.markReady();
  await h.context.switchConversation('card-b', 'chat-b');
  const next = new URL(h.context.location.href);
  assert.equal(next.searchParams.get('app_id'), 'card-b'); assert.equal(next.searchParams.get('conversation_id'), 'chat-b');
  assert.equal(next.searchParams.has('presentation'), false); assert.equal(next.searchParams.has('vn_view'), false);
  assert.equal(next.searchParams.get('unrelated'), 'keep');
  const reopened = fixture(next.search.slice(1), false); reopened.context.activeAppId = 'card-b'; reopened.context.activeConversationId = 'chat-b';
  reopened.context.markReady(); assert.deepEqual(reopened.modes(), []);
  assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('a matching scoped VN request writes its target view into the visible URL before and after readiness', () => {
  const h = fixture('&unrelated=keep'); h.navigate('card-b', 'chat-b', 'archive_vn', 'talk');
  let next = new URL(h.context.location.href);
  assert.equal(next.searchParams.get('presentation'), 'archive_vn'); assert.equal(next.searchParams.get('vn_view'), 'talk');
  assert.equal(next.searchParams.get('unrelated'), 'keep');
  h.message({ type: 'ready', app_id: 'card-b', conversation_id: 'chat-b' });
  h.message({ type: 'conversation', app_id: 'card-b', conversation_id: 'chat-b' });
  next = new URL(h.context.location.href);
  assert.equal(next.searchParams.get('presentation'), 'archive_vn'); assert.equal(next.searchParams.get('vn_view'), 'talk');
});

test('same-target explicit view changes update URL while ordinary same-target navigation sends no exit command', async () => {
  const h = fixture('&presentation=archive_vn&vn_view=stage'); h.context.markReady();
  h.navigate('card-a', 'chat-a', 'archive_vn', 'talk');
  assert.equal(new URL(h.context.location.href).searchParams.get('vn_view'), 'talk');
  const before = h.posts.length; h.navigate('card-a', 'chat-a'); await h.context.switchConversation('card-a', 'chat-a');
  assert.equal(h.posts.length, before, 'Ordinary history selection is not an implicit archive exit');
  assert.equal(new URL(h.context.location.href).searchParams.get('presentation'), 'archive_vn');
  assert.equal(new URL(h.context.location.href).searchParams.get('vn_view'), 'talk');
  assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('a changed app ID clears a previous VN URL even when the conversation ID happens to match', () => {
  const h = fixture('&presentation=archive_vn&vn_view=talk'); h.context.markReady();
  h.context.updateVisibleConversationUrl('card-b', 'chat-a');
  const next = new URL(h.context.location.href);
  assert.equal(next.searchParams.has('presentation'), false); assert.equal(next.searchParams.has('vn_view'), false);
});

test('failed target recovery clears the failed target presentation URL rather than moving it to the old chat', () => {
  const h = fixture(); h.navigate('card-b', 'chat-b', 'archive_vn', 'talk');
  h.message({ type: 'conversation-switch-failed', failed_app_id: 'card-b', failed_conversation_id: 'chat-b', app_id: 'card-a', conversation_id: 'chat-a' });
  const next = new URL(h.context.location.href);
  assert.equal(next.searchParams.get('conversation_id'), 'chat-a');
  assert.equal(next.searchParams.has('presentation'), false); assert.equal(next.searchParams.has('vn_view'), false);
});

for (const stale of ['owner', 'epoch']) test(`a stale ${stale} request cannot preserve a same-target VN URL for cold reopening`, () => {
  const h = fixture('&presentation=archive_vn&vn_view=talk');
  if (stale === 'owner') h.setOwner('synthetic-owner-b'); else h.context.runtimeAccountEpoch++;
  h.context.updateVisibleConversationUrl('card-a', 'chat-a');
  const next = new URL(h.context.location.href);
  assert.equal(next.searchParams.has('presentation'), false); assert.equal(next.searchParams.has('vn_view'), false);
});

test('a same-target canonical URL update preserves a valid already-consumed presentation query', () => {
  const h = fixture('&presentation=archive_vn&vn_view=talk'); h.context.markReady();
  h.context.updateVisibleConversationUrl('card-a', 'chat-a');
  const next = new URL(h.context.location.href);
  assert.equal(next.searchParams.get('presentation'), 'archive_vn'); assert.equal(next.searchParams.get('vn_view'), 'talk');
});

test('native hidden and visible forward only the bool and canonical IDs without restarting the chat frame', () => {
  const h = fixture(); h.visibility(false); h.visibility(true);
  assert.deepEqual(h.visibilityPosts().map(data => data.visible), [false, true]); assert.deepEqual(h.flushes, ['flush']);
  assert.ok(h.visibilityPosts().every(data => data.app_id === 'card-a' && data.conversation_id === 'chat-a'));
  assert.deepEqual(Object.keys(h.visibilityPosts()[0]).sort(), ['app_id', 'channel', 'conversation_id', 'type', 'version', 'visible']);
  assert.deepEqual(h.modes(), []); assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
  h.visibility('false'); assert.equal(h.visibilityPosts().length, 2);
});

test('hidden received before ready is sent before the explicit lazy presentation request once its matching scope is ready', () => {
  const h = fixture('&presentation=archive_vn'); h.context.runtimeReady = false; h.visibility(false);
  assert.deepEqual(h.visibilityPosts(), []); h.context.markReady();
  const types = h.posts.map(item => item.data.type);
  assert.ok(types.indexOf('presentation-visibility') < types.indexOf('presentation-mode'));
  assert.equal(h.visibilityPosts()[0].visible, false); assert.deepEqual(h.coldStarts, []);
});

for (const stale of ['owner', 'epoch', 'target']) test(`late visibility received before ready drops stale ${stale} scope instead of transferring it`, () => {
  const h = fixture(); h.context.runtimeReady = false; h.visibility(false);
  if (stale === 'owner') h.setOwner('synthetic-owner-b');
  else if (stale === 'epoch') h.context.runtimeAccountEpoch++;
  else { h.context.activeAppId = 'card-b'; h.context.activeConversationId = 'chat-b'; }
  h.context.markReady(); assert.deepEqual(h.visibilityPosts(), []);
  assert.deepEqual(h.coldStarts, []); assert.deepEqual(h.srcWrites, []);
});

test('visibility forwarding rechecks owner and epoch after optional display-cache flushing', () => {
  const h = fixture(); h.context.flushOptionalHostDisplayCache = () => { h.setOwner('synthetic-owner-b'); h.context.runtimeAccountEpoch++; };
  h.visibility(false); assert.deepEqual(h.visibilityPosts(), []);
});

test('account clearing drops retained visibility even when a later login reuses canonical IDs', () => {
  const h = fixture(); h.context.runtimeReady = false; h.visibility(false);
  h.listeners.get('homer-account-cleared')(); h.context.runtimeAccountBlocked = false;
  h.context.runtimeColdPending = false; h.context.markReady(); assert.deepEqual(h.visibilityPosts(), []);
});
