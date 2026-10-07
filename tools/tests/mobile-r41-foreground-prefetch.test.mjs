import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { emptyLocalSessions } from './helpers/bridge-session-vm.mjs';
import { sanitizeRuntimeValue } from '../../sillytavern-runtime/public/scripts/homer-local-runtime.mjs';

// Exercise the shipping switch, bounded session row, resource preparation and
// scheduler together. The established recovery fixture supplies canonical
// activation/rollback; synthetic API promises describe ordering, not latency.
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const fixtureSource = fs.readFileSync(new URL('./mobile-r35-switch-recovery.test.mjs', import.meta.url), 'utf8');
const start = fixtureSource.indexOf('function section(');
const end = fixtureSource.indexOf('async function switchTarget(h)', start);
assert.ok(start >= 0 && end > start, 'Established shipping-source recovery fixture boundaries');
const fixtureContext = vm.createContext({ assert, vm, bridge, script, URL, emptyLocalSessions, sanitizeRuntimeValue });
vm.runInContext(fixtureSource.slice(start, end), fixtureContext);

function section(begin, finish) {
    const first = bridge.indexOf(begin), last = bridge.indexOf(finish, first + begin.length);
    assert.ok(first >= 0 && last > first, 'Shipping bridge boundaries: ' + begin);
    return bridge.slice(first, last);
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
async function drain() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
}
const TARGET_APP = 'card-b', TARGET_CHAT = 'conversation-b';
const clone = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
    const h = fixtureContext.fixture(options), c = h.scope;
    const requests = [], order = [], timers = [], cleared = [];
    const sessionGate = deferred(), leaveGate = deferred(), hydrateGate = deferred(), hydrateStarted = deferred();
    const gates = new Map();
    let now = 1_000;
    Object.assign(c, {
        Date: { now: () => now }, URLSearchParams, adminPreviewRequested: false, localSessions: emptyLocalSessions(),
        SESSION_CACHE_TTL_MS: 30_000, SESSION_PREFETCH_LIMIT: 2,
        sessionPrefetchCache: new Map(), sessionPrefetchTimer: null, sessionPrefetchPeer: null,
        sessionReadFences: new WeakMap(), storageAckStamps: new Map(),
        payloadList: value => Array.isArray(value) ? value : value?.list || [],
        selectRuntimeModelId: () => 'fixture-model',
    });
    c.runtimeUiData.conversations = [
        { app_id: TARGET_APP, id: TARGET_CHAT },
        { app_id: 'card-c', id: 'conversation-c' },
        { app_id: 'card-d', id: 'conversation-d' },
    ];
    c.window.setTimeout = (callback, delay) => { timers.push({ id: timers.length + 1, callback, delay }); return timers.length; };
    c.window.clearTimeout = id => cleared.push(id);
    if (options.previousPreview) c.launch.admin_preview = true;
    if (options.holdSession) gates.set(TARGET_APP + '::' + TARGET_CHAT, sessionGate);
    const originalCommit = c.commitConversationBeforeSwitch;
    c.commitConversationBeforeSwitch = async () => {
        order.push('leave');
        if (options.holdLeave) await leaveGate.promise;
        return originalCommit();
    };
    c.fetchSession = async (app, conversation, _create, _attempt, fetchOptions) => {
        assert.equal(fetchOptions.deferLocalMerge, true, 'Prefetch remains raw before local fenced projection');
        const owner = c.owner, epoch = c.storageAccountEpoch;
        requests.push({ kind: 'session', app, conversation }); order.push('session:' + app);
        const payload = { user: { id: owner }, launch: {
            app_id: app, conversation_id: conversation, bridge_token: true,
            card: { name: 'Synthetic full card', character_book: { entries: [{ content: 'complete' }] },
                extensions: { fixture_script: { body: 'x'.repeat(options.large ? 3 * 1024 * 1024 : 64) } } },
            messages: [{ id: 'complete-message', content: 'synthetic message', swipes: ['one', 'two'], swipe_index: 1 }],
            ...(options.nextPreview && app === TARGET_APP ? { admin_preview: true } : {}),
        } };
        c.sessionReadFences.set(payload, {
            owner, epoch, scope: JSON.stringify([owner, app, conversation]), raw: true, fence: {},
        });
        if (options.getFailure && app === TARGET_APP) throw Error('Synthetic target failure');
        const gate = gates.get(app + '::' + conversation);
        if (gate) await gate.promise;
        return payload;
    };
    c.preferLocalSession = async payload => payload;
    c.prepareRuntimeState = (app, conversation) => {
        order.push('state:' + app); requests.push({ kind: 'state', app, conversation });
        return Object.freeze({ owner: c.owner, epoch: c.storageAccountEpoch,
            scope: JSON.stringify([c.owner, app, conversation]),
            pending: Promise.resolve({ value: { state: { variables: {}, extension_settings: {} }, fence: {} } }) });
    };
    c.prepareRuntimeModels = (app, conversation) => {
        order.push('models:' + app); requests.push({ kind: 'models', app, conversation });
        return Object.freeze({ owner: c.owner, epoch: c.storageAccountEpoch,
            scope: JSON.stringify([c.owner, app, conversation]),
            pending: Promise.resolve({ value: { list: [{ id: 'fixture-model' }], default_id: 'fixture-model' } }) });
    };
    c.requestJson = async path => {
        const query = new URL(path, 'https://fixture.invalid').searchParams;
        assert.ok(path.startsWith('/api/homer/regex?'), 'Only synthetic regex transport belongs to this fixture');
        requests.push({ kind: 'regex', app: query.get('app_id'), conversation: query.get('conversation_id') });
        return { scripts: [] };
    };
    vm.runInContext([
        section('function storageAckKey(', 'async function acknowledgeStorage('),
        section('function sessionCacheKey(', 'function setAccessClasses('),
        section('function prepareConversationResources(', 'async function refreshOfficialRegex('),
    ].join('\n'), c);
    const prepare = c.prepareConversationResources;
    c.prepareConversationResources = (app, conversation) => {
        const row = c.sessionPrefetchCache.get(c.sessionCacheKey(app, conversation));
        order.push(row ? 'prepare:row' : 'prepare:no-row');
        return prepare(app, conversation);
    };
    const stateLoader = c.loadRuntimeState, modelLoader = c.loadRuntimeUiData;
    const consumed = [];
    c.loadRuntimeUiData = async models => {
        consumed.push({ kind: 'models', ticket: models }); hydrateStarted.resolve();
        if (options.holdHydration) await hydrateGate.promise;
        return modelLoader(models);
    };
    c.loadRuntimeState = async (state, models, regex) => {
        consumed.push({ kind: 'state', ticket: state, regex });
        if (options.holdHydration) await hydrateGate.promise;
        return stateLoader(state, models, regex);
    };
    return { ...h, c, requests, order, timers, cleared, consumed,
        sessionGate, leaveGate, hydrateGate, hydrateStarted, gates,
        advance: () => { now += 31_000; },
        row: () => c.sessionPrefetchCache.get(c.sessionCacheKey(TARGET_APP, TARGET_CHAT)),
        prepare: () => c.prepareConversationResources(TARGET_APP, TARGET_CHAT),
        targetReads: kind => requests.filter(item => item.app === TARGET_APP && (!kind || item.kind === kind)),
        peerReads: () => requests.filter(item => item.app !== TARGET_APP),
        latestTimer: () => timers.filter(item => item.delay === 0).at(-1),
        fire: timer => timer?.callback(),
        switch: () => c.switchConversation({ app_id: TARGET_APP, id: TARGET_CHAT }),
    };
}

