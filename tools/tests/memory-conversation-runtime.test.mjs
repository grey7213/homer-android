// Executes the actual embedded adapter with the actual durable store. The IDB
// double is transaction-aware; this is not a substitute for final APK testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { transactionIDB } from './helpers/transaction-idb.mjs';
import { createLocalRuntimeStore, createLocalRuntimeAdapter } from '../../sillytavern-runtime/public/scripts/homer-local-runtime.mjs';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { MEMORY_VARIABLE, captureMemoryBook, verifiedMemoryBook } from '../../sillytavern-runtime/public/scripts/homer-memory-sync.mjs';
import { encodedBytesSha256 } from '../../sillytavern-runtime/public/scripts/homer-content-digest.mjs';
import { createHomerConversationStore, HomerMemoryScopeChangedError } from '../../sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/homerConversationStore.js';
import { createHomerMemoryAccess } from '../../sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/homerMemoryAccess.js';

const moduleURL = new URL('../../sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/homerConversationRuntime.js', import.meta.url);
const source = await readFile(moduleURL, 'utf8');
function fixture({ indexedDB = transactionIDB(), owner = 'synthetic-owner', conversation = 'synthetic-chat', subtle = webcrypto.subtle, privateWrites = false } = {}) {
    let context, saves = 0;
    const events = () => ({ listeners: new Map(), addEventListener(k, fn) {
        const list = this.listeners.get(k) || []; list.push(fn); this.listeners.set(k, list);
    }, emit(k, detail) { for (const fn of this.listeners.get(k) || []) fn(detail); } });
    const window = events(), document = Object.assign(events(), { body: { classList: { contains: k => k === 'homer-runtime' } } });
    document.dispatchEvent = event => document.emit(event.type, event);
    const values = new Map([['ai_xingyue_user', JSON.stringify({ id: owner })], ['ai_xingyue_logged_in', '1']]);
    const localStorage = { getItem: key => values.get(key) || null };
    const local = createLocalRuntimeStore({ indexedDB });
    const select = (who = owner, chat = conversation) => {
        values.set('ai_xingyue_user', JSON.stringify({ id: who }));
        context = { chatMetadata: { homer_bridge: { app_id: 'synthetic-card', conversation_id: chat }, world_info: 'creator-world' } };
    };
    select();
    const env = { window, document, localStorage, crypto: webcrypto, TextEncoder, structuredClone,
        createChatOutbox: () => createChatOutbox({ indexedDB }), MEMORY_VARIABLE, captureMemoryBook, verifiedMemoryBook,
        worldInfoCache: new Map(), CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        getContext: () => context, world_names: ['creator-world'], createHomerConversationStore, HomerMemoryScopeChangedError,
        encodedBytesSha256: bytes => encodedBytesSha256(bytes, { subtle }),
        createLocalRuntimeStore: () => local,
        loadWorldInfo: async name => (await local.read(JSON.parse(values.get('ai_xingyue_user')).id, 'world', name))?.data ?? null,
        saveWorldInfo: async (name, data) => {
            const activeOwner = JSON.parse(values.get('ai_xingyue_user')).id;
            await local.update(activeOwner, 'world', name, () => {
                assert.equal(JSON.parse(values.get('ai_xingyue_user')).id, activeOwner);
                saves++; return { data: structuredClone(data), localMutation: true };
            });
        },
    };
    if (privateWrites) {
        const adapter = createLocalRuntimeAdapter({ origin: 'https://memory.test', storage: local,
            owner: () => JSON.parse(values.get('ai_xingyue_user')).id, fetcher: () => { throw Error('No network is allowed'); } });
        Object.assign(env, { Request, Response, URL, location: { href: 'https://memory.test/module/dialogue/', origin: 'https://memory.test' }, fetch: adapter.fetch });
        env.saveWorldInfo = async (name, data) => {
            const response = await env.fetch('/api/worldinfo/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, data }) });
            assert.equal(response.ok, true); saves++;
        };
    }
    vm.createContext(env);
    // Parent imports are exactly the injected real host APIs above. Local module
    // logic is unchanged, including identity and asynchronous storage fences.
    const implementation = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(implementation + '\nthis.api={resolveHomerMemoryBook,captureHomerMemoryScope,homerMemoryBookName,assertHomerMemoryCurrent,assertHomerMemoryIdentity,readHomerMemoryForInjection};', env);
    return { env, window, document, values, indexedDB, local, select, api: env.api, get saves() { return saves; }, get context() { return context; } };
}

test('first-use summary store is local, owner-scoped and independent of creator world_info/global selectors', async () => {
    const f = fixture(); assert.equal((await f.api.resolveHomerMemoryBook()).valid, false); assert.equal(f.saves, 0);
    const book = await f.api.resolveHomerMemoryBook({ create: true });
    assert.equal(book.valid, true); assert.equal(f.context.chatMetadata.world_info, 'creator-world');
    assert.equal(f.saves, 1); assert.ok(f.env.world_names.includes(book.name));
    const rows = f.indexedDB.dump('homer-local-runtime-v1');
    assert.equal(rows[0].key[0], 'synthetic-owner'); assert.equal(rows[0].value.localMutation, true);
});
test('actual adapter persists memory edits/toggle/delete and injects only this conversation once', async () => {
    const f = fixture(), book = await f.api.resolveHomerMemoryBook({ create: true });
    book.data.entries[0] = { uid: 0, stmemorybooks: true, comment: 'Synthetic memory', content: 'Remember the village', key: ['village'], disable: false };
    book.data.entries[1] = { uid: 1, content: 'Must not inject unrelated book entries' };
    await f.env.saveWorldInfo(book.name, book.data);
    const api = createHomerMemoryAccess({ prepare: () => f.api.resolveHomerMemoryBook(), capture: f.api.captureHomerMemoryScope,
        current: s => { try { f.api.assertHomerMemoryCurrent(s); return true; } catch { return false; } },
        binding: f.api.homerMemoryBookName, chatKey: () => 'synthetic-chat', load: f.env.loadWorldInfo, save: f.env.saveWorldInfo,
        changed: () => {}, writeLane: (_names, task) => task() });
    let snapshot = await api.list(); await api.update(snapshot, snapshot.items[0], { title: 'Updated', content: 'Village updated', disabled: true });
    const chatLore = [{ uid: 99, world: 'creator-world', content: 'Creator stays' }];
    await f.api.readHomerMemoryForInjection(chatLore); await f.api.readHomerMemoryForInjection(chatLore);
    assert.equal(chatLore.length, 2); assert.equal(chatLore[0].content, 'Creator stays');
    assert.equal(chatLore[1].content, 'Village updated'); assert.equal(chatLore[1].disable, true);
    snapshot = await api.list(); await api.update(snapshot, snapshot.items[0], { remove: true });
    assert.equal((await api.list()).items.length, 0);
    const unchanged = await f.env.loadWorldInfo(book.name); assert.equal(unchanged.entries[1].content, 'Must not inject unrelated book entries');
});
test('fresh adapter/process-style reopen derives the durable book offline with no remote read', async () => {
    const f = fixture(); const book = await f.api.resolveHomerMemoryBook({ create: true });
    book.data.entries[0] = { uid: 0, stmemorybooks: true, content: 'Persisted on phone' }; await f.env.saveWorldInfo(book.name, book.data);
    const fresh = fixture({ indexedDB: f.indexedDB });
    const result = await fresh.api.resolveHomerMemoryBook();
    assert.equal(result.valid, true); assert.equal(result.name, book.name); assert.equal(result.data.entries[0].content, 'Persisted on phone');
    assert.equal(fresh.saves, 0);
});
test('LAN HTTP and older WebViews without SubtleCrypto reopen the identical SHA-256 book', async () => {
    const original = fixture();
    const book = await original.api.resolveHomerMemoryBook({ create: true });
    book.data.entries[0] = { uid: 0, stmemorybooks: true, content: 'Offline crypto parity' };
    await original.env.saveWorldInfo(book.name, book.data);
    for (const subtle of [null, { digest: () => Promise.reject(Error('Old WebView digest refused')) }]) {
        const fallback = fixture({ indexedDB: original.indexedDB, subtle });
        const reopened = await fallback.api.resolveHomerMemoryBook();
        assert.equal(reopened.valid, true);
        assert.equal(reopened.name, book.name);
        assert.equal(reopened.data.entries[0].content, 'Offline crypto parity');
        assert.equal(fallback.saves, 0);
    }
});
test('A/B/A and account switches never inject another scope, even after deriving its name', async () => {
    const f = fixture(), original = await f.api.resolveHomerMemoryBook({ create: true });
    original.data.entries[0] = { uid: 0, stmemorybooks: true, content: 'Only A' }; await f.env.saveWorldInfo(original.name, original.data);
    f.select('synthetic-owner', 'synthetic-b'); f.document.emit('homer-presentation-invalidated');
    assert.equal(f.api.homerMemoryBookName(), null); const b = [];
    await f.api.readHomerMemoryForInjection(b); assert.deepEqual(b, []);
    f.select(); f.document.emit('homer-presentation-invalidated'); const a = []; await f.api.readHomerMemoryForInjection(a); assert.equal(a[0].content, 'Only A');
    f.select('different-owner'); f.window.emit('storage', { key: 'ai_xingyue_user' }); const other = [];
    await f.api.readHomerMemoryForInjection(other); assert.deepEqual(other, []);
    assert.throws(() => f.api.assertHomerMemoryCurrent(original.homerScope), /已切换/);
});
test('in-flight durable read is fenced on logout/relogin ABA before injection', async () => {
    const f = fixture(), book = await f.api.resolveHomerMemoryBook({ create: true });
    const gate = f.indexedDB.holdNextCommit(), work = f.api.resolveHomerMemoryBook(); await gate.reached;
    f.window.emit('storage', { key: 'ai_xingyue_logged_in' }); f.window.emit('storage', { key: 'ai_xingyue_logged_in' }); gate.release();
    await assert.rejects(work, /已切换/); assert.throws(() => f.api.assertHomerMemoryCurrent(book.homerScope), /已切换/);
});
test('quota failure is visible, leaves no empty successful book and permits explicit retry', async () => {
    const f = fixture(); f.indexedDB.failNextPut = true;
    await assert.rejects(f.api.resolveHomerMemoryBook({ create: true }), /quota/);
    assert.equal((await f.api.resolveHomerMemoryBook()).valid, false);
    assert.equal((await f.api.resolveHomerMemoryBook({ create: true })).valid, true);
});
test('structured-cloned queue identities retain owner/epoch fences and reject A/B/A', async () => {
    const f = fixture(), scope = f.api.captureHomerMemoryScope();
    const identity = structuredClone({ key: scope.key, epoch: scope.epoch });
    assert.equal(f.api.assertHomerMemoryIdentity(identity).metadata, scope.metadata);
    assert.throws(() => f.api.assertHomerMemoryIdentity(null), /已切换/);
    f.select('synthetic-owner', 'synthetic-b'); f.document.emit('homer-presentation-invalidated');
    assert.throws(() => f.api.assertHomerMemoryIdentity(identity), /已切换/);
    f.select(); f.document.emit('homer-presentation-invalidated');
    assert.throws(() => f.api.assertHomerMemoryIdentity(identity), /已切换/);
});
test('genuine private write commits real outbox before projection and repairs projection loss offline', async () => {
    const f = fixture({ privateWrites: true }), book = await f.api.resolveHomerMemoryBook({ create: true });
    book.data.entries[0] = { uid: 0, stmemorybooks: true, content: 'Canonical synthetic memory', disable: false };
    await f.env.saveWorldInfo(book.name, book.data);
    const outbox = createChatOutbox({ indexedDB: f.indexedDB });
    const row = await outbox.read(book.homerScope.key, 'extension-settings');
    assert.equal(row.pending, true); assert.equal(JSON.parse(row.payload.variables[MEMORY_VARIABLE].body).entries[0].content, 'Canonical synthetic memory');
    await f.local.update(book.homerScope.owner, 'world', book.name, () => null);
    const repaired = await f.api.resolveHomerMemoryBook();
    assert.equal(repaired.data.entries[0].content, 'Canonical synthetic memory');
    assert.equal((await f.local.read(book.homerScope.owner, 'world', book.name)).data.entries[0].content, 'Canonical synthetic memory');
    const lore = []; await f.api.readHomerMemoryForInjection(lore); assert.equal(lore[0].content, 'Canonical synthetic memory');
});
test('outbox quota failure cannot report a successful memory edit or overwrite the old projection', async () => {
    const f = fixture({ privateWrites: true }), book = await f.api.resolveHomerMemoryBook({ create: true });
    book.data.entries[0] = { uid: 0, stmemorybooks: true, content: 'Old synthetic memory' }; await f.env.saveWorldInfo(book.name, book.data);
    f.indexedDB.failNextPut = true;
    book.data.entries[0].content = 'Must not commit';
    await assert.rejects(f.env.saveWorldInfo(book.name, book.data), /quota/);
    assert.equal((await f.api.resolveHomerMemoryBook()).data.entries[0].content, 'Old synthetic memory');
});
test('later extension fetch wrappers retain private durability and pass streamed unrelated requests unchanged', async () => {
    const f = fixture({ privateWrites: true }), book = await f.api.resolveHomerMemoryBook({ create: true });
    const previous = f.env.fetch; let streamed = null, events = 0;
    f.document.addEventListener('homer-memory-backup', () => { events++; });
    f.env.fetch = async (input, init) => {
        if (input instanceof Request && input.url.endsWith('/synthetic-stream')) {
            streamed = await input.text(); return new Response('Synthetic only');
        }
        return previous(input, init);
    };
    await f.api.resolveHomerMemoryBook();
    book.data.entries[0] = { uid: 0, stmemorybooks: true, content: 'Later wrapped fetch still commits' };
    await f.env.saveWorldInfo(book.name, book.data);
    assert.equal(events, 1, 'Retired wrappers must not commit twice');
    const row = await createChatOutbox({ indexedDB: f.indexedDB }).read(book.homerScope.key, 'extension-settings');
    assert.equal(JSON.parse(row.payload.variables[MEMORY_VARIABLE].body).entries[0].content, book.data.entries[0].content);
    const bytes = new TextEncoder().encode('Synthetic streamed body');
    await f.env.fetch(new Request('https://memory.test/synthetic-stream', { method: 'POST', duplex: 'half',
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }));
    assert.equal(streamed, 'Synthetic streamed body');
});
test('shipping manifest bundle source map contains both real private-memory modules and real range API', async () => {
    const dir = new URL('../../sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));
    assert.equal(manifest.js, 'index.build.js');
    const map = JSON.parse(await readFile(new URL('index.build.js.map', dir), 'utf8'));
    for (const file of ['homerConversationStore.js', 'homerConversationRuntime.js', 'homerMemoryAccess.js', 'homerMemoryView.js', 'index.js']) {
        // Dependencies also contain index.js; require the extension's exact
        // path rather than accidentally matching a bundled library's entry.
        // Require the extension-root source, not a library index.js. A
        // published bundle must be verifiable without build-only node_modules,
        // and Windows-generated maps must remain portable to Linux CI.
        const index = map.sources.findIndex(s => s.replace(/\\/g, '/') === file);
        assert.ok(index >= 0, file + ' missing from loaded bundle');
        assert.equal(map.sourcesContent[index].replace(/\r\n/g, '\n'), (await readFile(new URL(file, dir), 'utf8')).replace(/\r\n/g, '\n'));
    }
    const index = await readFile(new URL('index.js', dir), 'utf8');
    assert.match(index, /WORLDINFO_ENTRIES_LOADED[\s\S]{0,180}readHomerMemoryForInjection/);
    assert.match(index, /selectRange\(start, end\)[\s\S]{0,600}setSceneRange\(start, end\)/);
});
