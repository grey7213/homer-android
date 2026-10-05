import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createCardPreparationCache } from '../../sillytavern-runtime/public/scripts/homer-stable-template.mjs';
import { preloadStaticDialogueUi } from '../../sillytavern-runtime/public/scripts/homer-static-ui-preload.mjs';

// Reuse the established actual switch/recovery/activation fixture. No token,
// host queue, receive, bootstrap, notification or commit function is replaced.
// API/UI/IDB transaction promises below are controlled peripherals, not device
// timing or an independent proof of physical storage/authentication middleware.
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const recovery = fs.readFileSync(new URL('./mobile-r35-switch-recovery.test.mjs', import.meta.url), 'utf8');
const fixtureStart = recovery.indexOf('function section(');
const fixtureEnd = recovery.indexOf('async function switchTarget(h)', fixtureStart);
assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart, 'Existing recovery fixture boundaries');
const fixtureContext = vm.createContext({ assert, vm, bridge, script, URL });
vm.runInContext(recovery.slice(fixtureStart, fixtureEnd), fixtureContext);
console.log('Loaded current shipping source SHA256:', JSON.stringify({
    bridge: createHash('sha256').update(bridge).digest('hex'),
    core: createHash('sha256').update(script).digest('hex'),
}));

function section(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, 'Actual source boundaries: ' + start);
    return source.slice(first, last);
}
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function microtasks() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
const normalizerAt = bridge.indexOf('function normalizeBootstrapToken(');
const notifications = section(bridge, normalizerAt < 0 ? 'function notifyHostConversation(' : 'function normalizeBootstrapToken(', 'function canonicalDisplayTexts(');
const boundDeclaration = bridge.match(/^let boundBootstrapToken\s*=\s*[^;]+;/m)?.[0] || '';
const engineCapture = bridge.includes('const hostBootstrapEngineToken =')
    ? section(bridge, 'const hostBootstrapEngineToken =', 'let boundBootstrapToken') : '';
let documentNonce = 0;

