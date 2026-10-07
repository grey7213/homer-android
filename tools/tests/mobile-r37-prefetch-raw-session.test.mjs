import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sessionVM } from './helpers/bridge-session-vm.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';
import { createChatOutbox, OUTBOX_ACK_MAX_ROWS } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { capturePromptMessageState, clearPromptMessageState } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';

// Shipping bridge/account/session functions and shipping outbox. The IDB
// transaction double is deterministic; these are not browser timing claims.
const source = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const begin = source.indexOf('function sessionCacheKey(');
const end = source.indexOf('function scheduleSessionPrefetch(', begin);
assert.ok(begin >= 0 && end > begin, 'Actual prefetch/take source boundaries exist');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};
const OWNER = 'raw-session-fixture-owner';
const APP = 'raw-session-fixture-card';
const CONVERSATION = 'raw-session-fixture-conversation';
const scopeKey = (owner = OWNER, app = APP, conversation = CONVERSATION) => JSON.stringify([owner, app, conversation]);
const localMessage = (text, options = {}) => ({
    name: 'Fixture', is_user: false, is_system: false,
    mes: text, swipes: [text, text + ' alternate'], swipe_id: 0,
    swipe_info: [{ extra: { retained: true } }, { extra: {} }],
    extra: { homer_message_id: 'fixture-message', homer_sync_id: 'fixture-message', retained: { value: true } },
    ...options,
});
const cloudMessage = message => ({
    id: message.extra.homer_message_id || message.extra.homer_sync_id,
    role: message.is_system && !message.extra.homer_hidden ? 'system' : message.is_user ? 'user' : 'assistant',
    content: message.mes, swipes: [...message.swipes], swipe_index: message.swipe_id, created_at: 123,
});
const cloudSession = (text = 'fresh cloud', { launch = {}, ...options } = {}) => ({
    user: { id: OWNER },
    ...options,
    launch: {
        app_id: APP, conversation_id: CONVERSATION,
        card: { data: { name: 'Fixture' } }, bridge_token: true,
        messages: [cloudMessage(localMessage(text))],
        ...launch,
    },
});
function promptSnapshot(text = 'UNCHANGED') {
    const message = localMessage(text, {
        is_ejs_processed: [true], variables: [{ count: 1, nested: { value: 'once' } }], variables_initialized: [],
    });
    const captured = capturePromptMessageState(message);
    const saved = clone(message);
    clearPromptMessageState(saved);
    Object.assign(saved, captured.values);
    saved.extra.homer_prompt_state = captured.descriptor;
    return saved;
}

function harness(t, { cookieOnly = false } = {}) {
    const indexedDB = transactionIDB();
    const outbox = createChatOutbox({ indexedDB, databaseName: 'raw-session-unit-outbox' });
    t.after(() => outbox.close());
    const login = new Map(cookieOnly ? [] : [
        ['ai_xingyue_logged_in', '1'], ['ai_xingyue_user', JSON.stringify({ id: OWNER })],
    ]);
    const requests = [], reads = [], fences = [];
    let requestHandler = () => cloudSession();
    const originalRead = outbox.read.bind(outbox);
    const originalFence = outbox.fence.bind(outbox);
    outbox.read = async (...args) => { reads.push(args); return originalRead(...args); };
    outbox.fence = async (...args) => { fences.push(args); return originalFence(...args); };
    const context = sessionVM(source, {
        MODULE_ID: 'raw-session-unit', AbortController,
        chatOutbox: outbox, storageOwner: cookieOnly ? '' : OWNER,
        clearCardTransportMemory() {},
        localStorage: { getItem: key => login.get(key) || null },
        SESSION_CACHE_TTL_MS: 30_000,
        requestJson: async path => {
            requests.push(path);
            return requestHandler(path, requests.length);
        },
    });
    vm.runInContext(source.slice(begin, end), context);
    const cacheKey = (app = APP, conversation = CONVERSATION) => context.sessionCacheKey(app, conversation);
    const installCached = payload => context.sessionPrefetchCache.set(cacheKey(), {
        promise: Promise.resolve(payload), expiresAt: Date.now() + 30_000,
    });
    const prepare = (messages, { owner = OWNER, app = APP, conversation = CONVERSATION, kind = 'chat' } = {}) => outbox.prepare({
        scope: scopeKey(owner, app, conversation),
        body: JSON.stringify(kind === 'chat'
            ? { app_id: app, conversation_id: conversation, title: 'Fixture', messages }
            : { app_id: app, conversation_id: conversation, extension_settings: { fixture: true } }),
    }, kind);
    const changeOwner = owner => {
        if (!owner) {
            login.clear(); context.invalidateStorageAccount();
        } else {
            login.set('ai_xingyue_logged_in', '1');
            login.set('ai_xingyue_user', JSON.stringify({ id: owner }));
            context.reconcileStorageAccount();
        }
    };
    return {
        context, indexedDB, outbox, originalRead, requests, reads, fences,
        prepare, cacheKey, installCached, changeOwner,
        setRequest: handler => { requestHandler = handler; },
        prefetch: () => context.prefetchSession(APP, CONVERSATION),
        take: () => context.takePrefetchedSession(APP, CONVERSATION),
        fetch: () => context.fetchSession(APP, CONVERSATION),
        acknowledge: (committed, messages) => context.acknowledgeStorage(committed, { messages }),
    };
}

