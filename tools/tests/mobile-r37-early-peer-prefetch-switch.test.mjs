import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { emptyLocalSessions } from './helpers/bridge-session-vm.mjs';
import { sanitizeRuntimeValue } from '../../sillytavern-runtime/public/scripts/homer-local-runtime.mjs';

// Reuse the established recovery fixture without changing its file. Its
// switch/recovery/activation functions are extracted from shipping source.
// Peripheral VM promises model ordering, not browser or device latency.
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const recoveryFixtureSource = fs.readFileSync(new URL('./mobile-r35-switch-recovery.test.mjs', import.meta.url), 'utf8');
const fixtureStart = recoveryFixtureSource.indexOf('function section(');
const fixtureEnd = recoveryFixtureSource.indexOf('async function switchTarget(h)', fixtureStart);
assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart, 'Existing recovery fixture boundaries are available');
const fixtureContext = vm.createContext({ assert, vm, bridge, script, URL, emptyLocalSessions, sanitizeRuntimeValue });
vm.runInContext(recoveryFixtureSource.slice(fixtureStart, fixtureEnd), fixtureContext);

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
async function drainMicrotasks() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}
function harness(options = {}) {
    const h = fixtureContext.fixture(options);
    const order = [], schedules = [];
    const nextSession = { user: { id: 'owner-a' }, launch: {
        app_id: 'card-b', conversation_id: 'conversation-b',
        ...(options.nextPreview ? { admin_preview: true } : {}),
    } };
    if (options.previousPreview) h.previousSession.launch.admin_preview = true;
    h.scope.scheduleSessionPrefetch = peer => {
        const record = { peer, launch: h.scope.launch, owner: h.scope.owner, epoch: h.scope.storageAccountEpoch };
        schedules.push(record);
        order.push(peer === undefined ? 'default-prefetch' : 'previous-peer-prefetch');
    };
    return { ...h, order, schedules, nextSession,
        early: () => schedules.filter(record => record.peer !== undefined),
        defaults: () => schedules.filter(record => record.peer === undefined),
        switch: () => h.scope.switchConversation({ app_id: 'card-b', id: 'conversation-b' }),
    };
}

for (const firstSettled of ['commit', 'take']) {
    test(`previous peer is scheduled after both leave/take barriers and before hydration when ${firstSettled} settles first`, async () => {
        const h = harness(), commit = deferred(), take = deferred(), hydrated = deferred(), hydrateStarted = deferred();
        const settled = { commit: false, take: false };
        h.scope.commitConversationBeforeSwitch = async () => {
            h.order.push('commit-start');
            await commit.promise;
            settled.commit = true; h.order.push('commit-settled');
        };
        h.scope.takePrefetchedSession = async () => {
            h.order.push('take-start');
            const result = await take.promise;
            settled.take = true; h.order.push('take-settled');
            return result;
        };
        const recordSchedule = h.scope.scheduleSessionPrefetch;
        h.scope.scheduleSessionPrefetch = peer => {
            if (peer !== undefined) {
                assert.deepEqual(settled, { commit: true, take: true }, 'Both actual Promise.all members must have settled');
                assert.equal(h.scope.launch, h.nextSession.launch, 'Target launch is already bound');
                assert.equal(h.scope.session, h.nextSession);
                assert.equal(h.scope.owner, 'owner-a');
                assert.equal(h.scope.storageAccountEpoch, 0);
            }
            recordSchedule(peer);
        };
        h.scope.loadRuntimeUiData = () => {
            h.order.push('hydrate-start'); hydrateStarted.resolve();
            return hydrated.promise;
        };
        h.scope.loadRuntimeState = () => hydrated.promise;
        const switched = h.switch();
        try {
            await drainMicrotasks();
            assert.deepEqual(h.order, ['take-start', 'commit-start']);
            assert.equal(h.early().length, 0, 'No peer may be scheduled with both barriers unsettled');
            if (firstSettled === 'commit') commit.resolve();
            else take.resolve(h.nextSession);
            await drainMicrotasks();
            assert.equal(h.early().length, 0, 'One settled barrier is insufficient');
            assert.equal(h.scope.launch, h.previousSession.launch);
            assert.equal(h.order.includes('hydrate-start'), false);
            if (firstSettled === 'commit') take.resolve(h.nextSession);
            else commit.resolve();
            await Promise.race([hydrateStarted.promise, switched.then(() => { throw Error('Switch ended before required hydration'); })]);
            assert.equal(h.early().length, 1, 'Schedule the previous peer before beginning hydration');
            assert.equal(h.early()[0].peer, h.previousSession.launch, 'Preserve the previous launch identity as the peer argument');
            assert.equal(h.defaults().length, 0, 'The existing ready-tail scheduling has not happened yet');
            assert.ok(h.order.indexOf('previous-peer-prefetch') < h.order.indexOf('hydrate-start'));
        } finally {
            commit.resolve(); take.resolve(h.nextSession); hydrated.resolve();
            await switched;
        }
        assert.equal(h.early().length, 1, 'Successful ready must not repeat the previous-peer scheduling');
        assert.equal(h.defaults().length, 1, 'Retain the existing successful no-argument scheduling');
        assert.equal(h.scope.hasCanonicalConversationScope(), true);
        assert.equal(h.notices.filter(item => item.type === 'ready').length, 1);
    });
}

