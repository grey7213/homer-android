import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

// The subject is shipping host code, not a replacement queue implementation.
// Surrounding UI rendering is inert; iframe writes and protocol sends are observed.
const source = readFileSync(new URL('../../.web-cache/tree/frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
console.log('Actual host SHA256:', createHash('sha256').update(source).digest('hex'));
function extract(begin, end) {
    const first = source.indexOf(begin), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Actual host source boundary: ${begin}`);
    return source.slice(first, last);
}
const actual = [
    extract('function prepareAdminCard(', "window.addEventListener('homer:prepare-admin-preview'"),
    extract('function bindPreparedAdminPreview(', 'function bindPreparedConversation('),
    extract('function bindPreparedConversation(', 'function openRuntimeTool('),
    extract('function normalizeRuntimeUrl(', 'function updateVisibleConversationUrl('),
    extract('function updateVisibleConversationUrl(', 'async function loadHistory('),
    extract('function acceptsRuntimeTransition(', 'function modelData('),
    extract('function showConversationSwitchShell(', 'function fail('),
    extract('function clearReadyTimer(', 'function setDocumentTitle('),
    extract('function postRuntimeCommand(', 'function visiblePreviewText('),
    extract('function fail(', 'function normalizeRuntimeUrl('),
    extract('async function resolveLaunchTarget(', 'function allowedNavigationPath('),
    extract('async function switchConversation(', 'async function start('),
    extract('async function start(', "window.addEventListener('message', handleRuntimeMessage)"),
    extract("window.addEventListener('homer-account-cleared'", 'const uiReady ='),
].join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness({ prewarming = false, runtimeReady = false, runtimeBound = false,
    href = prewarming ? 'http://fixture.invalid/app/chat.html?prewarm=1' : 'http://fixture.invalid/app/chat.html?app_id=fixture-a&conversation_id=fixture-chat-a',
    conversationsResponse = null, sessionResponse = null, autoCommitDocument = true } = {}) {
    const sent = [], frameWrites = [], frameNameWrites = [], shellTargets = [], notices = [], readyCalls = [], apiRequests = [], previews = [], adminCalls = [], nativeCalls = [];
    const listeners = new Map();
    const timers = new Map(); let nextTimerId = 0;
    let owner = 'fixture-owner';
    const origin = 'http://fixture.invalid';
    const initialSrc = prewarming || runtimeBound ? origin + '/module/dialogue/?homer_embed=1&'
        + (prewarming ? 'homer_prewarm=1' : 'homer_app_id=fixture-a&homer_conversation_id=fixture-chat-a') : 'about:blank';
    let currentSrc = initialSrc;
    let currentName = '';
    let currentDocument = { documentElement: { dataset: { homerBootstrapDocument: 'fixture-document-initial' } } }, pendingDocument = null;
    const frame = { contentWindow: { name: 'homer-dialogue-module', postMessage(command, targetOrigin) { sent.push({ command: plain(command), targetOrigin }); } },
        removeAttribute(name) { assert.equal(name, 'src'); currentSrc = 'about:blank'; } };
    Object.defineProperty(frame, 'src', {
        get: () => currentSrc,
        set: value => {
            currentSrc = String(value); frameWrites.push(currentSrc);
            pendingDocument = { documentElement: { dataset: { homerBootstrapDocument: `fixture-document-${frameWrites.length}` } } };
            if (autoCommitDocument) { currentDocument = pendingDocument; pendingDocument = null; }
        },
    });
    Object.defineProperty(frame, 'contentDocument', { get: () => currentDocument });
    Object.defineProperty(frame, 'name', {
        get: () => currentName,
        set: value => { currentName = String(value); frameNameWrites.push(currentName); },
    });
    const location = { origin, href, get search() { return new URL(this.href).search; } };
    const scope = vm.createContext({ URL, URLSearchParams, HOST_CHANNEL: 'homer:dialogue-host:v1',
        DEFAULT_RUNTIME_PATH: '/module/dialogue/', LEGACY_RUNTIME_PATH: '/dialogue-core/',
        frame, location, crypto: webcrypto, window: { crypto: webcrypto, history: { replaceState(_state, _title, value) { location.href = String(value); } },
            setTimeout(callback, delay) { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; },
            clearTimeout(id) { timers.delete(id); }, addEventListener(name, callback) { listeners.set(name, callback); } },
        activeAppId: prewarming ? '' : 'fixture-a', activeConversationId: prewarming ? '' : 'fixture-chat-a', activeTarget: null,
        requestedPresentation: null, forwardPresentationVisibility() {}, presentationVisibility: null, syncArchivePresentation() {}, clearVisibleGameRequest:()=>false,
        coreReady: false, bridgeAvailable: false, runtimeReady, runtimeBound, prewarming,
        runtimePreparedTarget: '',
        adminPreview: false, adminBindPending: false, pendingAdminCard: '', preparedAdminCard: '', pendingDraft: '', pendingCommands: [],
        runtimeState: null, launchRequestId: 0, previewRequestId: 0, switchShellScope: '', readyTimer: 0,
        runtimeLaunchEpoch: 0, runtimeLaunchSequence: 0, runtimeLaunchOwner: '',
        runtimeColdPending: false, runtimeColdFailed: false, runtimeColdFlight: null,
        runtimeBindingPrefix: 'fixture-runtime-document', runtimeEngineToken: '', runtimePriorDocument: null, runtimeAccountBlocked: false, runtimeAccountEpoch: 0,
        settledPreviewQueue: { clear() {} },
        // This fixture selects explicit conversations, never optional history peers.
        // Real mailbox behavior is covered by mobile-r41-history-preparation-host.
        historyReadPreparation: { clear() {}, flush() { return false; } },
        navigationPending: false, pendingTool: null, modelDialog: { close() {} }, performance: { mark: value => adminCalls.push(['mark', value]) },
        composerDraftDirty: false, composerInputScope: '', previewSend: { disabled: false }, previewInput: { value: '' }, previewTitle: {},
        runtimeOverlayActive: false, setRuntimeOverlay() {}, syncHostInsets() {}, readyHandoffTimer: 0, insetsSignature: '',
        launcher: { setAttribute() {} }, announcer: {},
        READY_TIMEOUT_MS: 150000, launcherVisual: {}, history: [],
        document: { querySelector: selector => selector === '#preview-settings-title' ? {} : null, body: { classList: { add() {}, remove() {} } } },
        networkDetail: {}, console: { error() {} }, ApiError: class extends Error {},
        appearance: { refresh() {} }, composerUi: { refresh() {} },
        closeDrawers() {}, showToast: message => notices.push(message),
        scopedKey: key => owner + ':' + key, setDocumentTitle() {}, updateModelSummary() {}, renderConversation() {},
        showShell() {}, readCachedHistory: () => [], renderHistory() {}, loadHistory: async () => {},
        renderCachedConversation: id => previews.push(id), loadQuickPreview: async id => previews.push(id), writeCachedConversation() {},
        getCachedUser: () => owner ? { id: owner } : null,
        nativeCall: (...args) => nativeCalls.push(plain(args)),
        api: {
            conversations: async () => { apiRequests.push(['conversations']); return conversationsResponse || { data: { list: [{ app_id: 'fixture-a', id: 'fixture-chat-a' }] } }; },
            dialogueSession: async (app, conversation, options) => { apiRequests.push(['session', app, conversation, plain(options)]);
                return sessionResponse || { data: { launch: { app_id: app, conversation_id: conversation || 'fixture-resolved-a' } } }; },
        },
    });
    vm.runInContext(actual, scope);
    const actualShowSwitchShell = scope.showConversationSwitchShell;
    scope.showConversationSwitchShell = message => { shellTargets.push(plain(message)); return actualShowSwitchShell(message); };
    const actualMarkReady = scope.markReady;
    scope.markReady = (...args) => { readyCalls.push(args[0]); return actualMarkReady(...args); };
    return { scope, frame, sent, frameWrites, frameNameWrites, shellTargets, notices, readyCalls, apiRequests, previews, adminCalls, nativeCalls, initialSrc, timers,
        start() { return scope.start(); },
        switchTo(app = 'fixture-b', conversation = 'fixture-chat-b') { return scope.switchConversation(app, conversation); },
        message(type, payload = {}) {
            scope.handleRuntimeMessage({ origin, source: frame.contentWindow,
                data: { channel: scope.HOST_CHANNEL, version: 1, type, ...payload } });
        },
        coreReady({ token = String(frame.contentWindow.name || '').startsWith('homer-bootstrap:')
            ? String(frame.contentWindow.name).slice('homer-bootstrap:'.length) : '',
            documentToken = currentDocument?.documentElement?.dataset.homerBootstrapDocument, ...event } = {}) {
            scope.handleRuntimeMessage({ origin, source: frame.contentWindow,
                data: { channel: scope.HOST_CHANNEL, version: 1, type: 'core-ready', ...(token ? { engine_token: token } : {}),
                    ...(documentToken ? { document_token: documentToken } : {}) }, ...event });
        },
        bridgeReady(payload = {}) {
            scope.handleRuntimeMessage({ origin, source: frame.contentWindow,
                data: { channel: scope.HOST_CHANNEL, version: 1, type: 'bridge-available',
                    engine_token: String(frame.contentWindow.name).slice('homer-bootstrap:'.length),
                    document_token: currentDocument?.documentElement?.dataset.homerBootstrapDocument, ...payload } });
        },
        ready(app, conversation, event = {}) {
            scope.handleRuntimeMessage({ origin, source: frame.contentWindow, data: { channel: scope.HOST_CHANNEL,
                version: 1, type: 'ready', app_id: app, conversation_id: conversation, admin_preview: false }, ...event });
        },
        ack(command, { token = command.bootstrap_token, app = command.app_id, conversation = command.conversation_id, adminPreview = false, event = {} } = {}) {
            scope.handleRuntimeMessage({ origin, source: frame.contentWindow, data: { channel: scope.HOST_CHANNEL,
                version: 1, type: 'ready', app_id: app, conversation_id: conversation, admin_preview: adminPreview, state_scheduled: true,
                ...(token === undefined ? {} : { bootstrap_token: token }) }, ...event });
        },
        failure(command) {
            scope.handleRuntimeMessage({ origin, source: frame.contentWindow, data: { channel: scope.HOST_CHANNEL,
                version: 1, type: 'error', app_id: command.app_id, conversation_id: command.conversation_id,
                bootstrap_token: command.bootstrap_token, code: 'DIALOGUE_START_FAILED', message: 'Fixture explicit startup failure' } });
        },
        switchFailure(command, { token = command.bootstrap_token, app = 'fixture-b', conversation = 'fixture-chat-b', failedApp = command.app_id,
            failedConversation = command.conversation_id } = {}) {
            scope.handleRuntimeMessage({ origin, source: frame.contentWindow, data: { channel: scope.HOST_CHANNEL,
                version: 1, type: 'conversation-switch-failed', app_id: app, conversation_id: conversation,
                failed_app_id: failedApp, failed_conversation_id: failedConversation,
                admin_preview: false, state_scheduled: true, bootstrap_token: token } });
        },
        clearAccount(nextOwner = owner) { owner = nextOwner; listeners.get('homer-account-cleared')(); },
        setOwner(nextOwner) { owner = nextOwner; },
        commitDocument() { assert.ok(pendingDocument, 'Controlled navigation has a new document to commit'); currentDocument = pendingDocument; pendingDocument = null; },
        loadActualHistory() { vm.runInContext(extract('async function loadHistory(', 'async function resolveLaunchTarget('), scope); return scope.loadHistory(); },
        fireTimer(id) { const timer = timers.get(id); assert.ok(timer, 'Only a real still-owned timer can fire'); timers.delete(id); timer.callback(); },
    };
}

function assertOneEmptyEngine(h) {
    assert.deepEqual(h.notices, [], 'Startup must not fail through an incomplete VM harness');
    assert.equal(h.frameWrites.length, 1, 'The first host load creates exactly one runtime, never one per selected target');
    const target = new URL(h.frameWrites[0]);
    assert.equal(target.searchParams.get('homer_prewarm'), '1');
    assert.equal(target.searchParams.get('homer_app_id'), '');
    assert.equal(target.searchParams.get('homer_conversation_id'), '');
}
function bootstrapToken(command) {
    assert.equal(typeof command.bootstrap_token, 'string', 'The real dispatch must carry its bounded non-authorization token');
    assert.ok(command.bootstrap_token.length > 0 && command.bootstrap_token.length <= 80);
    assert.match(command.bootstrap_token, /^[A-Za-z0-9._:-]{1,80}$/);
    return command.bootstrap_token;
}
async function firstBind({ owner = 'fixture-owner' } = {}) {
    const h = harness({ prewarming: true }); h.setOwner(owner); await h.start();
    await h.switchTo(); h.coreReady();
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].command.type, 'bind-conversation');
    return h;
}

test('actual ordinary start creates one empty engine while latest target changes before its first resolve continuation/core-ready', async () => {
    const h = harness();
    for (const key of ['runtimeReady', 'runtimeBound', 'coreReady', 'prewarming']) assert.equal(h.scope[key], false);
    const startup = h.start();
    await h.switchTo();
    await h.switchTo('fixture-c', 'fixture-chat-c');
    await startup;
    assertOneEmptyEngine(h);
    assert.equal(h.sent.length, 0, 'Do not bind before actual core-ready');
    assert.equal(h.scope.activeAppId, 'fixture-c');
    assert.equal(h.scope.activeConversationId, 'fixture-chat-c');
});

test('actual cold start writes both independent DOM frame name and child Window name before runtime capture', async () => {
    const h = harness(); await h.start();
    assert.match(h.frame.name, /^homer-bootstrap:[A-Za-z0-9._:-]{1,80}$/);
    assert.equal(h.frame.contentWindow.name, h.frame.name,
        'Changing only the iframe DOM attribute cannot substitute for writing the existing child browsing context name');
    assertOneEmptyEngine(h);
});

test('cookie-only login with no cached user still dispatches one canonical bind after valid engine/document core-ready', async () => {
    const h = harness(); h.setOwner(null); await h.start();
    assert.equal(h.scope.runtimeBindingOwner(), '');
    h.coreReady(); h.coreReady();
    assert.equal(h.sent.length, 1, 'Missing cached profile is not an authorization denial or a reason to block the cookie-authenticated bridge');
    const command = h.sent[0].command; bootstrapToken(command);
    assert.equal(command.type, 'bind-conversation'); assert.equal(command.app_id, 'fixture-a');
    h.ack(command, { token: command.bootstrap_token + '-old' }); assert.equal(h.readyCalls.length, 0);
    h.ack(command); assert.equal(h.readyCalls.length, 1); assertOneEmptyEngine(h);
});

test('same-empty-owner account clear still invalidates an issued cookie-only flight and rejects its late ACK on retry', async () => {
    const h = await firstBind({ owner: null }), old = h.sent[0].command;
    const oldEpoch = h.scope.runtimeLaunchEpoch, accountEpoch = h.scope.runtimeAccountEpoch;
    h.clearAccount(null); h.ack(old); h.coreReady();
    assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 1); assert.equal(h.scope.runtimeBound, false);
    assert.ok(h.scope.runtimeAccountEpoch > accountEpoch); assert.ok(h.scope.runtimeLaunchEpoch > oldEpoch);
    await h.start(); h.coreReady(); const fresh = h.sent[1].command;
    assert.notEqual(bootstrapToken(fresh), bootstrapToken(old));
    h.ack(old); assert.equal(h.readyCalls.length, 0); h.ack(fresh); assert.equal(h.readyCalls.length, 1);
});

test('a previously unknown cached owner becoming available before cookie-only core is profile hydration, not an automatic new-account refusal', async () => {
    const h = harness(); h.setOwner(null); await h.start(); h.setOwner('fixture-owner'); h.coreReady();
    assert.equal(h.sent.length, 1, 'An authenticated profile filling the initially empty cache must not strand ordinary startup');
    assert.equal(h.scope.runtimeLaunchOwner, 'fixture-owner');
    assert.equal(h.scope.runtimeColdFlight.owner, 'fixture-owner');
    h.ack(h.sent[0].command); assert.equal(h.readyCalls.length, 1);
});

test('profile hydration while a cookie-only canonical flight is pending does not invalidate its token without an account-clear epoch', async () => {
    const h = await firstBind({ owner: null }), command = h.sent[0].command;
    h.setOwner('fixture-owner'); h.ack(command);
    assert.equal(h.readyCalls.length, 1); assert.equal(h.scope.runtimeReady, true);
    assert.equal(h.scope.runtimeLaunchOwner, 'fixture-owner');
});

for (const mismatch of ['token', 'scope', 'epoch']) {
    test(`an invalid ${mismatch} canonical ACK cannot adopt a newly hydrated cached owner for a cookie-only flight`, async () => {
        const h = await firstBind({ owner: null }), command = h.sent[0].command;
        h.setOwner('fixture-owner');
        const epoch = h.scope.runtimeColdFlight.epoch;
        if (mismatch === 'token') h.ack(command, { token: command.bootstrap_token + '-wrong' });
        else if (mismatch === 'scope') h.ack(command, { app: 'fixture-other-app', conversation: 'fixture-other-chat' });
        else {
            // Corrupt only this boundary input, not the actual queue: a stale
            // flight epoch must fail before the actual owner helper is called.
            h.scope.runtimeColdFlight.epoch = epoch - 1;
            h.ack(command);
        }
        assert.equal(h.scope.runtimeLaunchOwner, '', 'An uncorrelated message cannot refine the launch cache namespace');
        assert.equal(h.scope.runtimeColdFlight.owner, '');
        assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 1);
        h.scope.runtimeColdFlight.epoch = epoch;
        h.ack(command); assert.equal(h.readyCalls.length, 1);
        assert.equal(h.scope.runtimeLaunchOwner, 'fixture-owner');
    });
}

for (const nextOwner of [null, 'another-fixture-owner']) {
    test(`after the first cache-owner refinement, ${nextOwner === null ? 'cache clearing' : 'a different cached owner'} cannot acknowledge the pending latest drain`, async () => {
        const h = await firstBind({ owner: null }), first = h.sent[0].command;
        await h.switchTo('fixture-c', 'fixture-chat-c'); h.setOwner('fixture-owner'); h.ack(first);
        assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 2);
        assert.equal(h.scope.runtimeLaunchOwner, 'fixture-owner');
        assert.equal(h.scope.runtimeColdFlight.owner, 'fixture-owner');
        const latest = h.sent[1].command;
        h.setOwner(nextOwner); h.ack(latest); h.coreReady();
        assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 2);
        assert.equal(h.scope.runtimeLaunchOwner, 'fixture-owner', 'Refinement is one-way, not arbitrary cached-owner replacement');
        assert.equal(h.scope.runtimeColdFlight.owner, 'fixture-owner');
    });
}

test('a valid flight-token startup error remains visible after the initially unknown cached profile hydrates', async () => {
    const h = await firstBind({ owner: null }), command = h.sent[0].command;
    h.setOwner('fixture-owner'); h.failure(command);
    assert.equal(h.scope.runtimeColdFailed, true); assert.equal(h.scope.runtimeColdFlight, null);
    assert.equal(h.notices.length, 1); assert.match(h.notices[0], /Fixture explicit startup failure/);
    assert.equal(h.readyCalls.length, 0); assert.equal(h.scope.runtimeLaunchOwner, 'fixture-owner');
});

test('an invalid flight-token startup error cannot refine a cookie-only cached owner or fail its current startup', async () => {
    const h = await firstBind({ owner: null }), command = h.sent[0].command;
    h.setOwner('fixture-owner'); h.failure({ ...command, bootstrap_token: command.bootstrap_token + '-wrong' });
    assert.equal(h.scope.runtimeColdFailed, false); assert.equal(h.scope.runtimeColdPending, true);
    assert.equal(h.scope.runtimeLaunchOwner, ''); assert.equal(h.scope.runtimeColdFlight.owner, '');
    assert.equal(h.notices.length, 0); assert.equal(h.readyCalls.length, 0);
    h.failure(command); assert.equal(h.scope.runtimeColdFailed, true);
});

test('ordinary cold late core-ready binds only the latest target once without a second engine navigation', async () => {
    const h = harness();
    const startup = h.start();
    await h.switchTo();
    await h.switchTo('fixture-c', 'fixture-chat-c');
    await startup;
    h.coreReady({ origin: 'https://foreign.invalid' });
    h.coreReady({ source: {} });
    assert.equal(h.sent.length, 0, 'Foreign source/origin cannot flush a pending target');
    h.coreReady();
    h.coreReady();
    assert.equal(h.sent.length, 1);
    const { bootstrap_token, ...legacyCommand } = h.sent[0].command;
    bootstrapToken(h.sent[0].command);
    assert.deepEqual({ command: legacyCommand, targetOrigin: h.sent[0].targetOrigin },
        { command: { channel: 'homer:dialogue-host:v1', version: 1,
            type: 'bind-conversation', app_id: 'fixture-c', conversation_id: 'fixture-chat-c' }, targetOrigin: 'http://fixture.invalid' });
    assertOneEmptyEngine(h);
    assert.equal(h.scope.runtimeReady, false, 'Core-ready and a dispatched bind are not canonical readiness');
});

test('actual start does not wait to initialize the empty engine on a launch-only API response, and its stale response cannot restore the old target', async () => {
    const response = deferred();
    const h = harness({ href: 'http://fixture.invalid/app/chat.html?app_id=fixture-a', sessionResponse: response.promise });
    const startup = h.start();
    assert.deepEqual(h.apiRequests, [['session', 'fixture-a', '', { launchOnly: true }]]);
    const frameWritesBeforeResponse = h.frameWrites.length;
    await h.switchTo('fixture-c', 'fixture-chat-c');
    response.resolve({ data: { launch: { app_id: 'fixture-a', conversation_id: 'fixture-stale-resolved-a' } } });
    await startup;
    assert.equal(h.scope.activeAppId, 'fixture-c'); assert.equal(h.scope.activeConversationId, 'fixture-chat-c');
    assert.equal(h.previews.includes('fixture-stale-resolved-a'), false);
    assert.equal(frameWritesBeforeResponse, 1, 'Capability-only engine initialization must start before the target read settles');
    assertOneEmptyEngine(h);
    h.coreReady(); h.coreReady();
    assert.deepEqual(h.sent.map(item => item.command.type), ['bind-conversation']);
    assert.equal(h.sent[0].command.conversation_id, 'fixture-chat-c');
});

test('actual start fences an old conversation-list result while the newest explicit target continues to core-ready binding', async () => {
    const response = deferred();
    const h = harness({ href: 'http://fixture.invalid/app/chat.html', conversationsResponse: response.promise });
    const startup = h.start();
    await h.switchTo('fixture-c', 'fixture-chat-c');
    response.resolve({ data: { list: [{ app_id: 'fixture-a', id: 'fixture-stale-listed-a' }] } });
    await startup;
    assert.deepEqual(h.apiRequests, [['conversations']], 'An obsolete list cannot issue a launch-only request for its old card');
    assert.equal(h.scope.activeAppId, 'fixture-c'); assert.equal(h.scope.activeConversationId, 'fixture-chat-c');
    assertOneEmptyEngine(h);
    h.coreReady();
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].command.conversation_id, 'fixture-chat-c');
});

test('core-ready before target resolution creates no launch until the real target resolves, then binds once', async () => {
    const response = deferred();
    const h = harness({ href: 'http://fixture.invalid/app/chat.html?app_id=fixture-a', sessionResponse: response.promise });
    const startup = h.start();
    h.coreReady();
    assert.equal(h.sent.length, 0, 'An app without a resolved conversation cannot bind');
    response.resolve({ data: { launch: { app_id: 'fixture-a', conversation_id: 'fixture-resolved-a' } } });
    await startup;
    h.coreReady();
    assertOneEmptyEngine(h);
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].command.conversation_id, 'fixture-resolved-a');
});

test('first bind in flight retains the latest selection without replacing the engine or overlapping binds', async () => {
    const h = harness({ prewarming: true }); await h.start();
    await h.switchTo(); h.coreReady();
    assert.deepEqual(h.sent.map(item => item.command.type), ['bind-conversation']);
    await h.switchTo('fixture-c', 'fixture-chat-c');
    assert.equal(h.sent.length, 1, 'The first bootstrap must settle before another launch is dispatched');
    assertOneEmptyEngine(h);
});

test('a legitimate first-target canonical ACK internally binds the engine but does not mark that old target ready, then dispatches the latest normal switch once', async () => {
    const h = harness({ prewarming: true }); await h.start();
    await h.switchTo(); h.coreReady();
    await h.switchTo('fixture-c', 'fixture-chat-c');
    h.ack(h.sent[0].command); h.ack(h.sent[0].command);
    assert.equal(h.readyCalls.length, 0, 'Do not display or flush ordinary commands into the superseded first target');
    assert.deepEqual(h.sent.map(item => item.command.type), ['bind-conversation', 'switch-conversation']);
    assert.equal(h.sent[1].command.app_id, 'fixture-c'); assert.equal(h.sent[1].command.conversation_id, 'fixture-chat-c');
    assert.equal(h.scope.activeAppId, 'fixture-c'); assert.equal(h.scope.activeConversationId, 'fixture-chat-c');
});

test('account clear including same-owner relogin invalidates the unbound selection before a late core-ready', async () => {
    const h = harness({ prewarming: true }); await h.start();
    await h.switchTo(); h.clearAccount(); h.coreReady();
    assert.equal(h.sent.length, 0, 'The old owner/clear epoch cannot bind a retained selection after relogin');
});

test('public ready still rejects mismatched application/conversation and foreign sender/origin without false readiness', async () => {
    const h = harness(); await h.start();
    h.ready('other-app', 'fixture-chat-a'); h.ready('fixture-a', 'other-chat');
    h.ready('fixture-a', 'fixture-chat-a', { origin: 'https://foreign.invalid' });
    h.ready('fixture-a', 'fixture-chat-a', { source: {} });
    assert.equal(h.readyCalls.length, 0); assert.equal(h.scope.runtimeReady, false); assert.equal(h.scope.runtimeBound, false);
});

test('actual administrator start retains its preview route and never dispatches an ordinary conversation bind', async () => {
    const h = harness(); h.scope.adminPreview = true; await h.start(); h.coreReady();
    assert.equal(h.sent.some(item => item.command.type === 'bind-conversation'), false);
    assert.deepEqual(h.sent.map(item => item.command.type), ['bind-admin-preview']);
    assert.equal(h.sent[0].command.app_id, 'fixture-a');
    assert.deepEqual(h.adminCalls, [['mark', 'homer-admin-workspace-click']]);
    assertOneEmptyEngine(h);
});

test('existing empty prewarm keeps its one-engine late core-ready/latest-target binding contract', async () => {
    const h = harness({ prewarming: true });
    await h.switchTo();
    await h.switchTo('fixture-c', 'fixture-chat-c');
    assert.equal(h.sent.length, 0); assert.equal(h.frameWrites.length, 0);
    h.coreReady(); h.coreReady();
    assert.deepEqual(h.sent.map(item => item.command.type), ['bind-conversation']);
    assert.equal(h.sent[0].command.app_id, 'fixture-c');
    assert.equal(h.sent[0].command.conversation_id, 'fixture-chat-c');
    assert.equal(h.scope.runtimeReady, false); assert.equal(h.frame.src, h.initialSrc);
});

test('actual empty prewarm remains idle without a deadline, then first target selection owns a timeout before late core-ready', async () => {
    const h = harness({ prewarming: true }); await h.start();
    assertOneEmptyEngine(h); assert.equal(h.scope.readyTimer, 0); assert.equal(h.timers.size, 0);
    assert.equal(h.scope.runtimeColdFailed, false, 'Background idle has no timer capable of turning a prepared engine into an error');
    await h.switchTo(); const selectedDeadline = h.scope.readyTimer;
    assert.ok(selectedDeadline); assert.equal(h.timers.get(selectedDeadline)?.delay, h.scope.READY_TIMEOUT_MS);
    assert.equal(h.scope.coreReady, false); assert.equal(h.sent.length, 0);
    await h.switchTo('fixture-c', 'fixture-chat-c'); assert.equal(h.scope.readyTimer, selectedDeadline);
    h.coreReady(); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].command.app_id, 'fixture-c');
    assert.equal(h.sent[0].command.type, 'bind-conversation'); assert.equal(h.timers.has(selectedDeadline), false);
    assert.ok(h.scope.readyTimer); h.ack(h.sent[0].command);
    assert.equal(h.scope.readyTimer, 0); assert.equal(h.timers.size, 0); assertOneEmptyEngine(h);
});

test('already canonical warm navigation preserves the existing switch command instead of rebinding or replacing the iframe', async () => {
    const h = harness({ runtimeReady: true, runtimeBound: true });
    await h.switchTo();
    assert.deepEqual(h.sent.map(item => item.command.type), ['switch-conversation']);
    assert.equal(h.sent[0].command.app_id, 'fixture-b');
    assert.equal(h.sent[0].command.conversation_id, 'fixture-chat-b');
    assert.equal(Object.hasOwn(h.sent[0].command, 'bootstrap_token'), false, 'Warm ABI remains a legacy switch');
    assert.equal(h.frameWrites.length, 0); assert.equal(h.frame.src, h.initialSrc);
});

test('a same-WindowProxy ready with the same IDs but a mismatched or missing bootstrap token cannot acknowledge the first flight', async () => {
    const h = await firstBind(), command = h.sent[0].command;
    const token = bootstrapToken(command), sender = h.frame.contentWindow;
    h.ack(command, { token: token + '-stale' }); h.ack(command, { token: null });
    h.ack(command, { app: 'other-fixture-app' }); h.ack(command, { conversation: 'other-fixture-chat' });
    h.ack(command, { adminPreview: true });
    h.ready(command.app_id, command.conversation_id);
    h.ack(command, { event: { source: {} } }); h.ack(command, { event: { origin: 'https://foreign.invalid' } });
    assert.equal(h.frame.contentWindow, sender);
    assert.equal(h.readyCalls.length, 0); assert.equal(h.scope.runtimeBound, false); assert.equal(h.sent.length, 1);
    h.ack(command);
    assert.equal(h.readyCalls.length, 1); assert.equal(h.scope.runtimeBound, true);
});

test('manual retry changes the launch epoch/token while preserving WindowProxy and ignores the earlier same-scope canonical ACK', async () => {
    const h = await firstBind(), first = h.sent[0].command, firstToken = bootstrapToken(first), sender = h.frame.contentWindow;
    await h.start();
    assert.equal(h.sent.length, 1, 'The previous core-ready cannot bind the new runtime document');
    h.coreReady();
    assert.equal(h.sent.length, 2); const fresh = h.sent[1].command;
    assert.notEqual(bootstrapToken(fresh), firstToken);
    assert.equal(h.frame.contentWindow, sender); assert.equal(h.frameWrites.length, 2, 'One engine initialization per explicit startup generation');
    h.ack(first);
    assert.equal(h.readyCalls.length, 0); assert.equal(h.scope.runtimeBound, false);
    h.ack(fresh); assert.equal(h.readyCalls.length, 1);
});

test('manual retry rejects the previous document core-ready on the same WindowProxy until the new engine token arrives', async () => {
    const h = harness(); await h.start();
    const oldName = h.frame.name, oldEngineToken = oldName.slice('homer-bootstrap:'.length), sender = h.frame.contentWindow;
    assert.match(oldName, /^homer-bootstrap:[A-Za-z0-9._:-]{1,80}$/);
    assert.equal(new URL(h.frame.src).searchParams.has('engine_token'), false, 'Engine correlation stays out of URLs');
    await h.start();
    const newName = h.frame.name;
    assert.notEqual(newName, oldName); assert.equal(h.frame.contentWindow, sender);
    h.coreReady({ token: oldEngineToken }); h.coreReady({ token: '' });
    assert.equal(h.sent.length, 0); assert.equal(h.scope.coreReady, false);
    h.coreReady(); h.coreReady();
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].command.type, 'bind-conversation');
    assert.equal(h.frameWrites.length, 2); assert.equal(h.frameNameWrites.length, 2);
});

test('core-ready from an old document whose module captured the new name before navigation commit still cannot bind', async () => {
    const h = harness({ autoCommitDocument: false }); await h.start();
    const oldDocument = h.frame.contentDocument, sender = h.frame.contentWindow;
    oldDocument.documentElement.dataset.homerBootstrapDocument = 'fixture-late-old-module';
    h.coreReady(); // New frame.name, but still the prior physical document.
    assert.equal(h.sent.length, 0); assert.equal(h.scope.coreReady, false);
    assert.equal(h.scope.runtimePriorDocument, oldDocument);
    h.commitDocument(); assert.notEqual(h.frame.contentDocument, oldDocument); assert.equal(h.frame.contentWindow, sender);
    h.coreReady({ documentToken: 'fixture-late-old-module' });
    assert.equal(h.sent.length, 0, 'Even a new document must carry its own actual dataset marker');
    h.coreReady(); assert.equal(h.sent.length, 1); assert.equal(h.scope.runtimePriorDocument, null);
});

test('manual retry rejects both already-captured old core and late-old-module/new-name core until the next document commits', async () => {
    const h = harness({ autoCommitDocument: false }); await h.start(); h.commitDocument(); h.coreReady();
    const oldDocument = h.frame.contentDocument, oldEngineToken = h.frame.name.slice('homer-bootstrap:'.length);
    const oldDocumentToken = oldDocument.documentElement.dataset.homerBootstrapDocument;
    await h.start();
    h.coreReady({ token: oldEngineToken, documentToken: oldDocumentToken });
    oldDocument.documentElement.dataset.homerBootstrapDocument = 'fixture-late-module-after-retry'; h.coreReady();
    assert.equal(h.sent.length, 1); assert.equal(h.scope.coreReady, false); assert.equal(h.frame.contentDocument, oldDocument);
    h.commitDocument(); h.coreReady(); h.coreReady();
    assert.equal(h.sent.length, 2); assert.equal(h.sent[1].command.type, 'bind-conversation');
    assert.equal(h.frameWrites.length, 2);
});

test('selecting another target before core-ready preserves the real startup timeout owned by that pending engine', async () => {
    const h = harness(); await h.start(); const deadline = h.scope.readyTimer;
    assert.equal(h.timers.get(deadline)?.delay, h.scope.READY_TIMEOUT_MS);
    await h.switchTo(); await h.switchTo('fixture-c', 'fixture-chat-c');
    assert.equal(h.scope.readyTimer, deadline, 'Rendering another shell must not cancel the unresolved engine deadline');
    assert.equal(h.timers.has(deadline), true);
    h.fireTimer(deadline); assert.equal(h.scope.runtimeColdFailed, true); assert.equal(h.readyCalls.length, 0);
    h.coreReady(); assert.equal(h.sent.length, 0);
});

test('selecting a newer target during first bind preserves its real ACK timeout; a late ACK after timeout cannot drain', async () => {
    const h = await firstBind(), first = h.sent[0].command, deadline = h.scope.readyTimer;
    assert.equal(h.timers.get(deadline)?.delay, h.scope.READY_TIMEOUT_MS);
    await h.switchTo('fixture-c', 'fixture-chat-c');
    assert.equal(h.scope.readyTimer, deadline, 'Pending flight still owns its timeout despite the newer desired shell');
    h.fireTimer(deadline); h.ack(first);
    assert.equal(h.scope.runtimeColdFailed, true); assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 1);
});

test('a legitimate ACK renews the actual timeout only for the serial drain flight rather than leaving the old timer live', async () => {
    const h = await firstBind(), first = h.sent[0].command, firstDeadline = h.scope.readyTimer;
    await h.switchTo('fixture-c', 'fixture-chat-c'); h.ack(first);
    const nextDeadline = h.scope.readyTimer;
    assert.notEqual(nextDeadline, firstDeadline); assert.equal(h.timers.has(firstDeadline), false);
    assert.equal(h.timers.get(nextDeadline)?.delay, h.scope.READY_TIMEOUT_MS);
    await h.switchTo('fixture-d', 'fixture-chat-d');
    assert.equal(h.scope.readyTimer, nextDeadline, 'Only canonical C ACK, not a new shell D, may replace the flight deadline');
});

for (const owner of ['fixture-owner', 'another-fixture-owner']) {
    test(`account clear ${owner === 'fixture-owner' ? 'with same-owner relogin' : 'to another owner'} rejects an earlier token on the same WindowProxy and cannot drain its latest selection`, async () => {
        const h = await firstBind(), first = h.sent[0].command; bootstrapToken(first);
        await h.switchTo('fixture-c', 'fixture-chat-c'); h.clearAccount(owner); h.ack(first); h.coreReady();
        assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 1);
        assert.equal(h.scope.runtimeBound, false);
    });
}

test('first startup failure never drains desired C; explicit retry reads the real target again and requires a fresh token before readiness', async () => {
    const h = await firstBind(), first = h.sent[0].command, oldToken = bootstrapToken(first);
    await h.switchTo('fixture-c', 'fixture-chat-c'); h.failure(first);
    assert.equal(h.sent.length, 1); assert.equal(h.readyCalls.length, 0);
    assert.equal(h.scope.runtimeReady, false);
    await h.start(); h.coreReady();
    assert.equal(h.sent.length, 2); const retry = h.sent[1].command;
    assert.equal(retry.type, 'bind-conversation'); assert.equal(retry.app_id, 'fixture-c');
    assert.notEqual(bootstrapToken(retry), oldToken);
    h.ack(first); assert.equal(h.readyCalls.length, 0);
    h.ack(retry); assert.equal(h.readyCalls.length, 1);
});

test('selecting a different card after first startup failure explicitly creates a fresh epoch and never reuses its rejected flight', async () => {
    const h = await firstBind(), first = h.sent[0].command, oldEngineToken = h.frame.name.slice('homer-bootstrap:'.length);
    h.failure(first); assert.equal(h.scope.runtimeColdFailed, true);
    await h.switchTo('fixture-c', 'fixture-chat-c');
    assert.equal(h.frameWrites.length, 2); assert.equal(h.scope.runtimeColdFailed, false); assert.equal(h.scope.coreReady, false);
    h.ack(first); h.coreReady({ token: oldEngineToken });
    assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 1);
    h.coreReady(); const fresh = h.sent[1].command;
    assert.equal(fresh.type, 'bind-conversation'); assert.equal(fresh.app_id, 'fixture-c');
    assert.notEqual(bootstrapToken(fresh), bootstrapToken(first)); h.ack(fresh);
    assert.equal(h.readyCalls.length, 1); assert.equal(h.scope.runtimeReady, true);
});

test('selecting the same failed target retains its explicit error until retry instead of silently resetting or pretending ready', async () => {
    const h = await firstBind(), first = h.sent[0].command;
    h.failure(first); const epoch = h.scope.runtimeLaunchEpoch, messages = h.notices.length;
    await h.switchTo(first.app_id, first.conversation_id);
    assert.equal(h.scope.runtimeColdFailed, true); assert.equal(h.scope.runtimeLaunchEpoch, epoch);
    assert.equal(h.scope.runtimeReady, false); assert.equal(h.readyCalls.length, 0);
    assert.equal(h.frameWrites.length, 1); assert.equal(h.sent.length, 1); assert.equal(h.notices.length, messages);
});

test('a correlated drain failure restores the actual prior shell, drops newer desired targets, and does not pretend a successful queue drain', async () => {
    const h = await firstBind(), first = h.sent[0].command;
    await h.switchTo('fixture-c', 'fixture-chat-c'); h.ack(first);
    const drain = h.sent[1].command;
    await h.switchTo('fixture-d', 'fixture-chat-d');
    h.switchFailure(drain, { token: drain.bootstrap_token + '-old' });
    h.switchFailure(drain, { failedApp: 'other-fixture-app' });
    h.switchFailure(drain, { failedConversation: 'other-fixture-chat' });
    assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 2);
    assert.equal(h.scope.activeAppId, 'fixture-d');
    h.switchFailure(drain);
    assert.equal(h.scope.activeAppId, 'fixture-b'); assert.equal(h.scope.activeConversationId, 'fixture-chat-b');
    assert.equal(h.readyCalls.length, 1); assert.equal(h.scope.runtimeColdPending, false); assert.equal(h.scope.runtimeColdFlight, null);
    assert.equal(h.sent.length, 2, 'Do not switch to D after recovering B');
    h.ack(drain); h.ack(first);
    assert.equal(h.readyCalls.length, 1); assert.equal(h.sent.length, 2);
});

test('cold target changes retain the original draft/generation refusal before mutating IDs or enqueueing a launch', async () => {
    const h = await firstBind(), first = h.sent[0].command;
    h.scope.pendingDraft = 'synthetic pending draft'; await h.switchTo('fixture-c', 'fixture-chat-c');
    assert.equal(h.scope.activeAppId, 'fixture-b'); assert.equal(h.sent.length, 1);
    h.scope.pendingDraft = ''; h.scope.runtimeState = { generating: true };
    await h.switchTo('fixture-c', 'fixture-chat-c');
    assert.equal(h.scope.activeAppId, 'fixture-b'); assert.equal(h.sent.length, 1);
    h.scope.runtimeState = null; h.ack(first);
    assert.equal(h.sent.length, 1); assert.equal(h.readyCalls.length, 1);
});

test('cold pending rejects even same-scope old state/title/conversation/overlay/switching before those consumers can mutate the shell', async () => {
    const h = await firstBind(), command = h.sent[0].command;
    const untouched = { generating: false, fixture: 'new-scope-state' }; h.scope.runtimeState = untouched;
    let overlays = 0, titles = 0, states = 0;
    h.scope.cacheRuntimeState = () => { states++; };
    h.scope.setDocumentTitle = () => { titles++; };
    h.scope.setRuntimeOverlay = () => { overlays++; };
    const beforeShells = h.shellTargets.length;
    for (const type of ['state', 'title', 'conversation', 'overlay-state', 'conversation-switching']) h.message(type, {
        app_id: command.app_id, conversation_id: command.conversation_id, admin_preview: false,
        state: { app_id: command.app_id, conversation_id: command.conversation_id }, active: true, role_name: 'Old scope title',
    });
    assert.equal(states, 0); assert.equal(titles, 0); assert.equal(overlays, 0); assert.equal(h.shellTargets.length, beforeShells);
    assert.equal(h.scope.runtimeState, untouched); assert.equal(h.readyCalls.length, 0);
});

for (const flag of ['adminBindPending', 'pendingAdminCard']) {
    test(`actual switch refuses ${flag} before changing preview mode/IDs or starting an ordinary queue`, async () => {
        const h = harness({ runtimeReady: true, runtimeBound: true }); h.scope.adminPreview = true;
        h.scope[flag] = flag === 'pendingAdminCard' ? 'fixture-admin' : true;
        await h.switchTo('fixture-c', 'fixture-chat-c');
        assert.equal(h.scope.activeAppId, 'fixture-a'); assert.equal(h.scope.activeConversationId, 'fixture-chat-a');
        assert.equal(h.scope.adminPreview, true); assert.equal(h.sent.length, 0); assert.equal(h.frameWrites.length, 0);
    });
}

test('superseded first ACK cannot flush queued user commands; only final latest ACK flushes its actual same-scope queue', async () => {
    const h = await firstBind(), first = h.sent[0].command;
    h.scope.postRuntimeCommand('open-settings', { section: 'memory' });
    await h.switchTo('fixture-c', 'fixture-chat-c');
    h.scope.postRuntimeCommand('open-settings', { section: 'preset' });
    h.ack(first);
    assert.deepEqual(h.sent.map(item => item.command.type), ['bind-conversation', 'switch-conversation']);
    const drain = h.sent[1].command; h.ack(drain);
    assert.deepEqual(h.sent.map(item => item.command.type), ['bind-conversation', 'switch-conversation', 'open-settings']);
    assert.equal(h.sent[2].command.section, 'preset'); assert.equal(h.scope.pendingCommands.length, 0);
    assert.equal(h.scope.readyTimer, 0, 'Real markReady relinquishes the final ACK deadline');
});

test('tokenless current-target warm ready preserves the legacy ABI and real request-state fallback', () => {
    const h = harness({ runtimeReady: true, runtimeBound: true }); h.ready('fixture-a', 'fixture-chat-a');
    assert.equal(h.readyCalls.length, 1); assert.equal(h.scope.runtimeBound, true);
    assert.deepEqual(h.sent.map(item => item.command.type), ['request-state']);
});

test('actual administrator opening cannot replace an in-flight ordinary bind and a fresh preview resets all ordinary correlation', async () => {
    const h = await firstBind(), first = h.sent[0].command;
    h.scope.openAdminPreview('fixture-admin');
    assert.equal(h.scope.adminPreview, false); assert.equal(h.scope.activeAppId, 'fixture-b'); assert.equal(h.sent.length, 1);
    h.ack(first); h.scope.openAdminPreview('fixture-admin');
    assert.equal(h.scope.adminPreview, true); assert.equal(h.scope.runtimeColdFlight, null); assert.equal(h.scope.runtimeColdPending, false);
    assert.equal(h.sent.length, 2); assert.equal(h.sent[1].command.type, 'bind-admin-preview');
    h.ack(first); assert.equal(h.readyCalls.length, 1, 'Old ordinary token cannot acknowledge the administrator preview');
});

test('a cached owner mismatch rejects both engine dispatch and a previously issued canonical token without needing account-clear delivery', async () => {
    const unbound = harness(); await unbound.start(); unbound.setOwner('another-fixture-owner'); unbound.coreReady();
    assert.equal(unbound.sent.length, 0);
    const bound = await firstBind(), command = bound.sent[0].command; bound.setOwner('another-fixture-owner'); bound.ack(command);
    assert.equal(bound.readyCalls.length, 0); assert.equal(bound.scope.runtimeBound, false);
});

test('account clear fences an outstanding launch-only response before it can restore a target or send a bind', async () => {
    const response = deferred();
    const h = harness({ href: 'http://fixture.invalid/app/chat.html?app_id=fixture-a', sessionResponse: response.promise });
    const startup = h.start(); h.clearAccount();
    response.resolve({ data: { launch: { app_id: 'fixture-a', conversation_id: 'fixture-stale-resolved-a' } } }); await startup; h.coreReady();
    assert.equal(h.previews.includes('fixture-stale-resolved-a'), false); assert.equal(h.scope.activeConversationId, '');
    assert.equal(h.sent.length, 0); assert.equal(h.scope.runtimeBound, false);
});

test('account clear also rejects same-scope legacy ready from a retained warm document before an explicit new startup', async () => {
    for (const owner of ['fixture-owner', 'another-fixture-owner']) {
        const h = harness({ runtimeReady: true, runtimeBound: true });
        const sender = h.frame.contentWindow;
        h.clearAccount(owner); h.ready('fixture-a', 'fixture-chat-a');
        assert.equal(h.frame.contentWindow, sender);
        assert.equal(h.readyCalls.length, 0, 'Old warm legacy ABI cannot undo the explicit account-clear fence');
        assert.equal(h.scope.runtimeBound, false);
    }
});

for (const accountCase of ['owner-drift', 'same-owner-relogin', 'other-owner-clear']) {
    test(`actual deferred history response is discarded after ${accountCase} without writing the new owner's cache`, async () => {
        const response = deferred(), h = harness({ conversationsResponse: response.promise }), writes = [];
        h.scope.writeCachedHistory = value => writes.push(plain(value));
        const loading = h.loadActualHistory();
        if (accountCase === 'owner-drift') h.setOwner('another-fixture-owner');
        else h.clearAccount(accountCase === 'same-owner-relogin' ? 'fixture-owner' : 'another-fixture-owner');
        response.resolve({ data: { list: [{ app_id: 'fixture-old-card', id: 'fixture-old-chat' }] } }); await loading;
        assert.deepEqual(writes, []); assert.deepEqual(plain(h.scope.history), []);
    });
}

