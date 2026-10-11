import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { MEMORY_VARIABLE as KEY, MEMORY_ZERO_VERSION as ZERO, captureMemoryBook, memoryReceipt, verifiedMemoryBook, requireMemorySize } from '../../sillytavern-runtime/public/scripts/homer-memory-sync.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const scope = JSON.stringify(['synthetic-owner', 'synthetic-app', 'synthetic-conversation']);
const book = content => ({ entries: content === null ? {} : { 0: { uid: 0, stmemorybooks: true, content } }, homerMemory: { version: 1, scope } });
const snapshot = (variables = {}, key = scope) => { const [, app_id, conversation_id] = JSON.parse(key); return { scope: key, body: JSON.stringify({ app_id, conversation_id, extension_settings: {}, variables }) }; };
const proof = (envelope, version = 'a'.repeat(32)) => ({ memory_storage: { protocol: 1, complete: true, scope: JSON.parse(scope), version, digest: envelope.digest, change_id: envelope.change_id } });
const guard = () => true;

test('ordinary settings captures cannot erase or replace authoritative private memory', async () => {
    const outbox = createChatOutbox({ indexedDB: transactionIDB() });
    const memory = await captureMemoryBook(scope, book('Phone wins'));
    await outbox.prepareMemory(snapshot({ normal: 1 }), memory, guard);
    await outbox.prepare(snapshot({ normal: 2 }), 'extension-settings');
    assert.equal((await outbox.read(scope, 'extension-settings')).payload.variables[KEY].body, memory.body);
    const stale = await captureMemoryBook(scope, book('Stale settings snapshot'));
    await outbox.prepare(snapshot({ [KEY]: stale }), 'extension-settings');
    assert.equal((await outbox.read(scope, 'extension-settings')).payload.variables[KEY].body, memory.body);
});

test('unverified legacy ACK stays pending; accepted older ACK advances CAS but not newer contents', async () => {
    const outbox = createChatOutbox({ indexedDB: transactionIDB() });
    const a = await captureMemoryBook(scope, book('A')), first = await outbox.prepareMemory(snapshot(), a, guard);
    await assert.rejects(outbox.cloudACK(first, {}), /HM-M428/);
    const b = await captureMemoryBook(scope, book('B')), second = await outbox.prepareMemory(snapshot(), b, guard);
    assert.equal((await outbox.cloudACK(first, proof(a))).applied, false);
    const current = await outbox.read(scope, 'extension-settings');
    assert.equal(current.pending, true); assert.equal(current.memoryBaseVersion, 'a'.repeat(32));
    assert.equal((await verifiedMemoryBook(current.payload.variables[KEY], scope)).entries[0].content, 'B');
    assert.equal(current.commitId, second.commitId);
    await outbox.cloudACK(current, proof(b, 'b'.repeat(32)));
    assert.equal((await outbox.read(scope, 'extension-settings')).pending, false);
});

test('restore into fresh phone storage verifies scope/proof and preserves explicit-empty local memories', async () => {
    const outbox = createChatOutbox({ indexedDB: transactionIDB() }), remote = await captureMemoryBook(scope, book('Restored'));
    assert.equal(await outbox.rememberMemoryRemote(snapshot({ [KEY]: remote }), proof(remote), guard), true);
    assert.equal((await outbox.read(scope, 'extension-settings')).memoryVersion, 'a'.repeat(32));
    const empty = await captureMemoryBook(scope, book(null));
    await outbox.prepareMemory(snapshot(), empty, guard);
    assert.equal(await outbox.rememberMemoryRemote(snapshot({ [KEY]: remote }), proof(remote), guard), false);
    assert.deepEqual((await verifiedMemoryBook((await outbox.read(scope, 'extension-settings')).payload.variables[KEY], scope)).entries, {});
    const another = JSON.stringify(['another-owner', 'synthetic-app', 'synthetic-conversation']);
    await assert.rejects(outbox.rememberMemoryRemote(snapshot({ [KEY]: remote }, another), proof(remote), guard), /identity|version/);
    assert.throws(() => memoryReceipt(proof(remote), another, remote), /HM-M428/);
});

test('exact committed CAS rebase fences delayed ACK, edited rows and cancelled owner epochs', async () => {
    const outbox = createChatOutbox({ indexedDB: transactionIDB() }), memory = await captureMemoryBook(scope, book('Pending'));
    const first = await outbox.prepareMemory(snapshot(), memory, guard);
    assert.equal(first.memoryBaseVersion, ZERO);
    const work = { ...snapshot(), committed: first };
    assert.equal(await outbox.rebaseMemoryPending(work, 'b'.repeat(32), guard), true);
    assert.equal((await outbox.cloudACK(first, proof(memory))).applied, false);
    assert.equal((await outbox.read(scope, 'extension-settings')).pending, true);
    assert.equal(await outbox.rebaseMemoryPending(work, 'c'.repeat(32), guard), false);
    await assert.rejects(outbox.prepareMemory(snapshot(), memory, () => false), /conversation changed/);
});

test('actual transaction abort and permanent deletion cannot create or resurrect a memory', async () => {
    const idb = transactionIDB(), outbox = createChatOutbox({ indexedDB: idb });
    const memory = await captureMemoryBook(scope, book('Pending'));
    idb.failNextPut = true;
    await assert.rejects(outbox.prepareMemory(snapshot(), memory, guard), /quota/);
    assert.equal(await outbox.read(scope, 'extension-settings'), null);
    await outbox.deleteConversations('synthetic-owner', ['synthetic-conversation']);
    await assert.rejects(outbox.prepareMemory(snapshot(), memory, guard), /已删除/);
    await assert.rejects(outbox.rememberMemoryRemote(snapshot({ [KEY]: memory }), proof(memory), guard), /已删除/);
});

test('capacity includes provider token, rejects entire edit and never truncates', async () => {
    const outbox = createChatOutbox({ indexedDB: transactionIDB() }), old = await captureMemoryBook(scope, book('Old'));
    await outbox.prepareMemory(snapshot(), old, guard);
    const huge = await captureMemoryBook(scope, book('X'.repeat(512000)));
    assert.throws(() => requireMemorySize({ [KEY]: huge }), { code: 'HOMER_MEMORY_TOO_LARGE' });
    await assert.rejects(outbox.prepareMemory(snapshot(), huge, guard), { code: 'HOMER_MEMORY_TOO_LARGE' });
    assert.equal((await outbox.read(scope, 'extension-settings')).payload.variables[KEY].body, old.body);
    const boundary = { [KEY]: old, filler: '' };
    boundary.filler = 'X'.repeat(511990 - new TextEncoder().encode(JSON.stringify(boundary)).byteLength);
    assert.equal(new TextEncoder().encode(JSON.stringify(boundary)).byteLength, 511990);
    assert.throws(() => requireMemorySize(boundary), { code: 'HOMER_MEMORY_TOO_LARGE' }, 'Provider token must fit before any local commit');
});
