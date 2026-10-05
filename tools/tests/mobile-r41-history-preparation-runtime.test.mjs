import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sessionVM } from './helpers/bridge-session-vm.mjs';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(begin, end) {
    const from = source.indexOf(begin), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, 'Actual shipping function section exists'); return source.slice(from, to);
}
const clone = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const targets = () => [{ app_id: 'synthetic-a', conversation_id: 'synthetic-chat-a' }, { app_id: 'synthetic-b', conversation_id: 'synthetic-chat-b' }];
function fixture() {
    let clock = 100, requestHandler; const requests = [], fences = [], resources = [], marks = [], effects = [];
    const login = new Map([['ai_xingyue_logged_in', '1'], ['ai_xingyue_user', JSON.stringify({ id: 'owner' })]]);
    const c = sessionVM(source, {
        Date: { now: () => clock }, prewarmOnly: true, adminPreviewRequested: false, adminBinding: false,
        bridgeStartScheduled: false, requestedAppId: '', requestedConversationId: '', launch: null,
        hostBootstrapEngineToken: 'engine', hostBootstrapDocumentToken: 'document',
        storageOwner: 'owner', SESSION_CACHE_TTL_MS: 30_000, SESSION_PREFETCH_LIMIT: 2,
        clearCardTransportMemory() {}, AbortController,
        localStorage: { getItem: key => login.get(key) || null },
        chatOutbox: { fence: async scope => { fences.push(scope); return { revision: 0, ackRevision: 0, commitId: null }; }, read: async () => null },
        prepareConversationResources: (app, chat) => { resources.push([app, chat]); },
        requestJson: async path => {
            requests.push(path); if (requestHandler) return requestHandler(path);
            const params = new URL(path, 'http://fixture.invalid').searchParams;
            return { user: { id: 'owner' }, launch: { app_id: params.get('app_id'), conversation_id: params.get('conversation_id'),
                bridge_token: 'synthetic-only', card: { name: 'Synthetic source' }, messages: [{ content: 'fresh response ' + requests.length }] } };
        },
        performance: { mark: name => marks.push(name) },
        canNotifyHost: () => true, HOST_CHANNEL: 'channel',
        window: { location: { origin: 'http://fixture.invalid' }, parent: {} },
        importLaunchCharacter: () => effects.push('import'), loadCloudChat: () => effects.push('chat'),
        bootstrapLaunch: () => effects.push('activate'), generate: () => effects.push('generate'),
    });
    vm.runInContext(section('function sessionCacheKey(', 'function scheduleSessionPrefetch('), c);
    vm.runInContext(section('async function receiveHostCommand(', "window.addEventListener('message'"), c);
    const message = extra => ({ type: 'prepare-history-conversations', targets: targets(), owner: 'owner',
        engine_token: 'engine', document_token: 'document', expires_at: clock + 30_000, ...extra });
    const event = data => ({ origin: 'http://fixture.invalid', source: c.window.parent, data: { channel: 'channel', version: 1, ...data } });
    return { c, requests, fences, resources, marks, effects, message, event,
        prepare: extra => c.prepareColdHistoryConversations(message(extra)),
        settle: async () => { const pending = [...c.sessionPrefetchCache.values()].map(entry => entry.promise); const result = await Promise.allSettled(pending); await turn(); return result; },
        tick(amount) { clock += amount; }, setRequest(handler) { requestHandler = handler; },
        changeOwner(owner) { login.set('ai_xingyue_logged_in', owner ? '1' : '0'); login.set('ai_xingyue_user', JSON.stringify({ id: owner })); c.reconcileStorageAccount(); } };
}
function assertNoPreparation(h) { assert.deepEqual(h.requests, []); assert.deepEqual(h.fences, []); assert.deepEqual(h.resources, []); assert.deepEqual(h.effects, []); }

test('actual empty-engine handler atomically retains two peers and runs only fresh fenced read preparation', async () => {
    const h = fixture(); h.c.sessionPrefetchCache.set('old::old', {}); h.prepare();
    assert.deepEqual([...h.c.sessionPrefetchCache.keys()], ['synthetic-a::synthetic-chat-a', 'synthetic-b::synthetic-chat-b']);
    const outcomes = await h.settle(); assert.ok(outcomes.every(item => item.status === 'fulfilled'));
    assert.equal(h.requests.length, 2); assert.deepEqual(h.resources, [['synthetic-a', 'synthetic-chat-a'], ['synthetic-b', 'synthetic-chat-b']]);
    assert.deepEqual(h.fences.map(JSON.parse), targets().map(t => ['owner', t.app_id, t.conversation_id]));
    for (const row of h.c.sessionPrefetchCache.values()) {
        const payload = await row.promise, ticket = h.c.sessionReadFences.get(payload);
        assert.equal(ticket.raw, true); assert.equal(row.expiresAt, 30_100); assert.equal(ticket.owner, 'owner');
    }
    assert.equal(h.c.launch, null); assert.equal(h.c.requestedAppId, ''); assert.equal(h.c.requestedConversationId, '');
    assert.equal(h.c.bridgeStartScheduled, false); assert.deepEqual(h.effects, []);
});

