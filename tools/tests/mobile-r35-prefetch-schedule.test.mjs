import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function sourceBetween(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `actual bridge function boundaries: ${start}`);
    return source.slice(first, last);
}

function harness({ launch, conversations, owner = 'fixture-owner', epoch = 3 } = {}) {
    const calls = [], timers = [], cancelled = [];
    const login = new Map([
        ['ai_xingyue_logged_in', owner ? '1' : '0'],
        ['ai_xingyue_user', JSON.stringify({ id: owner })],
    ]);
    const context = { launch: launch || { app_id: 'a', conversation_id: 'active' }, runtimeUiData: { conversations: conversations || [
        { id: 'active', app_id: 'a' }, { id: 'peer-1', app_id: 'b' }, { conversation_id: 'peer-2', app_id: 'c' }, { id: 'peer-3', app_id: 'd' },
    ] }, SESSION_PREFETCH_LIMIT: 2, sessionPrefetchTimer: 42,
    sessionPrefetchPeer: null, sessionPrefetchCache: new Map(), loadingLaunch: false,
    storageOwner: owner, verifiedStorageOwner: '', storageAccountEpoch: epoch,
    storageRequests: new Set(), cardPreparations: new Map(), storageAckStamps: new Map(),
    preparedAdminLaunch: null, scopeDrafts: new Map(),
    clearCardTransportMemory() {},
    localStorage: { getItem: key => login.get(key) ?? null },
    window: { clearTimeout: value => cancelled.push(value), setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; } },
    prepareConversationResources() {},
    prefetchSession: (...args) => { calls.push(args); return Promise.resolve(); } };
    vm.createContext(context);
    vm.runInContext(sourceBetween('function authenticatedStorageOwner(', 'async function requestScopedStorage('), context);
    vm.runInContext(sourceBetween('function sessionCacheKey(', 'function invalidateCachedSession('), context);
    vm.runInContext(sourceBetween('function scheduleSessionPrefetch(', 'function setAccessClasses('), context);
    const fire = () => timers.at(-1)?.callback();
    const setOwner = nextOwner => {
        login.set('ai_xingyue_logged_in', nextOwner ? '1' : '0');
        login.set('ai_xingyue_user', JSON.stringify({ id: nextOwner }));
    };
    return { context, calls, timers, cancelled, fire, setOwner };
}

function displacedPreviousHarness() {
    return harness({ launch: { app_id: 'card-b', conversation_id: 'B' }, conversations: [
        { id: 'B', app_id: 'card-b' },
        { id: 'newer-1', app_id: 'card-c' },
        { id: 'newer-2', app_id: 'card-d' },
        { id: 'A', app_id: 'card-a' },
    ] });
}
const previousA = () => ({ app_id: 'card-a', conversation_id: 'A' });

test('a fast return can use bounded read-only preparation without an extra fixed delay', () => {
    const h = harness(); h.context.scheduleSessionPrefetch();
    assert.deepEqual(h.cancelled, [42]);
    assert.equal(h.timers[0].delay, 0);
    h.timers[0].callback();
    assert.deepEqual(h.calls, [['b', 'peer-1'], ['c', 'peer-2']]);
});
test('a queued old launch job cannot prefetch for a changed launch; a new schedule uses that launch', () => {
    const h = harness(); h.context.scheduleSessionPrefetch();
    h.context.launch = { app_id: 'b', conversation_id: 'peer-1' };
    h.timers[0].callback();
    assert.deepEqual(h.calls, []);
    h.context.scheduleSessionPrefetch(); h.fire();
    assert.deepEqual(h.calls, [['a', 'active'], ['c', 'peer-2']]);
});
test('failed background reads remain normal failures, not unhandled promises or a generation', async () => {
    const h = harness(); h.context.prefetchSession = (...args) => { h.calls.push(args); return Promise.reject(Error('synthetic offline')); };
    h.context.scheduleSessionPrefetch(); h.timers[0].callback();
    await Promise.resolve();
    assert.equal(h.calls.length, 2);
});

test('the previous ordinary peer precedes newer history entries even when displaced beyond latest two', () => {
    const h = displacedPreviousHarness();
    h.context.scheduleSessionPrefetch(previousA()); h.fire();
    assert.deepEqual(h.calls, [['card-a', 'A'], ['card-c', 'newer-1']]);
});

