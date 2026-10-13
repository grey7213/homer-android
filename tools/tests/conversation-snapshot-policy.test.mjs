import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { acceptsConversationSnapshot } from '../../frontend/assets/js/conversation-snapshot-policy.mjs';


const expected = { owner: 'qa-owner', appId: 'qa-card', conversationId: 'qa-chat', adminPreview: false, hasMessages: true };
const ready = overrides => ({ owner_id: 'qa-owner', app_id: 'qa-card', conversation_id: 'qa-chat',
    admin_preview: false, messages_ready: true, messages: [{ content: '完整本地正文' }], ...overrides });

test('late initialization/failure cannot clear cached text or be saved as a new empty archive', () => {
    for (const state of [ready({ messages_ready: false }), ready({ messages_ready: undefined }), ready({ messages: [] })]) {
        assert.equal(acceptsConversationSnapshot(state, expected), false);
    }
    assert.equal(acceptsConversationSnapshot(ready(), expected), true);
});
test('explicit user deletion is allowed; an actually new empty chat is allowed', () => {
    assert.equal(acceptsConversationSnapshot(ready({ messages: [], empty_authorized: true }), expected), true);
    assert.equal(acceptsConversationSnapshot(ready({ messages: [] }), { ...expected, hasMessages: false }), true);
});
test('owner, card, conversation and admin scope must all match', () => {
    for (const overrides of [{ owner_id: 'other' }, { app_id: 'B' }, { conversation_id: 'B' },
        { admin_preview: true }, { messages: undefined }]) assert.equal(acceptsConversationSnapshot(ready(overrides), expected), false);
    assert.equal(acceptsConversationSnapshot(ready(), { ...expected, owner: '' }), false);
});

// Exercise the actual shipping host handler, not just the policy helper.
const source = fs.readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('function cacheRuntimeState('), source.indexOf('\nfunction flushOptionalHostDisplayCache('));
function hostFixture() {
    const records = [], paints = [], scope = {
        acceptsConversationSnapshot, adminPreview: false, activeAppId: 'qa-card', activeConversationId: 'qa-chat',
        runtimeBindingOwner: () => 'qa-owner', runtimeState: null, currentMessages: [{ content: '完整本地正文' }],
        pendingDraft: '', previewSend: {}, previewInput: {}, setRuntimeOverlay() {},
        conversationSnapshot: state => ({ ...state, messages: state.messages.filter(item => item.content) }),
        canAcceptRuntimeDraft: () => false, settledPreviewQueue: { enqueue: state => records.push(state) },
        history: [], writeCachedHistory() {}, scopedKey: x => x, SETTINGS_CACHE_PREFIX: '', settingsSignature: '',
        localStorage: { setItem() {} }, document: { body: { classList: { contains: () => false } } },
        renderConversation: snapshot => { paints.push(snapshot); scope.currentMessages = snapshot.messages; },
        renderHistory() {}, updateModelSummary() {}, syncAdminHostControls() {}, composerUi: null,
    };
    vm.createContext(scope); vm.runInContext(handler, scope); return { scope, records, paints };
}
test('shipping host preserves visible content after a late empty state, then accepts a real recovery', () => {
    const f = hostFixture(); f.scope.cacheRuntimeState(ready({ messages: [] }));
    assert.equal(f.records.length, 0); assert.equal(f.paints.length, 0);
    f.scope.cacheRuntimeState(ready()); assert.equal(f.records.length, 1); assert.equal(f.paints.length, 1);
});
test('shipping host never persists an empty text projection from a rich-only message', () => {
    const f = hostFixture(); f.scope.cacheRuntimeState(ready({ messages: [{ display_text: '' }] }));
    assert.equal(f.records.length, 0); assert.equal(f.paints.length, 0);
});
test('shipping host applies and saves a completed explicit removal', () => {
    const f = hostFixture(); f.scope.cacheRuntimeState(ready({ messages: [], empty_authorized: true }));
    assert.equal(f.records.length, 1); assert.equal(f.paints.length, 1); assert.equal(f.scope.currentMessages.length, 0);
});

const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const begin = bridge.indexOf('function notifyHostState(');
const publisher = bridge.slice(begin, bridge.indexOf('\nfunction scheduleHostStateNotify(', begin));
test('actual publisher sends no message snapshot while the selected archive is loading or failed', () => {
    const sent = [], scope = {
        hostStateNotifyTimer: null, hostStateNotifyToken: null, tavoComposer: null, canNotifyHost: () => true,
        launch: { conversation_id: 'qa-chat' }, loadingLaunch: true, conversationRecoveryBlocked: false,
        hasCanonicalConversationScope: () => true, syncHostOverlayState() {},
        getContext: () => ({ chat: [] }), generationBusy: false, rollbackBusy: false, isGenerating: () => false,
        canonicalDisplayTexts: () => null, hostControlState: () => ({}), session: { user: { id: 'qa-owner' } },
        notifyHost: (...args) => sent.push(args), cancelHostStateNotify() {},
    };
    vm.createContext(scope); vm.runInContext(publisher, scope);
    scope.notifyHostState(); assert.equal(sent.length, 0);
    scope.loadingLaunch = false; scope.conversationRecoveryBlocked = true;
    scope.notifyHostState(); assert.equal(sent.length, 0);
    scope.conversationRecoveryBlocked = false; scope.notifyHostState('message-deleted');
    assert.equal(sent.length, 1); assert.equal(sent[0][1].state.messages_ready, true);
    assert.equal(sent[0][1].state.empty_authorized, true);
});
