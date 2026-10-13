// Actual selected bridge functions + real transactional outbox. Authentication
// and provider transport are synthetic peripherals, not production evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { captureCloudSync } from '../../sillytavern-runtime/public/scripts/homer-cloud-sync.mjs';
import { MEMORY_VARIABLE, MEMORY_ZERO_VERSION, memoryFromPayload, memoryReceipt, verifiedMemoryBook, captureMemoryBook } from '../../sillytavern-runtime/public/scripts/homer-memory-sync.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const source = await readFile(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const selected = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
const scopeKey = JSON.stringify(['synthetic-owner', 'synthetic-app', 'synthetic-chat']);
const makeBook = content => ({ entries: { 0: { uid: 0, stmemorybooks: true, content } }, homerMemory: { version: 1, scope: scopeKey } });
function fixture({ indexedDB = transactionIDB(), provider = async () => { throw Error('Synthetic offline'); } } = {}) {
    const outbox = createChatOutbox({ indexedDB }), uploads = [];
    const metadata = { homer_bridge: { app_id: 'synthetic-app', conversation_id: 'synthetic-chat' } };
    const scope = { owner: 'synthetic-owner', key: scopeKey, metadata };
    const env = {
        chatOutbox: outbox, captureCloudSync, MEMORY_VARIABLE, MEMORY_ZERO_VERSION, memoryFromPayload, memoryReceipt, verifiedMemoryBook,
        launch: { app_id: 'synthetic-app', conversation_id: 'synthetic-chat' }, storageAccountEpoch: 0,
        session: { user: { id: 'synthetic-owner' } }, runtimeVariables: {}, storageRequests: new Set(),
        conversationRecoveryBlocked: false, AbortController, URLSearchParams, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        getContext: () => ({ chatMetadata: env.metadata }), metadata,
        hasCanonicalConversationScope: () => !!env.metadata?.homer_bridge,
        cloudSyncScope: () => JSON.stringify([env.session.user.id, env.launch.app_id, env.launch.conversation_id]),
        reconcileStorageAccount: () => env.session.user.id,
        captureExtensionStorage: () => ({ snapshot: captureCloudSync(scopeKey, { app_id: env.launch.app_id, conversation_id: env.launch.conversation_id, extension_settings: {}, variables: env.runtimeVariables }) }),
        localSessions: { rememberResource: async () => {} },
        document: { dispatchEvent() {} }, queryString: (app, conversation) => new URLSearchParams({ app_id: app, conversation_id: conversation }).toString(),
        requestJson: (...args) => provider(...args),
        extensionSyncQueue: { enqueue: value => { uploads.push(value); return Promise.reject(Error('Synthetic offline')); } },
    };
    vm.createContext(env);
    vm.runInContext(selected('async function requestScopedStorage(', 'const extensionSyncQueue =') + selected('let stagedMemoryRestore = null;', 'async function persistModelSettings(')
        + '\nthis.stage = state => { stagedMemoryRestore = { scope: cloudSyncScope(), owner: session.user.id, epoch: storageAccountEpoch, launch, state }; };', env);
    return { env, outbox, scope, uploads, api: env.HomerMemoryStorage };
}

test('actual bridge commits offline before upload, then fresh scope restores verified cloud memory', async () => {
    const f = fixture(), memory = await captureMemoryBook(scopeKey, makeBook('Phone memory'));
    const committed = await f.api.commit(f.scope, memory);
    assert.equal(committed.pending, true); assert.equal(f.uploads.length, 1);
    assert.equal((await f.outbox.read(scopeKey, 'extension-settings')).payload.variables[MEMORY_VARIABLE].digest, memory.digest);
    const remote = { variables: { [MEMORY_VARIABLE]: memory }, extension_settings: {}, memory_storage: {
        protocol: 1, complete: true, scope: JSON.parse(scopeKey), digest: memory.digest, change_id: memory.change_id, version: 'a'.repeat(32),
    } };
    const fresh = fixture(); fresh.env.stage(remote);
    assert.equal(await fresh.api.restore(fresh.scope), true);
    assert.equal((await fresh.outbox.read(scopeKey, 'extension-settings')).pending, false);
    assert.equal((await verifiedMemoryBook((await fresh.outbox.read(scopeKey, 'extension-settings')).payload.variables[MEMORY_VARIABLE], scopeKey)).entries[0].content, 'Phone memory');
    assert.equal(fresh.uploads.length, 0);
});