test('fresh history messages retain normal origin, parent WindowProxy, channel and version checks', async () => {
    const h = fixture(), event = h.event(h.message());
    for (const bad of [{ origin: 'https://foreign.invalid' }, { source: {} }, { data: { ...event.data, channel: 'other' } },
        { data: { ...event.data, version: 2 } }]) await h.c.receiveHostCommand({ ...event, ...bad });
    assertNoPreparation(h); await h.c.receiveHostCommand(event); await h.settle(); assert.equal(h.requests.length, 2);
});

test('bound/admin/launch/binding/target documents never prepare speculative history', async () => {
    for (const [key, value] of Object.entries({ prewarmOnly: false, adminPreviewRequested: true, adminBinding: true,
        bridgeStartScheduled: true, requestedAppId: 'bound', requestedConversationId: 'bound', launch: {}, hostBootstrapEngineToken: '' })) {
        const h = fixture(); h.c[key] = value; h.prepare(); await h.settle(); assertNoPreparation(h);
    }
});

test('engine/document/strict owner mismatch and unavailable login cannot start private reads', async () => {
    for (const extra of [{ engine_token: 'old' }, { document_token: 'old' }, { owner: 'other' }, { owner: '' }]) {
        const h = fixture(); h.prepare(extra); await h.settle(); assertNoPreparation(h);
    }
    const h = fixture(); h.changeOwner(''); h.prepare(); await h.settle(); assertNoPreparation(h);
});

test('expiry is required, finite, future and no more than the original thirty-second window', async () => {
    for (const expiry of [undefined, null, '30100', NaN, Infinity, 100, 99, 30_101]) {
        const h = fixture(); h.prepare({ expires_at: expiry }); await h.settle(); assertNoPreparation(h);
    }
    const h = fixture(); h.prepare({ expires_at: 101 }); await h.settle(); assert.equal(h.requests.length, 2);
});

test('invalid or partially malformed whole batches leave existing retained rows untouched', async () => {
    const batches = [undefined, {}, [], [...targets(), { app_id: 'third', conversation_id: 'third' }],
        [targets()[0], null], [targets()[0], []], [targets()[0], { app_id: 4, conversation_id: 'chat' }],
        [targets()[0], { app_id: '', conversation_id: 'chat' }], [targets()[0], { app_id: 'valid', conversation_id: ' ' }],
        [targets()[0], { app_id: 'x'.repeat(161), conversation_id: 'valid' }],
        [targets()[0], { app_id: 'valid', conversation_id: 'x'.repeat(161) }]];
    for (const batch of batches) {
        const h = fixture(), old = {}; h.c.sessionPrefetchCache.set('old::old', old); h.prepare({ targets: batch });
        await h.settle(); assertNoPreparation(h); assert.equal(h.c.sessionPrefetchCache.size, 1);
        assert.equal(h.c.sessionPrefetchCache.get('old::old'), old);
    }
});

test('duplicates use one existing promise, and separator-colliding distinct pairs reject the entire batch', async () => {
    const h = fixture(); h.prepare({ targets: [targets()[0], targets()[0]] }); const first = h.c.sessionPrefetchCache.values().next().value.promise;
    h.prepare({ targets: [targets()[0]] }); await h.settle(); assert.equal(h.requests.length, 1);
    assert.equal(h.c.sessionPrefetchCache.values().next().value.promise, first);
    const bad = fixture(); bad.prepare({ targets: [{ app_id: 'a::b', conversation_id: 'c' }, { app_id: 'a', conversation_id: 'b::c' }] });
    await bad.settle(); assertNoPreparation(bad);
});

test('repeated two-peer preparation reuses actual same-scope thirty-second session flights', async () => {
    const h = fixture(); h.prepare(); const first = [...h.c.sessionPrefetchCache.values()].map(row => row.promise);
    h.prepare(); await h.settle(); assert.equal(h.requests.length, 2); assert.equal(h.fences.length, 2);
    assert.deepEqual([...h.c.sessionPrefetchCache.values()].map(row => row.promise), first);
    assert.equal(h.c.sessionPrefetchCache.size, 2);
});

