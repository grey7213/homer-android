import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from '../webview-compat/node_modules/esbuild/lib/main.js';
import {
    capturePromptMessageState, prepareAcknowledgedPromptStates, restoreAcknowledgedPromptStates,
    samePromptMessageSource, clearPromptMessageState,
} from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';
import { createChatOutbox } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { restoreCanonicalGreeting, greetingSwipes } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';
import { hasNonemptyDOMText } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-ejs-pre.mjs';
import { holdLargeSourceLayout, SOURCE_LAYOUT_HOLD_CLASS } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-source-layout.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';
import { clearCardTransportMemory } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';

const source = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
    assert.ok(begin >= 0 && finish > begin, 'Actual bridge section missing: ' + start);
    return source.slice(begin, finish);
}
const clone = value => JSON.parse(JSON.stringify(value));
const scope = (owner = 'fixture-owner') => JSON.stringify([owner, 'fixture-card', 'fixture-conversation']);
const localMessage = (id = 'fixture-first', text = 'START', options = {}) => ({
    name: 'Fixture', is_user: false, is_system: false, send_date: '2026-01-01T00:00:00.000Z',
    mes: text, swipes: [text, text + ' alternate'], swipe_id: 0,
    extra: { homer_message_id: id, homer_sync_id: id },
    is_ejs_processed: [true], variables: [{ count: 1, nested: { value: 'once' } }], variables_initialized: [],
    ...options,
});
function snapshotMessage(message) {
    const captured = capturePromptMessageState(message), result = clone(message);
    clearPromptMessageState(result);
    if (captured) { Object.assign(result, captured.values); result.extra.homer_prompt_state = captured.descriptor; }
    return result;
}
const cloudMessage = message => ({
    id: message.extra.homer_message_id || message.extra.homer_sync_id,
    role: message.is_system && !message.extra.homer_hidden ? 'system' : message.is_user ? 'user' : 'assistant',
    content: message.mes, swipes: [...message.swipes], swipe_index: message.swipe_id, created_at: 123,
});
const projectedMessage = message => ({
    name: 'Fresh name', mes: message.content, swipes: [...message.swipes], swipe_id: message.swipe_index,
    is_user: message.role === 'user', is_system: message.role === 'system',
    extra: { homer_message_id: message.id, homer_sync_id: message.id },
    swipe_info: message.swipes.map(() => ({ extra: {} })),
});

test('versioned capture preserves the complete JSON tuple without sharing mutable values', () => {
    const message = localMessage(), captured = capturePromptMessageState(message);
    assert.deepEqual(captured.descriptor, { version: 1, present: { is_ejs_processed: true, variables: true, variables_initialized: true } });
    assert.deepEqual(captured.values.variables_initialized, []);
    captured.values.variables[0].nested.value = 'changed';
    assert.equal(message.variables[0].nested.value, 'once');
});

test('new versioned no-variable snapshot distinguishes absent fields from empty fields', () => {
    const message = localMessage(); delete message.variables; delete message.variables_initialized;
    const local = snapshotMessage(message), cloud = cloudMessage(local), projected = projectedMessage(cloud);
    assert.equal(restoreAcknowledgedPromptStates([projected], prepareAcknowledgedPromptStates([cloud], [local], [clone(cloud)])), 1);
    assert.deepEqual(projected.is_ejs_processed, [true]);
    assert.equal(Object.hasOwn(projected, 'variables'), false);
    assert.equal(Object.hasOwn(projected, 'variables_initialized'), false);
    assert.equal(projected.extra.homer_prompt_state.present.variables, false);
});

test('valid per-swipe sparse metadata roundtrips JSON holes and the selected alternate', () => {
    const message = localMessage(); message.swipe_id = 1; message.mes = message.swipes[1];
    message.is_ejs_processed = [, true]; message.variables = [, { count: 2 }]; message.variables_initialized = [, true];
    const local = snapshotMessage(message), cloud = cloudMessage(local), projected = projectedMessage(cloud);
    assert.equal(restoreAcknowledgedPromptStates([projected], prepareAcknowledgedPromptStates([cloud], [local], [cloud])), 1);
    assert.deepEqual(projected.is_ejs_processed, [null, true]);
    assert.deepEqual(projected.variables, [null, { count: 2 }]);
});

