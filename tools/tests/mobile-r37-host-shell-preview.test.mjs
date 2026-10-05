import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
function extract(begin, end) {
    const start = source.indexOf(begin), stop = source.indexOf(end, start);
    assert.ok(start >= 0 && stop > start, `actual source ${begin}`);
    return source.slice(start, stop);
}
const actual = [
    extract('function nativeCall(', 'function parseJson('),
    extract('function parseJson(', 'function setStatus('),
    extract('function readCachedConversation(', 'function readCachedHistory('),
    extract('function scopedKey(', 'function renderMessages('),
    extract('function renderConversation(', 'function historyDisplayRows('),
    extract('function renderCachedConversation(', 'function showShell('),
    extract('function showConversationSwitchShell(', 'function fail('),
].join('\n');

function snapshot(conversation = 'chat-a', body = 'cached body') {
    return { conversation_id: conversation, app_id: `card-${conversation}`, title: `Title ${conversation}`,
        avatar: '/fixture/avatar.png', messages: [{ id: 'fixture-message', role: 'assistant', content: body, display_text: body }] };
}

function harness({ cached = true } = {}) {
    const calls = { nativeReads: 0, nativeWrites: 0, cachePaints: 0, api: 0, closes: 0, localWrites: 0, pageWrites: 0 };
    const paints = [], requests = [], nativeScopes = [], nativeCache = new Map(), local = new Map();
    let owner = 'owner-a';
    if (cached) nativeCache.set('owner-a:chat-a', snapshot());
    const text = () => ({ textContent: '', value: '', disabled: false });
    const settingsTitle = text(), settingsAvatar = {};
    const context = vm.createContext({
        runtimeReady: true, runtimeBound: false, runtimeState: { generating: false }, activeAppId: 'old-card', activeConversationId: 'old-chat',
        switchShellScope: '', previewRequestId: 0, prewarming: false, pendingTool: null, pendingDraft: '', adminPreview: false, runtimeColdPending: false,
        previewSend: text(), previewInput: text(), previewTitle: text(), previewAvatar: {}, composerUi: null,
        composerDraftDirty: false, composerInputScope: '', history: [], cachedSignatures: new Map(),
        PREVIEW_CACHE_PREFIX: 'homer.dialogue.preview.v2:',
        window: { HomerNative: {
            readConversationSnapshot(id) {
                assert.equal(this, context.window.HomerNative, 'native receiver retained');
                calls.nativeReads++; nativeScopes.push(`${owner}:${id}`); return JSON.stringify(nativeCache.get(`${owner}:${id}`) || {});
            },
            readLegacySnapshot() { return '{}'; },
            saveConversationSnapshot(payload) { calls.nativeWrites++; nativeCache.set(`${owner}:${JSON.parse(payload).conversation_id}`, JSON.parse(payload)); return true; },
        } },
        localStorage: { getItem: key => local.get(key) || null, setItem(key, value) { calls.localWrites++; local.set(key, value); } },
        document: { querySelector: selector => selector === '#preview-settings-title' ? settingsTitle : settingsAvatar },
        getCachedUser: () => ({ id: owner }),
        safePreviewImage: value => value || '', normalizeMessage: value => value, conversationSnapshot: value => value,
        appearance: { refresh() {} }, setPreviewAvatarSource(image, value) { image.src = value; }, setDocumentTitle() {},
        renderMessages(messages) { calls.cachePaints++; paints.push({ owner, id: context.activeConversationId, messages }); }, renderHistory() {},
        clearReadyTimer() {}, closeDrawers() { calls.closes++; }, showShell() {}, updateModelSummary() {},
        updateVisibleConversationUrl(appId, conversationId) { context.activeAppId = appId; context.activeConversationId = conversationId; },
        readPageCache: () => null, writePageCache() { calls.pageWrites++; },
        api: { messages(id, options) {
            calls.api++; assert.equal(options.limit, 120);
            let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
            requests.push({ id, resolve, reject }); return promise;
        } },
    });
    vm.runInContext(actual, context);
    return { context, calls, paints, requests, nativeScopes, nativeCache, local,
        shell(id = 'chat-a') { context.showConversationSwitchShell({ app_id: `card-${id}`, conversation_id: id }); },
        setOwner(value) { owner = value; },
        async settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
    };
}

test('actual switch shell reads and renders a cached snapshot exactly once but still requests fresh messages', () => {
    const h = harness(); h.shell();
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 1); assert.equal(h.calls.api, 1);
    assert.equal(h.calls.nativeWrites, 0); assert.equal(h.calls.localWrites, 0); assert.equal(h.calls.pageWrites, 0);
    assert.equal(h.context.previewRequestId, 1); assert.equal(h.paints[0].messages[0].content, 'cached body');
});

test('cache miss paints one empty scoped shell and does not read the same miss twice', () => {
    const h = harness({ cached: false }); h.shell();
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 1); assert.equal(h.calls.api, 1);
    assert.equal(h.paints[0].id, 'chat-a'); assert.equal(h.paints[0].messages.length, 0);
    assert.equal(h.calls.nativeWrites, 0);
});

test('default quick-preview callers still read/render cache and retain their ordinary fresh API request', async () => {
    const h = harness(); h.context.activeConversationId = 'chat-a'; h.context.activeAppId = 'card-chat-a'; h.context.runtimeReady = false;
    const work = h.context.loadQuickPreview('chat-a');
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 1); assert.equal(h.calls.api, 1);
    h.requests[0].resolve(snapshot('chat-a', 'fresh body')); await work;
    assert.equal(h.paints.length, 2); assert.equal(h.paints[1].messages[0].content, 'fresh body');
    assert.equal(h.calls.nativeWrites, 1); assert.equal(h.calls.localWrites, 1); assert.equal(h.calls.pageWrites, 1);
});