for (const failure of ['commit', 'take', 'invalid launch']) {
    test(`${failure} barrier failure schedules no previous peer and preserves the untouched old canonical chat`, async () => {
        const h = harness(), dom = h.scope.dom, metadata = h.scope.chat_metadata;
        h.scope.commitConversationBeforeSwitch = async () => { if (failure === 'commit') throw Error('Durable leave failed'); };
        h.scope.takePrefetchedSession = async () => {
            if (failure === 'take') throw Error('Fresh target read failed');
            return failure === 'invalid launch' ? { user: { id: 'owner-a' } } : h.nextSession;
        };
        await h.switch();
        assert.equal(h.early().length, 0);
        assert.equal(h.defaults().length, 0);
        assert.equal(h.scope.session, h.previousSession);
        assert.equal(h.scope.dom, dom); assert.equal(h.scope.chat_metadata, metadata);
        assert.equal(h.scope.hasCanonicalConversationScope(), true);
        assert.equal(h.calls.filter(item => ['activate', 'clear', 'print'].includes(item[0])).length, 0);
        assert.equal(h.notices.filter(item => item.type === 'conversation-switch-failed').length, 1);
        assert.equal(h.notices.filter(item => item.type === 'ready').length, 0);
    });
}

for (const mode of ['different owner', 'same-owner new epoch']) {
    test(`${mode} at the settled barrier schedules no previous peer and cannot restore an old account`, async () => {
        const h = harness();
        h.scope.takePrefetchedSession = async () => {
            if (mode === 'different owner') h.scope.owner = 'owner-b';
            h.scope.storageAccountEpoch++;
            return h.nextSession;
        };
        await h.switch();
        assert.equal(h.early().length, 0); assert.equal(h.defaults().length, 0);
        assert.equal(h.scope.conversationRecoveryBlocked, true);
        assert.equal(h.calls.filter(item => item[0] === 'activate').length, 0);
        assert.equal(h.notices.filter(item => item.type === 'ready' || item.type === 'conversation-switch-failed').length, 0);
    });
}

for (const preview of ['previousPreview', 'nextPreview']) {
    test(`${preview} excludes the early previous peer without removing the established ready-tail call`, async () => {
        const h = harness({ [preview]: true });
        h.scope.takePrefetchedSession = async () => h.nextSession;
        await h.switch();
        assert.equal(h.early().length, 0);
        assert.equal(h.defaults().length, 1, 'Default scheduling policy is tested separately using the actual scheduler');
        assert.equal(h.scope.hasCanonicalConversationScope(), true);
        assert.equal(h.notices.filter(item => item.type === 'ready').length, 1);
    });
}

test('existing busy permissions refuse the switch without committing, fetching or scheduling a peer', async () => {
    for (const flag of ['loadingLaunch', 'adminBinding', 'generationBusy', 'rollbackBusy']) {
        const h = harness(); h.scope[flag] = true;
        h.scope.commitConversationBeforeSwitch = () => { throw Error('No durable work while busy'); };
        h.scope.takePrefetchedSession = () => { throw Error('No target read while busy'); };
        h.scope.prepareRuntimeState = () => { throw Error('No state read while busy'); };
        h.scope.prepareRuntimeModels = () => { throw Error('No model read while busy'); };
        await h.switch();
        assert.equal(h.schedules.length, 0); assert.equal(h.scope.session, h.previousSession);
        assert.equal(h.calls.filter(item => item[0] === 'activate').length, 0);
    }
});

test('a later hydration failure still restores the original canonical DOM and never reports ready', async () => {
    const h = harness({ configurationFailure: true }), dom = h.scope.dom, metadata = h.scope.chat_metadata;
    await h.switch();
    // Earlier read-only preparation cannot predict a future hydration error.
    // Require recovery, not a fabricated prohibition on already-started reads.
    assert.equal(h.defaults().length, 0);
    assert.equal(h.scope.session, h.previousSession);
    assert.equal(h.scope.dom, dom); assert.equal(h.scope.chat_metadata, metadata);
    assert.equal(h.scope.hasCanonicalConversationScope(), true);
    assert.equal(h.calls.filter(item => ['activate', 'clear', 'print'].includes(item[0])).length, 0);
    assert.equal(h.notices.filter(item => item.type === 'conversation-switch-failed').length, 1);
    assert.equal(h.notices.filter(item => item.type === 'ready').length, 0);
});