test('unknown legacy isolated flags and incomplete/corrupt versioned tuples never restore', () => {
    for (const mode of ['old', 'presence', 'flag', 'variables', 'initialized', 'version', 'contradiction', 'bounds']) {
        const local = snapshotMessage(localMessage()), cloud = cloudMessage(local);
        if (mode === 'old') delete local.extra.homer_prompt_state;
        if (mode === 'presence') delete local.variables_initialized;
        if (mode === 'flag') local.is_ejs_processed = ['true'];
        if (mode === 'variables') local.variables = [123];
        if (mode === 'initialized') local.variables_initialized = [true];
        if (mode === 'initialized') local.variables = [];
        if (mode === 'version') local.extra.homer_prompt_state.version = 2;
        if (mode === 'contradiction') local.variables = [];
        if (mode === 'bounds') local.is_ejs_processed = [true, false, true];
        assert.deepEqual(prepareAcknowledgedPromptStates([cloud], [local], [cloud]), [null], mode);
    }
});

test('cyclic/non-JSON/getter variable objects cannot be mislabeled as a complete snapshot', () => {
    for (const mode of ['cycle', 'function', 'getter', 'date', 'nan']) {
        const message = localMessage();
        if (mode === 'cycle') message.variables[0].cycle = message.variables[0];
        if (mode === 'function') message.variables[0].action = () => {};
        if (mode === 'getter') Object.defineProperty(message.variables[0], 'read', { enumerable: true, get() { throw new Error('must not execute'); } });
        if (mode === 'date') message.variables[0].date = new Date();
        if (mode === 'nan') message.variables[0].number = NaN;
        assert.equal(capturePromptMessageState(message), null, mode);
    }
});

test('root tuple fields, array indices and nested variable accessors are rejected without executing getters', () => {
    for (const mode of ['field', 'array', 'nested']) {
        const message = localMessage(); let calls = 0;
        const getter = () => { calls++; return mode === 'field' ? [true] : {}; };
        if (mode === 'field') Object.defineProperty(message, 'is_ejs_processed', { enumerable: true, get: getter });
        if (mode === 'array') Object.defineProperty(message.variables, '0', { enumerable: true, get: getter });
        if (mode === 'nested') Object.defineProperty(message.variables[0], 'value', { enumerable: true, get: getter });
        assert.equal(capturePromptMessageState(message), null, mode);
        assert.equal(calls, 0, mode);
    }
});

test('both the fresh cloud and ACK must match local ID, role, raw body, all swipes and active index exactly', () => {
    for (const target of ['cloud', 'ack']) for (const field of ['id', 'role', 'content', 'swipes', 'swipe_index']) {
        const local = snapshotMessage(localMessage()), cloud = cloudMessage(local), ack = clone(cloud);
        const altered = target === 'cloud' ? cloud : ack;
        if (field === 'id') altered.id = 'other-id';
        if (field === 'role') altered.role = 'user';
        if (field === 'content') altered.content += ' remote edit';
        if (field === 'swipes') altered.swipes[1] += ' remote alternate edit';
        if (field === 'swipe_index') altered.swipe_index = 1;
        assert.deepEqual(prepareAcknowledgedPromptStates([cloud], [local], [ack]), [null], target + ':' + field);
    }
});

test('fresh deletion/insertion/reorder and duplicate IDs cannot cross-associate metadata', () => {
    const locals = [snapshotMessage(localMessage('first')), snapshotMessage(localMessage('second', 'SECOND'))];
    const clouds = locals.map(cloudMessage);
    assert.deepEqual(prepareAcknowledgedPromptStates([clouds[1]], locals, clouds), [null]);
    assert.deepEqual(prepareAcknowledgedPromptStates([clouds[1], clouds[0]], locals, clouds), [null, null]);
    const added = cloudMessage(localMessage('new', 'NEW'));
    const inserted = prepareAcknowledgedPromptStates([added, ...clouds], locals, clouds);
    assert.deepEqual(inserted, [null, null, null]);
    for (const target of ['cloud', 'local', 'ack']) {
        const fresh = clone(clouds), local = clone(locals), ack = clone(clouds);
        if (target === 'cloud') fresh[1].id = fresh[0].id;
        if (target === 'ack') ack[1].id = ack[0].id;
        if (target === 'local') local[1].extra = clone(local[0].extra);
        assert.deepEqual(prepareAcknowledgedPromptStates(fresh, local, ack), [null, null], target);
    }
});

