import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publicModel } from '../../frontend/assets/js/model-catalog.js';

const bridge = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
function section(source, start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, start);
    return source.slice(begin, finish);
}
const plain = value => JSON.parse(JSON.stringify(value));
const actualBridge = [
    section(bridge, 'function safeSiteOrigin(', 'const HOST_OVERLAY_SELECTOR'),
    section(bridge, 'function currentRoleName(', 'function notifyHostLoading('),
    section(bridge, 'function canonicalDisplayTexts(', 'function openHostRequestedSettings('),
    section(bridge, 'function currentConversationRecord(', 'function updateConversationTitle('),
    section(bridge, 'function hasCanonicalConversationScope(', 'function assertCanonicalConversationScope('),
].join('\n');

function child({ native = true, idle = true, admin = false, reuse = false, runtimeUrl = '' } = {}) {
    let owner = 'synthetic-owner', nextId = 0, reads = 0, postHook = null;
    const timers = new Map(), idles = new Map(), posts = [];
    const context = { chat: [{ mes: 'synthetic complete selected source', swipes: ['other', 'synthetic complete selected source'], swipe_id: 1, extra: { homer_message_id: 'synthetic-message' } }] };
    const scope = vm.createContext({
        URL, HOST_CHANNEL: 'homer:dialogue-host:v1', requestedEmbed: '1', requestedHostChannel: 'homer:dialogue-host:v1',
        requestedSiteOrigin: 'https://synthetic.invalid', loadingLaunch: false, conversationRecoveryBlocked: false,
        urlParams: new URL(runtimeUrl || ('https://synthetic.invalid/module/dialogue/' + (native ? '?homer_idle_host_display=1' : ''))).searchParams,
        session: null, launch: null, storageAccountEpoch: 1, hostBootstrapEngineToken: 'synthetic-engine', hostBootstrapDocumentToken: 'synthetic-document',
        hostStateNotifyTimer: null, hostStateNotifyToken: null, hostOverlayActive: false,
        generationBusy: false, rollbackBusy: false, tavoComposer: { refresh() {} },
        performance: { mark() {} },
        restoreScopeDraft() {}, syncHostOverlayState() {}, reconcileStorageAccount: () => owner,
        isGenerating: () => false, getContext: () => context, publicModel,
        conversationModelSettings: () => ({ model_id: 'synthetic-model', temperature: 0.7, top_p: 0.9 }),
        runtimeUiData: { conversations: [{ id: 'synthetic-chat', app_id: 'synthetic-card', title: 'Synthetic role' }],
            models: [{ id: 'synthetic-model', display_name: 'Synthetic public name', model: 'provider-model', group_id: 'group-b', group_name: 'Synthetic group' }], modelDefaultId: 'synthetic-model' },
        document: { documentElement: { dataset: { homerBootstrapDocument: 'synthetic-document' } },
            querySelectorAll() { reads++; return []; }, querySelector: () => ({ value: 'synthetic draft' }) },
        window: { location: { origin: 'https://synthetic.invalid', href: 'https://synthetic.invalid/module/dialogue/' + (native ? '?homer_idle_host_display=1' : '') },
            parent: { postMessage(data) { if (postHook) postHook(data); posts.push(plain(data)); } },
            setTimeout(callback, delay) { const id = reuse ? 0 : nextId++; timers.set(id, { callback, delay }); return id; },
            clearTimeout(id) { timers.delete(id); },
            ...(idle ? { requestIdleCallback(callback, options) { const id = reuse ? 0 : nextId++; idles.set(id, { callback, options }); return id; }, cancelIdleCallback(id) { idles.delete(id); } } : {}),
        },
    });
    vm.runInContext(section(bridge, 'const requestedIdleHostDisplay =', 'const HOST_CHANNEL'), scope);
    vm.runInContext(actualBridge, scope);
    vm.runInContext(section(bridge, 'async function receiveHostCommand(', "window.addEventListener('message'"), scope);
    function bind(nextOwner = owner, app = 'synthetic-card', conv = 'synthetic-chat') {
        owner = nextOwner;
        scope.session = { user: { id: owner } };
        scope.launch = { app_id: app, conversation_id: conv, admin_preview: admin, card: { data: { name: 'Synthetic role' } } };
        context.chatId = 'Homer-' + conv;
        context.characterId = 0; context.characters = [{ data: { extensions: { homer_bridge: { app_id: app } } } }];
        context.chatMetadata = { homer_bridge: { user_id: owner, app_id: app, conversation_id: conv, runtime: 'dialogue' } };
    }
    const flush = collection => { for (const [id, item] of [...collection]) { if (collection.delete(id)) item.callback(); } };
    bind();
    return { scope, context, timers, idles, posts, bind, reads: () => reads,
        setOwner: value => { owner = value; }, setPost: value => { postHook = value; },
        flushTimers: () => flush(timers), flushIdle: () => flush(idles), states: () => posts.filter(row => row.type === 'state') };
}

