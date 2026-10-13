import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';
const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function changeMessagePresentation(');
const action = source.slice(begin, source.indexOf('\nfunction closeMessageSelection(', begin));
const clone = value => JSON.parse(JSON.stringify(value));
const scopeId = JSON.stringify(['qa-owner', 'qa-card', 'qa-chat']);
function fixture() {
    const indexedDB = transactionIDB(), outbox = createChatOutbox({ indexedDB }), notices = [], uploads = [];
    const context = { chat: [{ mes: 'unsynced local reply', is_system: false, extra: {} }], saveChat: async () => {} };
    const scope = {
        getContext: () => context, generationBusy: false, rollbackBusy: false, loadingLaunch: false,
        launch: { local_pending: false }, runtimeVariables: {}, conversationRecoveryBlocked: false,
        reconcileStorageAccount: () => 'qa-owner', storageAccountEpoch: 1,
        resolveMessageMenuTarget: item => ({ message: item.message || item }),
        assertCanonicalConversationScope() {}, hasCanonicalConversationScope: () => true,
        cloudHomerMessageId: m => m.extra?.homer_message_id || '', crypto: { randomUUID },
        chatOutbox: outbox,
        captureCurrentChatStorage: () => ({ scope: scopeId, body: JSON.stringify({ app_id: 'qa-card', conversation_id: 'qa-chat', messages: clone(context.chat) }) }),
        captureExtensionStorage: () => {
            const payload = { app_id: 'qa-card', conversation_id: 'qa-chat', extension_settings: {}, variables: clone(scope.runtimeVariables) };
            return { snapshot: { scope: scopeId, payload, body: JSON.stringify(payload) } };
        },
        syncCloudChatSnapshot: async snapshot => { uploads.push(snapshot); }, extensionSyncQueue: { enqueue: async () => {} },
        localSessions: { rememberResource: async () => {} }, renderMessageMenuTargets() {},
        queueMessageMenuRender() {}, scheduleHostStateNotify() {}, showHostNotice: (...args) => notices.push(args),
    };
    vm.createContext(scope); vm.runInContext(action, scope); return { scope, context, outbox, indexedDB, notices, uploads };
}
test('unsynced message collapse commits locally without waiting for an unresolved cloud ACK', async () => {
    const f = fixture(); f.scope.syncCloudChatSnapshot = () => new Promise(() => {});
    assert.equal(await f.scope.changeMessagePresentation(f.context.chat, 'collapse', true), true);
    const id = f.context.chat[0].extra.homer_sync_id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(f.context.chat[0].extra.homer_collapsed, true);
    const chat = await f.outbox.read(scopeId), settings = await f.outbox.read(scopeId, 'extension-settings');
    assert.equal(chat.payload.messages[0].extra.homer_collapsed, true);
    assert.equal(settings.payload.variables.homer_message_presentation[id].collapsed, true);
    assert.equal(f.scope.rollbackBusy, false); assert.equal(f.notices.at(-1)[1], 'success');
});
test('hide/unhide preserves the original role and a stable UUID through local reopen', async () => {
    const f = fixture(); await f.scope.changeMessagePresentation(f.context.chat, 'hide', true);
    const id = f.context.chat[0].extra.homer_sync_id;
    assert.equal(f.context.chat[0].is_system, true);
    const stored = await f.outbox.read(scopeId); f.context.chat = stored.payload.messages;
    await f.scope.changeMessagePresentation(f.context.chat, 'hide', false);
    assert.equal(f.context.chat[0].is_system, false); assert.equal(f.context.chat[0].extra.homer_sync_id, id);
    assert.equal((await f.outbox.read(scopeId, 'extension-settings')).payload.variables.homer_message_presentation[id].hidden, false);
});
test('batch commit failure rolls back UI and both durable message/settings states', async () => {
    const f = fixture(); f.indexedDB.failNextPut = true;
    await assert.rejects(f.scope.changeMessagePresentation(f.context.chat, 'hide', true), { name: 'QuotaExceededError' });
    assert.equal(f.context.chat[0].is_system, false); assert.deepEqual(clone(f.context.chat[0].extra), {});
    assert.equal(await f.outbox.read(scopeId), null); assert.equal(await f.outbox.read(scopeId, 'extension-settings'), null);
    assert.equal(f.notices.length, 0); assert.equal(f.scope.rollbackBusy, false);
});
test('compatibility mirror failure cannot undo a successful durable local commit', async () => {
    const f = fixture(); f.context.saveChat = async () => { throw Error('mirror unavailable'); };
    assert.equal(await f.scope.changeMessagePresentation(f.context.chat, 'collapse', true), true);
    assert.equal((await f.outbox.read(scopeId)).payload.messages[0].extra.homer_collapsed, true);
});
test('already uploaded messages retain the server identity, without generating new UUIDs', async () => {
    const f = fixture(); f.context.chat[0].extra.homer_message_id = 'server-message';
    f.scope.crypto.randomUUID = () => assert.fail('Cloud identity already exists');
    await f.scope.changeMessagePresentation(f.context.chat, 'collapse', true);
    assert.equal((await f.outbox.read(scopeId, 'extension-settings')).payload.variables.homer_message_presentation['server-message'].collapsed, true);
});
test('scope change before durable commit rejects the mutation and does not affect the new scope', async () => {
    const f = fixture(), actual = f.outbox.prepareBatch;
    f.outbox.prepareBatch = async (entries, guard) => {
        f.scope.storageAccountEpoch++; f.scope.runtimeVariables = { newScope: true };
        return actual(entries, guard);
    };
    await assert.rejects(f.scope.changeMessagePresentation(f.context.chat, 'hide', true), { code: 'HOMER_OUTBOX_STALE_SCOPE' });
    assert.equal(f.scope.runtimeVariables.newScope, true); assert.equal(f.scope.runtimeVariables.homer_message_presentation, undefined);
    assert.equal(await f.outbox.read(scopeId), null);
});
