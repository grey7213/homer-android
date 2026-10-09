import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { captureCloudSync, canApplyCloudSync } from '../../sillytavern-runtime/public/scripts/homer-cloud-sync.mjs';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { createLocalSessionStore } from '../../sillytavern-runtime/public/scripts/homer-local-session.mjs';
import { sanitizeRuntimeValue } from '../../sillytavern-runtime/public/scripts/homer-local-runtime.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const scope = JSON.stringify(['offline-mutation-owner', 'card', 'conversation']);
const section = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Product function boundary is missing: ${start}`);
    return source.slice(from, to);
};
const mutationCode = [
    section('function captureCurrentChatStorage(', '\nasync function commitConversationBeforeSwitch('),
    section('async function syncCloudChat(', '\nasync function syncCloudChatSnapshot('),
    section('async function rollbackToMessage(', '\nasync function loadRuntimeState('),
    section('async function deleteCloudMessage(', '\nasync function handleMessageMenuAction('),
].join('\n');
const variableCode = [
    section('function captureExtensionStorage(', '\nasync function persistExtensionSettingsSnapshot('),
    section('async function persistRuntimeVariables(', '\nasync function persistModelSettings('),
].join('\n');

function fixture({ mirrorFailure = false } = {}) {
    const indexedDB = transactionIDB(), resourceIDB = transactionIDB();
    const outbox = createChatOutbox({ indexedDB, databaseName: 'local-mutation-outbox' });
    const localSessions = createLocalSessionStore({ indexedDB: resourceIDB, databaseName: 'local-mutation-resources' });
    const events = [], notices = [], uploads = [], logs = [], busyClasses = new Set();
    const context = {
        chat: Array.from({ length: 4 }, (_, i) => ({ mes: `unsynced-phone-message-${i}`, is_user: i % 2 === 0,
            extra: { homer_prompt_state: { variables: { turn: i } } } })),
        chatId: 'local-mirror', chatMetadata: { homer_preset_overrides: { legacy: true } },
        async saveChat() { if (mirrorFailure) throw new Error('Mirror unavailable'); },
        async printMessages() { events.push(['print', copy(this.chat)]); },
    };
    const runtimeVariables = { values: Array.from({ length: 500 }, (_, i) => ({ n: i, state: `variable-${i}` })),
        model_id: 'model-a', max_tokens: 8192, token_count: 63, api_key: 'fixture-private',
        nested: { bridge_token: 'fixture-private', is_admin: true, safe: 'card code can mention api_key literally' } };
    const settings = { world: { enabled: true }, api_key: 'fixture-private', nested: { csrf_token: 'fixture-private', safe: 1 } };
    const h = {
        MODULE_ID: 'local-mutation-test', console: { warn() {}, error() {} },
        launch: { app_id: 'card', conversation_id: 'conversation', card: { name: 'Local card' },
            storage: { protocol: 2, complete: true, version: 'a'.repeat(32) }, local_pending: true },
        owner: 'offline-mutation-owner', storageAccountEpoch: 0, lastSyncSignature: '',
        rollbackBusy: false, generationBusy: false, loadingLaunch: false, suppressSync: false,
        dialogueEventLogMuted: 0, conversationRecoveryBlocked: false, extensionSettingsHydrating: false,
        lastExtensionSettingsScope: '', lastExtensionSettingsSignature: '',
        runtimeVariables, settings, localSessions, chatOutbox: outbox,
        activeContext: context,
        captureCloudSync, canApplyCloudSync, sanitizeRuntimeValue,
        cloneJsonValue: copy, cloneJsonObject: copy,
        // Upstream st-context.js returns a fresh wrapper around the shared
        // chat and metadata on every call. Guard the canonical chat reference,
        // not object identity of the wrapper itself.
        getContext: () => ({ ...h.activeContext }), serializeChat: () => copy(h.activeContext.chat),
        cloudSyncScope: () => JSON.stringify([h.owner, h.launch.app_id, h.launch.conversation_id]),
        reconcileStorageAccount: () => h.owner,
        hasCanonicalConversationScope: () => true, assertCanonicalConversationScope() {},
        resolveMessageMenuTarget: index => context.chat[index] ? { messageIndex: index, message: context.chat[index] } : null,
        cloudHomerMessageId: message => String(message?.extra?.homer_message_id || ''),
        confirmRollback: async () => true, confirmHomerAction: async () => true,
        document: { body: { classList: { add: key => busyClasses.add(key), remove: key => busyClasses.delete(key) } } },
        queueMessageMenuRender() {}, closeMessageMenu() {},
        showHostNotice: (text, level) => notices.push({ text, level }), updateRuntimeStatus() {},
        event_types: { MESSAGE_DELETED: 'deleted', CHAT_LOADED: 'loaded' },
        eventSource: { async emit(...args) { events.push(args); } },
        logDialogueEvent: async (...args) => { logs.push(args); },
        // A never-settled cloud transport models offline operation. Local
        // acceptance must not await it; the actual durable store is not stubbed.
        syncCloudChatSnapshot: snapshot => { uploads.push(snapshot); return new Promise(() => {}); },
        extensionSyncQueue: { enqueue(snapshot) { uploads.push(snapshot); return new Promise(() => {}); } },
        extensionSettingsScope: () => JSON.stringify([h.launch.app_id, h.launch.conversation_id]),
        extensionSettingsSnapshot: () => ({ value: copy(h.settings), signature: JSON.stringify(h.settings) }),
        conversationModelSettings: () => ({ model_id: 'model-a', temperature: 0.5 }),
    };
    vm.createContext(h);
    vm.runInContext(`${mutationCode}\n${variableCode}`, h);
    return { h, context, indexedDB, resourceIDB, outbox, localSessions, events, notices, uploads, logs, busyClasses };
}

for (const [operation, expectedIndices] of [['rollback', [0, 1]], ['delete', [0, 1, 3]]]) {
    const invoke = ({ h }, index = 2) => operation === 'rollback'
        ? h.rollbackToMessage(index, { askConfirmation: false }) : h.deleteCloudMessage(index, true);

    test(`${operation} succeeds offline without cloud message IDs and retains complete canonical phone data after restart`, async () => {
        const f = fixture(), original = copy(f.context.chat);
        assert.ok(original.every(message => !message.extra.homer_message_id));
        assert.equal(await invoke(f), true);
        const expected = expectedIndices.map(i => original[i]);
        assert.deepEqual(f.context.chat, expected);
        assert.equal(f.uploads.length, 1);
        assert.equal(f.h.launch.local_pending, true);
        assert.equal(f.h.rollbackBusy, false);
        assert.equal(f.h.suppressSync, false);
        assert.equal(f.h.dialogueEventLogMuted, 0);
        assert.equal(f.busyClasses.size, 0);
        assert.equal(f.notices.at(-1).level, 'success');
        await f.outbox.close();
        const restarted = createChatOutbox({ indexedDB: f.indexedDB, databaseName: 'local-mutation-outbox' });
        const saved = await restarted.read(scope);
        assert.deepEqual(saved.payload.messages, expected);
        assert.equal(saved.pending, true);
        assert.equal((await restarted.pending('different-owner')).length, 0);
    });

    test(`${operation} restores the full in-memory chat when the authoritative IDB write fails`, async () => {
        const f = fixture(), original = copy(f.context.chat);
        await f.outbox.prepare(f.h.captureCurrentChatStorage());
        f.indexedDB.failNextPut = true;
        assert.equal(await invoke(f), false);
        assert.deepEqual(f.context.chat, original);
        assert.deepEqual((await f.outbox.read(scope)).payload.messages, original);
        assert.equal(f.uploads.length, 0);
        assert.equal(f.logs.length, 0);
        assert.equal(f.notices.at(-1).level, 'error');
        assert.equal(f.h.rollbackBusy, false);
        assert.equal(f.h.suppressSync, false);
        assert.equal(f.busyClasses.size, 0);
        assert.deepEqual(f.events.at(-1), ['print', original]);
    });

    test(`${operation} does not discard the committed mutation when only the compatibility mirror fails`, async () => {
        const f = fixture({ mirrorFailure: true }), original = copy(f.context.chat);
        assert.equal(await invoke(f), true);
        assert.deepEqual((await f.outbox.read(scope)).payload.messages, expectedIndices.map(i => original[i]));
        assert.equal(f.notices.at(-1).level, 'success');
    });

    test(`${operation} failure restores only its captured chat and cannot replace a newly active account's chat`, async () => {
        const f = fixture(), original = copy(f.context.chat);
        await f.outbox.prepare(f.h.captureCurrentChatStorage());
        const gate = f.indexedDB.holdNextCommit();
        const mutation = invoke(f);
        await gate.reached;
        const newChat = [{ mes: 'different account private chat', extra: {} }];
        f.h.activeContext = { chat: copy(newChat), chatMetadata: {}, chatId: 'other-chat',
            async printMessages() { f.events.push(['other-print']); }, async saveChat() {} };
        f.h.owner = 'other-owner'; f.h.storageAccountEpoch += 1;
        f.h.launch = { app_id: 'other-card', conversation_id: 'other-conversation' };
        f.indexedDB.failNextPut = true;
        gate.release();
        assert.equal(await mutation, false);
        assert.deepEqual(f.h.activeContext.chat, newChat);
        assert.deepEqual(f.context.chat, original);
        assert.deepEqual((await f.outbox.read(scope)).payload.messages, original);
        assert.equal(await f.outbox.read(f.h.cloudSyncScope()), null);
        assert.equal(f.uploads.length, 0);
        assert.equal(f.events.some(event => event[0] === 'other-print'), false);
    });

    test(`${operation} cannot print or claim success in a new account after the original local commit completes`, async () => {
        const f = fixture(), original = copy(f.context.chat);
        const gate = f.indexedDB.holdNextCommit();
        const mutation = invoke(f);
        await gate.reached;
        const newChat = [{ mes: 'different account private chat', extra: {} }];
        f.h.activeContext = { chat: copy(newChat), chatMetadata: {}, chatId: 'other-chat',
            async printMessages() { f.events.push(['other-print']); }, async saveChat() { f.events.push(['other-save']); } };
        f.h.owner = 'other-owner'; f.h.storageAccountEpoch += 1;
        f.h.launch = { app_id: 'other-card', conversation_id: 'other-conversation' };
        gate.release();
        assert.equal(await mutation, false);
        assert.deepEqual(f.h.activeContext.chat, newChat);
        assert.deepEqual((await f.outbox.read(scope)).payload.messages, expectedIndices.map(i => original[i]));
        assert.equal(await f.outbox.read(f.h.cloudSyncScope()), null);
        assert.equal(f.events.length, 0);
        assert.equal(f.notices.some(notice => notice.level === 'success'), false);
    });

    test(`${operation} failure cannot restore old messages into a shared chat array repopulated for another account`, async () => {
        const f = fixture(), original = copy(f.context.chat);
        await f.outbox.prepare(f.h.captureCurrentChatStorage());
        const gate = f.indexedDB.holdNextCommit();
        const mutation = invoke(f);
        await gate.reached;
        const newChat = [{ mes: 'new account reused the canonical chat array', extra: {} }];
        // Actual upstream load/clear operations splice the exported chat array.
        // Keeping the reference is not proof that it still belongs to A.
        f.context.chat.splice(0, f.context.chat.length, ...copy(newChat));
        f.h.activeContext = { ...f.context, chatMetadata: {}, chatId: 'other-chat' };
        f.h.owner = 'other-owner'; f.h.storageAccountEpoch += 1;
        f.h.launch = { app_id: 'other-card', conversation_id: 'other-conversation' };
        f.indexedDB.failNextPut = true;
        gate.release();
        assert.equal(await mutation, false);
        assert.deepEqual(f.h.activeContext.chat, newChat);
        assert.deepEqual((await f.outbox.read(scope)).payload.messages, original);
        assert.equal(await f.outbox.read(f.h.cloudSyncScope()), null);
        assert.equal(f.events.length, 0);
        assert.equal(f.uploads.length, 0);
    });
}