test('a validated explicit target has priority before bind and ignores any later history batch', async () => {
    const h = fixture(); h.prepare(); const retained = h.c.sessionPrefetchCache.get('synthetic-a::synthetic-chat-a').promise;
    h.c.prepareColdConversation({ owner: 'owner', engine_token: 'engine', document_token: 'document',
        app_id: 'synthetic-a', conversation_id: 'synthetic-chat-a' }); h.prepare(); await h.settle();
    assert.deepEqual([...h.c.sessionPrefetchCache.keys()], ['synthetic-a::synthetic-chat-a']);
    assert.equal(h.c.sessionPrefetchCache.values().next().value.promise, retained); assert.equal(h.requests.length, 2);
});

test('invalid explicit selections cannot poison future valid history preparation', async () => {
    for (const patch of [{ owner: 'other' }, { engine_token: 'old' }, { document_token: 'old' }, { app_id: '' }]) {
        const h = fixture(); h.c.prepareColdConversation({ owner: 'owner', engine_token: 'engine', document_token: 'document',
            app_id: 'selected', conversation_id: 'selected-chat', ...patch }); h.prepare(); await h.settle(); assert.equal(h.requests.length, 2);
    }
});

test('owner or same-owner logout epoch changes discard late raw responses without applying cards', async () => {
    for (const action of ['other-owner', 'same-owner-logout']) {
        const h = fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
        h.setRequest(async path => { await gate; const q = new URL(path, 'http://fixture.invalid').searchParams;
            return { user: { id: 'owner' }, launch: { app_id: q.get('app_id'), conversation_id: q.get('conversation_id'), bridge_token: 'synthetic-only', card: { name: 'Synthetic' }, messages: [] } }; });
        h.prepare(); const work = [...h.c.sessionPrefetchCache.values()].map(row => row.promise); await Promise.resolve();
        if (action === 'other-owner') h.changeOwner('other'); else h.c.invalidateStorageAccount();
        release(); const outcomes = await Promise.allSettled(work); assert.ok(outcomes.every(row => row.status === 'rejected'));
        assert.equal(h.c.sessionPrefetchCache.size, 0); assert.equal(h.c.launch, null); assert.deepEqual(h.effects, []);
    }
});

test('an owner change during resource preparation cannot dispatch the second target', async () => {
    const h = fixture(); h.c.prepareConversationResources = (...pair) => { h.resources.push(pair); h.changeOwner('other'); };
    h.prepare(); await turn(); assert.equal(h.fences.length, 1); assert.equal(h.resources.length, 1);
    assert.equal(h.c.sessionPrefetchCache.size, 0); assert.deepEqual(h.effects, []);
});

test('same-owner epoch change during resource preparation also prevents the second target', async () => {
    const h = fixture(); h.c.prepareConversationResources = (...pair) => { h.resources.push(pair); h.c.invalidateStorageAccount(); };
    h.prepare(); await turn(); assert.equal(h.fences.length, 1); assert.equal(h.resources.length, 1);
    assert.equal(h.c.sessionPrefetchCache.size, 0); assert.deepEqual(h.effects, []);
});

test('failed authenticated preparation releases the failed peer and never fabricates a launch', async () => {
    const h = fixture(); h.setRequest(async () => { throw Error('HTTP 403 synthetic'); }); h.prepare();
    const outcomes = await h.settle(); assert.ok(outcomes.every(row => row.status === 'rejected'));
    assert.equal(h.c.sessionPrefetchCache.size, 0); assert.equal(h.c.launch, null); assert.deepEqual(h.effects, []);
});

test('normal thirty-second expiry causes a new fresh fenced read instead of consuming an expired history payload', async () => {
    const h = fixture(); h.prepare({ targets: [targets()[0]] }); await h.settle(); assert.equal(h.requests.length, 1);
    const old = h.c.sessionPrefetchCache.values().next().value.promise; h.tick(30_000);
    h.prepare({ targets: [targets()[0]] }); await h.settle(); assert.equal(h.requests.length, 2); assert.equal(h.fences.length, 2);
    assert.notEqual(h.c.sessionPrefetchCache.values().next().value.promise, old); assert.deepEqual(h.effects, []);
});

test('the selected peer uses the original one-use raw/fence consumption rather than a projected preview', async () => {
    const h = fixture(); h.prepare({ targets: [targets()[0]] }); await h.settle();
    const row = h.c.sessionPrefetchCache.values().next().value, raw = await row.promise;
    assert.equal(h.c.sessionReadFences.get(raw).raw, true);
    const consumed = await h.c.takePrefetchedSession('synthetic-a', 'synthetic-chat-a');
    assert.deepEqual(clone(consumed.launch.card), { name: 'Synthetic source' });
    assert.equal(h.c.sessionReadFences.get(consumed).raw, false); assert.equal(h.requests.length, 1);
    assert.equal(h.c.sessionPrefetchCache.size, 0); assert.deepEqual(h.effects, []);
});