function hostHarness({ native = true, admin = false } = {}) {
    const effects = [], commands = [], normalized = [], cacheWrites = [];
    const classSet = new Set(), nodes = new Map();
    const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', value: '', disabled: false, setAttribute() {} }); return nodes.get(id); };
    const scope = vm.createContext({
        URL, DEFAULT_RUNTIME_PATH: '/module/dialogue/', LEGACY_RUNTIME_PATH: '/dialogue-core/', HOST_CHANNEL: 'homer:dialogue-host:v1',
        adminPreview: admin, runtimeReady: false, runtimeState: null, runtimeAccountBlocked: false, runtimeAccountEpoch: 1,
        runtimeColdPending: false, runtimeColdFailed: false, runtimeColdFlight: null, runtimeLaunchEpoch: 1,
        runtimeLaunchOwner: 'synthetic-owner', runtimeEngineToken: 'synthetic-engine', runtimePriorDocument: null,
        runtimeBound: false, coreReady: false, bridgeAvailable: false, prewarming: false,
        activeAppId: 'synthetic-card', activeConversationId: 'synthetic-chat', pendingDraft: '', composerDraftDirty: false,
        previewRequestId: 0, readyHandoffTimer: 0, adminBindPending: false, switchShellScope: '', runtimeOverlayActive: false,
        insetsSignature: '', pendingTool: null, settingsSignature: '', SETTINGS_CACHE_PREFIX: 'synthetic-settings:', history: [],
        previewInput: node('input'), previewSend: node('send'), launcherVisual: node('visual'), launcher: node('launcher'), announcer: node('announcer'),
        frame: { inert: true, contentWindow: {} }, composerUi: { refresh() { effects.push('composer'); } }, composerInputScope: '',
        getCachedUser: () => ({ id: 'synthetic-owner' }),
        updateVisibleConversationUrl(app, conv) { scope.activeAppId = app; scope.activeConversationId = conv; },
        dispatchColdRuntimeTarget() { effects.push('dispatch'); },
        clearReadyTimer() {}, setRuntimeOverlay(value) { effects.push('overlay'); scope.runtimeOverlayActive = value; }, syncHostInsets() {},
        postRuntimeCommand(type, data) { commands.push({ type, data: plain(data || {}) }); return true; },
        setDocumentTitle() {}, flushRuntimeCommands() { effects.push(['flush', scope.runtimeState?.models?.[0]?.name, scope.runtimeState?.generating]); },
        conversationSnapshot(value) { normalized.push(value); return { ...value, messages: value.messages || [] }; },
        scopedKey: value => value, updateModelSummary() { effects.push(['model', scope.runtimeState?.models?.[0]?.name]); }, renderHistory() { effects.push('history'); },
        writeCachedHistory(value) { cacheWrites.push(value); }, renderConversation() { effects.push('render'); },
        settledPreviewQueue: { enqueue(value) { effects.push(['enqueue', value.messages.length]); }, flush() { effects.push('cache-flush'); } },
        nativeCall: name => native && name === 'notifyShellReady' ? undefined : undefined,
        localStorage: { setItem(key, value) { cacheWrites.push({ key, value }); } },
        location: { href: 'https://synthetic.invalid/app/chat.html', origin: 'https://synthetic.invalid' },
        document: { activeElement: null, body: { classList: { add(value) { classSet.add(value); }, remove(value) { classSet.delete(value); }, contains: value => classSet.has(value) } }, querySelector: selector => selector === '.homer-composer-editor[open]' ? null : node(selector) },
        window: { clearTimeout() {}, ...(native ? { HomerNative: { notifyShellReady() {} } } : {}) },
    });
    vm.runInContext([
        section(host, 'function canAcceptRuntimeDraft(', 'function submitDraft('),
        section(host, 'function runtimeBindingOwner(', 'function resetColdRuntimeBinding('),
        section(host, 'function matchesColdRuntimeFlight(', 'function openRuntimeTool('),
        section(host, 'function markReady(', 'function visiblePreviewText('),
        section(host, 'function cacheRuntimeState(', 'function acceptsRuntimeTransition('),
        section(host, 'function normalizeRuntimeUrl(', 'function updateVisibleConversationUrl('),
        section(host, 'function acceptsRuntimeTransition(', 'function modelData('),
    ].join('\n'), scope);
    return { scope, effects, commands, normalized, cacheWrites, classSet };
}