function assertCloudUnprojected(payload, expectedMessages) {
    assert.deepEqual(clone(payload.launch.messages), expectedMessages);
    assert.equal(Object.hasOwn(payload.launch, 'local_chat'), false);
    assert.equal(Object.hasOwn(payload.launch, 'local_pending'), false);
}

test('prefetch defers the whole local read and preserves raw fresh cloud with its original read ticket', async t => {
    const h = harness(t);
    await h.prepare([localMessage('pending local')]);
    const fresh = cloudSession('unmodified cloud');
    const expected = clone(fresh.launch.messages);
    h.setRequest(() => fresh);
    const raw = await h.prefetch();
    assert.equal(h.reads.length, 0, 'Peer prefetch must not read/parse/project the full local body');
    assert.equal(h.requests.length, 1);
    assertCloudUnprojected(raw, expected);
    const ticket = h.context.sessionReadFences.get(raw);
    assert.equal(ticket.raw, true);
    assert.equal(ticket.owner, OWNER);
    assert.equal(ticket.epoch, 0);
    assert.equal(ticket.scope, scopeKey());
    assert.equal(ticket.fence.revision, 1);
    assert.equal(ticket.fence.ackRevision, 0);
    assert.equal(ticket.stamp, h.context.storageAckStamps.get(h.context.storageAckKey(scopeKey())));
    assert.equal(ticket.version, 0);
});

test('explicit deferred fetch has zero local reads while default fetch still merges once', async t => {
    const rawHarness = harness(t), normalHarness = harness(t);
    await rawHarness.prepare([localMessage('raw harness local')]);
    await normalHarness.prepare([localMessage('normal harness local')]);
    const raw = await rawHarness.context.fetchSession(APP, CONVERSATION, false, 0, { deferLocalMerge: true });
    const normal = await normalHarness.fetch();
    assert.equal(normalHarness.reads.length, 1);
    assert.equal(normal.launch.local_chat[0].mes, 'normal harness local');
    assert.equal(normal.launch.local_pending, true);
    assert.equal(rawHarness.reads.length, 0);
    assertCloudUnprojected(raw, cloudSession().launch.messages);
});

test('a prefetched session consumes one fresh local read and is released from the cache', async t => {
    const h = harness(t);
    await h.prefetch();
    assert.equal(h.context.sessionPrefetchCache.size, 1);
    const result = await h.take();
    assertCloudUnprojected(result, cloudSession().launch.messages);
    assert.equal(h.reads.length, 1, 'Prefetch plus take must perform exactly one complete local read');
    assert.equal(h.requests.length, 1);
    assert.equal(h.context.sessionPrefetchCache.size, 0);
});

test('consume freshly reads a save committed after prefetch and preserves complete 3MB canonical data', async t => {
    const h = harness(t);
    await h.prefetch();
    const large = 'x'.repeat(3_000_000);
    const messages = [localMessage(large, { is_system: true,
        extra: { homer_hidden: true, homer_sync_id: 'large-message', retained: { nested: [1, 2] } } })];
    await h.prepare(messages);
    const before = h.reads.length;
    const result = await h.take();
    assert.equal(h.reads.length - before, 1);
    assert.deepEqual(clone(result.launch.local_chat), messages);
    assert.equal(result.launch.local_pending, true);
    assert.equal(result.launch.messages[0].role, 'assistant');
    assert.equal(result.launch.messages[0].swipes[1], large + ' alternate');
});

