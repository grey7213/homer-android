import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const host = readFileSync(new URL('../../.web-cache/tree/frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
function extract(begin, end) {
    const first = host.indexOf(begin), last = host.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `actual host ${begin}`);
    return host.slice(first, last);
}
const accountBegin = host.indexOf("window.addEventListener('homer-account-cleared'");
const accountReset = accountBegin < 0 ? '' : host.slice(accountBegin, host.indexOf('\n});', accountBegin) + 4);
const actual = [
    extract('function bindPreparedConversation(', 'function openRuntimeTool('),
    extract('function nativeCall(', 'function parseJson('),
    extract('function parseJson(', 'function setStatus('),
    extract('function readCachedConversation(', 'function writeCachedConversation('),
    extract('function scopedKey(', 'function renderMessages('),
    extract('function renderConversation(', 'function historyDisplayRows('),
    extract('function renderCachedConversation(', 'function fail('),
    extract('function fail(', 'function normalizeRuntimeUrl('),
    extract('function markReady(', 'function visiblePreviewText('),
    extract('function acceptsRuntimeTransition(', 'function modelData('),
    extract('async function switchConversation(', 'async function start('),
    accountReset,
].join('\n');

function snapshot(id, title = `Cached ${id}`) {
    return { conversation_id: id, app_id: `card-${id}`, title, avatar: '/own-cover.png',
        messages: [{ id: 'own-message', role: 'assistant', content: 'own safe cached message' }] };
}

function harness() {
    let owner = 'owner-a';
    const calls = { nativeReads: 0, cachePaints: 0, api: 0, closes: 0, model: 0, shell: 0, ready: 0 };
    const cache = new Map(['chat-a', 'chat-b', 'chat-c'].map(id => [`owner-a:${id}`, snapshot(id)]));
    const requests = [], sent = [], viewListeners = new Map(), classes = new Set(['is-ready']);
    const text = () => ({ textContent: '', value: '', disabled: false });
    const settingsTitle = text(), settingsAvatar = {}, previewTitle = text(), previews = [];
    const context = vm.createContext({
        HOST_CHANNEL: 'homer:dialogue-host:v1', PREVIEW_CACHE_PREFIX: 'homer.dialogue.preview.v2:',
        runtimeReady: true, runtimeBound: true, runtimeState: { generating: false }, activeAppId: 'card-chat-a',
        requestedPresentation: null, forwardPresentationVisibility() {}, presentationVisibility: null, clearVisibleGameRequest:()=>false,
        activeConversationId: 'chat-a', switchShellScope: '', previewRequestId: 0, launchRequestId: 0,
        readyHandoffTimer: 0, insetsSignature: '', adminPreview: false, adminBindPending: false,
        prewarming: false, pendingTool: null, pendingDraft: '', pendingCommands: [],
        coreReady: false, bridgeAvailable: false, runtimeOverlayActive: false,
        runtimeLaunchEpoch: 0, runtimeLaunchSequence: 0, runtimeLaunchOwner: '', runtimeEngineToken: '', runtimePriorDocument: null,
        runtimeAccountBlocked: false, runtimeAccountEpoch: 0, runtimeColdPending: false, runtimeColdFailed: false, runtimeColdFlight: null,
        settledPreviewQueue: { clear() {} },
        // Already-bound switch fixtures have no pending empty-host history batch.
        // Real mailbox behavior is covered by mobile-r41-history-preparation-host.
        historyReadPreparation: { clear() {}, flush() { return false; } },
        runtimeBindingPrefix: 'fixture-host-document', pendingAdminCard: '',
        previewSend: text(), previewInput: text(), previewTitle, previewAvatar: {},
        composerUi: { refresh() {} }, composerDraftDirty: false, composerInputScope: '',
        history: ['chat-a', 'chat-b', 'chat-c'].map(id => ({ id, app_id: `card-${id}`, app_name: `History ${id}` })),
        cachedSignatures: new Map(), launcherVisual: {}, networkDetail: text(), announcer: text(),
        launcher: { setAttribute() {} }, frame: { inert: false, contentWindow: { postMessage(command) { sent.push(command); } } },
        location: { origin: 'http://fixture.invalid', href: 'http://fixture.invalid/app/chat.html',
            pathname: '/app/chat.html', search: '', hash: '', replace() { throw Error('Unexpected login navigation'); } },
        window: { HomerNative: {
            readConversationSnapshot(id) { calls.nativeReads++; assert.equal(this, context.window.HomerNative);
                return JSON.stringify(cache.get(`${owner}:${id}`) || {}); },
            readLegacySnapshot() { return '{}'; },
        }, clearTimeout() {}, addEventListener(name, callback) { viewListeners.set(name, callback); } },
        localStorage: { getItem() { return null; } },
        document: { title: '', body: { classList: {
            contains: name => classes.has(name), add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
        } }, querySelector: selector => selector === '#preview-settings-title' ? settingsTitle : settingsAvatar },
        getCachedUser: () => ({ id: owner }), safePreviewImage: value => value || '', normalizeMessage: value => value,
        appearance: { refresh() {} }, setPreviewAvatarSource(image, source) { image.src = source; },
        conversationSnapshot: value => value,
        renderMessages(messages) { calls.cachePaints++; previews.push(messages); }, renderHistory() {},
        writeCachedConversation() {}, clearReadyTimer() {}, closeDrawers() { calls.closes++; },
        setRuntimeOverlay() {}, syncHostInsets() {}, flushRuntimeCommands() {},
        setDocumentTitle(value) { context.document.title = value; },
        updateVisibleConversationUrl(app, conv) { context.activeAppId = app; context.activeConversationId = conv; },
        updateModelSummary() { calls.model++; }, showToast() {},
        postRuntimeCommand(type, payload) { sent.push({ type, ...payload }); return true; },
        cacheRuntimeState(value) { context.runtimeState = value; }, prepareAdminCard() {},
        console: { error() {} }, performance: { mark() {} }, ApiError: class extends Error {},
        api: { messages(id, options) {
            calls.api++; assert.equal(options.limit, 120);
            let resolve, reject;
            const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
            requests.push({ id, resolve, reject }); return promise;
        } },
    });
    vm.runInContext(actual, context);
    function message(type, payload = {}, event = {}) {
        context.handleRuntimeMessage({ origin: context.location.origin, source: context.frame.contentWindow,
            data: { channel: context.HOST_CHANNEL, version: 1, type, admin_preview: false, ...payload }, ...event });
    }
    return { context, calls, sent, requests, classes, settingsTitle, previews, cache, message,
        setOwner(value) { owner = value; }, clearAccount() { viewListeners.get('homer-account-cleared')?.(); },
        async switch(id = 'chat-b') { await context.switchConversation(`card-${id}`, id); },
        async settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); } };
}