test('uncached foreground target creates its bounded row before resource preparation and shares every exact read', async () => {
    const h = harness({ holdSession: true, holdLeave: true, large: true });
    const switched = h.switch();
    try {
        await drain();
        const row = h.row();
        assert.ok(row?.resources, 'First click attaches preparation to the already-created session row');
        assert.equal(row.expiresAt, 31_000);
        assert.deepEqual(h.order.slice(0, 5), ['session:card-b', 'prepare:row', 'state:card-b', 'models:card-b', 'leave']);
        assert.equal(h.prepare(), row.resources, 'Another exact preparation reuses the same resource tickets');
        await row.resources.regex.pending;
        for (const kind of ['session', 'state', 'models', 'regex']) assert.equal(h.targetReads(kind).length, 1);
        assert.equal(h.c.session, h.previousSession, 'Full old conversation remains active before durable leave');
        h.sessionGate.resolve(); h.leaveGate.resolve(); await switched;
        assert.equal(h.c.hasCanonicalConversationScope(), true);
        assert.equal(h.c.session.launch.card.extensions.fixture_script.body.length, 3 * 1024 * 1024);
        assert.deepEqual(clone(h.c.session.launch.card.character_book), { entries: [{ content: 'complete' }] });
        assert.deepEqual(clone(h.c.session.launch.messages[0].swipes), ['one', 'two']);
        assert.equal(h.c.session.launch.messages[0].swipe_index, 1);
        assert.equal(h.row(), undefined, 'Private raw session remains one-use, not a second permanent chat');
    } finally {
        h.sessionGate.resolve(); h.leaveGate.resolve(); await switched;
    }
});