test('actual history remains usable across a same-owner ordinary target switch, independent of launch request fences', async () => {
    const response = deferred(), h = harness({ conversationsResponse: response.promise }), writes = [];
    h.scope.writeCachedHistory = value => writes.push(plain(value));
    const loading = h.loadActualHistory(); await h.switchTo('fixture-c', 'fixture-chat-c');
    const expected = [{ app_id: 'fixture-c', id: 'fixture-chat-c' }]; response.resolve({ data: { list: expected } }); await loading;
    assert.deepEqual(writes, [expected]); assert.deepEqual(plain(h.scope.history), expected);
});

test('a drain switch remains serial when another target arrives: B bootstrap, C switch, D switch, then final readiness only', async () => {
    const h = await firstBind(), first = h.sent[0].command; bootstrapToken(first);
    await h.switchTo('fixture-c', 'fixture-chat-c'); h.ack(first);
    assert.equal(h.sent.length, 2); const second = h.sent[1].command;
    assert.equal(second.type, 'switch-conversation'); bootstrapToken(second);
    await h.switchTo('fixture-d', 'fixture-chat-d');
    assert.equal(h.sent.length, 2, 'D cannot overlap the outstanding canonical C switch');
    h.ack(second); assert.equal(h.sent.length, 3); const third = h.sent[2].command;
    assert.equal(third.type, 'switch-conversation'); assert.equal(third.app_id, 'fixture-d'); bootstrapToken(third);
    assert.equal(h.readyCalls.length, 0);
    h.ack(third); h.ack(third);
    assert.equal(h.readyCalls.length, 1); assert.equal(h.sent.length, 3); assertOneEmptyEngine(h);
});

