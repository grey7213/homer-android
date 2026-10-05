import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSettledPreviewQueue } from '../../frontend/assets/js/settled-preview-queue.mjs';

function fixture({ limit } = {}) {
    let account = 'owner-a:login-1', next = 0;
    const jobs = new Map(), writes = [];
    const queue = createSettledPreviewQueue({ scope: () => account, limit,
        write: item => writes.push(item),
        schedule: job => { jobs.set(++next, job); return next; }, cancel: id => jobs.delete(id) });
    return { queue, jobs, writes, owner: value => { account = value; },
        run: () => { for (const job of [...jobs.values()]) job(); } };
}
const snapshot = (id, text = 'synthetic body') => ({ app_id: 'synthetic-card', conversation_id: id,
    title: 'Fixture', avatar: '', messages: [{ id: 'message', content: text, role: 'assistant' }] });

test('display cache does not write synchronously on ready and coalesces the same scope', () => {
    const h = fixture(); h.queue.enqueue(snapshot('a', 'old')); h.queue.enqueue(snapshot('a', 'new'));
    assert.equal(h.writes.length, 0); assert.equal(h.jobs.size, 1);
    h.run(); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].messages[0].content, 'new');
    assert.equal(h.jobs.size, 0);
});
test('different chats retain their own settled display cache within the bound', () => {
    const h = fixture(); h.queue.enqueue(snapshot('a')); h.queue.enqueue(snapshot('b')); h.run();
    assert.deepEqual(h.writes.map(x => x.conversation_id), ['a', 'b']);
});
test('account and same-owner login epoch changes reject old pending writes', () => {
    for (const owner of ['owner-b:login-1', 'owner-a:login-2', '']) {
        const h = fixture(); h.queue.enqueue(snapshot('a')); h.owner(owner); h.run();
        assert.equal(h.writes.length, 0);
    }
});
test('logout clears payloads and a callback that was already queued stays inert', () => {
    const h = fixture(); h.queue.enqueue(snapshot('a')); const job = [...h.jobs.values()][0];
    h.queue.clear(); job(); assert.equal(h.writes.length, 0); assert.equal(h.jobs.size, 0);
});
test('exit flush writes once and cancels the delayed callback', () => {
    const h = fixture(); h.queue.enqueue(snapshot('a')); const late = [...h.jobs.values()][0];
    h.queue.flush(); late(); assert.equal(h.writes.length, 1); assert.equal(h.jobs.size, 0);
});
test('only optional preview rows are bounded and refresh moves them to most-recent', () => {
    const h = fixture({ limit: 2 }); h.queue.enqueue(snapshot('a')); h.queue.enqueue(snapshot('b'));
    h.queue.enqueue(snapshot('a', 'changed')); h.queue.enqueue(snapshot('c')); h.run();
    assert.deepEqual(h.writes.map(x => x.conversation_id), ['a', 'c']);
});
test('admin/unbound scope and malformed snapshots never schedule writes', () => {
    const h = fixture(); for (const value of [null, {}, { app_id: 'a' }, { conversation_id: 'a' }]) h.queue.enqueue(value);
    h.owner(''); h.queue.enqueue(snapshot('a')); assert.equal(h.jobs.size, 0);
});
test('a failed optional writer cannot abort later chat cache rows', () => {
    const written = [];
    const q = createSettledPreviewQueue({ scope: () => 'owner', schedule: () => 1, cancel() {},
        write: value => { if (value.conversation_id === 'a') throw Error('disk'); written.push(value.conversation_id); } });
    q.enqueue(snapshot('a')); q.enqueue(snapshot('b')); q.flush(); assert.deepEqual(written, ['b']);
});

test('shipping state consumer publishes live UI immediately and queues only settled previews', () => {
    const source = fs.readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
    const begin = source.indexOf('function cacheRuntimeState('), end = source.indexOf('function acceptsRuntimeTransition(', begin);
    const calls = [], listeners = new Map();
    const scope = { adminPreview: false, activeAppId: 'synthetic-card', activeConversationId: 'a', runtimeState: null,
        pendingDraft: '', previewSend: {}, previewInput: {}, history: [], settingsSignature: '', SETTINGS_CACHE_PREFIX: 'test:',
        setRuntimeOverlay() {}, conversationSnapshot: value => snapshot(value.conversation_id), canAcceptRuntimeDraft: () => true,
        settledPreviewQueue: { enqueue: value => calls.push(['queue', value.conversation_id]), flush: () => calls.push(['flush']) },
        canUseIdleHostDisplay: () => false,
        writeCachedConversation() { throw Error('Synchronous preview write'); }, writeCachedHistory() {}, scopedKey: value => value,
        localStorage: { setItem() {} },
        window: { addEventListener: (name, listener) => listeners.set(name, listener) },
        document: { body: { classList: { contains: () => true } }, visibilityState: 'visible',
            addEventListener: (name, listener) => listeners.set(name, listener) },
        renderConversation() {}, renderHistory() { calls.push(['history']); }, updateModelSummary() { calls.push(['model']); },
        composerUi: { refresh() { calls.push(['composer']); } } };
    vm.createContext(scope); vm.runInContext(source.slice(begin, end), scope);
    scope.cacheRuntimeState({ app_id: 'synthetic-card', conversation_id: 'a', generating: false });
    assert.deepEqual(calls.map(x => x[0]), ['queue', 'history', 'model', 'composer']);
    calls.length = 0;
    scope.cacheRuntimeState({ app_id: 'synthetic-card', conversation_id: 'a', generating: true });
    assert.deepEqual(calls.map(x => x[0]), ['history', 'model', 'composer']);
    calls.length = 0;
    scope.cacheRuntimeState({ app_id: 'other-card', conversation_id: 'a' }); assert.equal(calls.length, 0);
    const eventsBegin = source.indexOf("window.addEventListener('pagehide', flushOptionalHostDisplayCache);");
    const eventsEnd = source.indexOf("window.addEventListener('homer-account-cleared'", eventsBegin);
    assert.ok(eventsBegin >= 0 && eventsEnd > eventsBegin, 'actual exit/visibility listeners');
    vm.runInContext(source.slice(eventsBegin, eventsEnd), scope);
    listeners.get('pagehide')();
    assert.deepEqual(calls, [['flush']], 'exit still flushes the known display cache');
    calls.length = 0;
    listeners.get('visibilitychange')();
    assert.equal(calls.length, 0, 'visible documents do not force a flush');
    scope.document.visibilityState = 'hidden';
    listeners.get('visibilitychange')();
    assert.deepEqual(calls, [['flush']], 'hidden documents still flush the known display cache');
    calls.length = 0;
    listeners.get('homer-native-visibility')({ detail: { visible: true } });
    assert.equal(calls.length, 0);
    listeners.get('homer-native-visibility')({ detail: { visible: false } });
    assert.deepEqual(calls, [['flush']], 'native background still flushes the known display cache');
    assert.match(source, /homer-account-cleared'[\s\S]*?settledPreviewQueue\.clear\(\)/);
});