test('fresh shell response still renders and writes settled preview through the actual cache writer', async () => {
    const h = harness(); h.shell(); h.requests[0].resolve(snapshot('chat-a', 'fresh authoritative body')); await h.settle();
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 2);
    assert.equal(h.calls.nativeWrites, 1); assert.equal(h.calls.localWrites, 1); assert.equal(h.calls.pageWrites, 1);
    assert.equal(h.paints[1].messages[0].content, 'fresh authoritative body');
});

test('late old-scope and returned-ID mismatch responses cannot replace a newer shell', async () => {
    const h = harness(); h.nativeCache.set('owner-a:chat-b', snapshot('chat-b', 'second cached'));
    h.shell(); h.shell('chat-b');
    h.requests[0].resolve(snapshot('chat-a', 'late first')); await h.settle();
    assert.equal(h.paints.length, 2); assert.equal(h.context.activeConversationId, 'chat-b'); assert.equal(h.calls.nativeWrites, 0);
    h.requests[1].resolve(snapshot('wrong-id', 'wrong returned scope')); await h.settle();
    assert.equal(h.paints.length, 2); assert.equal(h.calls.nativeWrites, 0);
});

test('runtime-ready and request-ID fences still suppress late preview responses', async () => {
    for (const ready of [true, false]) {
        const h = harness(); h.shell();
        if (ready) h.context.runtimeReady = true;
        else h.context.previewRequestId++;
        h.requests[0].resolve(snapshot('chat-a', 'late ready response')); await h.settle();
        assert.equal(h.paints.length, 1); assert.equal(h.calls.nativeWrites, 0);
    }
});

test('same-scope duplicate bridge ACK does not re-read cache, request API or close a newly opened tool', () => {
    const h = harness(); h.shell(); const before = { ...h.calls };
    h.shell(); assert.deepEqual(h.calls, before); assert.equal(h.context.previewRequestId, 1);
});

test('the skip flag retains no cache object across accounts, even with the same card and conversation', async () => {
    const h = harness(); h.nativeCache.set('owner-b:chat-a', snapshot('chat-a', 'owner-b cached'));
    h.shell(); h.setOwner('owner-b'); h.shell();
    assert.deepEqual(h.nativeScopes, ['owner-a:chat-a', 'owner-b:chat-a']);
    assert.equal(h.calls.api, 2); assert.equal(h.paints[1].owner, 'owner-b'); assert.equal(h.paints[1].messages[0].content, 'owner-b cached');
    h.requests[0].resolve(snapshot('chat-a', 'owner-a late response')); await h.settle();
    assert.equal(h.paints.length, 2); assert.equal(h.calls.nativeWrites, 0);
});

test('network failure leaves the first cache paint intact without a second read or cache write', async () => {
    const h = harness(); h.shell(); h.requests[0].reject(new Error('fixture network failure')); await h.settle();
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 1); assert.equal(h.calls.nativeWrites, 0);
    assert.equal(h.paints[0].messages[0].content, 'cached body');
});

test('large safe text cache still crosses the native bridge and renders only once on this shell path', () => {
    const h = harness(); const large = snapshot();
    large.messages = Array.from({ length: 120 }, (_, index) => ({ id: `large-${index}`, role: 'assistant',
        content: 'ordinary text '.repeat(900).slice(0, 12000), display_text: 'ordinary text '.repeat(900).slice(0, 12000) }));
    h.nativeCache.set('owner-a:chat-a', large); h.shell();
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 1); assert.equal(h.calls.api, 1);
    assert.equal(h.paints[0].messages.length, 120); assert.equal(h.calls.nativeWrites, 0);
});

test('bound engine switching paints one scoped cache preview without a duplicate messages request or persistence', () => {
    for (const cached of [false, true]) {
        const h = harness({ cached }); h.context.runtimeBound = true; h.shell();
        assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 1);
        assert.equal(h.calls.api, 0); assert.equal(h.calls.nativeWrites, 0);
        assert.equal(h.calls.localWrites, 0); assert.equal(h.calls.pageWrites, 0);
        assert.equal(h.context.runtimeReady, false, 'a preview is never canonical readiness');
        assert.equal(h.context.previewRequestId, 1);
        const before = { ...h.calls }; h.shell(); assert.deepEqual(h.calls, before);
    }
});

test('a prior unbound preview cannot overwrite a bound same-conversation return', async () => {
    const h = harness(); h.shell();
    h.context.runtimeBound = true; h.shell('chat-b'); h.shell('chat-a');
    assert.equal(h.calls.api, 1); assert.equal(h.context.previewRequestId, 3);
    const count = h.paints.length;
    h.requests[0].resolve(snapshot('chat-a', 'late stale API response')); await h.settle();
    assert.equal(h.paints.length, count); assert.equal(h.calls.nativeWrites, 0);
});

test('unbound recovery retains the independent fresh preview read after a failed engine reset', () => {
    const h = harness(); h.context.runtimeBound = true; h.shell();
    h.context.runtimeBound = false; h.context.switchShellScope = ''; h.shell();
    assert.equal(h.calls.api, 1); assert.equal(h.requests[0].id, 'chat-a');
});
