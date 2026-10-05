import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridge = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const start = bridge.indexOf('const scopeDrafts = new Map();');
const end = bridge.indexOf('function prepareAdminLaunch(', start);
assert.ok(start > 0 && end > start);
const source = bridge.slice(start, end);

function harness(initial = '') {
    let value = initial, writes = 0;
    const events = [];
    const field = { get value() { return value; }, set value(next) { writes++; value = next; },
        dispatchEvent(event) { events.push(event); } };
    const context = { session: { user: { id: 'owner-a' } },
        launch: { app_id: 'card-a', conversation_id: 'chat-a' },
        document: { querySelector(selector) { assert.equal(selector, '#send_textarea'); return field; } }, Event };
    vm.createContext(context); vm.runInContext(source, context);
    return { context, field, events, get writes() { return writes; } };
}

test('already empty target draft does not write or emit synthetic input', () => {
    const h = harness(); h.context.restoreScopeDraft();
    assert.equal(h.field.value, ''); assert.equal(h.writes, 0); assert.equal(h.events.length, 0);
});

test('exact restored draft is idempotent while changed draft still emits bubbling input', () => {
    const h = harness('草稿 \n🙂'); h.context.retainScopeDraft();
    h.field.value = 'previous target'; const before = h.writes;
    h.context.restoreScopeDraft();
    assert.equal(h.field.value, '草稿 \n🙂'); assert.equal(h.writes, before + 1);
    assert.equal(h.events.length, 1); assert.equal(h.events[0].type, 'input'); assert.equal(h.events[0].bubbles, true);
    h.context.restoreScopeDraft();
    assert.equal(h.writes, before + 1); assert.equal(h.events.length, 1);
});

test('different target clears old input once and retains the prior scoped draft', () => {
    const h = harness('draft-a'); h.context.retainScopeDraft();
    h.context.launch = { app_id: 'card-b', conversation_id: 'chat-b' };
    h.context.restoreScopeDraft(); assert.equal(h.field.value, ''); assert.equal(h.events.length, 1);
    h.context.restoreScopeDraft(); assert.equal(h.events.length, 1);
    h.field.value = 'draft-b'; h.context.retainScopeDraft();
    h.context.launch = { app_id: 'card-a', conversation_id: 'chat-a' };
    h.context.restoreScopeDraft(); assert.equal(h.field.value, 'draft-a'); assert.equal(h.events.length, 2);
});

test('owner, card, conversation and admin-preview boundaries remain separate', () => {
    const h = harness('owner-a ordinary'); h.context.retainScopeDraft();
    for (const changed of [{ app_id: 'other-card', conversation_id: 'chat-a' },
        { app_id: 'card-a', conversation_id: 'other-chat' },
        { app_id: 'card-a', conversation_id: 'chat-a', admin_preview: true }]) {
        h.field.value = 'prior text'; h.context.launch = changed;
        h.context.restoreScopeDraft(); assert.equal(h.field.value, '');
    }
    h.context.launch = { app_id: 'card-a', conversation_id: 'chat-a' };
    h.context.session = { user: { id: 'owner-b' } }; h.field.value = 'prior-owner';
    h.context.restoreScopeDraft(); assert.equal(h.field.value, '');
    h.context.session = { user: { id: 'owner-a' } };
    h.context.restoreScopeDraft(); assert.equal(h.field.value, 'owner-a ordinary');
});

test('missing composer remains harmless and exact whitespace is not normalized away', () => {
    const h = harness(' \n'); h.context.retainScopeDraft(); h.field.value = '';
    h.context.restoreScopeDraft(); assert.equal(h.field.value, ' \n'); assert.equal(h.events.length, 1);
    h.context.document.querySelector = () => null;
    assert.doesNotThrow(() => h.context.restoreScopeDraft());
});

test('draft storage remains bounded to twelve scopes', () => {
    const h = harness();
    for (let index = 0; index < 20; index++) {
        h.context.launch.conversation_id = `chat-${index}`; h.field.value = `draft-${index}`;
        h.context.retainScopeDraft();
    }
    assert.equal(vm.runInContext('scopeDrafts.size', h.context), 12);
});