test('native final ready contains immediate public controls without touching message DOM and queues only bounded optional display', () => {
    const h = child(); h.scope.notifyHostConversation('ready');
    const ready = h.posts.find(row => row.type === 'ready');
    assert.ok(ready.control_state, 'ready must carry current controls');
    assert.equal(Object.hasOwn(ready.control_state, 'messages'), false);
    assert.equal(ready.control_state.models[0].name, 'Synthetic public name');
    assert.equal(ready.control_state.models[0].group_name, 'Synthetic group');
    assert.equal(ready.control_state.model_settings.temperature, 0.7);
    assert.equal(ready.control_state.draft, 'synthetic draft');
    assert.equal(ready.control_state.generating, false);
    assert.equal(h.reads(), 0); assert.equal(h.states().length, 0);
    assert.equal(h.idles.size, 1); assert.equal(h.timers.size, 0);
    assert.equal([...h.idles.values()][0].options.timeout, 500);
    h.flushIdle(); assert.equal(h.states().length, 1);
    assert.equal(h.states()[0].state.messages[0].content, 'synthetic complete selected source');
    assert.deepEqual(plain(h.context.chat[0].swipes), ['other', 'synthetic complete selected source']);
});

test('host adopts final controls before releasing queued submit/settings without normalizing or wiping messages/cache', () => {
    const h = hostHarness(), c = child(); c.scope.notifyHostConversation('ready');
    const ready = c.posts.find(row => row.type === 'ready');
    h.scope.pendingDraft = 'queued synthetic draft';
    h.scope.markReady(ready.role_name, { stateScheduled: ready.state_scheduled, controlState: ready.control_state });
    assert.equal(h.scope.runtimeState?.models?.[0]?.name, 'Synthetic public name');
    assert.equal(h.scope.runtimeState?.models?.[0]?.group_name, 'Synthetic group');
    assert.equal(h.scope.previewInput.value, '', 'pending user draft must not be overwritten by restored runtime draft');
    assert.equal(h.scope.pendingDraft, 'queued synthetic draft');
    assert.deepEqual(h.effects.find(row => Array.isArray(row) && row[0] === 'flush'), ['flush', 'Synthetic public name', false]);
    assert.equal(h.normalized.length, 0); assert.equal(h.cacheWrites.length, 0);
    assert.equal(h.commands.some(row => row.type === 'request-state'), false);
    assert.equal(h.classSet.has('is-ready'), true);
});

test('actual cold and warm ACK handlers adopt controls only after canonical source/flight correlation and before queued commands', () => {
    for (const cold of [true, false]) {
        const h = hostHarness(), c = child(); c.scope.notifyHostConversation('ready');
        const ready = c.posts.find(row => row.type === 'ready');
        if (cold) {
            h.scope.runtimeColdPending = true;
            h.scope.runtimeColdFlight = { epoch: 1, owner: 'synthetic-owner', token: 'synthetic-bind', appId: 'synthetic-card', conversationId: 'synthetic-chat' };
            ready.bootstrap_token = 'synthetic-bind';
        }
        h.scope.handleRuntimeMessage({ origin: 'https://synthetic.invalid', source: h.scope.frame.contentWindow, data: ready });
        assert.equal(h.scope.runtimeReady, true);
        assert.equal(h.scope.runtimeState.models[0].group_name, 'Synthetic group');
        assert.deepEqual(h.effects.find(row => Array.isArray(row) && row[0] === 'flush'), ['flush', 'Synthetic public name', false]);
        assert.equal(h.scope.previewInput.value, 'synthetic draft');
        assert.equal(h.normalized.length, 0); assert.equal(h.cacheWrites.length, 0);
    }
});