function harness(options = {}) {
    const h = fixtureContext.fixture(options), scope = h.scope;
    const wire = [], reads = [], localWrites = [], uploads = [], lifecycle = [], gates = new Map();
    const completion = deferred();
    const parent = { postMessage(message, origin) {
        wire.push({ message: plain(message), origin });
        if (['ready', 'error'].includes(message.type)) completion.resolve(message.type);
    } };
    const nextSession = { user: { id: 'owner-a' }, launch: {
        app_id: 'card-b', conversation_id: 'conversation-b',
        card: { spec: 'chara_card_v2', data: { name: 'New', description: 'Fixture authored source', extensions: {} } },
    } };
    scope.window.parent = parent;
    scope.window.name = options.windowName || '';
    scope.window.location.origin = 'https://fixture.test';
    scope.window.addEventListener = () => {};
    scope.console.warn = (...args) => h.calls.push(['warn', args[0]]);
    scope.console.error = (...args) => h.calls.push(['error', args[0], args[1]?.message]);
    scope.console.debug = () => {};
    scope.document.documentElement = { dataset: {}, classList: { add: value => h.classSet.add(value) } };
    Object.assign(scope, {
        preloadStaticDialogueUi,
        HOST_CHANNEL: 'fixture-host-channel', requestedEmbed: '1', requestedHostChannel: 'fixture-host-channel', requestedIdleHostDisplay: false,
        safeSiteOrigin: () => 'https://fixture.test', prewarmOnly: true, coreAvailable: true,
        bridgeStartScheduled: false, launchSessionPreloadPromise: null, prewarmBootstrapPromise: null,
        sessionPrefetchCache: new Map(), sessionCacheKey: (app, conversation) => `${app}::${conversation}`,
        adminPreviewRequested: false, requestedAppId: '', requestedConversationId: '',
        applicationReady: true, applicationReadyPromise: Promise.resolve(), postApplicationReadyWork: Promise.resolve(),
        extensionSettingsReplayWork: Promise.resolve(), extensionSettingsBaseline: {},
        restoreScopeDraft: () => {}, currentRoleName: () => scope.characters[scope.this_chid]?.name || 'Fixture',
        scheduleHostStateNotify: (_delay, reason) => h.calls.push(['state-scheduled', reason]),
        installKeywordInjector: () => {}, saveConversationExtensionSettings: () => {}, logDialogueEvent: () => {},
        runtimeGate: () => null, setRuntimeGate: () => {}, releaseRuntimeGate: async () => {},
        captureExtensionSettingsBaseline: () => {}, installPresentationModeBridge: () => {},
        installRoleplayHubCompatibility: () => {}, installCardStageRuntime: () => {},
        renderPresetLists: () => {}, installEventHandlers: () => {}, installTavoConversationUi: async () => {},
        installMessageMenu: () => {}, positionContinuationControl: () => {}, loadConversationHistory: async () => {},
        requestAnimationFrame: () => {},
        DOMPurify: { sanitize: value => value },
        crypto: { randomUUID: () => `fixture-document-${++documentNonce}` },
        conversationModelSettings: () => ({ model_id: 'fixture-model' }),
        requestCachedCharacter: (avatar, { fetcher, headers }) => fetcher('/api/characters/get', {
            method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }),
        }),
        ensureAdministratorExtensions: async () => { lifecycle.push('extensions'); },
        fetchSession: async (app, conversation, preview) => {
            reads.push(['session', app, conversation, preview]);
            if (options.sessionFailure) throw Error('Fixture authenticated read failed');
            if (gates.has('session')) await gates.get('session').promise;
            return nextSession;
        },
        takePrefetchedSession: async (app, conversation) => {
            reads.push(['target-session', app, conversation]);
            if (options.getFailure) throw Error('Target GET failed');
            return nextSession;
        },
        chatOutbox: { prepare: async (snapshot, kind = 'chat') => {
            const record = { scope: snapshot.scope, kind, payload: plain(snapshot.payload), characterId: scope.this_chid };
            localWrites.push(record);
            if (gates.has(kind)) await gates.get(kind).promise;
            return { scope: snapshot.scope, kind, pending: true };
        } },
        cloudSyncQueue: { enqueue: async snapshot => { uploads.push(['chat', snapshot.scope]); } },
        extensionSyncQueue: { enqueue: async snapshot => { uploads.push(['extension-settings', snapshot.scope]); return { deferred: false }; } },
    });
    const originalUiRead = scope.loadRuntimeUiData, originalStateRead = scope.loadRuntimeState;
    scope.prepareRuntimeState = (app, conversation) => {
        const ticket = { app, conversation, kind: 'runtime-state' }; reads.push(['prepare-state', ticket]); return ticket;
    };
    scope.prepareRuntimeModels = (app, conversation) => {
        const ticket = { app, conversation, kind: 'models' }; reads.push(['prepare-models', ticket]); return ticket;
    };
    scope.loadRuntimeUiData = async ticket => { reads.push(['models', ticket]); await originalUiRead(ticket); };
    scope.loadRuntimeState = async (ticket, catalog) => {
        reads.push(['state', ticket, catalog]); await originalStateRead(ticket, catalog);
    };
    const originalClear = scope.clearChat;
    scope.clearChat = async config => {
        lifecycle.push(['clear', scope.this_chid, scope.getCurrentChatId(), plain(config)]);
        await originalClear(config);
    };
    const originalFetch = scope.fetch;
    let importedCard;
    scope.fetch = async (url, config) => {
        if (url === '/api/characters/get') {
            lifecycle.push('full-character-read');
            return { ok: Boolean(importedCard), status: importedCard ? 200 : 404, json: async () => plain(importedCard) };
        }
        return originalFetch(url, config);
    };
    const originalContext = scope.getContext;
    scope.getContext = () => ({ ...originalContext(), getOneCharacter: (...args) => scope.getOneCharacter(...args) });
    scope.cardPreparations = createCardPreparationCache();
    scope.importLaunchCardJson = async (value, name) => {
        lifecycle.push('card-import');
        importedCard = { name: value.name, avatar: name + '.png', chat: '', data: plain(value.data) };
        return importedCard.avatar;
    };
    scope.syncLaunchCharacterAvatar = async () => {};
    scope.enableEmbeddedCardCapabilities = () => {};
    scope.ensureEmbeddedWorldInfo = async () => { lifecycle.push('world'); };
    scope.installCsrfAjaxBridge = () => {};
    // Remove the old unmarked fixture target: actual import/addIfMissing creates
    // its canonical full card; actual activate/binder still checks its mirror.
    scope.characters.pop();
    vm.runInContext([
        boundDeclaration && !notifications.includes(boundDeclaration) ? boundDeclaration : '',
        section(bridge, 'function canNotifyHost()', 'const HOST_OVERLAY_SELECTOR'),
        notifications,
        engineCapture,
        section(bridge, 'async function receiveHostCommand(', "window.addEventListener('message',"),
        section(bridge, 'async function commitConversationBeforeSwitch(', 'async function syncCloudChat('),
        section(bridge, 'function cloneCardWithMarker(', 'async function waitForStableCharacterForm('),
        section(bridge, 'function prepareInitialCharacterRead(', 'function normalizeOpeningMessage('),
        section(bridge, 'async function openLaunchCharacterChat(', 'function getManagedCoverUrl('),
        section(script, 'const preparedCharacterReads =', 'export function getCharacterSource(').replace(/^export /gm, ''),
        section(bridge, 'async function bootstrapLaunch(', 'async function startHomerBridge('),
        section(bridge, 'async function startHomerBridge(', 'export async function init('),
    ].join('\n'), scope);
    // Actual switch already comes from the reused fixture, but now calls these
    // actual notify/commit/import functions rather than its peripheral stubs.
    return { ...h, wire, reads, localWrites, uploads, lifecycle, gates, nextSession, completion,
        receive(type, token, extra = {}, transport = {}) {
            return scope.receiveHostCommand({ origin: 'https://fixture.test', source: parent,
                data: { channel: scope.HOST_CHANNEL, version: 1, type, app_id: 'card-b', conversation_id: 'conversation-b',
                    ...(token === undefined ? {} : { bootstrap_token: token }), ...extra }, ...transport });
        },
        switch(token) { return scope.switchConversation({ app_id: 'card-b', id: 'conversation-b' }, token); },
        messages(type) { return wire.filter(item => item.message.type === type).map(item => item.message); },
    };
}