function sourceBetween(start, end) {
    const first = bridge.indexOf(start), last = bridge.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, 'Actual lifecycle function boundaries: ' + start);
    return bridge.slice(first, last);
}
function lifecycleHarness() {
    const reads = [], timers = [], cancelled = [], callbacks = new Map(), persistence = [];
    const parent = {}, origin = 'https://fixture.test';
    const context = {
        launch: { app_id: 'card-b', conversation_id: 'conversation-b' },
        runtimeUiData: { conversations: [
            { app_id: 'card-c', id: 'conversation-c' }, { app_id: 'card-d', id: 'conversation-d' },
        ] },
        SESSION_PREFETCH_LIMIT: 2, sessionPrefetchTimer: null, sessionPrefetchPeer: null,
        sessionPrefetchCache: new Map(), storageAccountEpoch: 0,
        reconcileStorageAccount: () => 'owner-a',
        prefetchSession: (...args) => { reads.push(args); return Promise.resolve(); },
        window: { parent, location: { origin },
            clearTimeout: id => cancelled.push(id),
            setTimeout: callback => { timers.push(callback); return timers.length; },
            addEventListener: (name, callback) => callbacks.set(name, callback),
        },
        historyCoverLoader: { close: () => persistence.push(['covers-close']) }, syncTimer: 99,
        syncCloudChat: async options => persistence.push(['chat-sync', options]),
        flushExtensionSettingsPersist: async options => persistence.push(['settings-flush', options]),
        HOST_CHANNEL: 'fixture-host-channel', canNotifyHost: () => true,
        coreAvailable: true, adminBinding: false, loadingLaunch: false, generationBusy: false, rollbackBusy: false,
        isGenerating: () => false, performance: { mark() {} }, notifyHost() {}, retainScopeDraft() {},
        preparedAdminLaunch: null, requestedAppId: 'card-b', requestedConversationId: 'conversation-b',
        adminConversationDraft: {}, adminConversationConfig: null, runtimeVariables: {},
        lastGenerationDiagnostic: null, generationSnapshot: null,
        bridgeStartScheduled: true, prewarmBootstrapPromise: Promise.resolve(),
        ensureAdministratorExtensions: () => Promise.resolve(),
        prepareAdminLaunch: async () => ({ user: { id: 'owner-a', is_admin: true },
            launch: { app_id: 'preview-card', conversation_id: 'preview-conversation', admin_preview: true } }),
        // Actual bootstrapLaunch binds preloadedSession.launch synchronously,
        // before its first hydration await. Do not invent a pre-bind pause.
        bootstrapLaunch: async next => { context.launch = next.launch; },
    };
    vm.createContext(context);
    vm.runInContext(sourceBetween('function sessionCacheKey(', 'function invalidateCachedSession('), context);
    vm.runInContext(sourceBetween('function scheduleSessionPrefetch(', 'function setAccessClasses('), context);
    vm.runInContext(sourceBetween('async function receiveHostCommand(', "window.addEventListener('message',"), context);
    const pagehideStart = bridge.indexOf("    window.addEventListener('pagehide', () => {");
    const pagehideEnd = bridge.indexOf('\n    });', pagehideStart);
    assert.ok(pagehideStart >= 0 && pagehideEnd > pagehideStart, 'Actual pagehide registration exists');
    vm.runInContext(bridge.slice(pagehideStart, pagehideEnd + '\n    });'.length), context);
    context.scheduleSessionPrefetch({ app_id: 'card-a', conversation_id: 'conversation-a' });
    assert.ok(context.sessionPrefetchPeer);
    context.sessionPrefetchCache.set('private-fixture-cache', { promise: Promise.resolve() });
    return { context, reads, timers, cancelled, callbacks, persistence,
        queuedTimer: timers.at(-1), timerId: context.sessionPrefetchTimer,
        previewEvent: { origin, source: parent,
            data: { channel: context.HOST_CHANNEL, version: 1, type: 'bind-admin-preview', app_id: 'preview-card' } },
    };
}

test('actual pagehide clears remembered peer and prevents an already queued timer from starting private reads', () => {
    const h = lifecycleHarness();
    h.callbacks.get('pagehide')();
    assert.equal(h.context.sessionPrefetchPeer, null);
    assert.equal(h.context.sessionPrefetchCache.size, 0);
    assert.ok(h.cancelled.includes(h.timerId));
    assert.equal(h.persistence[0][0], 'covers-close');
    assert.equal(h.persistence.find(item => item[0] === 'chat-sync')[1].keepaliveOnly, true);
    const settings = h.persistence.find(item => item[0] === 'settings-flush')[1];
    assert.equal(settings.force, true); assert.equal(settings.keepalive, true);
    h.queuedTimer();
    assert.equal(h.reads.length, 0, 'Previously captured callback delivery must stay inert after pagehide cleanup');
});

test('actual preview binding clears remembered peer and keeps an already queued ordinary job inert', async () => {
    const h = lifecycleHarness();
    await h.context.receiveHostCommand(h.previewEvent);
    assert.equal(h.context.launch.admin_preview, true);
    assert.equal(h.context.sessionPrefetchPeer, null);
    assert.equal(h.context.sessionPrefetchCache.size, 0);
    assert.ok(h.cancelled.includes(h.timerId));
    assert.equal(h.context.adminBinding, false);
    h.queuedTimer();
    assert.equal(h.reads.length, 0);
});