test('consume retains the original GET fence across a subsequent same-scope ACK and clears pending', async t => {
    const h = harness(t), message = localMessage('last complete local');
    const committed = await h.prepare([message]);
    const raw = await h.prefetch();
    const ticket = h.context.sessionReadFences.get(raw);
    const ack = { id: 'assigned-cloud-id', role: 'assistant', content: message.mes,
        created_at: 456, swipes: [...message.swipes], swipe_index: 0 };
    await h.acknowledge(committed, [ack]);
    const result = await h.take();
    assert.equal(h.reads.at(-1)[2], ticket.fence, 'Do not replace the original GET fence with a current one');
    assert.equal(result.launch.local_chat[0].mes, message.mes);
    assert.equal(result.launch.local_chat[0].extra.homer_message_id, ack.id);
    assert.equal(result.launch.local_chat[0].extra.homer_created_at, 456);
    assert.equal(result.launch.local_pending, false);
});

test('cookie-only pending prefetch followed by a same-scope ACK keeps complete phone history without another cloud read', async t => {
    const h = harness(t, { cookieOnly: true }), message = localMessage('complete cookie-only local reply');
    const committed = await h.prepare([message]);
    h.setRequest((_path, count) => cloudSession(count === 1 ? 'cloud before cookie-only ACK' : message.mes));
    const raw = await h.prefetch();
    const ticket = h.context.sessionReadFences.get(raw);
    assert.equal(ticket.fence, null, 'An unknown initial cookie owner has no pre-GET local fence');
    assert.equal(ticket.version, 0);
    assert.equal(h.context.reconcileStorageAccount(), OWNER);
    await h.acknowledge(committed, [cloudMessage(message)]);
    const retained = await h.originalRead(scopeKey());
    assert.ok(retained, 'The ACK row remains present: this is not the existing missing-row guard');
    assert.equal(retained.pending, false);
    assert.equal(retained.ackRevision, retained.revision);
    assert.equal(ticket.stamp.version, 1);
    const result = await h.take();
    assert.equal(result.launch.messages[0].content, message.mes,
        'A null-fence ACK change must not return the pre-ACK cloud body');
    assert.equal(h.requests.length, 1, 'The now-verified phone archive does not need another cloud read');
    assert.equal(result.launch.local_chat[0].mes, message.mes);
    assert.equal(result.launch.local_pending, false);
    assert.equal(h.context.sessionPrefetchCache.size, 0);
});

test('cookie-only null-fence ACK during consume read delivery cannot replace complete phone progress', async t => {
    const h = harness(t, { cookieOnly: true }), message = localMessage('reply acknowledged during consume read');
    const committed = await h.prepare([message]);
    h.setRequest((_path, count) => cloudSession(count === 1 ? 'cloud before consume-read ACK' : message.mes));
    const raw = await h.prefetch(), ticket = h.context.sessionReadFences.get(raw);
    assert.equal(ticket.fence, null);
    assert.equal(ticket.version, 0);
    const readReached = deferred(), deliverRead = deferred();
    let firstRead = true;
    h.outbox.read = async (...args) => {
        h.reads.push(args);
        const snapshot = await h.originalRead(...args);
        if (firstRead) {
            firstRead = false;
            assert.equal(snapshot.pending, true, 'The real read completed before the ACK; only its delivery is held');
            readReached.resolve();
            await deliverRead.promise;
        }
        return snapshot;
    };
    const taken = h.take();
    try {
        await readReached.promise;
        assert.equal(h.requests.length, 1, 'The prefetched GET is still the only GET while its consume read waits');
        await h.acknowledge(committed, [cloudMessage(message)]);
        assert.equal(ticket.stamp.version, 1);
    } finally {
        deliverRead.resolve();
    }
    const result = await taken;
    assert.equal(h.requests.length, 1, 'An ACK cannot make complete phone progress wait for another cloud read');
    assert.equal(h.reads.length, 1);
    assert.equal(result.launch.local_chat[0].mes, message.mes);
    assert.equal(result.launch.messages[0].content, message.mes);
    assert.equal(result.launch.local_pending, true, 'A pre-ACK durable snapshot may retain its safe pending status until replay reconciles');
    assert.equal(h.context.sessionPrefetchCache.size, 0);
});