test('a fresh appended/edited message remains cloud-authoritative while unchanged prefix may retain state', () => {
    const locals = [snapshotMessage(localMessage('first')), snapshotMessage(localMessage('second', 'SECOND'))], clouds = locals.map(cloudMessage);
    const fresh = [...clone(clouds), cloudMessage(localMessage('new', 'NEW'))]; fresh[1].content = 'remote edit'; fresh[1].swipes[0] = 'remote edit';
    const states = prepareAcknowledgedPromptStates(fresh, locals, clouds), projected = fresh.map(projectedMessage);
    assert.equal(restoreAcknowledgedPromptStates(projected, states), 1);
    assert.equal(projected[1].mes, 'remote edit'); assert.equal(Object.hasOwn(projected[1], 'is_ejs_processed'), false);
    assert.equal(projected[2].mes, 'NEW'); assert.equal(Object.hasOwn(projected[2], 'is_ejs_processed'), false);
});

test('permanent mes/swipe disagreement and greeting normalization changes cannot restore state', () => {
    const local = snapshotMessage(localMessage()), cloud = cloudMessage(local), states = prepareAcknowledgedPromptStates([cloud], [local], [cloud]);
    for (const field of ['mes', 'swipes', 'swipe_id', 'role']) {
        const projected = projectedMessage(cloud);
        if (field === 'mes') projected.mes += ' normalized';
        if (field === 'swipes') projected.swipes.push('new author greeting');
        if (field === 'swipe_id') { projected.swipe_id = 1; projected.mes = projected.swipes[1]; }
        if (field === 'role') projected.is_user = true;
        assert.equal(restoreAcknowledgedPromptStates([projected], states), 0, field);
        assert.equal(Object.hasOwn(projected, 'is_ejs_processed'), false);
    }
    const changed = snapshotMessage(localMessage()); changed.mes = 'permanently changed';
    const changedCloud = cloudMessage(changed);
    assert.deepEqual(prepareAcknowledgedPromptStates([changedCloud], [changed], [changedCloud]), [null]);
});

test('restoration is a fresh clone and leaves cloud ordering, bodies, defaults and ACK inputs untouched', () => {
    const local = snapshotMessage(localMessage()), cloud = cloudMessage(local), before = JSON.stringify([local, cloud]);
    const states = prepareAcknowledgedPromptStates([cloud], [local], [cloud]), projected = projectedMessage(cloud), original = clone(projected);
    assert.equal(restoreAcknowledgedPromptStates([projected], states), 1);
    for (const key of ['name', 'mes', 'swipes', 'swipe_id', 'swipe_info']) assert.deepEqual(projected[key], original[key]);
    projected.variables[0].count = 77;
    assert.equal(states[0].values.variables[0].count, 1);
    assert.equal(JSON.stringify([local, cloud]), before);
});

test('actual serializeChat records fields and absence descriptor, never a stale descriptor or arbitrary top-level field', () => {
    const message = localMessage(); message.unrelated_private = 'must not persist';
    message.extra.homer_prompt_state = { version: 999, present: {} };
    const context = { getContext: () => ({ chat: [message] }), launch: { conversation_id: 'fixture-conversation' }, capturePromptMessageState };
    vm.createContext(context); vm.runInContext(section('function serializeChat()', 'async function recoverFailedGeneration('), context);
    const saved = clone(context.serializeChat()[0]);
    assert.deepEqual(saved.is_ejs_processed, [true]);
    assert.deepEqual(saved.variables, message.variables); assert.deepEqual(saved.variables_initialized, []);
    assert.equal(saved.extra.homer_prompt_state.version, 1);
    assert.equal(Object.hasOwn(saved, 'unrelated_private'), false);
});

