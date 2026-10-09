import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const host = fs.readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
function evaluate(start, end, context) {
  Object.assign(context, {
    runtimeLaunchEpoch: 0, runtimeLaunchSequence: 0, runtimeLaunchOwner: '', runtimeEngineToken: '', runtimePriorDocument: null,
    runtimeAccountBlocked: false, runtimeAccountEpoch: 0, runtimeColdPending: false, runtimeColdFailed: false, runtimeColdFlight: null,
    runtimeBindingPrefix: 'fixture-host-document', ...context,
    // No history preparation is offered in this legacy behavior fixture.
    // The actual mailbox protocol is covered by mobile-r41-history-preparation-host.
    historyReadPreparation: context.historyReadPreparation || { clear() {}, flush() { return false; } },
  });
  vm.createContext(context);
  vm.runInContext(host.slice(host.indexOf('function runtimeBindingOwner('), host.indexOf('function openRuntimeTool(')), context);
  vm.runInContext(host.slice(host.indexOf(start), host.indexOf(end)), context);
  return context;
}
test('bridge notifications do not read an undefined runtime state', () => {
  let bindings = 0;
  const source = {}, native = [];
  const context = evaluate('function handleRuntimeMessage(', 'function modelData(', {
    location: { origin: 'https://example.test', href: 'https://example.test/app/chat.html?prewarm=1' }, frame: { contentWindow: source },
    HOST_CHANNEL: 'homer:dialogue-host:v1', prepareAdminCard() {},
    getCachedUser: () => ({ id: 'fixture-owner' }), nativeCall: (...args) => native.push(args),
    bindPreparedConversation() { bindings++; },
  });
  context.handleRuntimeMessage({ origin: 'https://example.test', source, data: { channel: 'homer:dialogue-host:v1', version: 1, type: 'core-ready' } });
  assert.equal(bindings, 1);
  assert.equal(native.length, 0, 'Legacy tokenless core-ready cannot complete a correlated native preparation');
  context.handleRuntimeMessage({ origin: 'https://attacker.test', source, data: { channel: 'homer:dialogue-host:v1', version: 1, type: 'core-ready' } });
  assert.equal(bindings, 1);
});
test('late titles, conversations and overlays cannot replace the active conversation', () => {
  const source = {}, received = [];
  const context = evaluate('function handleRuntimeMessage(', 'function modelData(', {
    location: { origin: 'https://example.test' }, frame: { contentWindow: source },
    HOST_CHANNEL: 'homer:dialogue-host:v1', adminPreview: false, runtimeReady: true,
    activeAppId: 'current-card', activeConversationId: 'current-chat',
    setDocumentTitle: value => received.push(['title', value]),
    updateVisibleConversationUrl: (...value) => received.push(['conversation', ...value]),
    setRuntimeOverlay: value => received.push(['overlay', value]),
  });
  for (const type of ['title', 'conversation', 'overlay-state']) {
    for (const scope of [
      { app_id: 'old-card', conversation_id: 'old-chat' },
      { app_id: 'current-card', conversation_id: 'old-chat' },
      { app_id: 'old-card', conversation_id: 'current-chat' },
      { app_id: 'current-card', conversation_id: 'current-chat', admin_preview: true },
    ]) context.handleRuntimeMessage({ origin: 'https://example.test', source,
      data: { channel: 'homer:dialogue-host:v1', version: 1, type, active: true, ...scope } });
  }
  assert.equal(received.length, 0);
  for (const type of ['title', 'conversation', 'overlay-state']) context.handleRuntimeMessage({ origin: 'https://example.test', source,
    data: { channel: 'homer:dialogue-host:v1', version: 1, type, active: true,
      app_id: 'current-card', conversation_id: 'current-chat', role_name: 'Current' } });
  assert.equal(received.length, 3);
});
test('retained input focus does not discard a different conversation draft', () => {
  const input = {};
  const context = evaluate('function canAcceptRuntimeDraft(', 'function submitDraft(', {
    pendingDraft: '', composerDraftDirty: false, activeConversationId: 'new-chat',
    composerInputScope: 'account:old-chat', composerUi: { input },
    scopedKey: value => 'account:' + value,
    document: { activeElement: input, querySelector: () => null },
  });
  assert.equal(context.canAcceptRuntimeDraft(), true);
  context.composerInputScope = 'account:new-chat';
  assert.equal(context.canAcceptRuntimeDraft(), false);
  context.document.activeElement = null;
  assert.equal(context.canAcceptRuntimeDraft(), true);
  context.composerDraftDirty = true;
  assert.equal(context.canAcceptRuntimeDraft(), false);
});
test('runtime transitions require the current source or announced target; stale failures are rejected', () => {
  const context = evaluate('function acceptsRuntimeTransition(', 'function handleRuntimeMessage(', {
    activeAppId: 'card-b', activeConversationId: 'chat-b', adminPreview: false,
  });
  assert.equal(context.acceptsRuntimeTransition({type:'conversation-switching',app_id:'card-c',conversation_id:'chat-c',from_app_id:'card-b',from_conversation_id:'chat-b'}), true);
  assert.equal(context.acceptsRuntimeTransition({type:'conversation-switching',app_id:'card-b',conversation_id:'chat-b',from_app_id:'card-a',from_conversation_id:'chat-a'}), true);
  assert.equal(context.acceptsRuntimeTransition({type:'conversation-switching',app_id:'card-a',conversation_id:'chat-a',from_app_id:'old-card',from_conversation_id:'old-chat'}), false);
  assert.equal(context.acceptsRuntimeTransition({type:'conversation-switch-failed',failed_app_id:'card-a',failed_conversation_id:'chat-a'}), false);
  assert.equal(context.acceptsRuntimeTransition({type:'conversation-switch-failed',failed_app_id:'card-b',failed_conversation_id:'chat-b'}), true);
  context.adminPreview = true; context.activeConversationId = '';
  assert.equal(context.acceptsRuntimeTransition({type:'conversation-switching',admin_preview:true,app_id:'card-b',conversation_id:'preview'}), true);
});
test('native-selected IDs do not falsely acknowledge a shell before old drawers close', () => {
  let closes = 0;
  const context = evaluate('function showConversationSwitchShell(', 'function fail(', {
    runtimeReady: false, runtimeBound: false, activeAppId: 'card-b', activeConversationId: 'chat-b',
    switchShellScope: { key: 'account:' + JSON.stringify(['card-a', 'chat-a']), roleName: '' },
    scopedKey: value => 'account:' + value,
    prewarming: false, pendingTool: null, clearReadyTimer() {}, previewSend: {}, previewInput: {},
    closeDrawers() { closes++; }, updateVisibleConversationUrl() {}, showShell() {},
    renderCachedConversation: () => true, updateModelSummary() {}, composerUi: null, loadQuickPreview() {},
  });
  context.showConversationSwitchShell({app_id:'card-b',conversation_id:'chat-b'});
  assert.equal(closes, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.switchShellScope)), {
    key: 'account:' + JSON.stringify(['card-b', 'chat-b']), roleName: '',
  });
  context.previewInput.value = 'new typed draft'; context.composerDraftDirty = true;
  context.showConversationSwitchShell({app_id:'card-b',conversation_id:'chat-b'});
  assert.equal(closes, 1, 'the bridge ACK must not close a newly opened tool');
  assert.equal(context.previewInput.value, 'new typed draft');
  assert.equal(context.composerDraftDirty, true);
});
test('host insets are sent once per real size and again when the runtime becomes ready', () => {
  const sent = [];
  const context = evaluate('function syncHostInsets(', 'const hostSizeObserver', {
    runtimeReady: false, insetsSignature: '',
    document: { body: {classList:{contains:()=>false}}, querySelector: selector => ({ getBoundingClientRect: () => ({ height: selector === '.preview-header' ? 48 : 74 }) }) },
    postRuntimeCommand(type, payload, options) { sent.push({ type, ...payload, ...options }); return true; },
  });
  context.syncHostInsets(); assert.equal(sent.length, 0);
  context.runtimeReady = true; context.syncHostInsets(); context.syncHostInsets();
  assert.deepEqual(sent, [{ type: 'host-insets', top: 48, bottom: 74, queue: false }]);
  context.insetsSignature = ''; context.syncHostInsets(); assert.equal(sent.length, 2);
});
test('canceling a pre-ready send removes only queued draft commands and restores its text', () => {
  let rendered = 0, refreshed = 0;
  const commands = [{ command: { type: 'draft' } }, { command: { type: 'open-settings' } }];
  const context = evaluate('function stopDraft(', 'function prepareAdminCard(', {
    runtimeReady: false, pendingCommands: commands, pendingDraft: 'draft', previewInput: { value: '' },
    currentMessages: [], renderMessages() { rendered++; }, composerUi: { refresh() { refreshed++; } },
  });
  context.stopDraft();
  assert.equal(context.previewInput.value, 'draft'); assert.equal(context.pendingDraft, '');
  assert.equal(commands.length, 1); assert.equal(commands[0].command.type, 'open-settings');
  assert.equal(rendered, 1); assert.equal(refreshed, 1);
});
test('live Stop is delegated to the current generation engine', () => {
  const sent = [];
  const context = evaluate('function stopDraft(', 'function prepareAdminCard(', {
    runtimeReady: true, postRuntimeCommand: (...args) => sent.push(args),
  });
  context.stopDraft(); assert.equal(sent[0][0], 'stop'); assert.equal(sent[0][2].queue, false);
});
test('cached snapshots deduplicate unchanged bodies and never persist admin previews', () => {
  let writes = 0;
  const context = evaluate('function writeCachedConversation(', 'function readCachedHistory(', {
    adminPreview: true, PREVIEW_CACHE_PREFIX: 'preview:', cachedSignatures: new Map(), nativeCall() { writes++; },
    scopedKey: key => key, localStorage: { setItem() { writes++; } },
    getCachedUser: () => ({ id: 'fixture' }), readPageCache: () => null, writePageCache() {},
  });
  const snapshot = { conversation_id: 'c', app_id: 'a', title: 'title', messages: [{ content: 'body' }] };
  context.writeCachedConversation(snapshot); assert.equal(writes, 0);
  context.adminPreview = false;
  context.writeCachedConversation(snapshot); context.writeCachedConversation({ ...snapshot, updated_at: Date.now() });
  assert.equal(writes, 2);
  context.writeCachedConversation({ ...snapshot, messages: [{ content: 'edited' }] }); assert.equal(writes, 4);
});
test('rendered regex text survives repeated normalization without parsing it as HTML', () => {
  const context = evaluate('function normalizeMessage(', 'function conversationSnapshot(', {
    visiblePreviewText: () => { throw new Error('Already rendered text must not be parsed again'); },
  });
  const first = context.normalizeMessage({ id: 'm', role: 'assistant', content: 'RAW', display_text: 'Visible <tag> & text' });
  assert.equal(first.content, 'Visible <tag> & text');
  assert.equal(context.normalizeMessage(first).content, first.content);
});
