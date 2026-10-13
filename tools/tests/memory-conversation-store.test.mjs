import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHomerConversationStore } from '../../sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/homerConversationStore.js';
import { createHomerMemoryAccess } from '../../sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/homerMemoryAccess.js';

function fixture() {
    let epoch = 0, scope, saves = 0, delay;
    const data = new Map();
    const select = (owner = 'owner-a', conversation = 'chat-a') => scope = { owner, epoch: ++epoch,
        key: JSON.stringify([owner, 'card-a', conversation]), metadata: { world_info: 'creator-world', STMemoryBooks: {} } };
    select();
    const api = createHomerConversationStore({ capture: () => scope, current: s => s === scope,
        digest: key => createHash('sha256').update(key).digest('hex'),
        read: async (s, name) => { if (delay) await delay; return structuredClone(data.get(name) ?? null); },
        save: async (s, name, value) => { saves++; data.set(name, structuredClone(value)); },
        writeLane: (_names, task) => task(),
    });
    return { api, data, select, get saves() { return saves; }, get scope() { return scope; },
        hold() { delay = new Promise(resolve => { this.resume = () => { delay = null; resolve(); }; }); } };
}

test('overview and memory list preparation do not write, choose a world book or generate', async () => {
    const f = fixture(), initial = structuredClone(f.scope.metadata);
    const result = await f.api.read();
    assert.equal(result.data, null); assert.equal(f.saves, 0);
    assert.deepEqual(f.scope.metadata, initial);
});
test('first explicit summary safely creates exactly one private book without changing creator metadata', async () => {
    const f = fixture(), initial = structuredClone(f.scope.metadata);
    const rows = await Promise.all([f.api.ensure(), f.api.ensure(), f.api.ensure()]);
    assert.equal(f.saves, 1); assert.equal(new Set(rows.map(row => row.name)).size, 1);
    assert.equal(rows[0].data.homerMemory.scope, f.scope.key);
    assert.deepEqual(f.scope.metadata, initial); assert.match(rows[0].name, /^homer-memory-[a-f0-9]{64}$/);
});
test('reopening a persisted conversation derives the same book and preserves existing entries', async () => {
    const f = fixture(), original = await f.api.ensure();
    original.data.entries[0] = { uid: 0, stmemorybooks: true, content: 'synthetic memory' };
    f.data.set(original.name, original.data); f.select('owner-a', 'chat-b'); await f.api.ensure(); f.select();
    const reopened = await f.api.ensure();
    assert.equal(reopened.name, original.name); assert.equal(reopened.data.entries[0].content, 'synthetic memory');
    assert.equal(f.saves, 2);
});
test('same card with different conversations and accounts uses isolated stores', async () => {
    const f = fixture(), a = await f.api.ensure();
    f.select('owner-a', 'chat-b'); const b = await f.api.ensure();
    f.select('owner-b', 'chat-a'); const c = await f.api.ensure();
    assert.equal(new Set([a.name, b.name, c.name]).size, 3);
    assert.equal(Object.keys(b.data.entries).length, 0);
});
test('foreign or corrupt ownership markers are never overwritten or returned', async () => {
    const f = fixture(), row = await f.api.read();
    for (const bad of [{ entries: {} }, { entries: {}, homerMemory: { version: 1, scope: 'other-chat' } },
        { entries: [], homerMemory: { version: 1, scope: f.scope.key } }]) {
        f.data.set(row.name, bad); await assert.rejects(f.api.ensure(), /身份不一致/);
        assert.equal(f.saves, 0); assert.deepEqual(f.data.get(row.name), bad);
    }
});
for (const mode of ['conversation', 'account', 'ABA']) test(mode + ' fences delayed preparation before any write', async () => {
    const f = fixture(); f.hold(); const work = f.api.ensure(); await new Promise(r => setImmediate(r));
    if (mode === 'account') f.select('owner-b'); else f.select('owner-a', 'chat-b');
    if (mode === 'ABA') f.select(); f.resume();
    await assert.rejects(work, /已切换/); assert.equal(f.saves, 0);
});
test('read failure stays actionable and never becomes empty successful storage', async () => {
    const api = createHomerConversationStore({ capture: () => ({ key: 'x' }), current: () => true,
        digest: () => 'a'.repeat(64), read: () => { throw Error('synthetic disk failure'); }, save: () => assert.fail('must not write'), writeLane: (_n, fn) => fn() });
    await assert.rejects(api.ensure(), /disk failure/);
});
test('editing is bound to the captured owner epoch even when chat key and book name repeat', async () => {
    let scope = { epoch: 1 }, saved = 0;
    const data = { entries: { 0: { stmemorybooks: true, comment: 'Title', content: 'Original' } } };
    const api = createHomerMemoryAccess({ binding: () => 'same-name', chatKey: () => 'same-key',
        capture: () => scope, current: s => s === scope, prepare: () => null,
        load: () => structuredClone(data), save: () => saved++, changed: () => {}, writeLane: (_n, fn) => fn() });
    const snapshot = await api.list(); scope = { epoch: 2 };
    await assert.rejects(api.update(snapshot, snapshot.items[0], { title: 'New', content: 'New' }), /已切换/);
    assert.equal(saved, 0);
});
test('memory management edits/toggles/removes only tagged records and checks revisions', async () => {
    let data = { entries: { 0: { stmemorybooks: true, comment: 'Title', content: 'Original' }, 1: { content: 'Creator setting' } } };
    const api = createHomerMemoryAccess({ binding: () => 'memory', chatKey: () => 'chat', load: () => structuredClone(data),
        save: (_name, next) => { data = next; }, changed: () => {}, writeLane: (_n, fn) => fn() });
    let snapshot = await api.list(); assert.equal(snapshot.items.length, 1);
    await api.update(snapshot, snapshot.items[0], { title: 'New', content: 'Remember', disabled: true });
    assert.equal(data.entries[0].content, 'Remember'); assert.equal(data.entries[0].disable, true);
    await assert.rejects(api.update(snapshot, snapshot.items[0], { remove: true }), /发生变化/);
    snapshot = await api.list(); await api.update(snapshot, snapshot.items[0], { remove: true });
    assert.deepEqual(data.entries, { 1: { content: 'Creator setting' } });
});