test('B to C to B ABA cannot acknowledge a new B flight using the first B token', async () => {
    const h = await firstBind(), first = h.sent[0].command, tokenB = bootstrapToken(first);
    await h.switchTo('fixture-c', 'fixture-chat-c'); h.ack(first);
    const second = h.sent[1].command; bootstrapToken(second);
    await h.switchTo('fixture-b', 'fixture-chat-b'); h.ack(second);
    const last = h.sent[2].command;
    assert.equal(last.app_id, first.app_id); assert.equal(last.conversation_id, first.conversation_id);
    assert.notEqual(bootstrapToken(last), tokenB);
    h.ack(first); assert.equal(h.readyCalls.length, 0); assert.equal(h.sent.length, 3);
    h.ack(last); assert.equal(h.readyCalls.length, 1); assertOneEmptyEngine(h);
});

test('native hidden preparation is announced for the empty engine, not a selected role or generation', async () => {
    const h = harness({ prewarming: true }); await h.start();
    assert.equal(h.sent.length, 0);
    assert.equal(h.nativeCalls.length, 1);
    assert.equal(h.nativeCalls[0][0], 'notifyDialoguePreparationStarted');
    assert.equal(h.nativeCalls[0][1], h.scope.location.href);
    assert.equal(h.nativeCalls[0][2], 'fixture-owner');
    assert.equal(h.nativeCalls[0][3], h.scope.runtimeEngineToken);
    assertOneEmptyEngine(h);
});