test('default history refresh retains the previous peer only for the same current scope', () => {
    const h = displacedPreviousHarness();
    h.context.scheduleSessionPrefetch(previousA()); h.fire();
    h.calls.length = 0;
    h.context.runtimeUiData.conversations = [
        { id: 'newest', app_id: 'card-z' }, { id: 'second', app_id: 'card-y' },
    ];
    h.context.scheduleSessionPrefetch(); h.fire();
    assert.deepEqual(h.calls, [['card-a', 'A'], ['card-z', 'newest']]);
});

test('a new current scope cannot inherit the previous scope peer on a default refresh', () => {
    const h = displacedPreviousHarness();
    h.context.scheduleSessionPrefetch(previousA()); h.fire(); h.calls.length = 0;
    h.context.launch = { app_id: 'card-c', conversation_id: 'newer-1' };
    h.context.scheduleSessionPrefetch(); h.fire();
    assert.deepEqual(h.calls, [['card-b', 'B'], ['card-d', 'newer-2']]);
});

test('previous peer is deduplicated against history while at most two unique pairs are prepared', () => {
    const h = harness({ launch: { app_id: 'card-b', conversation_id: 'B' }, conversations: [
        { id: 'A', app_id: 'card-a' }, { conversation_id: 'A', app_id: 'card-a' },
        { id: 'C', app_id: 'card-c' }, { id: 'D', app_id: 'card-d' },
    ] });
    h.context.scheduleSessionPrefetch(previousA()); h.fire();
    assert.deepEqual(h.calls, [['card-a', 'A'], ['card-c', 'C']]);
});

test('invalid history and preferred identifiers do not consume either of the two slots', () => {
    const h = harness({ conversations: [
        { id: 'missing-app' }, { id: ' ', app_id: 'invalid' }, { app_id: 'missing-conversation' },
        { id: ' peer-1 ', app_id: ' b ' }, { conversation_id: 'peer-2', app_id: 'c' },
    ] });
    h.context.scheduleSessionPrefetch({ app_id: ' ', conversation_id: 'old' }); h.fire();
    assert.deepEqual(h.calls, [['b', 'peer-1'], ['c', 'peer-2']]);
});

test('current pair is excluded but the same conversation identifier in another app remains eligible', () => {
    const h = harness({ conversations: [
        { id: 'active', app_id: 'a' }, { id: 'active', app_id: 'other-app' },
        { id: 'peer-1', app_id: 'b' },
    ] });
    h.context.scheduleSessionPrefetch({ app_id: 'a', conversation_id: 'active' }); h.fire();
    assert.deepEqual(h.calls, [['other-app', 'active'], ['b', 'peer-1']]);
});

test('bounded scheduling evicts unwanted cached peers without aborting already authorized reads', () => {
    const h = displacedPreviousHarness();
    let aborted = 0;
    const staleKey = h.context.sessionCacheKey('stale-app', 'stale');
    const wantedKey = h.context.sessionCacheKey('card-a', 'A');
    h.context.sessionPrefetchCache.set(staleKey, { promise: Promise.resolve(), abort: () => aborted++ });
    h.context.sessionPrefetchCache.set(wantedKey, { promise: Promise.resolve(), abort: () => aborted++ });
    h.context.scheduleSessionPrefetch(previousA()); h.fire();
    assert.equal(h.context.sessionPrefetchCache.has(staleKey), false);
    assert.equal(h.context.sessionPrefetchCache.has(wantedKey), true);
    assert.equal(aborted, 0);
});

for (const change of ['owner', 'same-owner-epoch', 'current-app', 'current-conversation', 'preview']) {
    test(`a queued previous-peer job is inert after ${change} changes`, () => {
        const h = displacedPreviousHarness();
        h.context.scheduleSessionPrefetch(previousA());
        if (change === 'owner') h.setOwner('fixture-other-owner');
        if (change === 'same-owner-epoch') h.context.storageAccountEpoch++;
        if (change === 'current-app') h.context.launch = { ...h.context.launch, app_id: 'new-app' };
        if (change === 'current-conversation') h.context.launch = { ...h.context.launch, conversation_id: 'new-conversation' };
        if (change === 'preview') h.context.launch = { ...h.context.launch, admin_preview: true };
        h.fire();
        assert.deepEqual(h.calls, []);
    });
}