async function bound(h, token) {
    await h.receive('bind-conversation', token);
    await h.completion.promise;
    await microtasks();
    assert.equal(h.messages('ready').length, 1, 'Actual receive/start/bootstrap completes once: ' + JSON.stringify(h.calls.filter(item => item[0] === 'error')));
    return h.messages('ready')[0];
}

test('actual receive/start/bootstrap echoes a valid correlation token through actual notifications', async () => {
    for (const token of ['r12.document-1:flight_2', 'x'.repeat(80)]) {
        const h = harness(), message = await bound(h, token);
        assert.equal(message.bootstrap_token, token);
        assert.equal(message.app_id, 'card-b'); assert.equal(message.conversation_id, 'conversation-b');
        assert.equal(message.state_scheduled, true);
        assert.equal(h.wire.find(item => item.message === message)?.origin || h.wire.at(-1).origin, 'https://fixture.test');
        assert.equal(message.channel, 'fixture-host-channel'); assert.equal(message.version, 1);
        assert.equal(h.scope.loadingLaunch, false); assert.equal(h.scope.hasCanonicalConversationScope(), true);
    }
});

test('a missing token retains ordinary old-host startup without an added token property', async () => {
    const h = harness(), message = await bound(h);
    assert.equal(Object.hasOwn(message, 'bootstrap_token'), false);
    assert.deepEqual(h.reads.filter(item => item[0] === 'session'), [['session', 'card-b', 'conversation-b', false]]);
    assert.deepEqual(h.lifecycle.filter(item => ['full-character-read', 'card-import'].includes(item)),
        ['full-character-read', 'card-import', 'full-character-read'],
        'A cold mirror probes once (404), imports the target, then reads its complete metadata');
    assert.equal(h.lifecycle.filter(item => item === 'world').length, 1);
    const clear = h.lifecycle.find(item => Array.isArray(item) && item[0] === 'clear');
    assert.deepEqual(clear, ['clear', '0', 'Homer-conversation-a', { clearData: true, preserveItemizedPrompts: true }]);
    assert.ok(h.calls.some(item => item[0] === 'prompts' && item[1] === 'Homer-conversation-b'));
    assert.ok(h.events.some(item => item[0] === 'chat-loaded' && item[1] === 'Homer-conversation-b'));
});