test('actual serializer uses native default swipe zero for a processed message without explicit swipe fields', () => {
    const message = localMessage(); delete message.swipes; delete message.swipe_id;
    const context = { getContext: () => ({ chat: [message] }), launch: { conversation_id: 'fixture-conversation' }, capturePromptMessageState };
    vm.createContext(context); vm.runInContext(section('function serializeChat()', 'async function recoverFailedGeneration('), context);
    const saved = clone(context.serializeChat()[0]);
    assert.deepEqual(saved.swipes, []); assert.equal(saved.swipe_id, 0);
    assert.deepEqual(saved.is_ejs_processed, [true]); assert.equal(saved.extra.homer_prompt_state.version, 1);
});

test('actual serializer rejects an accessor state field without executing it or persisting an old presence descriptor', () => {
    const message = localMessage(); let calls = 0;
    Object.defineProperty(message, 'variables', { enumerable: true, get() { calls++; return [{}]; } });
    message.extra.homer_prompt_state = { version: 1, present: { is_ejs_processed: true, variables: true, variables_initialized: true } };
    const context = { getContext: () => ({ chat: [message] }), launch: { conversation_id: 'fixture-conversation' }, capturePromptMessageState };
    vm.createContext(context); vm.runInContext(section('function serializeChat()', 'async function recoverFailedGeneration('), context);
    const saved = clone(context.serializeChat()[0]);
    assert.equal(calls, 0); assert.equal(Object.hasOwn(saved, 'variables'), false);
    assert.equal(Object.hasOwn(saved, 'is_ejs_processed'), false); assert.equal(saved.extra.homer_prompt_state, undefined);
});

function bridgeHarness() {
    const outbox = createChatOutbox({ indexedDB: transactionIDB(), databaseName: 'r37-prompt' });
    const context = {
        owner: 'fixture-owner', storageAccountEpoch: 0, reconcileStorageAccount: () => context.owner,
        chatOutbox: outbox, sessionReadFences: new WeakMap(), storageAckStamps: new Map(),
        acknowledgedPromptTickets: new WeakMap(), prepareAcknowledgedPromptStates, restoreAcknowledgedPromptStates,
        capturePromptMessageState, samePromptMessageSource, clearPromptMessageState,
        cloneJsonValue: clone, storageAckKey: value => value,
    };
    vm.createContext(context); vm.runInContext(section('async function preferLocalSession(', 'async function fetchSession('), context);
    return { context, outbox };
}
const sessionPayload = messages => ({ user: { id: 'fixture-owner' }, launch: {
    app_id: 'fixture-card', conversation_id: 'fixture-conversation', messages,
} });
async function acknowledged(harness, local, ack) {
    const committed = await harness.outbox.prepare({ scope: scope(), body: JSON.stringify({
        app_id: 'fixture-card', conversation_id: 'fixture-conversation', messages: local,
    }) });
    await harness.outbox.cloudACK(committed, { messages: ack });
    return harness.outbox.fence(scope());
}

test('actual stable-ACK preferLocalSession attaches only a launch-keyed validated tuple ticket without overriding fresh body', async () => {
    const h = bridgeHarness(), locals = [snapshotMessage(localMessage())], clouds = locals.map(cloudMessage);
    const fence = await acknowledged(h, locals, clouds), payload = sessionPayload(clone(clouds));
    assert.equal(await h.context.preferLocalSession(payload, 'fixture-card', 'fixture-conversation', fence), payload);
    assert.equal(payload.launch.local_chat, undefined); assert.deepEqual(payload.launch.messages, clouds);
    const ticket = h.context.acknowledgedPromptTickets.get(payload.launch);
    assert.equal(ticket.owner, 'fixture-owner'); assert.equal(ticket.epoch, 0); assert.equal(ticket.scope, scope());
    assert.deepEqual(clone(ticket.states[0].values.variables), [{ count: 1, nested: { value: 'once' } }]);
    assert.equal(h.context.acknowledgedPromptTickets.get({ ...payload.launch }), undefined);
});