test('actual restore refuses unsupported proof, account ABA and corrupt bytes without a write', async () => {
    const f = fixture(), memory = await captureMemoryBook(scopeKey, makeBook('Remote'));
    const remote = { variables: { [MEMORY_VARIABLE]: memory } };
    f.env.stage(remote); await assert.rejects(f.api.restore(f.scope), /HM-M428/);
    assert.equal(await f.outbox.read(scopeKey, 'extension-settings'), null);
    f.env.storageAccountEpoch += 2;
    await assert.rejects(f.api.restore(f.scope), /会话已切换/);
    const fresh = fixture(); fresh.env.stage({ ...remote, variables: { [MEMORY_VARIABLE]: { ...memory, body: memory.body + ' ' } } });
    await assert.rejects(fresh.api.restore(fresh.scope), /incomplete/);
    assert.equal(await fresh.outbox.read(scopeKey, 'extension-settings'), null);
});

test('legacy local settings without memory preserve local variables while restoring the new namespace', async () => {
    const f = fixture(), memory = await captureMemoryBook(scopeKey, makeBook('Cloud private memory'));
    await f.outbox.prepare(captureCloudSync(scopeKey, { app_id: 'synthetic-app', conversation_id: 'synthetic-chat',
        extension_settings: { local_setting: 1 }, variables: { local_variable: 2 } }), 'extension-settings');
    f.env.stage({ variables: { remote_variable: 3, [MEMORY_VARIABLE]: memory }, extension_settings: {}, memory_storage: {
        protocol: 1, complete: true, scope: JSON.parse(scopeKey), digest: memory.digest, change_id: memory.change_id, version: 'a'.repeat(32),
    } });
    assert.equal(await f.api.restore(f.scope), true);
    const result = await f.outbox.read(scopeKey, 'extension-settings');
    assert.equal(result.payload.variables.local_variable, 2); assert.equal(result.payload.variables.remote_variable, undefined);
    assert.equal(result.payload.variables[MEMORY_VARIABLE].digest, memory.digest);
    assert.equal(result.pending, true, 'Other local settings still require upload');
});

test('actual sender sends authoritative bytes, rebases once on verified CAS conflict, never regenerates', async () => {
    let posts = 0, gets = 0, sent;
    const f = fixture({ provider: async (path, options) => {
        if (!options) { gets++; return { memory_storage: { protocol: 1, complete: true, scope: JSON.parse(scopeKey), version: 'b'.repeat(32) } }; }
        assert.equal(path, '/api/homer/runtime-state'); sent = JSON.parse(options.body); posts++;
        if (posts === 1) throw Object.assign(Error('Synthetic CAS conflict'), { status: 409 });
        const memory = sent.variables[MEMORY_VARIABLE];
        return { memory_storage: { protocol: 1, complete: true, scope: JSON.parse(scopeKey), version: 'c'.repeat(32), digest: memory.digest, change_id: memory.change_id } };
    } });
    const memory = await captureMemoryBook(scopeKey, makeBook('Actual phone bytes'));
    const committed = await f.api.commit(f.scope, memory);
    const captured = captureCloudSync(scopeKey, { app_id: 'synthetic-app', conversation_id: 'synthetic-chat', extension_settings: {}, variables: {} });
    captured.committed = committed;
    const result = await f.env.requestScopedStorage(captured, 'extension-settings');
    assert.equal(posts, 2); assert.equal(gets, 1); assert.equal(sent.variables[MEMORY_VARIABLE].body, memory.body);
    assert.equal(sent.variables[MEMORY_VARIABLE].base_version, 'b'.repeat(32));
    await f.outbox.cloudACK(captured.committed, result);
    assert.equal((await f.outbox.read(scopeKey, 'extension-settings')).pending, false);
});

test('a repeatedly racing provider leaves local memory pending after exactly one rebase attempt', async () => {
    let posts = 0;
    const f = fixture({ provider: async (_path, options) => {
        if (!options) return { memory_storage: { protocol: 1, complete: true, scope: JSON.parse(scopeKey), version: 'b'.repeat(32) } };
        posts++; throw Object.assign(Error('Still conflicting'), { status: 409 });
    } });
    const memory = await captureMemoryBook(scopeKey, makeBook('Phone remains'));
    const committed = await f.api.commit(f.scope, memory), snapshot = { ...captureCloudSync(scopeKey, JSON.parse(committed.body)), committed };
    await assert.rejects(f.env.requestScopedStorage(snapshot, 'extension-settings'), /Still conflicting/);
    assert.equal(posts, 2); assert.equal((await f.outbox.read(scopeKey, 'extension-settings')).pending, true);
});