test('invalid-present token values execute the legacy path and are never echoed or coerced', async () => {
    for (const token of [null, false, 0, {}, [], '', ' ', 'a'.repeat(81), '非ASCII', 'a/b', 'a?b', 'a\n', 'a\u0000']) {
        const h = harness(), message = await bound(h, token);
        assert.equal(Object.hasOwn(message, 'bootstrap_token'), false, 'Invalid token is not an authorization rejection or string coercion');
        assert.equal(h.reads.filter(item => item[0] === 'session').length, 1);
    }
});

test('a later bind cannot overwrite the accepted token or start another bootstrap during its fresh read', async () => {
    const h = harness(), session = deferred(); h.gates.set('session', session);
    await h.receive('bind-conversation', 'first-token'); await microtasks();
    await h.receive('bind-conversation', 'second-token', { app_id: 'card-c', conversation_id: 'conversation-c' });
    assert.equal(h.reads.filter(item => item[0] === 'session').length, 1);
    assert.equal(h.scope.requestedAppId, 'card-b'); assert.equal(h.messages('ready').length, 0);
    session.resolve(); await h.completion.promise; await microtasks();
    assert.equal(h.messages('ready')[0]?.bootstrap_token, 'first-token');
    assert.equal(h.messages('ready').length, 1);
});

test('origin/source/channel/version checks remain authoritative despite a valid token', async () => {
    for (const transport of [{ origin: 'https://other.test' }, { source: {} },
        { data: { channel: 'wrong', version: 1, type: 'bind-conversation', bootstrap_token: 'valid' } },
        { data: { channel: 'fixture-host-channel', version: 2, type: 'bind-conversation', bootstrap_token: 'valid' } }]) {
        const h = harness(); await h.receive('bind-conversation', 'valid', {}, transport); await microtasks();
        assert.equal(h.reads.length, 0); assert.equal(h.wire.length, 0); assert.equal(h.scope.bridgeStartScheduled, false);
    }
});

for (const failure of ['sessionFailure', 'configurationFailure']) {
    test(`${failure} sends a token-scoped actual error without a false success ACK`, async () => {
        const h = harness({ [failure]: true }); await h.receive('bind-conversation', 'failed-flight'); await h.completion.promise; await microtasks();
        assert.equal(h.messages('ready').length, 0); assert.equal(h.messages('error').length, 1);
        assert.equal(h.messages('error')[0].bootstrap_token, 'failed-flight');
        assert.equal(h.messages('error')[0].code, 'DIALOGUE_START_FAILED');
        assert.equal(h.scope.loadingLaunch, false);
    });
}