test('pending/newer-local path keeps its previous complete canonical preference rather than consuming stable-ACK ticket', async () => {
    const h = bridgeHarness(), locals = [snapshotMessage(localMessage())], clouds = locals.map(cloudMessage);
    const fence = await acknowledged(h, locals, clouds);
    locals[0].mes = 'new local'; locals[0].swipes[0] = 'new local';
    await h.outbox.prepare({ scope: scope(), body: JSON.stringify({ app_id: 'fixture-card', conversation_id: 'fixture-conversation', messages: locals }) });
    const payload = sessionPayload(clone(clouds));
    await h.context.preferLocalSession(payload, 'fixture-card', 'fixture-conversation', fence);
    assert.equal(payload.launch.local_chat[0].mes, 'new local'); assert.equal(payload.launch.local_pending, true);
    assert.equal(h.context.acknowledgedPromptTickets.get(payload.launch), undefined);
});

test('foreign owner and an account epoch change while the outbox read waits cannot create a ticket', async () => {
    for (const mode of ['owner', 'epoch']) {
        const h = bridgeHarness(), locals = [snapshotMessage(localMessage())], clouds = locals.map(cloudMessage);
        const fence = await acknowledged(h, locals, clouds), read = h.outbox.read.bind(h.outbox);
        h.outbox.read = async (...args) => { const row = await read(...args); if (mode === 'owner') h.context.owner = 'foreign-owner'; else h.context.storageAccountEpoch++; return row; };
        const payload = sessionPayload(clouds);
        await assert.rejects(h.context.preferLocalSession(payload, 'fixture-card', 'fixture-conversation', fence), /账号已切换/);
        assert.equal(h.context.acknowledgedPromptTickets.get(payload.launch), undefined);
    }
});

function loadHarness(h, payload) {
    const events = [], prints = [], chat = [], chatMetadata = {};
    const classes = new Set();
    const chatRoot = { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) } };
    Object.assign(h.context, {
        session: payload, launch: payload.launch, runtimeVariables: {}, suppressSync: false,
        holdLargeSourceLayout: () => holdLargeSourceLayout(chatRoot),
        restoreCanonicalGreeting, greetingSwipes, regex_placement: { AI_OUTPUT: 2 },
        getRegexScripts: () => [], getRegexedString: raw => raw,
        getContext: () => ({ chat, chatMetadata, chatId: 'Fixture', printMessages: async () => {
            assert.ok(classes.has(SOURCE_LAYOUT_HOLD_CLASS)); prints.push(clone(chat));
        } }),
        pendingCardScriptCharacter: null, performance: { mark() {} }, queueMessageMenuRender() {},
        event_types: { CHAT_CHANGED: 'changed', CHAT_LOADED: 'loaded' }, eventSource: { emit: async name => {
            assert.ok(classes.has(SOURCE_LAYOUT_HOLD_CLASS)); events.push(name);
        } },
        conversationModelSettings: () => ({}), prefetchPersonaAvatarsForCurrentChat() {},
        scrollChatToBottom() { assert.equal(classes.has(SOURCE_LAYOUT_HOLD_CLASS), false); },
        scrollOnMediaLoad() {}, scheduleSync() {}, scheduleHostStateNotify() {},
        cloneJsonValue: clone,
    });
    vm.runInContext(section('function normalizeOpeningMessage(', 'function cloudMessageToDialogue('), h.context);
    vm.runInContext(section('function cloudMessageToDialogue(', 'function serializeChat('), h.context);
    return { events, prints, chat, classes };
}

test('actual cloud hydration releases the source layout on an event failure and restores sync state', async () => {
    const h = bridgeHarness(), payload = sessionPayload([cloudMessage(snapshotMessage(localMessage()))]);
    const loaded = loadHarness(h, payload);
    h.context.eventSource.emit = async () => { throw new Error('Synthetic renderer failure'); };
    await assert.rejects(h.context.loadCloudChat(), /Synthetic renderer failure/);
    assert.equal(loaded.classes.has(SOURCE_LAYOUT_HOLD_CLASS), false);
    assert.equal(h.context.suppressSync, false);
    assert.equal(loaded.chat.length, 1);
});

