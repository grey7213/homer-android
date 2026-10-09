import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sanitizeRuntimeValue } from '../../sillytavern-runtime/public/scripts/homer-local-runtime.mjs';
import { createStoryStore } from '../../frontend/app/assets/js/visual-novel-story-store.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';
import { capturePromptMessageState } from '../../sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';

const stageSource = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/card-stage.js', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Shipping source boundaries exist: ${start}`);
    return source.slice(first, last);
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// Execute the shipping stage and bridge functions. Only DOM, module loading,
// generation and account data are synthetic; this is not a browser/device test.
class Node {
    constructor(tag = 'div') {
        this.tagName = tag; this.children = []; this.parent = null; this.dataset = {};
        this.attributes = new Map(); this.listeners = new Map(); this.hidden = false;
        this.style = { setProperty() {}, removeProperty() {} };
        const classes = new Set();
        this.classList = { add: (...values) => values.forEach(value => classes.add(value)),
            remove: (...values) => values.forEach(value => classes.delete(value)), contains: value => classes.has(value) };
    }
    get isConnected() { return this.tagName === 'body' || this.parent?.isConnected === true; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of nodes.reverse()) { node.remove(); node.parent = this; this.children.unshift(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    querySelectorAll() { return []; }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
    dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); return true; }
}