test('native core completion follows only the current same-origin engine/document ACK, never bridge availability', async () => {
    const h = harness({ prewarming: true }); await h.start();
    h.message('bridge-available');
    h.coreReady({ token: 'old-engine' });
    h.coreReady({ documentToken: 'old-document' });
    h.coreReady({ origin: 'https://external.invalid' });
    h.coreReady({ source: {} });
    assert.equal(h.nativeCalls.filter(call => call[0] === 'notifyDialogueCoreReady').length, 0);
    h.coreReady();
    const done = h.nativeCalls.filter(call => call[0] === 'notifyDialogueCoreReady');
    assert.equal(done.length, 1);
    assert.deepEqual(done[0], ['notifyDialogueCoreReady', h.scope.location.href, 'fixture-owner', h.scope.runtimeEngineToken]);
    assert.equal(h.sent.length, 0, 'Capability-only preparation must not bind or execute a role');
});

test('native preparation cancellation uses the retired token and account-clear prevents a late core completion', async () => {
    const h = harness({ prewarming: true }); await h.start();
    const retired = h.scope.runtimeEngineToken;
    h.clearAccount(null);
    assert.ok(h.nativeCalls.some(call => call[0] === 'notifyDialoguePreparationStopped' && call[3] === retired));
    h.coreReady({ token: retired });
    assert.equal(h.nativeCalls.filter(call => call[0] === 'notifyDialogueCoreReady').length, 0);
    assert.equal(h.sent.length, 0);
});

