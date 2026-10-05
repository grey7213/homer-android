import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { restoreCanonicalGreeting } from '../../sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';
import { deferScrollUntilSourceLayoutRelease, holdLargeSourceLayout, SOURCE_LAYOUT_HOLD_CLASS } from '../../sillytavern-runtime/public/scripts/homer-source-layout.mjs';
import { restoreAcknowledgedPromptStates, samePromptMessageSource, clearPromptMessageState } from '../../sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';

const script = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function printHarness() {
    const calls = [];
    const context = {
        chat: [], power_user: { chat_truncation: 5 }, chatElement: { append: value => calls.push(['append', value]) },
        redisplayChat: async value => calls.push(['render', value]),
        scrollChatToBottom: value => calls.push(['scroll', value]),
        scrollOnMediaLoad: () => calls.push(['media']), delay: () => Promise.resolve(), debounce_timeout: { short: 1 },
    };
    vm.createContext(context);
    vm.runInContext(script.slice(script.indexOf('export async function printMessages('), script.indexOf('export async function redisplayChat(')).replace(/^export /, ''), context);
    return { context, calls };
}

test('normal printMessages retains its original automatic scroll/media behavior', async () => {
    const h = printHarness();
    await h.context.printMessages();
    assert.deepEqual(h.calls.map(call => call[0]), ['render', 'scroll', 'media']);
    assert.equal(h.calls[1][1].waitForFrame, true);
});

test('Homer deferred-scroll printing still renders all requested messages and respects truncation', async () => {
    const h = printHarness(); h.context.chat = Array.from({ length: 9 }, () => ({}));
    await h.context.printMessages({ scroll: false });
    assert.deepEqual(h.calls.map(call => call[0]), ['append', 'render']);
    assert.equal(h.calls[1][1].startIndex, 4);
    assert.equal(h.calls[1][1].fade, false);
});

function loadHarness(fail) {
    const calls = [], chat = [], metadata = {};
    const context = {
        suppressSync: false, session: { user: { id: 'fixture-owner' } }, holdLargeSourceLayout,
        acknowledgedPromptTickets: new WeakMap(), restoreAcknowledgedPromptStates, samePromptMessageSource, clearPromptMessageState,
        launch: { app_id: 'fixture-card', conversation_id: 'fixture-chat', local_chat: [{ mes: 'complete raw message', swipes: ['a', 'b'], extra: { hidden: true } }] },
        getContext: () => ({ chat, chatMetadata: metadata, chatId: 'Homer-fixture-chat', printMessages: async options => { calls.push(['print', options]); if (fail === 'print') throw Error('synthetic render failure'); } }),
        cloneJsonValue: value => JSON.parse(JSON.stringify(value)), conversationModelSettings: () => ({}),
        prefetchPersonaAvatarsForCurrentChat: () => calls.push(['prefetch']),
        performance: { mark() {} }, queueMessageMenuRender() {}, pendingCardScriptCharacter: null,
        event_types: { CHAT_CHANGED: 'changed', CHAT_LOADED: 'loaded' },
        eventSource: { emit: async event => { calls.push([event]); if (fail === event) throw Error('synthetic lifecycle failure'); } },
        scrollChatToBottom: options => calls.push(['scroll', options]), scheduleSync() {}, scheduleHostStateNotify() {}, restoreScopeDraft() {},
        scrollOnMediaLoad: () => calls.push(['media']),
        restoreCanonicalGreeting, getRegexScripts: () => [], regex_placement: { AI_OUTPUT: 2 },
        getRegexedString: () => assert.fail('plain storage fixture must not replay display rules'),
    };
    vm.createContext(context);
    vm.runInContext(bridge.slice(bridge.indexOf('function normalizeOpeningMessage('), bridge.indexOf('function cloudMessageToDialogue(')), context);
    vm.runInContext(bridge.slice(bridge.indexOf('async function loadCloudChat('), bridge.indexOf('function serializeChat(')), context);
    return { context, calls, chat, metadata };
}