test('rollback to the first unsynced message durably preserves an intentionally empty phone conversation', async () => {
    const f = fixture();
    assert.equal(await f.h.rollbackToMessage(0, { askConfirmation: false }), true);
    assert.deepEqual(f.context.chat, []);
    assert.deepEqual((await f.outbox.read(scope)).payload.messages, []);
    assert.equal((await f.outbox.read(scope)).pending, true);
});

test('variable saving preserves all sanitized values in both durable stores without waiting for cloud ACK', async () => {
    const f = fixture(), expected = sanitizeRuntimeValue(copy(f.h.runtimeVariables));
    await f.h.persistRuntimeVariables();
    const queued = await f.outbox.read(scope, 'extension-settings');
    const resource = await f.localSessions.resource(scope, 'runtime-state');
    assert.deepEqual(queued.payload.variables, expected);
    assert.deepEqual(resource.variables, expected);
    assert.equal(resource.variables.values.length, 500);
    assert.equal(resource.variables.max_tokens, 8192);
    assert.equal(resource.variables.token_count, 63);
    assert.deepEqual(resource.extension_settings, { world: { enabled: true }, nested: { safe: 1 } });
    assert.equal(queued.pending, true);
    assert.equal(f.uploads.length, 1);
    assert.deepEqual(copy(f.context.chatMetadata.homer_model_settings), { model_id: 'model-a', temperature: 0.5 });
    assert.equal('homer_preset_overrides' in f.context.chatMetadata, false);
    f.h.runtimeVariables.values[0].state = 'changed after save';
    assert.equal((await f.localSessions.resource(scope, 'runtime-state')).variables.values[0].state, 'variable-0');
});