test('selected cold target reads start at verified bridge availability without binding or claiming ready', async () => {
    const h = harness(); await h.start();
    h.bridgeReady(); h.bridgeReady();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].command.type, 'prepare-conversation');
    assert.equal(h.sent[0].command.app_id, 'fixture-a');
    assert.equal(h.sent[0].command.owner, 'fixture-owner');
    assert.equal(h.scope.coreReady, false); assert.equal(h.readyCalls.length, 0);
    await h.switchTo();
    assert.deepEqual(h.sent.map(item => item.command.type), ['prepare-conversation', 'prepare-conversation']);
    assert.equal(h.sent[1].command.app_id, 'fixture-b');
    h.coreReady();
    assert.equal(h.sent[2].command.type, 'bind-conversation');
    assert.equal(h.sent[2].command.app_id, 'fixture-b');
    assert.equal(h.frameWrites.length, 1);
});

test('empty preparation reads no previous role and stale bridge notifications cannot start reads', async () => {
    const h = harness({ prewarming: true }); await h.start();
    h.bridgeReady(); assert.equal(h.sent.length, 0);
    await h.switchTo(); assert.equal(h.sent.length, 1);
    h.scope.startColdRuntime();
    h.bridgeReady({ engine_token: 'retired' });
    h.bridgeReady({ document_token: 'retired' });
    assert.equal(h.sent.length, 1);
    h.bridgeReady(); assert.equal(h.sent.length, 2);
    h.clearAccount('other-fixture-owner');
    h.bridgeReady(); assert.equal(h.sent.length, 2);
});

test('unknown-owner and admin cold preparation make no speculative target read', async () => {
    const h = harness(); h.setOwner(null); await h.start(); h.bridgeReady();
    assert.equal(h.sent.length, 0);
    h.setOwner('fixture-owner'); h.scope.adminPreview = true; h.bridgeReady();
    assert.equal(h.sent.length, 0);
});