test('current preview launches schedule no background peer reads', () => {
    const h = displacedPreviousHarness();
    h.context.launch.admin_preview = true;
    h.context.scheduleSessionPrefetch(previousA()); h.fire();
    assert.deepEqual(h.calls, []);
});

test('a previous preview does not become the current ordinary launch preferred peer', () => {
    const h = displacedPreviousHarness();
    h.context.scheduleSessionPrefetch({ ...previousA(), admin_preview: true }); h.fire();
    assert.deepEqual(h.calls, [['card-c', 'newer-1'], ['card-d', 'newer-2']]);
});

test('a server-verified cookie-only owner can schedule ordinary scoped read-only preparation', () => {
    const h = harness({ owner: '' });
    h.context.acceptVerifiedSessionOwner({ user: { id: 'fixture-cookie-owner' } }, '', h.context.storageAccountEpoch);
    h.context.scheduleSessionPrefetch(); h.fire();
    assert.deepEqual(h.calls, [['b', 'peer-1'], ['c', 'peer-2']]);
});

test('an unverified empty owner cannot start private peer reads', () => {
    const h = harness({ owner: '' });
    h.context.scheduleSessionPrefetch(); h.fire();
    assert.deepEqual(h.calls, []);
});

test('an already queued superseded timer cannot execute even in the same owner and current scope', () => {
    const h = displacedPreviousHarness();
    h.context.scheduleSessionPrefetch(previousA());
    const oldTimer = h.timers.at(-1);
    h.context.scheduleSessionPrefetch({ app_id: 'card-e', conversation_id: 'E' });
    assert.ok(h.cancelled.includes(1));
    oldTimer.callback();
    assert.deepEqual(h.calls, []);
    h.fire();
    assert.deepEqual(h.calls, [['card-e', 'E'], ['card-c', 'newer-1']]);
});

test('actual account invalidation clears remembered peer and prevents a same-owner relogin old job', () => {
    const h = displacedPreviousHarness();
    h.context.scheduleSessionPrefetch(previousA());
    h.context.sessionPrefetchPeer ??= { fixture: 'remembered-peer' };
    const initialEpoch = h.context.storageAccountEpoch;
    h.context.invalidateStorageAccount();
    assert.equal(h.context.sessionPrefetchPeer, null);
    assert.ok(h.context.storageAccountEpoch > initialEpoch);
    h.context.reconcileStorageAccount(); h.fire();
    assert.deepEqual(h.calls, []);
});

test('actual owner reconciliation clears remembered peer and does not carry it into the new account', () => {
    const h = displacedPreviousHarness();
    h.context.scheduleSessionPrefetch(previousA());
    h.context.sessionPrefetchPeer ??= { fixture: 'remembered-peer' };
    h.setOwner('fixture-other-owner'); h.context.reconcileStorageAccount();
    assert.equal(h.context.sessionPrefetchPeer, null);
    h.context.scheduleSessionPrefetch(); h.fire();
    assert.deepEqual(h.calls, [['card-c', 'newer-1'], ['card-d', 'newer-2']]);
});

test('late default refresh after account epoch change cannot revive the remembered previous peer', () => {
    const h = displacedPreviousHarness();
    h.context.scheduleSessionPrefetch(previousA()); h.fire(); h.calls.length = 0;
    h.context.storageAccountEpoch++;
    h.context.scheduleSessionPrefetch(); h.fire();
    assert.deepEqual(h.calls, [['card-c', 'newer-1'], ['card-d', 'newer-2']]);
});

test('rejected previous-peer reads remain handled background failures for every selected pair', async () => {
    const h = displacedPreviousHarness();
    h.context.prefetchSession = (...args) => { h.calls.push(args); return Promise.reject(Error('synthetic offline')); };
    h.context.scheduleSessionPrefetch(previousA()); h.fire();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.calls, [['card-a', 'A'], ['card-c', 'newer-1']]);
});