test('existing unexpired exact target resources retain their original deadline without duplicate authorized reads', async () => {
    const h = harness();
    const raw = h.c.prefetchSession(TARGET_APP, TARGET_CHAT), prepared = h.prepare(), row = h.row();
    await Promise.all([raw, prepared.regex.pending]);
    const deadline = row.expiresAt;
    await h.switch();
    for (const kind of ['session', 'state', 'models', 'regex']) assert.equal(h.targetReads(kind).length, 1);
    assert.equal(h.consumed.find(item => item.kind === 'state').ticket, prepared.state);
    assert.equal(h.consumed.find(item => item.kind === 'models').ticket, prepared.models);
    assert.equal(prepared.state.expiresAt, deadline); assert.equal(prepared.regex.expiresAt, deadline);
    assert.equal(h.row(), undefined);
});

test('expired target starts a new authorized session and new resources rather than extending an old deadline', async () => {
    const h = harness();
    const raw = h.c.prefetchSession(TARGET_APP, TARGET_CHAT), prepared = h.prepare();
    await Promise.all([raw, prepared.regex.pending]); h.advance();
    await h.switch();
    for (const kind of ['session', 'state', 'models', 'regex']) assert.equal(h.targetReads(kind).length, 2);
    assert.notEqual(h.consumed.find(item => item.kind === 'state').ticket, prepared.state);
    assert.equal(prepared.state.expiresAt, 31_000, 'Old preparation TTL was not mutated');
});

test('old queued history timer arriving during durable leave neither reads nor prunes foreground target resources', async () => {
    const h = harness({ holdSession: true, holdLeave: true });
    h.c.scheduleSessionPrefetch(); const old = h.latestTimer();
    const switched = h.switch();
    try {
        await drain();
        const row = h.row();
        h.fire(old); await drain();
        assert.equal(h.c.loadingLaunch, true);
        assert.equal(h.peerReads().length, 0);
        assert.equal(h.row(), row); assert.equal(h.prepare(), row.resources);
        for (const kind of ['session', 'state', 'models', 'regex']) assert.equal(h.targetReads(kind).length, 1);
        assert.equal(h.c.session, h.previousSession);
    } finally {
        h.sessionGate.resolve(); h.leaveGate.resolve(); await switched;
    }
});

test('previous peer is remembered without background traffic during hydration and two peers still prepare after ready/finally', async () => {
    const h = harness({ holdHydration: true });
    const switched = h.switch();
    try {
        await Promise.race([
            h.hydrateStarted.promise,
            switched.then(() => assert.fail('Switch finished before expected hydration began')),
        ]);
        assert.equal(h.c.loadingLaunch, true);
        assert.equal(h.c.sessionPrefetchPeer.appId, 'card-a');
        h.fire(h.latestTimer()); await drain();
        assert.equal(h.peerReads().length, 0, 'No session/state/models/regex peer work on foreground hydration path');
        h.hydrateGate.resolve(); await switched;
        assert.equal(h.c.loadingLaunch, false);
        const readyTail = h.latestTimer(); assert.ok(readyTail);
        h.fire(readyTail); await drain();
        for (const app of ['card-a', 'card-c']) {
            for (const kind of ['session', 'state', 'models', 'regex']) {
                assert.equal(h.requests.filter(item => item.app === app && item.kind === kind).length, 1);
            }
        }
        assert.equal(h.c.sessionPrefetchCache.size, 2);
        assert.deepEqual([...h.c.sessionPrefetchCache.keys()].sort(), ['card-a::conversation-a', 'card-c::conversation-c']);
        assert.equal(h.notices.filter(item => item.type === 'ready').length, 1);
    } finally {
        h.hydrateGate.resolve(); await switched;
    }
});