test('actual bound host switch then runtime announcement paints/reads once without a duplicate API and preserves new draft', async () => {
    const h = harness(); await h.switch();
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 1); assert.equal(h.calls.api, 0);
    assert.equal(h.context.runtimeReady, false);
    h.context.previewInput.value = 'new typed pending draft'; h.context.composerDraftDirty = true;
    h.context.composerInputScope = 'new-typing-scope';
    const before = { ...h.calls };
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b',
        from_app_id: 'card-chat-a', from_conversation_id: 'chat-a' });
    assert.deepEqual(h.calls, before);
    assert.equal(h.context.previewInput.value, 'new typed pending draft');
    assert.equal(h.context.composerDraftDirty, true); assert.equal(h.context.composerInputScope, 'new-typing-scope');
    assert.equal(h.context.previewRequestId, 1); assert.equal(h.context.runtimeReady, false);
    assert.equal(h.sent.filter(item => item.type === 'switch-conversation').length, 1);
});

test('runtime-originated first transition still paints normally and same-target role correction is retained', () => {
    const h = harness();
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b',
        from_app_id: 'card-chat-a', from_conversation_id: 'chat-a' });
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.cachePaints, 1); assert.equal(h.calls.api, 0);
    h.context.previewInput.value = 'typed'; const before = { ...h.calls };
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b', role_name: ' Corrected role ' });
    assert.deepEqual(h.calls, before); assert.equal(h.context.previewTitle.textContent, 'Corrected role');
    assert.equal(h.settingsTitle.textContent, 'Corrected role'); assert.equal(h.context.document.title, 'Corrected role');
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b', role_name: '   ' });
    assert.equal(h.context.previewTitle.textContent, 'Corrected role'); assert.equal(h.context.previewInput.value, 'typed');
});

