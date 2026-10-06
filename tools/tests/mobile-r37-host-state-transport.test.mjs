import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publicModel } from '../../.web-cache/tree/frontend/assets/js/model-catalog.js';
import { capturePromptMessageState } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';
import { createChatOutbox } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const bridge = readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../../.web-cache/tree/frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../../.web-cache/tree/frontend/assets/js/admin-dialogue.js', import.meta.url), 'utf8');

function extract(source, begin, end) {
    const start = source.indexOf(begin), finish = source.indexOf(end, start);
    assert.ok(start >= 0 && finish > start, `actual product section ${begin}`);
    return source.slice(start, finish);
}

const actualBridge = [
    extract(bridge, 'function safeSiteOrigin(', 'const HOST_OVERLAY_SELECTOR'),
    extract(bridge, 'function currentRoleName(', 'function notifyHostLoading('),
    extract(bridge, 'function canonicalDisplayTexts(', 'function openHostRequestedSettings('),
    extract(bridge, 'function serializeChat(', 'async function recoverFailedGeneration('),
    extract(bridge, 'function hasCanonicalConversationScope(', 'function assertCanonicalConversationScope('),
    extract(bridge, 'function currentConversationRecord(', 'function updateConversationTitle('),
].join('\n');

const plain = value => JSON.parse(JSON.stringify(value));

function message(overrides = {}) {
    return { name: 'Fixture assistant', is_user: false, is_system: false,
        send_date: '2026-01-01T00:00:00.000Z', mes: 'fixture first source',
        swipes: ['fixture first source', 'fixture selected source'], swipe_id: 1,
        extra: { homer_message_id: 'fixture-message', homer_created_at: 123,
            homer_hidden: false, homer_collapsed: false }, ...overrides };
}