test('actual cloud load starts fresh persona read before rendering and scrolls only after normal lifecycle', async () => {
    const h = loadHarness(); await h.context.loadCloudChat();
    assert.deepEqual(h.calls.map(call => call[0]), ['prefetch', 'print', 'changed', 'loaded', 'scroll', 'media']);
    assert.equal(h.calls[1][1].scroll, false);
    assert.equal(h.chat[0].mes, 'complete raw message');
    assert.deepEqual([...h.chat[0].swipes], ['a', 'b']);
    assert.equal(h.metadata.homer_bridge.user_id, 'fixture-owner');
    assert.equal(h.context.suppressSync, false);
});

for (const stage of ['print', 'changed', 'loaded']) test(`actual ${stage} failure cannot permanently disable later saves`, async () => {
    const h = loadHarness(stage);
    await assert.rejects(h.context.loadCloudChat(), /synthetic/);
    assert.equal(h.context.suppressSync, false);
    assert.equal(h.calls.some(call => call[0] === 'scroll'), false);
});

function scrollRoot(height = 800) {
    const classes = new Set();
    const root = { isConnected: true, heightReads: 0, classList: {
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
    } };
    Object.defineProperty(root, 'scrollHeight', { get() { root.heightReads++; return height; } });
    return root;
}

function scrollHarness() {
    const frames = new Map(), cancelled = [], writes = [], counters = { position: 0, scrollTop: 0 };
    let nextId = 0, currentTop = 17;
    const root = scrollRoot();
    const lastMessage = { length: 1, position() { counters.position++; return { top: 48 }; } };
    const element = { 0: root,
        find(selector) { assert.equal(selector, '.mes'); return { last: () => lastMessage }; },
        scrollTop(value) {
            if (arguments.length === 0) { counters.scrollTop++; return currentTop; }
            currentTop = value; writes.push([element[0], value]); return element;
        },
    };
    const context = {
        chatElement: element, power_user: { auto_scroll_chat_to_bottom: true, waifuMode: false },
        deferScrollUntilSourceLayoutRelease,
        requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { cancelled.push(id); frames.delete(id); },
    };
    vm.createContext(context);
    const body = script.slice(script.indexOf('let requestId = null;'), script.indexOf('export function substituteParamsExtended('));
    vm.runInContext(body.replace(/^export /gm, ''), context);
    return { context, root, element, lastMessage, frames, cancelled, writes, counters,
        scroll: options => context.scrollChatToBottom(options),
        frame() {
            assert.equal(frames.size, 1, 'one live scroll RAF');
            const [id, callback] = frames.entries().next().value;
            frames.delete(id); callback();
        },
    };
}

async function flushScrollRelease() {
    await Promise.resolve(); await Promise.resolve();
}

test('normal immediate and frame scrolls retain their mode and cancel RAF id zero', () => {
    const h = scrollHarness();
    h.scroll();
    assert.equal(h.root.heightReads, 1);
    assert.deepEqual(h.writes.map(([, value]) => value), [800]);
    h.scroll({ waitForFrame: true }); h.scroll({ waitForFrame: true });
    assert.deepEqual(h.cancelled, [0]);
    assert.equal(h.root.heightReads, 1);
    h.frame();
    assert.equal(h.root.heightReads, 2);
    assert.equal(h.writes.length, 2);
});