test('same-scope pending role correction survives the first already-requested API preview title', async () => {
    const h = harness(); h.context.runtimeBound = false; h.context.runtimeReady = false;
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b',
        from_app_id: 'card-chat-a', from_conversation_id: 'chat-a' });
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b', role_name: 'Confirmed role' });
    h.context.previewInput.value = 'typed while actual preview API pending'; h.context.composerDraftDirty = true;
    h.requests[0].resolve(snapshot('chat-b', 'older API projection title')); await h.settle();
    assert.equal(h.context.previewTitle.textContent, 'Confirmed role');
    assert.equal(h.settingsTitle.textContent, 'Confirmed role'); assert.equal(h.context.document.title, 'Confirmed role');
    assert.equal(h.context.previewInput.value, 'typed while actual preview API pending');
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.api, 1); assert.equal(h.context.runtimeReady, false);
});

test('pending record retains only the scoped identity and bounded name, never the cached messages or HTML', async () => {
    const h = harness(); await h.switch();
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b', role_name: 'N'.repeat(250) });
    const record = JSON.parse(JSON.stringify(h.context.switchShellScope));
    assert.deepEqual(Object.keys(record).sort(), ['key', 'roleName']);
    assert.equal(record.roleName.length, 120); assert.equal(h.context.previewTitle.textContent.length, 120);
    assert.ok(!JSON.stringify(record).includes('own safe cached message'));
});

test('ready invalidates the pending-shell identity without accepting cached shell as readiness', async () => {
    const h = harness(); await h.switch(); const pendingIdentity = h.context.switchShellScope;
    assert.ok(pendingIdentity); assert.equal(h.classes.has('is-ready'), false);
    h.context.previewInput.value = 'typed-before-ready'; h.context.composerDraftDirty = true;
    h.message('ready', { app_id: 'card-chat-b', conversation_id: 'chat-b', role_name: 'Bound B' });
    assert.equal(h.context.switchShellScope, ''); assert.equal(h.context.runtimeReady, true);
    assert.equal(h.classes.has('is-ready'), true); assert.equal(h.context.previewInput.value, 'typed-before-ready');
    assert.ok(h.sent.some(item => item.type === 'composer-text' && item.content === 'typed-before-ready'));
    const reads = h.calls.nativeReads;
    await h.switch('chat-a'); await h.switch('chat-b');
    assert.equal(h.calls.nativeReads, reads + 2); assert.equal(h.context.activeConversationId, 'chat-b');
});

test('failed transition restores different scope and marks only the restored runtime ready', async () => {
    const h = harness(); await h.switch();
    h.message('conversation-switch-failed', { app_id: 'card-chat-a', conversation_id: 'chat-a',
        failed_app_id: 'card-chat-b', failed_conversation_id: 'chat-b', role_name: 'Restored A' });
    assert.equal(h.calls.nativeReads, 2); assert.equal(h.calls.api, 0); assert.equal(h.context.runtimeReady, true);
    assert.equal(h.context.activeConversationId, 'chat-a'); assert.equal(h.context.switchShellScope, '');
    assert.equal(h.context.document.title, 'Restored A');
});