test('actual cloud projection consumes the exact launch ticket before print/events, preserves swipe_info, and cannot reuse it', async () => {
    const h = bridgeHarness(), locals = [snapshotMessage(localMessage())], clouds = locals.map(cloudMessage);
    const fence = await acknowledged(h, locals, clouds), payload = sessionPayload(clone(clouds));
    payload.launch.card = { data: { name: 'Fresh card', first_mes: 'START', alternate_greetings: ['START alternate'] } };
    await h.context.preferLocalSession(payload, 'fixture-card', 'fixture-conversation', fence);
    const loaded = loadHarness(h, payload);
    await h.context.loadCloudChat();
    assert.deepEqual(clone(loaded.chat[0].is_ejs_processed), [true]);
    assert.deepEqual(loaded.prints[0][0].variables, [{ count: 1, nested: { value: 'once' } }]);
    assert.deepEqual(loaded.events, ['changed', 'loaded']);
    assert.equal(loaded.chat[0].swipe_info.length, 2);
    assert.equal(h.context.acknowledgedPromptTickets.get(payload.launch), undefined);
    await h.context.loadCloudChat();
    assert.equal(Object.hasOwn(loaded.chat[0], 'is_ejs_processed'), false, 'consumed ticket is not a state cache');
});

test('actual greeting canonicalization invalidates the formerly rendered state ticket rather than inheriting its flag', async () => {
    const h = bridgeHarness(), rendered = '<html><body><section class="legacy">START</section></body></html>';
    const locals = [snapshotMessage(localMessage('fixture-first', rendered, { swipes: [rendered], swipe_id: 0 }))], clouds = locals.map(cloudMessage);
    const fence = await acknowledged(h, locals, clouds), payload = sessionPayload(clone(clouds));
    payload.launch.card = { data: { name: 'Fresh card', first_mes: 'START', alternate_greetings: [] } };
    await h.context.preferLocalSession(payload, 'fixture-card', 'fixture-conversation', fence);
    const loaded = loadHarness(h, payload);
    h.context.getRegexScripts = () => [{ scriptName: 'fixture-author-rule', findRegex: '^START$', replaceString: rendered, placement: [2], markdownOnly: true, disabled: false }];
    h.context.getRegexedString = raw => raw === 'START' ? rendered : raw;
    await h.context.loadCloudChat();
    assert.equal(loaded.chat[0].mes, 'START');
    assert.equal(Object.hasOwn(loaded.chat[0], 'is_ejs_processed'), false);
    assert.equal(Object.hasOwn(loaded.chat[0], 'variables'), false);
});

test('actual ticket consumption rejects changed owner/epoch/scope or a distinct launch object', async () => {
    for (const mode of ['owner', 'epoch', 'scope', 'launch']) {
        const h = bridgeHarness(), locals = [snapshotMessage(localMessage())], clouds = locals.map(cloudMessage);
        const fence = await acknowledged(h, locals, clouds), payload = sessionPayload(clone(clouds));
        await h.context.preferLocalSession(payload, 'fixture-card', 'fixture-conversation', fence);
        const loaded = loadHarness(h, payload);
        if (mode === 'owner') h.context.owner = 'foreign-owner';
        if (mode === 'epoch') h.context.storageAccountEpoch++;
        if (mode === 'scope') payload.launch.conversation_id = 'other-conversation';
        if (mode === 'launch') h.context.launch = { ...payload.launch };
        await h.context.loadCloudChat();
        assert.equal(Object.hasOwn(loaded.chat[0], 'is_ejs_processed'), false, mode);
    }
});

test('same-owner login observed by actual reconciliation advances epoch before a formerly matching ticket can apply', async () => {
    const h = bridgeHarness(), locals = [snapshotMessage(localMessage())], clouds = locals.map(cloudMessage);
    const fence = await acknowledged(h, locals, clouds), payload = sessionPayload(clone(clouds));
    await h.context.preferLocalSession(payload, 'fixture-card', 'fixture-conversation', fence);
    const loaded = loadHarness(h, payload);
    // The local login cache has re-established the same owner, but this runtime
    // has not reconciled that new login yet. Use the real account helper rather
    // than a test double that changes epoch before the conditional is evaluated.
    Object.assign(h.context, {
        storageOwner: '', verifiedStorageOwner: '', storageRequests: new Set(),
        clearCardTransportMemory,
        cardPreparations: { clear() {} }, sessionPrefetchCache: new Map(), preparedAdminLaunch: null, scopeDrafts: new Map(),
        localStorage: { getItem: key => key === 'ai_xingyue_logged_in' ? '1'
            : key === 'ai_xingyue_user' ? JSON.stringify({ id: 'fixture-owner' }) : null },
    });
    vm.runInContext(section('function authenticatedStorageOwner()', 'async function requestScopedStorage('), h.context);
    await h.context.loadCloudChat();
    assert.equal(h.context.storageAccountEpoch, 1);
    assert.equal(h.context.storageOwner, 'fixture-owner');
    assert.equal(Object.hasOwn(loaded.chat[0], 'is_ejs_processed'), false);
});

