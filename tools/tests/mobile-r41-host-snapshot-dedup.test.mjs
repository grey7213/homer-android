import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publicModel } from '../../frontend/assets/js/model-catalog.js';
import { restoreCanonicalGreeting } from '../../sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';
import { restoreAcknowledgedPromptStates, samePromptMessageSource, clearPromptMessageState } from '../../sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';

// Execute the shipping functions. Only DOM, timers and event peripherals are
// synthetic; no account, service, generation or private card is involved.
const source = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, `shipping section ${start}`);
    return source.slice(begin, finish);
}
const actual = [
    section('function safeSiteOrigin(', 'const HOST_OVERLAY_SELECTOR'),
    section('function currentRoleName(', 'function notifyHostLoading('),
    section('function canonicalDisplayTexts(', 'function openHostRequestedSettings('),
    section('function currentConversationRecord(', 'function updateConversationTitle('),
    section('function hasCanonicalConversationScope(', 'function assertCanonicalConversationScope('),
    section('function normalizeOpeningMessage(', 'function cloudMessageToDialogue('),
    section('async function loadCloudChat(', 'function serializeChat('),
].join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
const fixtureMessage = (value = 'synthetic selected source') => ({
    mes: value, name: 'Synthetic assistant', is_user: false, is_system: false,
    swipes: ['synthetic alternate source', value], swipe_id: 1,
    extra: { homer_message_id: 'synthetic-message' },
});

function harness({ firstTimer = 1, loading = false, reuseTimer = false } = {}) {
    let owner = 'synthetic-owner-a', nextTimer = firstTimer;
    const timers = new Map(), cleared = [], posts = [], effects = [];
    let onPost = null, failPhase = null, domReads = 0;
    const context = { chat: [fixtureMessage()], chatMetadata: {}, chatId: '', characterId: 0, characters: [] };
    const scope = vm.createContext({
        URL, HOST_CHANNEL: 'homer:dialogue-host:v1', requestedEmbed: '1', requestedIdleHostDisplay: false,
        requestedHostChannel: 'homer:dialogue-host:v1', requestedSiteOrigin: 'https://synthetic.invalid',
        loadingLaunch: loading, session: null, launch: null, suppressSync: false,
        runtimeUiData: { conversations: [], models: [], modelDefaultId: '' },
        hostStateNotifyTimer: null, hostStateNotifyToken: null, generationBusy: false, rollbackBusy: false,
        conversationRecoveryBlocked: false, hostOverlayActive: false,
        tavoComposer: { refresh() {} }, syncHostOverlayState() {}, restoreScopeDraft() {},
        getContext: () => context, reconcileStorageAccount: () => owner,
        isGenerating: () => false, publicModel, conversationModelSettings: () => ({}),
        acknowledgedPromptTickets: new WeakMap(), restoreAcknowledgedPromptStates,
        samePromptMessageSource, clearPromptMessageState,
        cloneJsonValue: plain, cloudMessageToDialogue: plain,
        restoreCanonicalGreeting, getRegexScripts: () => [], regex_placement: { AI_OUTPUT: 2 },
        getRegexedString: () => assert.fail('plain fixture must not rerun display rules'),
        pendingCardScriptCharacter: null,
        prefetchPersonaAvatarsForCurrentChat: () => effects.push('persona-read'),
        holdLargeSourceLayout() { effects.push('hold'); return () => effects.push('release'); },
        queueMessageMenuRender: () => effects.push('message-menu'), performance: { mark() {} },
        event_types: { CHAT_CHANGED: 'chat-changed', CHAT_LOADED: 'chat-loaded' },
        eventSource: { async emit(event) {
            effects.push(event);
            if (failPhase === event) throw new Error('synthetic render failure');
        } },
        scrollChatToBottom: () => effects.push('scroll'), scrollOnMediaLoad: () => effects.push('media'),
        scheduleSync: delay => effects.push(`durable-sync:${delay}`),
        document: {
            querySelectorAll() { domReads++; return []; },
            querySelector: () => ({ value: 'synthetic draft' }),
        },
        window: {
            location: { origin: 'https://synthetic.invalid' },
            parent: { postMessage(data, origin) {
                if (onPost) onPost(data);
                posts.push({ data: plain(data), origin });
            } },
            setTimeout(callback, delay) {
                const id = reuseTimer ? firstTimer : nextTimer++;
                timers.set(id, { callback, delay });
                return id;
            },
            clearTimeout(id) { cleared.push(id); timers.delete(id); },
        },
    });
    context.printMessages = async () => {
        effects.push('print');
        if (failPhase === 'print') throw new Error('synthetic render failure');
    };
    vm.runInContext(actual, scope);
    function bind(nextOwner = owner, app = 'synthetic-card-a', conversation = 'synthetic-chat-a') {
        owner = nextOwner;
        scope.session = { user: { id: owner } };
        scope.launch = { app_id: app, conversation_id: conversation,
            card: { data: { name: 'Synthetic role' } }, messages: [fixtureMessage()] };
        context.chatId = `Homer-${conversation}`;
        context.characters = [{ avatar: 'synthetic.png', data: { extensions: { homer_bridge: { app_id: app } } } }];
        context.chatMetadata = { homer_bridge: { user_id: owner, app_id: app, conversation_id: conversation, runtime: 'dialogue' } };
    }
    function flush() {
        for (const [id, timer] of [...timers]) {
            if (!timers.delete(id)) continue;
            timer.callback();
        }
    }
    bind();
    return { scope, context, timers, cleared, posts, effects, bind, flush,
        states: () => posts.filter(item => item.data.type === 'state'),
        setOwner: value => { owner = value; },
        setPost: callback => { onPost = callback; },
        fail: phase => { failPhase = phase; },
        domReads: () => domReads };
}