test('cookie-only null-fence stamp identity eviction does not discard an intact phone ACK archive', async t => {
    const h = harness(t, { cookieOnly: true }), message = localMessage('earlier stable cookie local');
    const committed = await h.prepare([message]);
    await h.outbox.cloudACK(committed, { messages: [cloudMessage(message)] });
    h.setRequest((_path, count) => cloudSession(count === 1 ? 'cloud under previous stamp identity' : 'fresh cloud under new stamp identity'));
    const raw = await h.prefetch();
    const ticket = h.context.sessionReadFences.get(raw);
    assert.equal(ticket.fence, null);
    for (let i = 0; i < 65; i++) h.context.storageAckStamp(scopeKey(OWNER, 'other-card', 'cookie-stamp-' + i));
    assert.equal(h.context.storageAckStamps.get(h.context.storageAckKey(scopeKey())), undefined);
    assert.equal(ticket.stamp.version, 0, 'Identity invalidation does not require a same-scope version increment');
    assert.ok(await h.originalRead(scopeKey()), 'The local row remains after only in-memory stamp eviction');
    const result = await h.take();
    assert.equal(result.launch.messages[0].content, message.mes);
    assert.equal(result.launch.local_chat[0].mes, message.mes);
    assert.equal(result.launch.local_pending, false);
    assert.equal(h.requests.length, 1);
});

test('cookie-only null fence with no intervening ACK keeps the complete phone history over a remote edit', async t => {
    const h = harness(t, { cookieOnly: true }), message = localMessage('old acknowledged local body');
    const committed = await h.prepare([message]);
    await h.outbox.cloudACK(committed, { messages: [cloudMessage(message)] });
    const fresh = cloudSession('REMOTE AUTHORITATIVE EDIT');
    h.setRequest(() => fresh);
    const raw = await h.prefetch();
    const ticket = h.context.sessionReadFences.get(raw);
    assert.equal(ticket.fence, null);
    assert.equal(ticket.version, ticket.stamp.version);
    const result = await h.take();
    assert.equal(result.launch.local_chat[0].mes, message.mes);
    assert.equal(result.launch.messages[0].content, message.mes);
    assert.equal(result.launch.local_pending, false);
    assert.equal(h.requests.length, 1, 'A verified phone archive does not wait for cloud authority');
    assert.equal(h.reads.length, 1);
    assert.equal(h.context.acknowledgedPromptTickets.get(result.launch), undefined);
});

test('a newer durable version supersedes the local version present when the peer was prefetched', async t => {
    const h = harness(t);
    await h.prepare([localMessage('older local')]);
    await h.prefetch();
    const newest = localMessage('newest local', { swipe_id: 1, mes: 'newest local alternate' });
    await h.prepare([newest]);
    const result = await h.take();
    assert.deepEqual(clone(result.launch.local_chat), [newest]);
    assert.equal(result.launch.local_pending, true);
});

test('ACKs beyond the former row budget retain the prefetched target phone history', async t => {
    const h = harness(t), message = localMessage('saved before ACK');
    const committed = await h.prepare([message]);
    h.setRequest((_path, count) => cloudSession(count === 1 ? 'old issued cloud' : 'fresh after eviction'));
    await h.prefetch();
    await h.acknowledge(committed, [cloudMessage(message)]);
    for (let i = 0; i < OUTBOX_ACK_MAX_ROWS; i++) {
        const other = localMessage('other ' + i);
        const saved = await h.prepare([other], { app: 'other-card', conversation: 'other-' + i });
        await h.outbox.cloudACK(saved, { messages: [cloudMessage(other)] });
    }
    assert.equal((await h.originalRead(scopeKey())).payload.messages[0].mes, message.mes);
    const result = await h.take();
    assert.equal(result.launch.messages[0].content, message.mes);
    assert.equal(result.launch.local_chat[0].mes, message.mes);
    assert.equal(result.launch.local_pending, false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.context.sessionPrefetchCache.size, 0);
});

test('ACK stamp-budget eviction after prefetch also rejects an old missing-row cloud response', async t => {
    const h = harness(t);
    h.setRequest((_path, count) => cloudSession(count === 1 ? 'old stamp response' : 'fresh stamp response'));
    await h.prefetch();
    for (let i = 0; i < 65; i++) h.context.storageAckStamp(scopeKey(OWNER, 'other-card', 'stamp-' + i));
    assert.equal(h.context.storageAckStamps.size, 64);
    const result = await h.take();
    assert.equal(result.launch.messages[0].content, 'fresh stamp response');
    assert.equal(h.requests.length, 2);
});