test('actual cold ACK rejects foreign source, wrong token/owner/epoch or target before any controls adoption', () => {
    for (const mutate of [
        (h, event) => { event.origin = 'https://foreign.invalid'; },
        (h, event) => { event.source = {}; },
        (h, event) => { event.data.bootstrap_token = 'old-token'; },
        h => { h.scope.runtimeColdFlight.owner = 'old-owner'; },
        h => { h.scope.runtimeColdFlight.epoch = 0; },
        (h, event) => { event.data.app_id = 'other-card'; },
        h => { h.scope.runtimeAccountBlocked = true; },
    ]) {
        const h = hostHarness(), c = child(); c.scope.notifyHostConversation('ready');
        h.scope.runtimeColdPending = true;
        h.scope.runtimeColdFlight = { epoch: 1, owner: 'synthetic-owner', token: 'synthetic-bind', appId: 'synthetic-card', conversationId: 'synthetic-chat' };
        const ready = { ...c.posts.find(row => row.type === 'ready'), bootstrap_token: 'synthetic-bind' };
        const event = { origin: 'https://synthetic.invalid', source: h.scope.frame.contentWindow, data: ready };
        mutate(h, event); h.scope.handleRuntimeMessage(event);
        assert.equal(h.scope.runtimeReady, false); assert.equal(h.scope.runtimeState, null);
        assert.equal(h.effects.length, 0); assert.equal(h.normalized.length, 0); assert.equal(h.cacheWrites.length, 0);
    }
});

test('actual reused prewarm bind and later switch receiver keep the document capability without a new navigation', async () => {
    const nativeHost = hostHarness(), prewarmUrl = nativeHost.scope.runtimeTarget('', '');
    const h = child({ runtimeUrl: prewarmUrl.href }), consumed = [];
    Object.assign(h.scope, { prewarmOnly: true, coreAvailable: true, bridgeStartScheduled: false, requestedAppId: '', requestedConversationId: '', boundBootstrapToken: '',
        async startHomerBridge() { consumed.push([h.scope.requestedAppId, h.scope.requestedConversationId]); },
        async switchConversation(conversation) { consumed.push([conversation.app_id, conversation.id]); },
    });
    const send = data => h.scope.receiveHostCommand({ origin: 'https://synthetic.invalid', source: h.scope.window.parent,
        data: { channel: 'homer:dialogue-host:v1', version: 1, ...data } });
    await send({ type: 'bind-conversation', app_id: 'synthetic-card', conversation_id: 'synthetic-chat', bootstrap_token: 'synthetic-bind' });
    h.scope.notifyHostConversation('ready');
    await send({ type: 'switch-conversation', app_id: 'synthetic-card-b', conversation_id: 'synthetic-chat-b' });
    h.bind('synthetic-owner', 'synthetic-card-b', 'synthetic-chat-b'); h.scope.notifyHostConversation('ready');
    assert.deepEqual(consumed, [['synthetic-card', 'synthetic-chat'], ['synthetic-card-b', 'synthetic-chat-b']]);
    assert.equal(h.posts.filter(row => row.type === 'ready' && row.control_state).length, 2);
    assert.equal(h.idles.size, 1); assert.equal(h.timers.size, 0);
});

test('controls with invalid scope or shape cause an immediate authoritative request, never empty messages persistence', () => {
    for (const change of [c => { c.app_id = 'wrong'; }, c => { c.conversation_id = 'wrong'; }, c => { c.models = null; }, c => { c.generating = null; }, c => { c.admin_preview = true; }]) {
        const h = hostHarness(), c = child(); c.scope.notifyHostConversation('ready');
        const controls = plain(c.posts.find(row => row.type === 'ready').control_state || {}); change(controls);
        h.scope.markReady('Synthetic role', { stateScheduled: true, controlState: controls });
        assert.equal(h.scope.runtimeState, null); assert.ok(h.commands.some(row => row.type === 'request-state'));
        assert.equal(h.normalized.length, 0); assert.equal(h.cacheWrites.length, 0);
    }
});