test('shipping loading transaction retains rendering and durable sync but sends only its final ready snapshot', async () => {
    const h = harness({ loading: true }), original = plain(h.scope.launch.messages);
    await h.scope.loadCloudChat();
    assert.equal(h.timers.size, 0, 'chat-loaded display snapshot must wait for final ready');
    assert.equal(h.states().length, 0);
    assert.deepEqual(h.effects, ['hold', 'persona-read', 'print', 'message-menu', 'chat-changed', 'chat-loaded', 'release', 'scroll', 'media', 'durable-sync:100']);
    assert.deepEqual(plain(h.context.chat), original);
    h.scope.notifyHostConversation('ready');
    assert.equal(h.timers.size, 1);
    const ready = h.posts.find(item => item.data.type === 'ready');
    assert.equal(ready.data.state_scheduled, true);
    h.scope.loadingLaunch = false;
    h.flush();
    assert.equal(h.states().length, 1);
    assert.equal(h.states()[0].data.reason, 'ready');
    assert.equal(h.states()[0].data.state.messages[0].content, original[0].mes);
    assert.deepEqual(plain(h.context.chat), original, 'snapshot must not mutate complete canonical swipes');
});

test('shipping ordinary cloud reloads continue to notify and never retain a loading suppression latch', async () => {
    const h = harness({ loading: true });
    h.scope.scheduleHostStateNotify(0, 'chat-loaded');
    assert.equal(h.timers.size, 0);
    h.scope.loadingLaunch = false;
    await h.scope.loadCloudChat();
    assert.equal(h.timers.size, 1);
    h.flush();
    assert.equal(h.states().length, 1);
    assert.equal(h.states()[0].data.reason, 'chat-loaded');
    assert.ok(h.effects.includes('durable-sync:100'));
});

test('loading coalesces only chat-loaded; ordinary edits, swipes, generation and model feedback remain scheduled', () => {
    for (const reason of ['message-edited', 'message-swiped', 'generation-started', 'generation-ended', 'model-settings', 'requested', 'ready']) {
        const h = harness({ loading: true });
        h.scope.scheduleHostStateNotify(0, reason);
        assert.equal(h.timers.size, 1, reason);
        h.flush();
        assert.equal(h.states().length, 1, reason);
        assert.equal(h.states()[0].data.reason, reason);
    }
});