for (const failure of ['commitFailure', 'getFailure', 'configurationFailure']) {
    test(`${failure} restores old canonical chat without launching deferred peers or reporting ready`, async () => {
        const h = harness({ [failure]: true }), dom = h.c.dom;
        await h.switch(); h.fire(h.latestTimer()); await drain();
        assert.equal(h.peerReads().length, 0);
        assert.equal(h.c.session, h.previousSession); assert.equal(h.c.dom, dom);
        assert.equal(h.c.hasCanonicalConversationScope(), true); assert.equal(h.c.loadingLaunch, false);
        assert.equal(h.notices.filter(item => item.type === 'ready').length, 0);
        assert.equal(h.notices.filter(item => item.type === 'conversation-switch-failed').length, 1);
    });
}

for (const change of ['different-owner', 'same-owner-epoch', 'logout']) {
    test(`${change} during leave invalidates target consumption and prevents old account recovery or peer reads`, async () => {
        const h = harness({ holdSession: true, holdLeave: true });
        h.c.scheduleSessionPrefetch(); const old = h.latestTimer();
        const switched = h.switch();
        if (change === 'different-owner') h.c.owner = 'owner-b';
        if (change === 'logout') h.c.owner = '';
        h.c.storageAccountEpoch++;
        h.fire(old); h.sessionGate.resolve(); h.leaveGate.resolve(); await switched; await drain();
        assert.equal(h.c.conversationRecoveryBlocked, true);
        assert.equal(h.peerReads().length, 0);
        assert.equal(h.calls.filter(item => item[0] === 'activate').length, 0);
        assert.equal(h.notices.filter(item => item.type === 'ready' || item.type === 'conversation-switch-failed').length, 0);
    });
    test(`${change} after ready keeps its already queued peer timer inert`, async () => {
        const h = harness(); await h.switch(); const queued = h.latestTimer();
        if (change === 'different-owner') h.c.owner = 'owner-b';
        if (change === 'logout') h.c.owner = '';
        h.c.storageAccountEpoch++;
        h.fire(queued); await drain(); assert.equal(h.peerReads().length, 0);
    });
}

test('foreground scheduling does not cancel or restart a previously authorized in-flight peer read', async () => {
    const h = harness({ holdSession: true, holdLeave: true });
    const peer = deferred(); h.gates.set('card-c::conversation-c', peer);
    const pending = h.c.prefetchSession('card-c', 'conversation-c');
    const existing = h.c.sessionPrefetchCache.get('card-c::conversation-c');
    h.c.scheduleSessionPrefetch(); const old = h.latestTimer();
    const switched = h.switch();
    try {
        h.fire(old); await drain();
        assert.equal(h.c.sessionPrefetchCache.get('card-c::conversation-c'), existing);
        assert.equal(h.c.prefetchSession('card-c', 'conversation-c'), pending);
        assert.equal(h.requests.filter(item => item.app === 'card-c' && item.kind === 'session').length, 1);
        h.sessionGate.resolve(); h.leaveGate.resolve(); await switched;
        h.fire(h.latestTimer()); await drain();
        assert.equal(h.c.sessionPrefetchCache.get('card-c::conversation-c'), existing);
        assert.equal(h.requests.filter(item => item.app === 'card-c' && item.kind === 'session').length, 1);
        peer.resolve(); await pending;
    } finally {
        h.sessionGate.resolve(); h.leaveGate.resolve(); peer.resolve(); await switched; await pending;
    }
});

test('current administrator preview still starts no ordinary deferred peer requests', async () => {
    const h = harness({ nextPreview: true });
    await h.switch(); h.fire(h.latestTimer()); await drain();
    assert.equal(h.peerReads().length, 0); assert.equal(h.c.sessionPrefetchPeer, null);
});