test('prewarm and selected native ordinary URL both opt in, while legacy/browser/admin URLs do not', () => {
    for (const native of [true, false]) for (const admin of [true, false]) {
        const h = hostHarness({ native, admin });
        for (const ids of [['', ''], ['synthetic-card', 'synthetic-chat']]) {
            const url = h.scope.runtimeTarget(...ids);
            assert.equal(url.searchParams.get('homer_idle_host_display'), native && !admin ? '1' : null);
        }
    }
});

test('legacy, non-opt-in and admin preserve original zero timer and ready shape', () => {
    for (const options of [{ native: false }, { admin: true }]) {
        const h = child(options); h.scope.notifyHostConversation('ready');
        assert.equal(h.posts.find(row => row.type === 'ready').control_state, undefined);
        assert.equal(h.idles.size, 0); assert.equal(h.timers.size, 1);
        assert.equal([...h.timers.values()][0].delay, 0);
        h.flushTimers(); assert.equal(h.states().length, 1);
    }
});

test('native final display has a bounded fallback without requestIdleCallback', () => {
    const h = child({ idle: false }); h.scope.notifyHostConversation('ready');
    assert.equal([...h.timers.values()][0].delay, 32);
    h.flushTimers(); assert.equal(h.states().length, 1);
});

test('immediate request and model feedback cancel old optional idle, with current data only', () => {
    for (const reason of ['requested', 'model-settings']) {
        const h = child({ reuse: true }); h.scope.notifyHostConversation('ready');
        const stale = h.idles.get(0)?.callback;
        h.context.chat[0].swipes = []; h.context.chat[0].mes = 'synthetic current edit';
        h.scope.notifyHostState(reason);
        assert.equal(h.idles.size, 0); assert.equal(h.states().length, 1);
        stale?.(); assert.equal(h.states().length, 1);
        assert.equal(h.states()[0].state.messages[0].content, 'synthetic current edit');
    }
});

test('ordinary edits, swipes, generation and restored failure retain their immediate original path', () => {
    for (const reason of ['message-edited', 'message-swiped', 'generation-started', 'generation-ended', 'conversation-switch-failed']) {
        const h = child(); h.scope.notifyHostConversation('ready');
        h.scope.scheduleHostStateNotify(0, reason);
        assert.equal(h.idles.size, 0); assert.equal([...h.timers.values()][0].delay, 0);
        h.flushTimers(); assert.equal(h.states()[0].reason, reason);
    }
    const h = child(); h.scope.notifyHostConversation('conversation-switch-failed');
    assert.equal(h.idles.size, 0); assert.equal([...h.timers.values()][0].delay, 0);
    const explicit = child(); explicit.scope.scheduleHostStateNotify(0, 'generation-started', { idleDisplay: true });
    assert.equal(explicit.idles.size, 0); assert.equal([...explicit.timers.values()][0].delay, 0);
});

test('late final display drops account ABA, target/document/engine changes without clearing a newer notification', () => {
    for (const change of [
        h => { h.scope.storageAccountEpoch++; },
        h => { h.setOwner('another-owner'); },
        h => { h.bind(); },
        h => { h.scope.launch.app_id = 'wrong'; },
        h => { h.scope.launch.admin_preview = true; },
        h => { h.scope.hostBootstrapEngineToken = 'new-engine'; },
        h => { h.scope.document.documentElement.dataset.homerBootstrapDocument = 'new-document'; },
    ]) {
        const h = child({ reuse: true }); h.scope.notifyHostConversation('ready');
        const old = h.idles.get(0)?.callback; change(h); h.flushIdle(); assert.equal(h.states().length, 0);
        h.bind(); h.scope.scheduleHostStateNotify(0, 'message-edited'); const token = h.scope.hostStateNotifyToken;
        old?.(); assert.equal(h.scope.hostStateNotifyToken, token); h.flushTimers(); assert.equal(h.states().length, 1);
    }
});