function stageFixture({ config = {}, search = '', importGate = null, mountGate = null } = {}) {
    const body = new Node('body'), document = new Node('document');
    document.body = body; document.documentElement = new Node('html');
    document.createElement = tag => new Node(tag);
    document.getElementById = id => body.children.find(node => node.id === id) || null;
    document.querySelector = () => null;
    let owner = 'owner-a', epoch = 1;
    const character = { name: 'Synthetic role', data: { extensions: { homer_card_experience: config } } };
    const context = { characterId: 0, chatId: 'Homer-conversation-a', characters: [character], chat: [],
        chatMetadata: { homer_bridge: { user_id: owner, app_id: 'app-a', conversation_id: 'conversation-a' } } };
    const calls = { imports: 0, mounts: [], updates: [], busy: [], views: [], visibility: [], destroyed: 0, legacyMounts: 0, legacyConsumed: [] };
    const reader = { update: messages => calls.updates.push(messages), setBusy: value => calls.busy.push(value),
        setView: value => calls.views.push(value), setHostVisible: value => calls.visibility.push(value), closeTopOverlay: () => true, destroy: () => { calls.destroyed++; } };
    const archiveModule = { async mountVisualNovel(options) {
        calls.mounts.push(options);
        if (mountGate) await mountGate.promise;
        return reader;
    } };
    const handlers = new Map(), timerCallbacks = [];
    const eventNames = ['CHAT_CHANGED', 'CHAT_LOADED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
        'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED',
        'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED'];
    const storage = new Map();
    const sandbox = {
        document, URLSearchParams, console, Event,
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        window: { location: { search, origin: 'https://synthetic.invalid' },
            setTimeout: callback => { timerCallbacks.push(callback); return timerCallbacks.length; }, clearTimeout() {} },
        sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        getContext: () => context,
        event_types: Object.fromEntries(eventNames.map(name => [name, name])),
        eventSource: { on: (name, callback) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(callback); } },
        async loadArchiveRuntime() { calls.imports++; if (importGate) await importGate.promise; return archiveModule; },
        async loadLegacyRuntime() { return { destroyCardExperience() {},
            mountCardExperience: () => { calls.legacyMounts++; },
            consumeCardExperienceText: value => calls.legacyConsumed.push(value) }; },
    };
    sandbox.window.parent = sandbox.window;
    const executable = stageSource.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
        .replace(/import\('\/app\/assets\/js\/visual-novel-runtime\.mjs\?[^']+'\)/, 'loadArchiveRuntime()')
        .replace(/import\('\/app\/assets\/js\/card-experience-runtime\.mjs\?[^']+'\)/, 'loadLegacyRuntime()');
    assert.ok(executable.includes('archiveRuntimePromise ||= loadArchiveRuntime()'));
    vm.createContext(sandbox); vm.runInContext(executable, sandbox);
    sandbox.installCardStageRuntime({ captureScope: () => {
        const capturedOwner = owner, capturedEpoch = epoch;
        return { scope: Object.freeze({ owner, appId: 'app-a', conversationId: 'conversation-a' }),
            isCurrent: () => owner === capturedOwner && epoch === capturedEpoch };
    }, isBusy: () => false });
    return { context, character, calls, body, document, reader, sandbox, api: sandbox.window.__homerCardStageRuntime,
        emit: (name, ...args) => { for (const callback of handlers.get(name) || []) callback(...args); },
        changeOwner(value) { owner = value; epoch++; context.chatMetadata.homer_bridge.user_id = value;
            document.dispatchEvent(new sandbox.CustomEvent('homer-presentation-invalidated')); },
    };
}

test('ordinary cards remain tavern and import no visual reader until explicit archive request', async () => {
    const h = stageFixture();
    await h.api.refresh();
    assert.equal(h.api.presentationMode(), 'tavern');
    assert.equal(h.calls.imports, 0);
    assert.equal(h.calls.legacyMounts, 0);
    assert.equal(await h.api.setPresentationMode('archive_vn'), true);
    assert.equal(h.api.presentationMode(), 'archive_vn');
    assert.equal(h.calls.mounts.length, 1);
    assert.equal(h.calls.legacyMounts, 0);
    assert.equal(h.document.getElementById('homerVisualNovelRoot').getAttribute('data-homer-overlay-active'), 'true');
});

test('ordinary native visibility keeps VN unimported and passes hidden state to a later explicit lazy mount', async () => {
    const h = stageFixture(); await h.api.refresh();
    h.document.dispatchEvent(new h.sandbox.CustomEvent('homer-presentation-visibility', { detail: { visible: false, isCurrent: () => true } }));
    assert.equal(h.calls.imports, 0); assert.equal(h.calls.mounts.length, 0); assert.deepEqual(h.calls.visibility, []);
    await h.api.setPresentationMode('archive_vn');
    assert.equal(h.calls.mounts[0].hostVisible, false); assert.deepEqual(h.calls.visibility, [false]);
    h.document.dispatchEvent(new h.sandbox.CustomEvent('homer-presentation-visibility', { detail: { visible: true, isCurrent: () => true } }));
    assert.deepEqual(h.calls.visibility, [false, true]); assert.equal(h.calls.mounts.length, 1);
});

test('native hidden during a pending import mounts only a suspended reader when that same scope completes', async () => {
    const gate = deferred(), h = stageFixture({ importGate: gate });
    const opening = h.api.setPresentationMode('archive_vn'); await Promise.resolve();
    h.document.dispatchEvent(new h.sandbox.CustomEvent('homer-presentation-visibility', { detail: { visible: false, isCurrent: () => true } }));
    gate.resolve(); assert.equal(await opening, true);
    assert.equal(h.calls.mounts[0].hostVisible, false); assert.deepEqual(h.calls.visibility, [false]);
});

test('late reader initialization receives the newest physical visibility and stale scope events cannot change it', async () => {
    const gate = deferred(), h = stageFixture({ mountGate: gate });
    const opening = h.api.setPresentationMode('archive_vn');
    for (let turn = 0; turn < 8 && !h.calls.mounts.length; turn++) await Promise.resolve();
    h.document.dispatchEvent(new h.sandbox.CustomEvent('homer-presentation-visibility', { detail: { visible: false, isCurrent: () => true } }));
    h.document.dispatchEvent(new h.sandbox.CustomEvent('homer-presentation-visibility', { detail: { visible: true, isCurrent: () => false } }));
    gate.resolve(); assert.equal(await opening, true); assert.deepEqual(h.calls.visibility, [false]);
    h.changeOwner('owner-b');
    h.document.dispatchEvent(new h.sandbox.CustomEvent('homer-presentation-visibility', { detail: { visible: true, isCurrent: () => false } }));
    assert.deepEqual(h.calls.visibility, [false]); assert.equal(h.calls.destroyed, 1);
});

test('archive receives the complete canonical messages and public card fields', async () => {
    const h = stageFixture();
    h.character.data.character_book = { entries: [{ content: 'PROTECTED-SYNTHETIC-WORLD' }] };
    const long = 'Complete synthetic reply. '.repeat(2000);
    h.context.chat.push({ mes: long, is_user: false, extra: { homer_sync_id: 'synthetic-reply-a' } });
    await h.api.setPresentationMode('archive_vn');
    const mount = h.calls.mounts[0];
    assert.equal(mount.messages, h.context.chat);
    assert.equal(mount.messages[0].mes, long);
    assert.equal(mount.scope.owner, 'owner-a');
    assert.deepEqual(Object.keys(mount.card).sort(), ['avatar', 'card_experience', 'media_assets', 'name']);
    assert.ok(!JSON.stringify(mount.card).includes('PROTECTED-SYNTHETIC-WORLD'));
    h.context.chat.push({ mes: 'Second reply', is_user: false });
    await h.sandbox.renderMessage(1);
    assert.equal(h.calls.updates.at(-1), h.context.chat);
});

test('existing visual_novel remains distinct and one reader replaces its presentation only', async () => {
    const h = stageFixture({ config: { galgame: { enabled: true, theme: 'archive' } } });
    await h.api.refresh();
    assert.equal(h.api.presentationMode(), 'visual_novel');
    assert.equal(h.calls.legacyMounts, 1);
    assert.equal(h.calls.imports, 0);
    await h.api.setPresentationMode('archive_vn');
    assert.equal(h.calls.mounts.length, 1);
    assert.equal(h.document.getElementById('homerCardExperienceRoot'), null);
    assert.equal(h.calls.legacyMounts, 1);
});

test('the one-use presentation query opens archive only after a canonical scope is available', async () => {
    const h = stageFixture({ search: '?presentation=archive_vn' });
    await h.api.refresh();
    assert.equal(h.api.presentationMode(), 'archive_vn');
    h.changeOwner('owner-b');
    await h.api.refresh();
    assert.equal(h.api.presentationMode(), 'tavern');
    assert.equal(h.calls.mounts.length, 1);
});

test('late module completion cannot mount a retired account even with reused chat array', async () => {
    const gate = deferred(), h = stageFixture({ importGate: gate });
    const opening = h.api.setPresentationMode('archive_vn');
    await Promise.resolve();
    h.changeOwner('owner-b');
    gate.resolve(); await opening;
    assert.equal(h.calls.mounts.length, 0);
    assert.equal(h.body.classList.contains('homer-vn-reader-active'), false);
});

test('late async reader completion destroys retired content and preserves the new tavern mode', async () => {
    const gate = deferred(), h = stageFixture({ mountGate: gate });
    const opening = h.api.setPresentationMode('archive_vn', { view: 'talk' });
    for (let turn = 0; turn < 5 && !h.calls.mounts.length; turn++) await Promise.resolve();
    assert.equal(h.calls.mounts.length, 1);
    await h.api.setPresentationMode('tavern');
    gate.resolve(); assert.equal(await opening, false);
    assert.equal(h.calls.destroyed, 1);
    assert.deepEqual(h.calls.views, []);
    assert.equal(h.document.getElementById('homerVisualNovelRoot'), null);
    assert.equal(h.api.presentationMode(), 'tavern');
});

test('scoped talk and stage requests reuse the mounted reader and ignore unknown views', async () => {
    const h = stageFixture();
    assert.equal(await h.api.setPresentationMode('archive_vn', { view: 'talk' }), true);
    assert.equal(await h.api.setPresentationMode('archive_vn', { view: 'stage' }), true);
    assert.equal(await h.api.setPresentationMode('archive_vn', { view: 'arbitrary-view' }), true);
    assert.equal(h.calls.mounts.length, 1);
    assert.deepEqual(h.calls.views, ['talk', 'stage']);
    h.changeOwner('owner-b');
    assert.equal(h.calls.destroyed, 1);
    assert.deepEqual(h.calls.views, ['talk', 'stage']);
});

test('busy notifications and Back use the same reader; account removal destroys it', async () => {
    const h = stageFixture();
    await h.api.setPresentationMode('archive_vn');
    h.emit('GENERATION_STARTED', 'normal', {}, true);
    assert.equal(h.calls.busy.at(-1), false);
    h.emit('GENERATION_STARTED', 'normal', {}, false);
    assert.equal(h.calls.busy.at(-1), true);
    h.document.dispatchEvent(new h.sandbox.CustomEvent('homer-presentation-runtime-state', { detail: { busy: false } }));
    assert.equal(h.calls.busy.at(-1), false);
    assert.equal(h.sandbox.closeCardStageOverlay(), true);
    h.changeOwner('owner-b');
    assert.equal(h.calls.destroyed, 1);
    assert.equal(h.sandbox.closeCardStageOverlay(), false);
    assert.equal(h.document.getElementById('homerVisualNovelRoot'), null);
});

function bridgeFixture({ refreshGate = null, story = null, confirmed = true, failBackup = false,
    failBatch = false, failPrint = false, backupGate = null, batchGate = null } = {}) {
    const calls = { send: 0, stop: 0, actions: [], settings: [], drafts: [], notices: [], events: [],
        saves: [], batches: [], uploads: [], print: 0, mirror: 0, updates: 0, blocked: 0, deleted: [] };
    const clone = value => JSON.parse(JSON.stringify(value));
    const context = { chat: [], chatMetadata: { homer_bridge: { user_id: 'owner-a', app_id: 'app-a', conversation_id: 'conversation-a' },
        integrity: 'synthetic-integrity', card_signature: 'synthetic-binding' }, chatId: 'Homer-conversation-a',
        async printMessages() { calls.print++; if (failPrint && calls.print === 1) throw new Error('synthetic render failure'); },
        async saveChat() { calls.mirror++; },
    };
    const stories = new Map(story ? [[story.id, clone(story)]] : []);
    const storyStore = {
        async save(scope, value) {
            calls.saves.push(clone({ scope, ...value }));
            if (backupGate) await backupGate.promise;
            if (failBackup) throw new Error('synthetic quota failure');
            const result = { ...clone(value), id: `story-${calls.saves.length}`, version: 1 };
            stories.set(result.id, result); return { id: result.id, name: result.name, messageCount: result.messages.length };
        },
        async list() { return [...stories.values()].map(value => ({ id: value.id, name: value.name, messageCount: value.messages.length })); },
        async get(scope, id) { return stories.has(id) ? clone(stories.get(id)) : null; },
        async delete(scope, id) { calls.deleted.push(id); return stories.delete(id); },
    };
    const sandbox = {
        session: { user: { id: 'owner-a' } }, launch: { app_id: 'app-a', conversation_id: 'conversation-a', bridge_token: 'SYNTHETIC-NON-CREDENTIAL' },
        storageAccountEpoch: 1, conversationRecoveryBlocked: false, loadingLaunch: false, generationBusy: false, rollbackBusy: false,
        owner: 'owner-a', canonical: true,
        getContext: () => ({ ...context, stopGeneration: () => { calls.stop++; } }),
        isGenerating: () => false, reconcileStorageAccount() { return sandbox.owner; },
        hasCanonicalConversationScope() { return sandbox.canonical; },
        assertCanonicalConversationScope() { assert.equal(sandbox.canonical, true); },
        scheduleHostStateNotify() {}, setComposerDraft: value => calls.drafts.push(value),
        async runAction(action) { calls.actions.push(action); },
        async refreshBridgeToken() { if (refreshGate) await refreshGate.promise; },
        showHostNotice: (...args) => calls.notices.push(args),
        openHostRequestedSettings: panel => calls.settings.push(panel), setDrawerOpen: side => calls.settings.push(side),
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        window: { clearTimeout() {}, __homerCardStageRuntime: { async updateMessages() { calls.updates++; } } },
        runtimeVariables: { syntheticProgress: 3 }, extension_settings: { syntheticExtension: { value: 4 } },
        conversationExtensionSettings: {}, suppressSync: false, extensionSettingsHydrating: false,
        syncTimer: null, extensionSettingsPersistTimer: null, extensionSettingsReplayWork: Promise.resolve(),
        lastSyncSignature: '', lastExtensionSettingsScope: '', lastExtensionSettingsSignature: '',
        cloneJsonObject: clone, cloneJsonValue: clone, sanitizeRuntimeValue, capturePromptMessageState,
        extensionSettingsSnapshot: () => ({ value: clone(sandbox.extension_settings), signature: JSON.stringify(sandbox.extension_settings) }),
        replaceExtensionSettings(value) { for (const key of Object.keys(sandbox.extension_settings)) delete sandbox.extension_settings[key]; Object.assign(sandbox.extension_settings, clone(value)); },
        cloudSyncScope: () => JSON.stringify([sandbox.owner, sandbox.launch.app_id, sandbox.launch.conversation_id]),
        extensionSettingsScope: () => `${sandbox.launch.app_id}\u0000${sandbox.launch.conversation_id}`,
        captureCloudSync: (scope, payload) => ({ scope, payload: clone(payload), body: JSON.stringify(payload) }),
        captureCurrentChatStorage: () => { const payload = { app_id: sandbox.launch.app_id, conversation_id: sandbox.launch.conversation_id,
            title: 'Synthetic role', messages: clone(context.chat) }; return { scope: sandbox.cloudSyncScope(), payload, body: JSON.stringify(payload) }; },
        async loadStoryStoreModule() { return { createStoryStore: () => storyStore }; },
        async confirmHomerAction() { return confirmed; },
        event_types: { SETTINGS_LOADED: 'SETTINGS_LOADED' }, eventSource: { async emit(name) { calls.events.push(name); } },
        chatOutbox: { async prepareBatch(entries, guard) {
            calls.batches.push(clone(entries));
            if (batchGate) await batchGate.promise;
            if (!guard()) throw new Error('synthetic stale scope');
            if (failBatch) throw new Error('synthetic batch quota failure');
            return entries.map((entry, index) => ({ pending: true, commitId: `synthetic-${index}` }));
        } },
        localSessions: { async rememberResource() {} },
        async syncCloudChatSnapshot(value) { calls.uploads.push({ kind: 'chat', value }); },
        extensionSyncQueue: { async enqueue(value) { calls.uploads.push({ kind: 'settings', value }); } },
        applyConnectionConfiguration() {}, queueMessageMenuRender() {},
        blockConversationRecovery() { calls.blocked++; sandbox.conversationRecoveryBlocked = true; },
        document: { dispatchEvent: event => calls.events.push(event),
            querySelector: () => ({ matches: () => false, click: () => { calls.send++; } }) },
    };
    vm.createContext(sandbox);
    vm.runInContext('const archivePresentationScopes = new WeakMap(); let archiveStoryStorePromise = null; let activeGameTurn = null; let activeArchiveGameId = ""; let archiveGameEpoch = 0;\n'
        + section(bridgeSource, 'function captureArchivePresentationScope(', 'function resolveChatStorageConflict(')
            .replace(/import\('\/app\/assets\/js\/visual-novel-story-store\.mjs\?[^']+'\)/, 'loadStoryStoreModule()'), sandbox);
    return { sandbox, calls, context, capture: () => sandbox.captureArchivePresentationScope(),
        action: (scope, action, payload = {}) => sandbox.receiveArchivePresentationAction({ scope, action, ...payload }) };
}

test('bridge rejects forged scopes, account epochs and unavailable canonical scope', async () => {
    const h = bridgeFixture(), ticket = h.capture();
    assert.equal(await h.action({ ...ticket.scope }, 'submit', { text: 'forged' }), false);
    h.sandbox.storageAccountEpoch++;
    assert.equal(ticket.isCurrent(), false);
    assert.equal(await h.action(ticket.scope, 'stop'), false);
    assert.equal(h.calls.stop, 0);
    h.sandbox.canonical = false;
    assert.equal(h.capture(), null);
});

test('reader submit/continue/stop/settings/exit reuse canonical product actions', async () => {
    const h = bridgeFixture(), { scope } = h.capture();
    assert.equal(await h.action(scope, 'submit', { text: 'Synthetic input' }), true);
    assert.equal(h.calls.send, 1);
    assert.equal(await h.action(scope, 'continue'), true);
    assert.deepEqual(h.calls.actions, ['next']);
    h.sandbox.generationBusy = true;
    assert.equal(await h.action(scope, 'submit', { text: 'Second input' }), false);
    assert.equal(await h.action(scope, 'stop'), true);
    assert.equal(h.calls.stop, 1);
    h.sandbox.generationBusy = false;
    assert.equal(await h.action(scope, 'settings', { panel: 'memory' }), true);
    assert.equal(await h.action(scope, 'settings', { panel: 'history' }), true);
    assert.equal(await h.action(scope, 'settings', { panel: 'arbitrary-code' }), false);
    assert.deepEqual(h.calls.settings, ['memory', 'left']);
    assert.equal(await h.action(scope, 'exit'), true);
    assert.equal(h.calls.events.at(-1).detail.mode, 'tavern');
});

test('token preparation finishing after a scope change never submits to the new conversation', async () => {
    const gate = deferred(), h = bridgeFixture({ refreshGate: gate }), { scope } = h.capture();
    h.sandbox.launch.bridge_token = '';
    const sending = h.action(scope, 'submit', { text: 'Old scoped draft' });
    await Promise.resolve();
    h.sandbox.launch = { app_id: 'app-b', conversation_id: 'conversation-b', bridge_token: 'SYNTHETIC-NON-CREDENTIAL' };
    gate.resolve();
    assert.equal(await sending, false);
    assert.equal(h.calls.send, 0);
});

const savedStory = () => ({ version: 1, id: 'saved-a', name: 'Synthetic chapter', messages: [{ name: 'Role', mes: 'Earlier plot',
    is_user: false, swipes: ['Earlier plot', 'Other plot'], swipe_id: 0, extra: { syntheticState: { score: 7 } } }],
    metadata: { variables: { chapter: 1 } }, variables: { syntheticProgress: 1 },
    extensionSettings: { syntheticExtension: { value: 1 } }, cursor: { messageId: 'synthetic-a', segment: 1 },
});

test('named story saves complete current messages, metadata, variables and extensions without bindings or recursive copies', async () => {
    const h = bridgeFixture(), { scope } = h.capture();
    const long = 'Complete synthetic plot. '.repeat(2500);
    h.context.chat.push({ mes: long, swipes: [long, 'Alternative synthetic plot'], swipe_id: 0, extra: { token_count: 5000 } });
    h.context.chatMetadata.variables = { chapter: 9, nested: { bridge_token: 'SYNTHETIC-REMOVED', integrity: 'not-restorable' } };
    h.sandbox.runtimeVariables.homer_story_metadata = { unwantedRecursion: {} };
    const result = await h.action(scope, 'save-story', { name: 'Synthetic full save', cursor: { segment: 4 } });
    assert.equal(result.messageCount, 1);
    const saved = h.calls.saves[0];
    assert.equal(saved.messages[0].mes, long);
    assert.deepEqual(saved.messages[0].swipes, [long, 'Alternative synthetic plot']);
    assert.equal(saved.messages[0].extra.token_count, 5000);
    assert.equal(saved.metadata.variables.chapter, 9);
    assert.deepEqual(saved.metadata.variables.nested, {});
    assert.equal(saved.metadata.homer_bridge, undefined);
    assert.equal(saved.metadata.integrity, undefined);
    assert.equal(saved.metadata.card_signature, undefined);
    assert.equal(saved.variables.homer_story_metadata, undefined);
    assert.deepEqual(saved.extensionSettings, { syntheticExtension: { value: 4 } });
    assert.equal(h.calls.batches.length, 0);
    assert.equal(h.calls.uploads.length, 0);
});

test('actual host snapshot satisfies the shipping complete-story store rather than a permissive mock', async () => {
    const h = bridgeFixture(), { scope } = h.capture();
    h.context.chat.push({ name: 'Synthetic role', mes: 'Complete stored plot', swipes: ['Complete stored plot', 'Alternate'],
        swipe_id: 0, extra: { homer_sync_id: 'synthetic-local', token_count: 9 } });
    h.context.chatMetadata.variables = { chapter: 2 };
    h.sandbox.extension_settings.STMemoryBooks = { moduleSettings: { maxTokens: 1024, tokenWarningThreshold: 800 } };
    const snapshot = h.sandbox.captureArchiveStory({ name: 'Actual shipping store' });
    const clone = value => JSON.parse(JSON.stringify(value));
    const store = createStoryStore({ indexedDB: cardTransportIDB() });
    const summary = await store.save(clone(scope), clone(snapshot));
    assert.equal(summary.id, snapshot.id);
    assert.equal(summary.messageCount, 1);
    const reopened = await store.get(clone(scope), summary.id);
    assert.equal(reopened.metadata.variables.chapter, 2);
    assert.equal(reopened.metadata.homer_bridge, undefined);
    assert.equal(reopened.extensionSettings.STMemoryBooks.moduleSettings.maxTokens, 1024);
    assert.deepEqual(reopened.messages[0].swipes, ['Complete stored plot', 'Alternate']);
    store.close();
});

test('confirmed full story restore backs up later plot and commits both kinds without replacing engine containers or bindings', async () => {
    const h = bridgeFixture({ story: savedStory() }), { scope } = h.capture();
    h.context.chat.push({ mes: 'Later plot never silently discarded', extra: { syntheticState: { score: 99 } } });
    h.context.chatMetadata.variables = { chapter: 8 };
    const chatRef = h.context.chat, metadataRef = h.context.chatMetadata, bindingRef = metadataRef.homer_bridge;
    const result = await h.action(scope, 'load-story', { id: 'saved-a' });
    assert.equal(result.id, 'saved-a');
    assert.equal(result.cursor.segment, 1);
    assert.equal(h.context.chat, chatRef);
    assert.equal(h.context.chatMetadata, metadataRef);
    assert.equal(metadataRef.homer_bridge, bindingRef);
    assert.equal(metadataRef.integrity, 'synthetic-integrity');
    assert.equal(metadataRef.card_signature, 'synthetic-binding');
    assert.equal(h.calls.saves[0].messages[0].mes, 'Later plot never silently discarded');
    assert.equal(h.calls.saves[0].metadata.variables.chapter, 8);
    assert.equal(h.context.chat[0].mes, 'Earlier plot');
    assert.equal(metadataRef.variables.chapter, 1);
    assert.equal(h.sandbox.runtimeVariables.syntheticProgress, 1);
    assert.equal(h.sandbox.extension_settings.syntheticExtension.value, 1);
    assert.deepEqual(h.calls.batches[0].map(value => value.kind), ['chat', 'extension-settings']);
    assert.equal(h.calls.uploads.length, 2);
    assert.equal(h.calls.print, 1);
    assert.equal(h.calls.mirror, 1);
    assert.equal(h.sandbox.rollbackBusy, false);
    assert.equal(h.sandbox.suppressSync, false);
});

test('cancelled restore and deletion keep full current plot and the named story', async () => {
    const h = bridgeFixture({ story: savedStory(), confirmed: false }), { scope } = h.capture();
    h.context.chat.push({ mes: 'Current plot' });
    assert.equal(await h.action(scope, 'load-story', { id: 'saved-a' }), false);
    assert.equal(await h.action(scope, 'delete-story', { id: 'saved-a' }), false);
    assert.equal(h.context.chat[0].mes, 'Current plot');
    assert.equal(h.calls.saves.length, 0);
    assert.equal(h.calls.batches.length, 0);
    assert.equal(h.calls.deleted.length, 0);
    assert.equal((await h.action(scope, 'list-stories')).length, 1);
});

for (const failure of ['failBackup', 'failBatch', 'failPrint']) {
    test(`${failure} leaves original complete plot and settings usable without an upload`, async () => {
        const h = bridgeFixture({ story: savedStory(), [failure]: true }), { scope } = h.capture();
        h.context.chat.push({ mes: 'Original complete plot', swipes: ['Original complete plot', 'Alternate'], swipe_id: 1 });
        h.context.chatMetadata.variables = { chapter: 8 };
        assert.equal(await h.action(scope, 'load-story', { id: 'saved-a' }), false);
        assert.equal(h.context.chat[0].mes, 'Original complete plot');
        assert.deepEqual(h.context.chat[0].swipes, ['Original complete plot', 'Alternate']);
        assert.equal(h.context.chatMetadata.variables.chapter, 8);
        assert.equal(h.sandbox.runtimeVariables.syntheticProgress, 3);
        assert.equal(h.sandbox.extension_settings.syntheticExtension.value, 4);
        assert.equal(h.calls.blocked, 0);
        assert.equal(h.calls.uploads.length, 0);
        assert.equal(h.sandbox.rollbackBusy, false);
        assert.equal(h.sandbox.extensionSettingsHydrating, false);
    });
}

test('account change during backup cannot replace or recover over the newly selected canonical plot', async () => {
    const gate = deferred(), h = bridgeFixture({ story: savedStory(), backupGate: gate }), { scope } = h.capture();
    h.context.chat.push({ mes: 'Original account plot' });
    const loading = h.action(scope, 'load-story', { id: 'saved-a' });
    for (let turn = 0; turn < 15 && !h.calls.saves.length; turn++) await Promise.resolve();
    assert.equal(h.calls.saves.length, 1);
    h.sandbox.storageAccountEpoch++;
    h.sandbox.owner = 'owner-b';
    h.sandbox.launch = { app_id: 'app-b', conversation_id: 'conversation-b' };
    h.context.chat.splice(0, h.context.chat.length, { mes: 'New account plot' });
    gate.resolve();
    assert.equal(await loading, false);
    assert.equal(h.context.chat[0].mes, 'New account plot');
    assert.equal(h.calls.batches.length, 0);
    assert.equal(h.calls.uploads.length, 0);
});

test('generation starting during lazy storage loading cannot capture a partial turn', async () => {
    const h = bridgeFixture(), { scope } = h.capture();
    const saving = h.action(scope, 'save-story', { name: 'Do not capture partial generation' });
    h.sandbox.generationBusy = true;
    assert.equal(await saving, false);
    assert.equal(h.calls.saves.length, 0);
});

test('presentation exit before atomic commit rolls back only its still-current canonical containers', async () => {
    const gate = deferred(), h = bridgeFixture({ story: savedStory(), batchGate: gate }), { scope } = h.capture();
    h.context.chat.push({ mes: 'Original plot before reader exit' });
    let presentationCurrent = true;
    const loading = h.action(scope, 'load-story', { id: 'saved-a', presentationCurrent: () => presentationCurrent });
    for (let turn = 0; turn < 30 && !h.calls.batches.length; turn++) await Promise.resolve();
    assert.equal(h.calls.batches.length, 1);
    presentationCurrent = false;
    gate.resolve();
    assert.equal(await loading, false);
    assert.equal(h.context.chat[0].mes, 'Original plot before reader exit');
    assert.equal(h.calls.blocked, 0);
    assert.equal(h.calls.uploads.length, 0);
});

test('checkpoint metadata survives IDs changing but does not overwrite metadata after transcript edits', async () => {
    const h = bridgeFixture({ story: savedStory() }), { scope } = h.capture();
    assert.ok(await h.action(scope, 'load-story', { id: 'saved-a' }));
    h.context.chat[0].extra.homer_message_id = 'synthetic-cloud-id';
    h.context.chatMetadata.variables = { chapter: 10 };
    h.sandbox.applyArchiveStoryMetadataState(h.context);
    assert.equal(h.context.chatMetadata.variables.chapter, 1);
    h.context.chat[0].mes = 'Edited later plot';
    h.context.chatMetadata.variables = { chapter: 11 };
    h.sandbox.applyArchiveStoryMetadataState(h.context);
    assert.equal(h.context.chatMetadata.variables.chapter, 11);
});

test('parent presentation requests require exact supplied canonical IDs and forward view', async () => {
    const events = [], parent = {};
    const sandbox = { window: { parent, location: { origin: 'https://synthetic.invalid' } },
        canNotifyHost: () => true, HOST_CHANNEL: 'homer-runtime',
        launch: { app_id: 'app-a', conversation_id: 'conversation-a' },
        assertCanonicalConversationScope() {},
        activeArchiveGameId: '', invalidateArchiveGame() {},
        captureArchivePresentationScope: () => ({ isCurrent: () => true }),
        document: { dispatchEvent: event => events.push(event) },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    };
    vm.createContext(sandbox);
    vm.runInContext(section(bridgeSource, 'async function receiveHostCommand(', "window.addEventListener('message',"), sandbox);
    const request = (data = {}, outer = {}) => sandbox.receiveHostCommand({
        origin: sandbox.window.location.origin, source: parent,
        data: { channel: 'homer-runtime', version: 1, type: 'presentation-mode', mode: 'archive_vn', view: 'talk',
            app_id: 'app-a', conversation_id: 'conversation-a', ...data }, ...outer,
    });
    await request();
    assert.equal(events.length, 1);
    assert.equal(events[0].detail.mode, 'archive_vn');
    assert.equal(events[0].detail.view, 'talk');
    for (const data of [{ app_id: 'app-b' }, { conversation_id: 'conversation-b' }, { app_id: ' app-a' },
        { conversation_id: 'conversation-a ' }, { app_id: null }, { conversation_id: 1 }]) await request(data);
    await request({}, { origin: 'https://foreign.invalid' });
    await request({}, { source: {} });
    assert.equal(events.length, 1);
    await sandbox.receiveHostCommand({ origin: sandbox.window.location.origin, source: parent,
        data: { channel: 'homer-runtime', version: 1, type: 'presentation-mode', mode: 'tavern' } });
    assert.equal(events.length, 2);
});

test('parent visibility requests require exact IDs and trusted parent then issue only a boolean and captured scope guard', async () => {
    const events = [], parent = {}; let owner = 'owner-a', epoch = 1;
    const sandbox = { window: { parent, location: { origin: 'https://synthetic.invalid' } },
        canNotifyHost: () => true, HOST_CHANNEL: 'homer-runtime', launch: { app_id: 'app-a', conversation_id: 'conversation-a' },
        captureArchivePresentationScope() { const capturedOwner = owner, capturedEpoch = epoch;
            return { isCurrent: () => capturedOwner === owner && capturedEpoch === epoch }; },
        document: { dispatchEvent: event => events.push(event) },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    };
    vm.createContext(sandbox);
    vm.runInContext(section(bridgeSource, 'async function receiveHostCommand(', "window.addEventListener('message',"), sandbox);
    const request = (data = {}, outer = {}) => sandbox.receiveHostCommand({ origin: sandbox.window.location.origin, source: parent,
        data: { channel: 'homer-runtime', version: 1, type: 'presentation-visibility', visible: false,
            app_id: 'app-a', conversation_id: 'conversation-a', ...data }, ...outer });
    await request(); assert.equal(events.length, 1); assert.equal(events[0].type, 'homer-presentation-visibility');
    assert.deepEqual(Object.keys(events[0].detail).sort(), ['isCurrent', 'visible']); assert.equal(events[0].detail.isCurrent(), true);
    for (const data of [{ app_id: 'app-b' }, { conversation_id: 'conversation-b' }, { app_id: ' app-a' },
        { conversation_id: null }, { app_id: 1 }, { visible: 'false' }]) await request(data);
    await request({}, { origin: 'https://foreign.invalid' }); await request({}, { source: {} });
    assert.equal(events.length, 1); owner = 'owner-b'; epoch++; assert.equal(events[0].detail.isCurrent(), false);
    await request({ visible: true }); assert.equal(events.length, 2); assert.equal(events[1].detail.isCurrent(), true);
});
