import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const source = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(begin, end) { const a = source.indexOf(begin), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
const code = section('function cloneGenerationMessages(', 'async function syncLaunchCharacterAvatar(')
  + section('async function recoverFailedGeneration(', 'function cloudSyncScope(')
  + section('async function syncCloudChat(', 'async function syncCloudChatSnapshot(');
const ended = section('    for (const event of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED])', '    eventSource.on(event_types.CHAT_CHANGED');
const clone = value => JSON.parse(JSON.stringify(value));
const emitterSource = readFileSync(new URL('../../sillytavern-runtime/public/lib/eventemitter.js', import.meta.url), 'utf8');
function realEmitter(errors) {
  const sandbox = vm.createContext({ localStorage: { getItem: () => null },
    console: { trace() {}, debug() {}, error(error) { errors.push(error); } } });
  vm.runInContext(emitterSource.replace('export { EventEmitter }', ''), sandbox);
  return new sandbox.EventEmitter();
}
function fixture() {
  let owner = 'qa-owner'; const indexedDB = transactionIDB(), outbox = createChatOutbox({ indexedDB });
  const calls = { mirrors: 0, prints: 0, uploads: 0, notices: [], states: [], emitterErrors: [] };
  const context = { chatId: 'Homer-qa-chat', chat: [{ mes: 'saved opening', is_user: false }],
    saveChat: async () => { calls.mirrors++; }, printMessages: async () => { calls.prints++; } };
  const scope = vm.createContext({ structuredClone, Promise, console: { warn() {}, error() {}, debug() {}, log() {} },
    getContext: () => context, reconcileStorageAccount: () => owner, storageAccountEpoch: 1,
    launch: { app_id: 'qa-card', conversation_id: 'qa-chat', messages: clone(context.chat), local_pending: true },
    cloudSyncScope: () => JSON.stringify([owner, scope.launch.app_id, scope.launch.conversation_id]),
    lastSyncSignature: '', suppressSync: false, conversationRecoveryBlocked: false, dialogueEventLogMuted: 0,
    hasCanonicalConversationScope: () => true, assertCanonicalConversationScope() {},
    chatOutbox: outbox, canApplyCloudSync: () => true,
    serializeChat: () => clone(context.chat),
    captureCurrentChatStorage: () => {
      const payload = { app_id: scope.launch.app_id, conversation_id: scope.launch.conversation_id, messages: clone(context.chat) };
      return { scope: scope.cloudSyncScope(), payload, body: JSON.stringify(payload) };
    },
    syncCloudChatSnapshot: async () => { calls.uploads++; await new Promise(() => {}); },
    eventSource: realEmitter(calls.emitterErrors), event_types: { CHAT_LOADED: 'loaded', GENERATION_ENDED: 'ended', GENERATION_STOPPED: 'stopped' },
    generationFailure: () => ({ message: 'Synthetic failure' }), lastGenerationDiagnostic: null, MODULE_ID: 'qa',
    showHostNotice: (...args) => calls.notices.push(args), updateRuntimeStatus() {}, queueMessageMenuRender() {},
    generationRecoveryChain: Promise.resolve(), generationSnapshot: null, generationSettleTimer: null,
    generationBusy: true, activeGameTurn: null, syncTimer: null, isGenerating: () => false,
    renderDiagnosticButtons() {}, scheduleHostStateNotify: (...args) => calls.states.push(args),
    window: { clearTimeout() {} }, document: { body: { classList: { toggle() {} } } },
  });
  vm.runInContext(code, scope);
  const snapshot = scope.captureGenerationSnapshot('normal');
  context.chat.push({ mes: 'synthetic pending user', is_user: true }, { mes: '', is_user: false });
  scope.launch.messages = clone(context.chat);
  const recover = () => scope.recoverFailedGeneration(snapshot);
  return { scope, context, calls, outbox, indexedDB, snapshot, recover, owner(value) { owner = value; },
    installEnded() { vm.runInContext(ended, scope); } };
}
test('actual failed generation recovery commits canonical rollback without a cloud ACK or mirror response', async () => {
  const f = fixture(); f.context.saveChat = () => { f.calls.mirrors++; return new Promise(() => {}); };
  const result = await Promise.race([f.recover(), new Promise((_, reject) => setTimeout(() => reject(Error('Recovery waited for cloud/mirror')), 500))]);
  assert.equal(result, true); const stored = await f.outbox.read(f.snapshot.scope);
  assert.deepEqual(stored.payload.messages, [{ mes: 'saved opening', is_user: false }]);
  assert.equal(stored.pending, true); assert.equal(f.calls.uploads, 1); assert.equal(f.calls.prints, 1);
  assert.equal(f.calls.notices.length, 1); assert.equal(f.scope.suppressSync, false);
});
test('quota failure does not announce rollback or lose the current unsaved messages', async () => {
  const f = fixture(), failed = clone(f.context.chat); f.indexedDB.failNextPut = true;
  await assert.rejects(f.recover()); assert.deepEqual(clone(f.context.chat), failed);
  assert.equal(await f.outbox.read(f.snapshot.scope), null); assert.equal(f.calls.notices.length, 0);
  assert.equal(f.calls.prints, 0); assert.equal(f.calls.mirrors, 0);
  assert.equal(f.indexedDB.failNextPut, false); assert.ok(f.indexedDB.trace.includes('transaction-abort'));
});
for (const drift of ['owner', 'epoch', 'launch', 'chat-array', 'conversation']) {
  test(`actual recovery refuses a reused chatId after ${drift} drift`, async () => {
    const f = fixture(), failed = clone(f.context.chat);
    if (drift === 'owner') f.owner('qa-other');
    if (drift === 'epoch') f.scope.storageAccountEpoch++;
    if (drift === 'launch') f.scope.launch = { ...f.scope.launch };
    if (drift === 'chat-array') f.context.chat = clone(f.context.chat);
    if (drift === 'conversation') f.scope.launch.conversation_id = 'qa-other-chat';
    assert.equal(await f.recover(), false); assert.deepEqual(clone(f.context.chat), failed);
    assert.equal(await f.outbox.read(f.snapshot.scope), null); assert.equal(f.calls.prints, 0); assert.equal(f.calls.notices.length, 0);
  });
}
test('owner drift after canonical commit cannot repaint or report failure into a new account', async () => {
  const f = fixture(); f.scope.syncCloudChatSnapshot = async () => { f.owner('qa-other'); };
  assert.equal(await f.recover(), true); assert.ok(await f.outbox.read(f.snapshot.scope));
  assert.equal(f.calls.prints, 0); assert.equal(f.calls.notices.length, 0); assert.equal(f.calls.mirrors, 0);
});
test('actual GENERATION_STOPPED recovery settles Send while cloud ACK is unresolved', async () => {
  const f = fixture(); f.scope.generationSnapshot = f.snapshot; f.installEnded();
  await f.scope.eventSource.emit('stopped'); await f.scope.generationRecoveryChain;
  assert.equal(f.scope.generationBusy, false); assert.equal(f.calls.notices.length, 1);
  assert.ok(await f.outbox.read(f.snapshot.scope)); assert.equal(f.calls.states.at(-1)[1], 'generation-ended');
  assert.deepEqual(f.calls.emitterErrors, []);
});
test('queued old generation completion cannot save the new account after ABA relogin', async () => {
  const f = fixture(); let release; f.scope.generationRecoveryChain = new Promise(r => { release = r; });
  f.scope.generationSnapshot = f.snapshot; f.installEnded(); await f.scope.eventSource.emit('ended');
  f.scope.storageAccountEpoch++; f.context.chat = [{ mes: 'new login same identifiers', is_user: false }];
  release(); await f.scope.generationRecoveryChain;
  assert.equal(await f.outbox.read(f.snapshot.scope), null); assert.equal(f.calls.prints, 0); assert.equal(f.calls.states.length, 0);
  assert.equal(f.context.chat[0].mes, 'new login same identifiers');
  assert.deepEqual(f.calls.emitterErrors, []);
});
test('successful generation completion still saves real new text locally and settles Send', async () => {
  const f = fixture(); f.context.chat.at(-1).mes = 'successful synthetic reply';
  f.scope.generationSnapshot = f.snapshot; f.installEnded(); await f.scope.eventSource.emit('ended'); await f.scope.generationRecoveryChain;
  assert.equal(f.scope.generationBusy, false); assert.equal(f.calls.notices.length, 0);
  assert.equal((await f.outbox.read(f.snapshot.scope)).payload.messages.at(-1).mes, 'successful synthetic reply');
  assert.deepEqual(f.calls.emitterErrors, []);
});