test('actual restored-failure host ACK stays on the immediate full-state path and never claims optional controls', () => {
    const h = hostHarness(), c = child();
    c.scope.notifyHostConversation('conversation-switch-failed', { failed_app_id: 'synthetic-card-b', failed_conversation_id: 'synthetic-chat-b' });
    assert.equal(c.idles.size, 0); assert.equal(c.posts.at(-1).control_state, undefined);
    h.scope.activeAppId = 'synthetic-card-b'; h.scope.activeConversationId = 'synthetic-chat-b';
    h.scope.showConversationSwitchShell = message => { h.scope.activeAppId = message.app_id; h.scope.activeConversationId = message.conversation_id; };
    h.scope.showToast = () => {};
    h.scope.pendingCommands = [];
    h.scope.handleRuntimeMessage({ origin: 'https://synthetic.invalid', source: h.scope.frame.contentWindow, data: c.posts.at(-1) });
    assert.equal(h.scope.runtimeReady, true); assert.equal(h.scope.activeConversationId, 'synthetic-chat');
    assert.equal(h.commands.at(-1)?.type, 'request-state');
    assert.equal(h.normalized.length, 0); assert.equal(h.cacheWrites.length, 0);
    c.scope.notifyHostState('requested'); c.flushTimers(); assert.equal(c.states().length, 1);
    assert.equal(c.states()[0].reason, 'requested');
});

test('reentrant immediate state never consumes newly scheduled work even with numeric ID zero reuse', () => {
    const h = child({ reuse: true }); h.scope.notifyHostConversation('ready');
    h.setPost(data => { if (data.type !== 'state') return; h.setPost(null); h.scope.scheduleHostStateNotify(0, 'message-edited'); });
    h.scope.notifyHostState('requested');
    assert.equal(h.idles.size, 0); assert.equal(h.timers.size, 1);
    h.flushTimers(); assert.equal(h.states().length, 2); assert.equal(h.states()[1].reason, 'message-edited');
});

test('generation remains immediate and skips optional message DOM, then final display reflects the new settled state', () => {
    const h = child(); h.scope.notifyHostConversation('ready'); h.scope.generationBusy = true;
    h.scope.scheduleHostStateNotify(0, 'generation-started'); h.flushTimers();
    assert.equal(h.idles.size, 0); assert.equal(h.reads(), 0); assert.equal(h.states()[0].state.generating, true);
    h.scope.generationBusy = false; h.scope.scheduleHostStateNotify(0, 'generation-ended'); h.flushTimers();
    assert.equal(h.states()[1].state.generating, false);
});

test('failed direct transport preserves queued optional work; constructor failure never promises unscheduled readiness', () => {
    const h = child(); h.scope.notifyHostConversation('ready');
    h.setPost(data => { if (data.type === 'state') throw Error('synthetic transport failure'); });
    assert.throws(() => h.scope.notifyHostState('requested'), /synthetic transport failure/);
    assert.equal(h.idles.size, 1); h.setPost(null); h.flushIdle(); assert.equal(h.states().length, 1);
    const failed = child(); failed.scope.window.requestIdleCallback = () => { throw Error('synthetic scheduler failure'); };
    assert.throws(() => failed.scope.notifyHostConversation('ready'), /synthetic scheduler failure/);
    assert.equal(failed.posts.some(row => row.type === 'ready'), false);
});

test('native exit/hidden best-effort requests current full state and flushes known cached display, not a fake new empty snapshot', () => {
    const h = hostHarness(); h.scope.runtimeReady = true;
    h.scope.flushOptionalHostDisplayCache();
    assert.equal(h.commands.at(-1)?.type, 'request-state'); assert.ok(h.effects.includes('cache-flush'));
    assert.equal(h.normalized.length, 0); assert.equal(h.cacheWrites.length, 0);
    const old = hostHarness({ native: false }); old.scope.runtimeReady = true; old.scope.flushOptionalHostDisplayCache();
    assert.equal(old.commands.length, 0); assert.ok(old.effects.includes('cache-flush'));
});