for (const first of ['chat', 'extension-settings']) {
    test(`actual switch ACK waits for both old-scope durable writes when ${first} completes first`, async () => {
        const h = harness(), chat = deferred(), settings = deferred();
        h.gates.set('chat', chat); h.gates.set('extension-settings', settings);
        const switched = h.receive('switch-conversation', 'switch-flight');
        await microtasks();
        assert.equal(h.localWrites.length, 2); assert.equal(h.messages('ready').length, 0);
        assert.equal(h.scope.launch, h.previousSession.launch); assert.equal(h.lifecycle.length, 0);
        assert.deepEqual(h.localWrites.map(item => [JSON.parse(item.scope), item.kind, item.characterId]), [
            [['owner-a', 'card-a', 'conversation-a'], 'chat', '0'],
            [['owner-a', 'card-a', 'conversation-a'], 'extension-settings', '0'],
        ]);
        assert.equal(h.localWrites[0].payload.messages[0].mes, h.oldMessage.mes);
        assert.deepEqual(h.localWrites[0].payload.messages[0].swipes, plain(h.oldMessage.swipes));
        (first === 'chat' ? chat : settings).resolve(); await microtasks();
        assert.equal(h.messages('ready').length, 0); assert.equal(h.scope.launch, h.previousSession.launch);
        (first === 'chat' ? settings : chat).resolve(); await switched;
        assert.equal(h.messages('ready')[0]?.bootstrap_token, 'switch-flight');
        assert.equal(h.messages('ready').length, 1); assert.equal(h.scope.hasCanonicalConversationScope(), true);
        assert.equal(h.uploads.length, 2);
        assert.deepEqual(h.reads.filter(item => item[0].startsWith('prepare')).map(item => [item[0], item[1].app, item[1].conversation]), [
            ['prepare-state', 'card-b', 'conversation-b'], ['prepare-models', 'card-b', 'conversation-b'],
        ]);
        assert.equal(h.reads.find(item => item[0] === 'state')[1], h.reads.find(item => item[0] === 'prepare-state')[1]);
        assert.equal(h.reads.find(item => item[0] === 'models')[1], h.reads.find(item => item[0] === 'prepare-models')[1]);
    });
}

test('direct actual switch accepts its optional second token argument and leaves tokenless legacy compatible', async () => {
    for (const token of ['direct-flight', undefined, 'invalid/token']) {
        const h = harness(); await h.switch(token);
        const ack = h.messages('ready')[0]; assert.ok(ack, JSON.stringify(h.calls.filter(item => item[0] === 'error')));
        if (token === 'direct-flight') assert.equal(ack.bootstrap_token, token);
        else assert.equal(Object.hasOwn(ack, 'bootstrap_token'), false);
        assert.equal(h.scope.hasCanonicalConversationScope(), true);
    }
});

for (const flag of ['generationBusy', 'rollbackBusy', 'adminBinding', 'loadingLaunch']) {
    test(`a valid token cannot bypass ${flag} or begin target reads/durable writes`, async () => {
        const h = harness(); h.scope[flag] = true; await h.receive('switch-conversation', 'busy-flight');
        assert.equal(h.scope.launch, h.previousSession.launch); assert.equal(h.reads.length, 0);
        assert.equal(h.localWrites.length, 0); assert.equal(h.messages('ready').length, 0);
        if (flag === 'loadingLaunch') assert.equal(h.messages('conversation-switch-failed').length, 0);
        else assert.equal(h.messages('conversation-switch-failed')[0]?.bootstrap_token, 'busy-flight');
    });
}

test('invalid canonical state cannot produce a successful token ACK or durable writes', async () => {
    const h = harness(); h.scope.chat_metadata.homer_bridge.conversation_id = 'wrong-conversation';
    await h.receive('switch-conversation', 'canonical-flight');
    assert.equal(h.localWrites.length, 0); assert.equal(h.reads.length, 0);
    assert.equal(h.messages('ready').length, 0); assert.equal(h.messages('conversation-switch-failed').length, 0);
    assert.equal(h.scope.conversationRecoveryBlocked, true);
    assert.equal(h.messages('error')[0]?.bootstrap_token, 'canonical-flight');
});