test('startup failure invalidates same-target shell so a real retry reads and paints again', async () => {
    const h = harness(); h.context.runtimeBound = false; h.context.runtimeReady = false;
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b',
        from_app_id: 'card-chat-a', from_conversation_id: 'chat-a' });
    h.context.fail(new Error('isolated failure'));
    assert.equal(h.classes.has('is-error'), true);
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b' });
    assert.equal(h.calls.nativeReads, 2); assert.equal(h.calls.api, 2); assert.equal(h.classes.has('is-error'), false);
    assert.equal(h.context.runtimeReady, false);
});

test('same scoped identifiers across owner change cannot reuse the previous owner shell', async () => {
    const h = harness(); await h.switch();
    h.cache.set('owner-b:chat-b', snapshot('chat-b', 'Owner B cached'));
    h.setOwner('owner-b');
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b' });
    assert.equal(h.calls.nativeReads, 2); assert.equal(h.calls.api, 0);
    assert.equal(h.context.previewTitle.textContent, 'Owner B cached');
    assert.equal(h.context.previewRequestId, 2, 'both scopes invalidate previous preview tickets');
    assert.equal(h.context.previewTitle.textContent, 'Owner B cached');
});

test('account clear invalidates pending dedup and late API even when the same owner signs back in', async () => {
    const h = harness(); h.context.runtimeBound = false; h.context.runtimeReady = false;
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b',
        from_app_id: 'card-chat-a', from_conversation_id: 'chat-a' });
    h.clearAccount();
    h.requests[0].resolve(snapshot('chat-b', 'late before logout')); await h.settle();
    assert.equal(h.context.previewTitle.textContent, 'Cached chat-b'); assert.equal(h.calls.cachePaints, 1);
    assert.equal(h.context.switchShellScope, '');
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b' });
    assert.equal(h.calls.nativeReads, 1); assert.equal(h.calls.api, 1);
    assert.equal(h.context.runtimeAccountBlocked, true, 'A retained old runtime must not revive the account-cleared shell');
});

test('late/different-source/foreign-origin/admin-mode announcements cannot mutate a current shell', async () => {
    const h = harness(); await h.switch('chat-c'); const before = { ...h.calls };
    const late = { app_id: 'card-chat-b', conversation_id: 'chat-b', from_app_id: 'card-chat-a', from_conversation_id: 'chat-a' };
    h.message('conversation-switching', late);
    h.message('conversation-switch-failed', { ...late, failed_app_id: 'card-chat-b', failed_conversation_id: 'chat-b' });
    h.message('conversation-switching', { app_id: 'card-chat-c', conversation_id: 'chat-c' }, { origin: 'http://other.invalid' });
    h.message('conversation-switching', { app_id: 'card-chat-c', conversation_id: 'chat-c' }, { source: {} });
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b', admin_preview: true,
        from_app_id: 'card-chat-c', from_conversation_id: 'chat-c' });
    assert.deepEqual(h.calls, before); assert.equal(h.context.activeConversationId, 'chat-c');
});

test('busy user switch remains blocked and duplicate announcement cannot clear current generation state', async () => {
    const h = harness(); h.context.runtimeState = { generating: true }; await h.switch();
    assert.equal(h.calls.nativeReads, 0); assert.equal(h.sent.length, 0); assert.equal(h.context.activeConversationId, 'chat-a');
    h.context.runtimeState = { generating: false }; await h.switch();
    h.context.runtimeState = { generating: true }; h.context.pendingDraft = 'pending submitted draft';
    const state = h.context.runtimeState, before = { ...h.calls };
    h.message('conversation-switching', { app_id: 'card-chat-b', conversation_id: 'chat-b' });
    assert.deepEqual(h.calls, before); assert.equal(h.context.runtimeState, state);
    assert.equal(h.context.pendingDraft, 'pending submitted draft');
});