test('another-scope or extension-kind ACK does not invalidate an unchanged missing-row peer GET', async t => {
    const h = harness(t);
    await h.prefetch();
    const other = localMessage('unrelated');
    const otherSaved = await h.prepare([other], { app: 'other-card', conversation: 'other-conversation' });
    await h.acknowledge(otherSaved, [cloudMessage(other)]);
    const settings = await h.prepare(null, { kind: 'extension-settings' });
    await h.context.acknowledgeStorage(settings, {});
    const result = await h.take();
    assert.equal(result.launch.messages[0].content, 'fresh cloud');
    assert.equal(h.requests.length, 1);
});

for (const field of ['app_id', 'conversation_id']) {
    test(`deferred prefetch rejects an incorrect ${field} before caching a usable raw payload`, async t => {
        const h = harness(t);
        h.setRequest(() => cloudSession('incorrect scope', { launch: { ...cloudSession().launch, [field]: 'different-scope' } }));
        await assert.rejects(h.prefetch(), /信息不一致/);
        assert.equal(h.context.sessionPrefetchCache.size, 0);
        assert.equal(h.reads.length, 0);
    });
}

test('foreign-owner session response rejects before any full local read', async t => {
    const h = harness(t);
    h.setRequest(() => cloudSession('foreign response', { user: { id: 'another-fixture-owner' } }));
    await assert.rejects(h.prefetch(), /账号已切换/);
    assert.equal(h.reads.length, 0);
    assert.equal(h.context.sessionPrefetchCache.size, 0);
});

test('cookie-only first prefetch establishes its verified owner and can be consumed normally', async t => {
    const h = harness(t, { cookieOnly: true });
    await h.prefetch();
    assert.equal(h.context.reconcileStorageAccount(), OWNER);
    assert.equal(h.context.storageAccountEpoch, 0);
    const result = await h.take();
    assert.equal(result.user.id, OWNER);
    assert.equal(result.launch.messages[0].content, 'fresh cloud');
    assert.equal(h.requests.length, 1);
});

test('cookie-only logout and same-owner fresh login reject an earlier unfinished GET epoch', async t => {
    const h = harness(t, { cookieOnly: true }), remote = deferred(), started = deferred();
    h.setRequest((_path, count) => {
        if (count === 1) { started.resolve(); return remote.promise; }
        return cloudSession('fresh cookie login');
    });
    const old = h.prefetch();
    const rejected = assert.rejects(old, /账号已切换/);
    await started.promise;
    h.changeOwner('');
    assert.equal((await h.fetch()).launch.messages[0].content, 'fresh cookie login');
    remote.resolve(cloudSession('earlier login cloud'));
    await rejected;
    assert.equal(h.context.storageAccountEpoch, 1);
    assert.equal(h.context.reconcileStorageAccount(), OWNER);
    assert.equal(h.context.sessionPrefetchCache.size, 0);
});

for (const mode of ['different owner', 'same-owner cookie login']) {
    test(`take holding an already-verified raw response rejects after ${mode} replaces its account epoch`, async t => {
        const h = harness(t, { cookieOnly: true });
        const raw = await h.prefetch(), held = deferred();
        h.context.sessionPrefetchCache.set(h.cacheKey(), { promise: held.promise, expiresAt: Date.now() + 30_000 });
        const take = h.take();
        const rejected = assert.rejects(take, /账号已切换/);
        h.changeOwner('');
        if (mode === 'different owner') h.changeOwner('another-fixture-owner');
        else {
            h.setRequest(() => cloudSession('fresh new login epoch'));
            await h.fetch();
        }
        held.resolve(raw);
        await rejected;
    });
}

test('account change while the actual consume read transaction waits still rejects its late result', async t => {
    const h = harness(t);
    await h.prefetch();
    const gate = h.indexedDB.holdNextCommit();
    const taken = h.take();
    const rejected = assert.rejects(taken, /账号已切换/);
    await gate.reached;
    h.changeOwner(''); h.changeOwner(OWNER);
    gate.release();
    await rejected;
});