for (const failure of ['getFailure', 'configurationFailure', 'pluginFailure']) {
    test(`${failure} recovery echoes the failed attempt token only after restoring old canonical state`, async () => {
        const h = harness({ [failure]: true }); await h.receive('switch-conversation', 'recovery-flight');
        const ack = h.messages('conversation-switch-failed')[0]; assert.ok(ack);
        assert.equal(ack.bootstrap_token, 'recovery-flight'); assert.equal(ack.app_id, 'card-a');
        assert.equal(ack.conversation_id, 'conversation-a'); assert.equal(ack.failed_app_id, 'card-b');
        assert.equal(ack.failed_conversation_id, 'conversation-b'); assert.equal(ack.state_scheduled, true);
        assert.equal(h.messages('ready').length, 0); assert.equal(h.scope.hasCanonicalConversationScope(), true);
        if (failure === 'pluginFailure') {
            assert.deepEqual(plain(h.scope.chat), plain([h.oldMessage]));
            assert.ok(h.events.some(item => item[0] === 'chat-loaded' && item[1] === 'Homer-conversation-a'));
        }
    });
}

for (const accountCase of ['owner-change', 'same-owner-relogin']) {
    test(`${accountCase} during actual durable leave blocks old-scope recovery and successful token ACKs`, async () => {
        const h = harness(), chat = deferred(), settings = deferred();
        h.gates.set('chat', chat); h.gates.set('extension-settings', settings);
        const switched = h.receive('switch-conversation', 'old-account-flight'); await microtasks();
        if (accountCase === 'owner-change') h.scope.owner = 'owner-b';
        h.scope.storageAccountEpoch++;
        chat.resolve(); settings.resolve(); await switched;
        assert.equal(h.scope.conversationRecoveryBlocked, true);
        assert.equal(h.messages('ready').length, 0); assert.equal(h.messages('conversation-switch-failed').length, 0);
        assert.equal(h.uploads.length, 0); assert.equal(h.lifecycle.length, 0);
        assert.equal(h.messages('error')[0]?.bootstrap_token, 'old-account-flight');
    });
}

test('recovery failure does not turn a correlation token into restored usability', async () => {
    const h = harness({ pluginFailure: true, recoveryPluginFailure: true });
    await h.receive('switch-conversation', 'blocked-flight');
    assert.equal(h.scope.conversationRecoveryBlocked, true);
    assert.equal(h.messages('ready').length, 0); assert.equal(h.messages('conversation-switch-failed').length, 0);
    assert.equal(h.messages('error')[0]?.bootstrap_token, 'blocked-flight');
});

async function engineHarness(name) {
    assert.ok(engineCapture, 'Actual shipping module has the one-time engine capture');
    const h = harness({ windowName: name }), callbacks = new Map();
    h.scope.initialized = false;
    h.scope.window.addEventListener = (type, callback) => callbacks.set(type, callback);
    h.scope.eventSource.once = (type, callback) => h.handlers.set(type, callback);
    Object.assign(h.scope, {
        installProductSurfaceBoundary: () => {}, installEmbeddedComposerPolicy: () => {},
        ensureHomerExtensionSettingDefaults: () => {}, installExtensionSettingsPersistenceBridge: () => {},
        installEmbeddedDocumentLookupBridge: () => {},
        prepareTavoConversationUi: () => Promise.resolve(),
    });
    vm.runInContext(section(bridge, 'function beginSharedPrewarm()', 'async function preferLocalSession(')
        + bridge.slice(bridge.indexOf('export async function init(')).replace(/^export /gm, ''), h.scope);
    await h.scope.init();
    const core = callbacks.get('homer:runtime-core-ready'); assert.equal(typeof core, 'function');
    return { ...h, core };
}