test('restored tuple uses the actual Prompt handler dry-run path while raw/EJS/WI still run normally for an edited message', async () => {
    const plugin = new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template/', import.meta.url);
    const handlerSource = fs.readFileSync(new URL('src/modules/handler.ts', plugin), 'utf8');
    const begin = handlerSource.indexOf('async function handleMessageRender('), end = handlerSource.indexOf('// export for command', begin);
    const handler = transformSync(handlerSource.slice(begin, end), { loader: 'ts', target: 'es2022' }).code;
    const ejs = { module: { exports: {} }, exports: {} };
    vm.runInNewContext(fs.readFileSync(new URL('src/3rdparty/ejs.js', plugin), 'utf8'), ejs);
    for (const edited of [false, true]) {
        const local = snapshotMessage(localMessage()), fresh = cloudMessage(local);
        if (edited) { fresh.content = 'REMOTE'; fresh.swipes[0] = 'REMOTE'; }
        const message = projectedMessage(fresh);
        restoreAcknowledgedPromptStates([message], prepareAcknowledgedPromptStates([fresh], [local], [cloudMessage(local)]));
        const phases = [], evaluations = [], variables = message.variables?.[0] || { count: 0 };
        let html = '<p>' + message.mes + '</p>', saves = 0;
        const container = { text: () => 'visible message', html(value) { if (arguments.length) html = value; return html; } };
        const parent = { find: () => container };
        const context = {
            settings: { enabled: true, render_enabled: true, depth_limit: -1, code_blocks_enabled: true,
                raw_message_evaluation_enabled: true, cache_enabled: 0 },
            chat: [message], STATE: {}, isFakeRun: false, runID: 0, $: () => parent, hasNonemptyDOMText,
            prepareContext: async () => ({ variables }), getEnabledWorldInfoEntries: async () => [],
            evaluateWIEntities: async (_env, options) => { phases.push(options.decorator); return ''; },
            applyRegex: (_env, content, options) => options.before && !options.html ? '<% variables.count++ %>' + content : content,
            escapeReasoningBlocks: value => value, unescapeHtmlEntities: value => value,
            evalTemplateHandler: async (content, env, _where, options) => {
                evaluations.push(options.options.filename.startsWith('render_permanent/') ? 'permanent' : 'render');
                return ejs.module.exports.render(content, env, options.options);
            },
            messageFormatting: value => '<p>' + value + '</p>', getCurrentChatId: () => 'fixture-conversation',
            updateMessageBlock() {}, updateReasoningUI() {}, addCopyToCodeBlocks() {}, appendMediaToMessage() {},
            eventSource: { emit: async () => assert.fail('plain unchanged output does not emit duplicate frontend events') },
            event_types: { USER_MESSAGE_RENDERED: 'user', CHARACTER_MESSAGE_RENDERED: 'assistant' },
            checkAndSave: async () => { saves++; }, updateTokens() {},
            console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
        };
        vm.createContext(context); vm.runInContext(handler, context);
        await context.handleMessageRender('0', 'preload', true);
        assert.deepEqual(phases, ['@@render_before', '@@render_after'], 'all world-info render phases remain active');
        assert.deepEqual(evaluations, edited ? ['permanent', 'render'] : ['render']);
        assert.equal(variables.count, 1, 'valid once-only variable tuple is not re-executed or lost');
        assert.equal(saves, edited ? 1 : 0);
        assert.equal(message.is_ejs_processed[0], true);
    }
});