test('variable saving fails closed on either durable write failure and never starts a cloud upload', async () => {
    for (const failedStore of ['outbox', 'resource']) {
        const f = fixture();
        (failedStore === 'outbox' ? f.indexedDB : f.resourceIDB).failNextPut = true;
        await assert.rejects(f.h.persistRuntimeVariables());
        assert.equal(f.uploads.length, 0);
        assert.equal(await f.localSessions.resource(scope, 'runtime-state'), null);
        const queued = await f.outbox.read(scope, 'extension-settings');
        if (failedStore === 'outbox') assert.equal(queued, null);
        else { assert.equal(queued.pending, true); assert.equal(queued.payload.variables.values.length, 500); }
    }
});

test('variable resource and queued upload use the same immutable values when variables change while the write commits', async () => {
    const f = fixture(), expected = sanitizeRuntimeValue(copy(f.h.runtimeVariables));
    const gate = f.indexedDB.holdNextCommit();
    const save = f.h.persistRuntimeVariables();
    await gate.reached;
    f.h.runtimeVariables.values[0].state = 'newer unsaved value';
    f.h.settings.world.enabled = false;
    gate.release();
    await save;
    assert.deepEqual((await f.localSessions.resource(scope, 'runtime-state')).variables, expected);
    assert.deepEqual((await f.outbox.read(scope, 'extension-settings')).payload.variables, expected);
    assert.deepEqual(f.uploads[0].payload.variables, expected);
    assert.equal((await f.localSessions.resource(scope, 'runtime-state')).extension_settings.world.enabled, true);
});

test('variable saving rejects a changed account after committing only the immutable original outbox snapshot', async () => {
    const f = fixture(), expected = sanitizeRuntimeValue(copy(f.h.runtimeVariables));
    const gate = f.indexedDB.holdNextCommit();
    const save = f.h.persistRuntimeVariables();
    await gate.reached;
    f.h.owner = 'other-owner'; f.h.storageAccountEpoch += 1;
    f.h.launch = { app_id: 'other-card', conversation_id: 'other-conversation' };
    f.h.runtimeVariables = { other_account: true };
    const otherScope = f.h.cloudSyncScope();
    gate.release();
    await assert.rejects(save, /会话已切换/);
    assert.equal(await f.localSessions.resource(otherScope, 'runtime-state'), null);
    assert.equal(await f.localSessions.resource(scope, 'runtime-state'), null);
    assert.deepEqual((await f.outbox.read(scope, 'extension-settings')).payload.variables, expected);
    assert.equal(await f.outbox.read(otherScope, 'extension-settings'), null);
    assert.equal(f.uploads.length, 0);
});