test('actual evaluated module keeps its captured engine token after the frame name changes for retry', async () => {
    const old = await engineHarness('homer-bootstrap:engine-old');
    old.scope.window.name = 'homer-bootstrap:engine-new'; old.core();
    assert.equal(old.messages('core-ready')[0]?.engine_token, 'engine-old');
    const fresh = await engineHarness('homer-bootstrap:engine-new'); fresh.core();
    assert.equal(fresh.messages('core-ready')[0]?.engine_token, 'engine-new');
    assert.equal(old.reads.length, 0); assert.equal(fresh.reads.length, 0);
    assert.equal(old.lifecycle.includes('card-import'), false); assert.equal(fresh.lifecycle.includes('card-import'), false);
});

test('actual core-ready sender accepts the token boundary and treats invalid frame names as legacy only', async () => {
    const valid = await engineHarness('homer-bootstrap:' + 'x'.repeat(80)); valid.core();
    assert.equal(valid.messages('core-ready')[0]?.engine_token, 'x'.repeat(80));
    for (const name of ['', 'ordinary-frame', 'homer-bootstrap:', 'homer-bootstrap:' + 'x'.repeat(81),
        'homer-bootstrap:a/b', 'homer-bootstrap:非ASCII', 'homer-bootstrap:a\n']) {
        const h = await engineHarness(name); h.core();
        assert.equal(h.messages('core-ready').length, 1);
        assert.equal(h.messages('core-ready')[0].engine_token || '', '');
        assert.equal(h.reads.length, 0); assert.equal(h.scope.bridgeStartScheduled, false);
    }
});

test('actual per-module document capture writes its dataset and echoes that immutable identity from core-ready', async () => {
    const old = await engineHarness('homer-bootstrap:shared-engine');
    const oldDocument = old.scope.document.documentElement.dataset.homerBootstrapDocument;
    assert.equal(typeof oldDocument, 'string'); assert.ok(oldDocument);
    old.scope.window.name = 'homer-bootstrap:retry-engine'; old.core();
    assert.equal(old.messages('core-ready')[0].document_token, oldDocument);
    const fresh = await engineHarness('homer-bootstrap:shared-engine'); fresh.core();
    const freshDocument = fresh.scope.document.documentElement.dataset.homerBootstrapDocument;
    assert.notEqual(freshDocument, oldDocument);
    assert.equal(fresh.messages('core-ready')[0].document_token, freshDocument);
    assert.equal(fresh.messages('core-ready')[0].engine_token, 'shared-engine');
    const legacy = await engineHarness('ordinary-frame'); legacy.core();
    assert.equal(Object.hasOwn(legacy.scope.document.documentElement.dataset, 'homerBootstrapDocument'), false);
    assert.equal(legacy.reads.length, 0);
});

test('a captured engine token cannot bypass actual notification origin/embed guards or grant a launch', async () => {
    for (const mutation of [h => { h.scope.requestedEmbed = '0'; }, h => { h.scope.safeSiteOrigin = () => 'https://other.test'; }]) {
        const h = await engineHarness('homer-bootstrap:engine-valid'); mutation(h); h.core();
        assert.equal(h.messages('core-ready').length, 0); assert.equal(h.reads.length, 0);
        assert.equal(h.scope.bridgeStartScheduled, false); assert.equal(h.messages('ready').length, 0);
    }
});

test('capture occurs at module evaluation, not document creation: a changed name before evaluation is not distinguishable', async () => {
    // Deliberate causal limitation, not a browser navigation simulation: if an
    // old document evaluates the module only after the host changed frame.name,
    // the actual capture can see the new token. Host same-WindowProxy acceptance
    // tests cover matching; this VM must not be reported as full document identity.
    const h = await engineHarness('homer-bootstrap:already-changed'); h.core();
    assert.equal(h.messages('core-ready')[0]?.engine_token, 'already-changed');
});