test('many held requests perform no layout reads and become one final frame scroll', async () => {
    const h = scrollHarness(), release = holdLargeSourceLayout(h.root);
    for (let index = 0; index < 32; index++) h.scroll({ waitForFrame: Boolean(index % 2) });
    assert.equal(h.root.heightReads, 0);
    assert.equal(h.counters.position, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.frames.size, 0);
    release(); await flushScrollRelease();
    assert.equal(h.root.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
    assert.equal(h.root.heightReads, 0);
    h.frame();
    assert.equal(h.root.heightReads, 1);
    assert.equal(h.writes.length, 1);
});

test('a held immediate request flushes without an extra animation frame', async () => {
    const h = scrollHarness(), release = holdLargeSourceLayout(h.root);
    h.scroll({ waitForFrame: true }); h.scroll({ waitForFrame: false });
    release();
    assert.equal(h.root.heightReads, 0);
    await flushScrollRelease();
    assert.equal(h.root.heightReads, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(h.frames.size, 0);
});

for (const immediate of [false, true]) test(`post-finally ${immediate ? 'immediate' : 'frame'} scroll supersedes a deferred request`, async () => {
    const h = scrollHarness(), release = holdLargeSourceLayout(h.root);
    h.scroll({ waitForFrame: immediate });
    release(); h.scroll({ waitForFrame: !immediate });
    await flushScrollRelease();
    if (!immediate) h.frame();
    assert.equal(h.root.heightReads, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(h.frames.size, 0);
});

test('a RAF queued before the lease is guarded again at execution', async () => {
    const h = scrollHarness(); h.scroll({ waitForFrame: true });
    const release = holdLargeSourceLayout(h.root);
    h.frame();
    assert.equal(h.root.heightReads, 0);
    assert.equal(h.writes.length, 0);
    release(); await flushScrollRelease(); h.frame();
    assert.equal(h.root.heightReads, 1);
    assert.equal(h.writes.length, 1);
});

test('a newer held request cancels a pre-lease RAF before reading its source layout', async () => {
    const h = scrollHarness(); h.scroll({ waitForFrame: true });
    const release = holdLargeSourceLayout(h.root);
    h.scroll({ waitForFrame: true });
    assert.deepEqual(h.cancelled, [0]);
    assert.equal(h.frames.size, 0);
    assert.equal(h.root.heightReads, 0);
    release(); await flushScrollRelease(); h.frame();
    assert.equal(h.writes.length, 1);
});

test('nested leases and a new lease before the final frame do not lose the final scroll', async () => {
    const h = scrollHarness(), first = holdLargeSourceLayout(h.root), second = holdLargeSourceLayout(h.root);
    h.scroll({ waitForFrame: true });
    first(); first(); await flushScrollRelease();
    assert.equal(h.frames.size, 0);
    second(); await flushScrollRelease();
    const third = holdLargeSourceLayout(h.root);
    h.frame();
    assert.equal(h.root.heightReads, 0);
    third(); await flushScrollRelease(); h.frame();
    assert.equal(h.root.heightReads, 1);
    assert.equal(h.writes.length, 1);
});

test('auto-scroll is checked again both at release and in an already queued RAF', async () => {
    const h = scrollHarness(), release = holdLargeSourceLayout(h.root);
    h.scroll({ waitForFrame: true }); h.context.power_user.auto_scroll_chat_to_bottom = false;
    release(); await flushScrollRelease();
    assert.equal(h.frames.size, 0);
    assert.equal(h.root.heightReads, 0);
    h.context.power_user.auto_scroll_chat_to_bottom = true;
    h.scroll({ waitForFrame: true }); h.context.power_user.auto_scroll_chat_to_bottom = false;
    h.frame();
    assert.equal(h.root.heightReads, 0);
    h.context.power_user.auto_scroll_chat_to_bottom = true; h.scroll();
    assert.equal(h.writes.length, 1);
});

test('a new disabled request cancels a pending frame instead of scrolling later', () => {
    const h = scrollHarness(); h.scroll({ waitForFrame: true });
    h.context.power_user.auto_scroll_chat_to_bottom = false; h.scroll();
    assert.equal(h.frames.size, 0);
    assert.equal(h.root.heightReads, 0);
});

for (const stage of ['release', 'frame']) test(`a replaced or disconnected root is not scrolled at ${stage}`, async () => {
    const h = scrollHarness(), nextRoot = scrollRoot(1200);
    if (stage === 'release') {
        const release = holdLargeSourceLayout(h.root);
        h.scroll({ waitForFrame: true }); h.element[0] = nextRoot;
        release(); await flushScrollRelease();
    } else {
        h.scroll({ waitForFrame: true }); h.element[0] = nextRoot; h.frame();
    }
    assert.equal(h.root.heightReads, 0);
    assert.equal(nextRoot.heightReads, 0);
    assert.equal(h.writes.length, 0);
    nextRoot.isConnected = false; h.scroll();
    assert.equal(nextRoot.heightReads, 0);
    nextRoot.isConnected = true; h.scroll();
    assert.deepEqual(h.writes, [[nextRoot, 1200]]);
});

for (const stage of ['release', 'frame']) test(`a root disconnected after requesting scroll is rechecked at ${stage}`, async () => {
    const h = scrollHarness();
    if (stage === 'release') {
        const release = holdLargeSourceLayout(h.root);
        h.scroll({ waitForFrame: true }); h.root.isConnected = false;
        release(); await flushScrollRelease();
        assert.equal(h.frames.size, 0);
    } else {
        h.scroll({ waitForFrame: true }); h.root.isConnected = false; h.frame();
    }
    assert.equal(h.root.heightReads, 0);
    assert.equal(h.writes.length, 0);
    h.root.isConnected = true; h.scroll();
    assert.equal(h.writes.length, 1);
});

test('waifu mode reads the final last-message position only after the lease', async () => {
    const h = scrollHarness(), release = holdLargeSourceLayout(h.root);
    h.scroll({ waitForFrame: true }); h.context.power_user.waifuMode = true;
    assert.equal(h.counters.position, 0);
    release(); await flushScrollRelease(); h.frame();
    assert.equal(h.root.heightReads, 1);
    assert.equal(h.counters.position, 1);
    assert.equal(h.counters.scrollTop, 1);
    assert.deepEqual(h.writes.map(([, value]) => value), [65]);
    h.lastMessage.length = 0; h.scroll();
    assert.deepEqual(h.writes.map(([, value]) => value), [65, 800]);
});

test('actual cloud render lifecycle scrolls stay deferred and the existing final scroll coalesces them', async () => {
    const h = loadHarness(), scrolling = scrollHarness();
    h.context.holdLargeSourceLayout = () => holdLargeSourceLayout(scrolling.root);
    h.context.scrollChatToBottom = scrolling.context.scrollChatToBottom;
    h.context.eventSource.emit = async event => {
        h.calls.push([event]);
        h.context.scrollChatToBottom({ waitForFrame: event === 'loaded' });
        assert.equal(scrolling.root.heightReads, 0);
        assert.equal(scrolling.writes.length, 0);
    };
    await h.context.loadCloudChat(); await flushScrollRelease();
    assert.deepEqual(h.calls.map(call => call[0]), ['prefetch', 'print', 'changed', 'loaded', 'media']);
    assert.equal(scrolling.root.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
    scrolling.frame();
    assert.equal(scrolling.root.heightReads, 1);
    assert.equal(scrolling.writes.length, 1);
    assert.equal(h.chat[0].mes, 'complete raw message');
});

test('failed cloud lifecycle retains its original error and releases a requested fallback scroll', async () => {
    const h = loadHarness(), scrolling = scrollHarness(), failure = new Error('synthetic lifecycle failure');
    h.context.holdLargeSourceLayout = () => holdLargeSourceLayout(scrolling.root);
    h.context.scrollChatToBottom = scrolling.context.scrollChatToBottom;
    h.context.eventSource.emit = async () => {
        h.context.scrollChatToBottom({ waitForFrame: true }); throw failure;
    };
    await assert.rejects(h.context.loadCloudChat(), error => error === failure);
    await flushScrollRelease();
    assert.equal(h.context.suppressSync, false);
    assert.equal(scrolling.root.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
    scrolling.frame();
    assert.equal(scrolling.root.heightReads, 1);
    assert.equal(scrolling.writes.length, 1);
    scrolling.scroll();
    assert.equal(scrolling.writes.length, 2);
});