for (const pollution of ['no ticket', 'legacy ticket', 'local_chat', 'local_pending', 'consumed ticket']) {
    test(`take discards a ${pollution} cache entry and fetches fresh cloud instead of laundering its projected messages`, async t => {
        const h = harness(t), polluted = cloudSession('polluted cached body');
        const stamp = h.context.storageAckStamp(scopeKey());
        if (pollution === 'local_chat') polluted.launch.local_chat = [localMessage('polluted canonical')];
        if (pollution === 'local_pending') polluted.launch.local_pending = true;
        if (pollution !== 'no ticket') h.context.sessionReadFences.set(polluted, pollution === 'legacy ticket'
            ? { fence: null, stamp, version: 0 }
            : { fence: null, stamp, version: 0, raw: pollution !== 'consumed ticket',
                scope: scopeKey(), owner: OWNER, epoch: 0 });
        h.installCached(polluted);
        h.setRequest(() => cloudSession('fresh unpolluted server body'));
        const result = await h.take();
        assert.equal(result.launch.messages[0].content, 'fresh unpolluted server body');
        assert.equal(h.requests.length, 1);
        assertCloudUnprojected(result, cloudSession('fresh unpolluted server body').launch.messages);
        assert.equal(h.reads.length, 1, 'Discarded payload must not perform a local merge before its fresh fetch');
        assert.equal(h.context.sessionPrefetchCache.size, 0);
    });
}

test('a consumed raw object cannot be reinserted and consumed as a second cloud-response cache', async t => {
    const h = harness(t);
    h.setRequest((_path, count) => cloudSession('cloud response ' + count));
    await h.prefetch();
    const first = await h.take();
    assert.equal(h.context.sessionPrefetchCache.size, 0);
    h.installCached(first);
    const second = await h.take();
    assert.equal(second.launch.messages[0].content, 'cloud response 2');
    assert.equal(h.requests.length, 2);
});

test('an expired earlier prefetch rejection cannot delete the newer promise cached under the same key', async t => {
    const h = harness(t), oldResponse = deferred(), started = deferred();
    h.setRequest((path, count) => {
        if (count === 1) { started.resolve(); return oldResponse.promise; }
        if (path.startsWith('/console/')) throw new Error('earlier peer fallback failed');
        return cloudSession('newer cached response');
    });
    const older = h.prefetch();
    const rejected = assert.rejects(older, /earlier peer fallback failed/);
    await started.promise;
    h.context.sessionPrefetchCache.get(h.cacheKey()).expiresAt = 0;
    const newer = h.prefetch();
    await newer;
    assert.equal(h.context.sessionPrefetchCache.get(h.cacheKey()).promise, newer);
    oldResponse.reject(new Error('earlier embedded request failed'));
    await rejected;
    assert.equal(h.context.sessionPrefetchCache.get(h.cacheKey())?.promise, newer,
        'The older catch must delete only the promise it originally cached');
    assert.equal((await h.take()).launch.messages[0].content, 'newer cached response');
});

test('an earlier take finally cannot delete a replacement peer prefetch when its response arrives later', async t => {
    const h = harness(t), oldResponse = deferred(), started = deferred();
    h.setRequest((_path, count) => {
        if (count === 1) { started.resolve(); return oldResponse.promise; }
        return cloudSession('replacement cached response');
    });
    const olderTake = h.take();
    await started.promise;
    h.context.sessionPrefetchCache.get(h.cacheKey()).expiresAt = 0;
    const replacement = h.prefetch();
    await replacement;
    oldResponse.resolve(cloudSession('earlier taken response'));
    assert.equal((await olderTake).launch.messages[0].content, 'earlier taken response');
    assert.equal(h.context.sessionPrefetchCache.get(h.cacheKey())?.promise, replacement,
        'The older finally must release only its own cache entry');
    assert.equal((await h.take()).launch.messages[0].content, 'replacement cached response');
    assert.equal(h.requests.length, 2);
});

test('stable ACK canonical prompt state is restored only at consumption and preserves its complete phone source', async t => {
    const h = harness(t), local = promptSnapshot(), cloud = cloudMessage(local);
    const committed = await h.prepare([local]);
    await h.acknowledge(committed, [cloud]);
    h.setRequest(() => cloudSession('unused', { launch: { ...cloudSession().launch, messages: [clone(cloud)] } }));
    const raw = await h.prefetch();
    assert.equal(h.context.acknowledgedPromptTickets.get(raw.launch), undefined, 'Peer preparation does not merge template tuples');
    const result = await h.take();
    assert.equal(result.launch.messages[0].content, local.mes);
    assert.equal(result.launch.local_chat[0].mes, local.mes);
    assert.deepEqual(clone(result.launch.local_chat[0].variables), [{ count: 1, nested: { value: 'once' } }]);
    assert.deepEqual(clone(result.launch.local_chat[0].is_ejs_processed), [true]);
    assert.equal(result.launch.local_pending, false);
    assert.equal(h.context.acknowledgedPromptTickets.get(result.launch), undefined);
});