test('failed render preserves cleanup and restored-switch feedback, without poisoning later ordinary notifications', async () => {
    for (const phase of ['print', 'chat-changed', 'chat-loaded']) {
        const h = harness({ loading: true }); h.fail(phase);
        await assert.rejects(h.scope.loadCloudChat(), /synthetic render failure/);
        assert.equal(h.scope.suppressSync, false);
        assert.equal(h.effects.at(-1), 'release');
        assert.equal(h.timers.size, 0);
        assert.equal(h.effects.some(item => item.startsWith('durable-sync:')), false);
        h.scope.notifyHostConversation('conversation-switch-failed', { failed_app_id: 'synthetic-failed-card' });
        h.scope.loadingLaunch = false;
        h.flush();
        assert.equal(h.states().length, 1);
        assert.equal(h.states()[0].data.reason, 'conversation-switch-failed');
        h.scope.scheduleHostStateNotify(0, 'message-edited'); h.flush();
        assert.equal(h.states().length, 2);
    }
});

test('eligible immediate state consumes its old scheduled notification, including timer ID zero', () => {
    for (const firstTimer of [0, 1]) {
        const h = harness({ firstTimer });
        h.scope.scheduleHostStateNotify(0, 'ready');
        assert.equal(h.scope.hostStateNotifyTimer, firstTimer);
        h.context.chat[0].mes = 'synthetic current source'; h.context.chat[0].swipes = [];
        h.scope.notifyHostState('requested');
        assert.equal(h.timers.size, 0);
        assert.equal(h.scope.hostStateNotifyTimer, null);
        h.flush();
        assert.equal(h.states().length, 1);
        assert.equal(h.states()[0].data.state.messages[0].content, 'synthetic current source');
    }
});

test('ineligible direct state must not cancel a future eligible current-scope snapshot', () => {
    for (const reason of ['account', 'scope', 'recovery', 'origin']) {
        const h = harness(); h.scope.scheduleHostStateNotify(0, 'ready');
        if (reason === 'account') h.setOwner('synthetic-owner-b');
        if (reason === 'scope') h.scope.launch = { ...h.scope.launch, conversation_id: 'synthetic-chat-b' };
        if (reason === 'recovery') h.scope.conversationRecoveryBlocked = true;
        if (reason === 'origin') h.scope.requestedSiteOrigin = 'https://foreign.invalid';
        h.scope.notifyHostState('requested');
        assert.equal(h.states().length, 0);
        assert.equal(h.timers.size, 1, reason);
        h.bind('synthetic-owner-b', 'synthetic-card-b', 'synthetic-chat-b');
        h.scope.conversationRecoveryBlocked = false; h.scope.requestedSiteOrigin = 'https://synthetic.invalid';
        h.flush();
        assert.equal(h.states().length, 1);
        assert.equal(h.states()[0].data.state.app_id, 'synthetic-card-b');
        assert.equal(h.states()[0].data.state.conversation_id, 'synthetic-chat-b');
    }
});

test('cancelled or account-invalidated pending notifications do not publish a stale state', () => {
    const h = harness(); h.scope.scheduleHostStateNotify(0, 'ready');
    h.setOwner('synthetic-owner-b'); h.flush();
    assert.equal(h.states().length, 0);
    h.bind('synthetic-owner-b', 'synthetic-card-b', 'synthetic-chat-b');
    h.scope.scheduleHostStateNotify(0, 'ready');
    h.scope.window.clearTimeout(h.scope.hostStateNotifyTimer); h.scope.hostStateNotifyTimer = null;
    h.flush(); assert.equal(h.states().length, 0);
    h.scope.scheduleHostStateNotify(0, 'message-edited'); h.flush();
    assert.equal(h.states().length, 1);
});

test('snapshot exceptions retain the scheduled retry rather than promising delivery that failed', () => {
    const h = harness(); h.scope.scheduleHostStateNotify(0, 'ready');
    h.setPost(data => { if (data.type === 'state') throw new Error('synthetic transport failure'); });
    assert.throws(() => h.scope.notifyHostState('requested'), /synthetic transport failure/);
    assert.equal(h.timers.size, 1);
    h.setPost(null); h.flush();
    assert.equal(h.states().length, 1);
});

test('composer exceptions preserve the existing scheduled state', () => {
    const h = harness(); h.scope.scheduleHostStateNotify(0, 'ready');
    h.scope.tavoComposer.refresh = () => { throw new Error('synthetic composer failure'); };
    assert.throws(() => h.scope.notifyHostState('requested'), /synthetic composer failure/);
    assert.equal(h.timers.size, 1);
    h.scope.tavoComposer.refresh = () => {}; h.flush();
    assert.equal(h.states().length, 1);
});