function harness(initialMessages = [message()]) {
    let owner = 'owner-a', nextTimer = 0;
    const timers = new Map(), posts = [], timeline = [];
    const canonical = { chat: initialMessages };
    const scope = vm.createContext({
        URL, HOST_CHANNEL: 'homer:dialogue-host:v1', requestedEmbed: '1', requestedIdleHostDisplay: false,
        requestedHostChannel: 'homer:dialogue-host:v1', requestedSiteOrigin: 'https://fixture.invalid',
        session: null, launch: null, runtimeUiData: { conversations: [], models: [{ id: 'fixture-model' }], modelDefaultId: 'fixture-model' },
        hostStateNotifyTimer: null, hostStateNotifyToken: null, generationBusy: false, rollbackBusy: false, loadingLaunch: false,
        conversationRecoveryBlocked: false, hostOverlayActive: false,
        tavoComposer: { refresh() {} }, syncHostOverlayState() {}, restoreScopeDraft() {},
        reconcileStorageAccount: () => owner, isGenerating: () => false,
        getContext: () => canonical, capturePromptMessageState, publicModel,
        conversationModelSettings: () => ({ model_id: 'fixture-model', temperature: 0.7 }),
        document: { querySelectorAll: () => [], querySelector: () => ({ value: 'fixture draft' }) },
        window: {
            location: { origin: 'https://fixture.invalid' },
            parent: { postMessage(data, origin) {
                timeline.push({ kind: 'post', type: data.type, pendingTimers: timers.size });
                posts.push({ data: plain(data), origin });
            } },
            setTimeout(callback, delay) {
                timers.set(++nextTimer, { callback, delay });
                timeline.push({ kind: 'schedule', id: nextTimer, delay });
                return nextTimer;
            },
            clearTimeout(id) { timers.delete(id); },
        },
    });
    vm.runInContext(actualBridge, scope);
    function bind(nextOwner = 'owner-a', app = 'card-a', conversation = 'chat-a', messages = canonical.chat) {
        owner = nextOwner;
        scope.session = { user: { id: owner } };
        scope.launch = { app_id: app, conversation_id: conversation, card: { data: { name: `Role ${app}` } },
            conversation: { id: conversation, app_id: app, app_name: `Role ${app}` } };
        canonical.chat = messages;
        canonical.chatId = `Homer-${conversation.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        canonical.characterId = 0;
        canonical.characters = [{ data: { extensions: { homer_bridge: { app_id: app } } } }];
        canonical.chatMetadata = { homer_bridge: { user_id: owner, app_id: app, conversation_id: conversation, runtime: 'dialogue' } };
    }
    function flush() {
        for (const [id, timer] of [...timers]) {
            if (!timers.delete(id)) continue;
            timer.callback();
        }
    }
    bind();
    return { scope, canonical, posts, timeline, timers, bind, flush,
        states: () => posts.filter(post => post.data.type === 'state').map(post => post.data.state),
        setOwner: value => { owner = value; } };
}

function normalize(snapshot) {
    const context = vm.createContext({ activeAppId: 'card-a', activeConversationId: 'chat-a',
        safePreviewImage: value => value || '', visiblePreviewText: value => String(value || '').trim().slice(0, 12_000) });
    vm.runInContext(extract(host, 'function normalizeMessage(', 'function readCachedConversation('), context);
    const result = context.conversationSnapshot({ app_id: 'card-a', conversation_id: 'chat-a', messages: [snapshot] });
    return plain(result.messages);
}

test('actual host notification omits full swipe bodies and retains the selected source without mutating canonical messages', () => {
    const original = message({ swipes: ['A'.repeat(1_572_864), 'B'.repeat(1_572_864)],
        extra: { homer_message_id: 'fixture-large', homer_created_at: 123, homer_hidden: true, homer_collapsed: true } });
    const before = plain(original);
    Object.freeze(original.swipes); Object.freeze(original.extra); Object.freeze(original);
    const h = harness([original]);
    const snapshot = h.scope.hostMessageSnapshot(original, 0, new Map([[0, 'fixture rendered text']]));
    assert.equal(Object.hasOwn(snapshot, 'swipes'), false);
    assert.equal(snapshot.content, original.swipes[1].slice(0, 60_000));
    assert.equal(snapshot.swipe_index, 1);
    assert.equal(snapshot.hidden, true); assert.equal(snapshot.collapsed, true);
    assert.equal(snapshot.display_text, 'fixture rendered text'); assert.equal(snapshot.created_at, 123);
    assert.ok(JSON.stringify(snapshot).length < 61_000, 'notification does not transfer multi-MB alternate sources');
    assert.deepEqual(plain(original), before);
});

test('thin notifications have the same actual host normalization as the previous full-swipe payload', () => {
    const cases = [
        message(), message({ is_user: true }), message({ swipes: [], mes: 'standalone source', swipe_id: 0 }),
        message({ swipe_id: 999 }), message({ extra: { homer_hidden: true, homer_collapsed: true } }),
        message({ swipes: ['first', 'unicode source 文本'.repeat(8_000)] }),
    ];
    for (const original of cases) {
        const h = harness([original]);
        const snapshot = h.scope.hostMessageSnapshot(original, 0, new Map([[0, 'rendered <tag> & ordinary text']]));
        const legacyPayload = { ...snapshot, swipes: original.swipes.slice(0, 100) };
        assert.deepEqual(normalize(snapshot), normalize(legacyPayload));
        assert.equal(Object.hasOwn(normalize(snapshot)[0], 'swipes'), false);
    }
});

test('actual complete serializer and outbox preserve full swipes through durable prepare and cloud ACK', async () => {
    const original = message({ swipes: ['A'.repeat(1_572_864), 'B'.repeat(1_572_864)], mes: 'B'.repeat(1_572_864) });
    const h = harness([original]);
    h.scope.hostMessageSnapshot(original, 0, null);
    const serialized = plain(h.scope.serializeChat());
    assert.deepEqual(serialized[0].swipes, original.swipes);
    assert.equal(serialized[0].mes, original.mes); assert.equal(serialized[0].swipe_id, 1);
    const outbox = createChatOutbox({ indexedDB: transactionIDB(), databaseName: 'host-state-transport' });
    const identity = JSON.stringify(['owner-a', 'card-a', 'chat-a']);
    const committed = await outbox.prepare({ scope: identity, body: JSON.stringify({
        app_id: 'card-a', conversation_id: 'chat-a', messages: serialized }) });
    const acknowledgement = { messages: [{ id: 'fixture-cloud-message', role: 'assistant', content: original.mes,
        swipes: original.swipes, swipe_index: 1 }] };
    assert.equal((await outbox.cloudACK(committed, acknowledgement)).applied, true);
    const saved = await outbox.read(identity);
    assert.deepEqual(saved.payload.messages[0].swipes, original.swipes);
    assert.deepEqual(saved.ackPayload.messages[0].swipes, original.swipes);
    assert.equal(saved.ackRevision, saved.revision); assert.equal(saved.pending, false);
    await outbox.close();
});

test('actual ready explicitly promises state only after its real timer is scheduled', () => {
    const h = harness();
    h.scope.notifyHostConversation('ready', { state_scheduled: false });
    const ready = h.posts.find(post => post.data.type === 'ready');
    assert.equal(ready.data.state_scheduled, true);
    assert.equal(h.timeline.find(entry => entry.kind === 'post' && entry.type === 'ready').pendingTimers, 1);
    assert.equal(h.timers.size, 1); assert.equal(h.states().length, 0);
    h.flush();
    assert.equal(h.states().length, 1); assert.equal(h.states()[0].conversation_id, 'chat-a');
    assert.equal(h.states()[0].messages[0].content, 'fixture selected source');
    assert.equal(Object.hasOwn(h.states()[0].messages[0], 'swipes'), false);
});

test('a failed timer cannot publish a ready promise for state that was never scheduled', () => {
    const h = harness();
    h.scope.window.setTimeout = () => { throw new Error('fixture timer unavailable'); };
    assert.throws(() => h.scope.notifyHostConversation(), /fixture timer unavailable/);
    assert.equal(h.posts.some(post => post.data.type === 'ready'), false);
    assert.equal(h.timers.size, 0);
});

test('restored switch failure promises one state and retains the failed target identity', () => {
    const h = harness();
    h.scope.notifyHostConversation('conversation-switch-failed', { failed_app_id: 'failed-card', failed_conversation_id: 'failed-chat' });
    const failure = h.posts.find(post => post.data.type === 'conversation-switch-failed').data;
    assert.equal(failure.state_scheduled, true);
    assert.equal(failure.app_id, 'card-a'); assert.equal(failure.conversation_id, 'chat-a');
    assert.equal(failure.failed_app_id, 'failed-card'); assert.equal(failure.failed_conversation_id, 'failed-chat');
    assert.ok(h.posts.filter(post => ['title', 'conversation'].includes(post.data.type))
        .every(post => !Object.hasOwn(post.data, 'state_scheduled')));
    h.flush(); assert.equal(h.states().length, 1);
    assert.equal(h.states()[0].conversation_id, 'chat-a');
});

test('actual scheduler coalesces chat-loaded and repeated ready into one current state', () => {
    const h = harness();
    h.scope.scheduleHostStateNotify(0, 'chat-loaded');
    h.scope.notifyHostConversation(); h.scope.notifyHostConversation();
    assert.equal(h.timers.size, 1);
    h.flush();
    const states = h.posts.filter(post => post.data.type === 'state');
    assert.equal(states.length, 1); assert.equal(states[0].data.reason, 'ready');
    assert.equal(h.timers.size, 0); assert.equal(h.scope.hostStateNotifyTimer, null);
});

test('pending state cannot notify a target whose canonical scope has not been bound', () => {
    const h = harness(); h.scope.notifyHostConversation();
    h.scope.launch = { app_id: 'card-b', conversation_id: 'chat-b' };
    assert.equal(h.scope.hasCanonicalConversationScope(), false);
    h.flush(); assert.equal(h.states().length, 0);
    h.bind('owner-a', 'card-b', 'chat-b', [message({ mes: 'new source', swipes: [], swipe_id: 0 })]);
    h.scope.notifyHostConversation(); h.flush();
    assert.equal(h.states().length, 1); assert.equal(h.states()[0].app_id, 'card-b');
    assert.equal(h.states()[0].messages[0].content, 'new source');
});

test('coalesced scope/account transition serializes only the newly bound canonical conversation', () => {
    const h = harness(); h.scope.notifyHostConversation();
    h.setOwner('owner-b'); assert.equal(h.scope.hasCanonicalConversationScope(), false);
    h.bind('owner-b', 'card-b', 'chat-b', [message({ swipes: [], swipe_id: 0, mes: 'owner-b source' })]);
    h.scope.notifyHostConversation();
    assert.equal(h.timers.size, 1); h.flush();
    assert.equal(h.states().length, 1); assert.equal(h.states()[0].conversation_id, 'chat-b');
    assert.equal(h.states()[0].messages[0].content, 'owner-b source');
});

test('actual notification gates retain canonical recovery, embed and same-origin requirements', () => {
    const blocked = harness(); blocked.scope.conversationRecoveryBlocked = true;
    blocked.scope.notifyHostConversation(); blocked.flush(); assert.equal(blocked.states().length, 0);
    for (const [field, value] of [['requestedEmbed', '0'], ['requestedSiteOrigin', 'https://other.invalid'], ['requestedHostChannel', 'other-channel']]) {
        const h = harness(); h.scope[field] = value;
        h.scope.notifyHostConversation(); h.flush();
        assert.equal(h.posts.length, 0); assert.equal(h.timers.size, 0);
    }
});

test('actual existing admin host accepts the additive ready capability without consuming state swipes', () => {
    const h = harness(), listeners = [];
    const frame = {};
    const legacy = vm.createContext({ URLSearchParams, location: { origin: 'https://fixture.invalid' },
        window: { addEventListener: (type, callback) => { if (type === 'message') listeners.push(callback); } },
        document: { querySelector: () => ({ contentWindow: frame }) },
        clearTimeout() {}, performance: { mark() {} } });
    vm.runInContext(admin.replace(/^import .*\r?\n/, '').replace('export function adminDialogue(', 'function adminDialogue('), legacy);
    const controller = legacy.adminDialogue(); controller.preparePreviewRuntime();
    controller.previewPendingCard = 'card-a'; controller.previewStarting = true;
    h.scope.notifyHostConversation();
    const ready = h.posts.find(post => post.data.type === 'ready').data;
    listeners.forEach(callback => callback({ origin: 'https://fixture.invalid', source: frame, data: ready }));
    assert.equal(controller.previewStarted, true); assert.equal(controller.previewStarting, false);
    assert.equal(controller.previewPendingCard, ''); assert.equal(controller.previewSetupOpen, false);
});