for (const mismatch of ['cloud edit', 'ACK edit', 'cloud reorder']) {
    test(`stable ACK ${mismatch} cannot replace complete phone source or its canonical template state`, async t => {
        const h = harness(t);
        const locals = [promptSnapshot('FIRST'), promptSnapshot('SECOND')];
        locals[1].extra.homer_message_id = 'second-fixture-message';
        locals[1].extra.homer_sync_id = 'second-fixture-message';
        const clouds = locals.map(cloudMessage), acknowledgements = clone(clouds), fresh = clone(clouds);
        if (mismatch === 'cloud edit') { fresh[0].content = 'REMOTE EDIT'; fresh[0].swipes[0] = 'REMOTE EDIT'; }
        if (mismatch === 'ACK edit') { acknowledgements[0].content = 'DIFFERENT ACK'; acknowledgements[0].swipes[0] = 'DIFFERENT ACK'; }
        if (mismatch === 'cloud reorder') fresh.reverse();
        const committed = await h.prepare(locals);
        await h.acknowledge(committed, acknowledgements);
        h.setRequest(() => cloudSession('unused', { launch: { ...cloudSession().launch, messages: fresh } }));
        await h.prefetch();
        const result = await h.take();
        assert.deepEqual(result.launch.messages.map(message => message.content), locals.map(message => message.mes));
        assert.deepEqual(result.launch.local_chat.map(message => message.mes), locals.map(message => message.mes));
        assert.deepEqual(clone(result.launch.local_chat[0].variables), [{ count: 1, nested: { value: 'once' } }]);
        assert.equal(result.launch.local_pending, false);
        assert.equal(h.context.acknowledgedPromptTickets.get(result.launch), undefined);
    });
}

test('embedded success uses one GET, fallback preserves target scope, and each cache payload is used once', async t => {
    const h = harness(t);
    h.setRequest(path => path.startsWith('/api/homer/session') ? { launch: { app_id: APP } } : cloudSession('fallback cloud'));
    await h.prefetch();
    const first = await h.take();
    assert.equal(first.launch.messages[0].content, 'fallback cloud');
    assert.equal(h.requests.length, 2);
    for (const path of h.requests) {
        const url = new URL(path, 'https://fixture.invalid');
        assert.equal(url.searchParams.get('app_id'), APP);
        assert.equal(url.searchParams.get('conversation_id'), CONVERSATION);
    }
    h.setRequest(() => cloudSession('new one-use cloud'));
    assert.equal((await h.take()).launch.messages[0].content, 'new one-use cloud');
    assert.equal(h.requests.length, 3);
    assert.equal(h.context.sessionPrefetchCache.size, 0);
});

test('incomplete fallback and storage failure propagate while dropping the failed cache entry', async t => {
    const incomplete = harness(t);
    incomplete.setRequest(() => ({ launch: { app_id: APP } }));
    await assert.rejects(incomplete.take(), /会话数据不完整/);
    assert.equal(incomplete.context.sessionPrefetchCache.size, 0);
    const storage = harness(t);
    storage.indexedDB.openError = true;
    await assert.rejects(storage.take(), /IndexedDB open failure/);
    assert.equal(storage.requests.length, 0);
    assert.equal(storage.context.sessionPrefetchCache.size, 0);
});

test('admin preview remains isolated from normal outbox fence/read and fallback even with deferred option supplied', async t => {
    const h = harness(t);
    h.setRequest(() => ({ user: { id: OWNER, is_admin: true },
        launch: { app_id: APP, conversation_id: 'fixture-preview', admin_preview: true, bridge_token: true } }));
    const preview = await h.context.fetchSession(APP, '', true, 0, { deferLocalMerge: true });
    assert.equal(preview.launch.admin_preview, true);
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].startsWith('/api/homer/admin-preview?'));
    assert.equal(h.reads.length, 0);
    assert.equal(h.fences.length, 0);
});