test('reentrant composer scheduling is future work and cannot be consumed by an immediate snapshot', () => {
    const h = harness(); h.scope.scheduleHostStateNotify(0, 'ready');
    h.scope.tavoComposer.refresh = () => {
        h.scope.tavoComposer.refresh = () => {};
        h.scope.scheduleHostStateNotify(0, 'message-updated');
    };
    h.scope.notifyHostState('requested');
    assert.equal(h.states().length, 1);
    assert.equal(h.timers.size, 1);
    h.context.chat[0].mes = 'synthetic later edit'; h.context.chat[0].swipes = [];
    h.flush();
    assert.equal(h.states().length, 2);
    assert.equal(h.states()[1].data.state.messages[0].content, 'synthetic later edit');
});

test('postMessage reentrancy retains a newly scheduled mutation and its complete current state', () => {
    const h = harness(); h.scope.scheduleHostStateNotify(0, 'ready');
    h.setPost(data => {
        if (data.type !== 'state') return;
        h.setPost(null);
        h.context.chat[0].mes = 'synthetic next source'; h.context.chat[0].swipes = [];
        h.scope.scheduleHostStateNotify(0, 'message-edited');
    });
    h.scope.notifyHostState('requested');
    assert.equal(h.timers.size, 1);
    h.flush(); assert.equal(h.states().length, 2);
    assert.equal(h.states()[1].data.state.messages[0].content, 'synthetic next source');
});

test('reentrant future work survives numeric timer ID reuse, including zero', () => {
    for (const firstTimer of [0, 1]) {
        for (const phase of ['composer', 'post']) {
            const h = harness({ firstTimer, reuseTimer: true });
            h.scope.scheduleHostStateNotify(0, 'ready');
            const scheduleNext = () => h.scope.scheduleHostStateNotify(0, 'message-edited');
            if (phase === 'composer') h.scope.tavoComposer.refresh = () => {
                h.scope.tavoComposer.refresh = () => {}; scheduleNext();
            };
            else h.setPost(data => {
                if (data.type !== 'state') return;
                h.setPost(null); scheduleNext();
            });
            h.scope.notifyHostState('requested');
            assert.equal(h.states().length, 1);
            assert.equal(h.scope.hostStateNotifyTimer, firstTimer);
            assert.equal(h.timers.size, 1, `${phase}, reused ID ${firstTimer}`);
            h.context.chat[0].mes = 'synthetic future source'; h.context.chat[0].swipes = [];
            h.flush();
            assert.equal(h.states().length, 2);
            assert.equal(h.states()[1].data.state.messages[0].content, 'synthetic future source');
            assert.equal(h.scope.hostStateNotifyTimer, null);
            assert.equal(h.scope.hostStateNotifyToken, null);
        }
    }
});

test('an obsolete callback cannot release or send another generation with the same numeric ID', () => {
    const h = harness({ firstTimer: 0, reuseTimer: true });
    h.scope.scheduleHostStateNotify(0, 'ready');
    const obsolete = h.timers.get(0).callback;
    h.scope.scheduleHostStateNotify(0, 'message-edited');
    const currentToken = h.scope.hostStateNotifyToken;
    obsolete();
    assert.equal(h.states().length, 0);
    assert.equal(h.scope.hostStateNotifyTimer, 0);
    assert.equal(h.scope.hostStateNotifyToken, currentToken);
    h.flush();
    assert.equal(h.states().length, 1);
    assert.equal(h.states()[0].data.reason, 'message-edited');
    assert.equal(h.scope.hostStateNotifyToken, null);
});

test('generation and rollback feedback keep their original no-DOM-text-read path', () => {
    for (const flag of ['generationBusy', 'rollbackBusy']) {
        const h = harness(); h.scope[flag] = true;
        h.scope.scheduleHostStateNotify(0, 'generation-started');
        h.scope.notifyHostState('requested');
        assert.equal(h.domReads(), 0);
        assert.equal(h.states()[0].data.state.generating, true);
        assert.equal(h.timers.size, 0);
    }
});
