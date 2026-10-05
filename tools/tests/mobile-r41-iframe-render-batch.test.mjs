import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createMessageIframeRenderBatch } from '../../sillytavern-runtime/public/scripts/extensions/third-party/js-slash-runner/homer-iframe-render-batch.mjs';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/third-party/js-slash-runner/dist/index.js', import.meta.url), 'utf8');
const start = source.indexOf('var homerMessageIframeBatch;var jI=');
const finish = source.indexOf('function MI(', start);
assert.ok(start > 0 && finish > start, 'exercise the shipping store');
const actualStore = source.slice(start, finish);

function fixture() {
    let scope = 'account-1/epoch-1/card-1/chat-1', settings = { enabled: true, allow_streaming: false };
    const listeners = new Map();
    const frame = { nodeType: 1, tagName: 'IFRAME', isConnected: true, contentWindow: {},
        addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } };
    const codes = [{ textContent: '<button>test</button>' }];
    const pre = { querySelectorAll: () => codes };
    const wrapper = { nodeType: 1, isConnected: true,
        contains: value => value === frame,
        querySelector: selector => selector === ':scope > pre' ? pre : frame };
    const batch = createMessageIframeRenderBatch({ getScope: () => scope, getSettings: () => settings });
    const old = { message_id: 0, reload_memo: 'old', elements: [wrapper] };
    const fresh = () => ({ message_id: 0, reload_memo: 'new', elements: [wrapper] });
    function mount() { batch.begin(); batch.captureSource(wrapper, codes[0].textContent); batch.mounted(wrapper, frame); }
    return { batch, old, fresh, frame, wrapper, codes, listeners, mount,
        scope(value) { scope = value; }, settings(value) { settings = value; } };
}

test('same-batch mounted source preserves the row and consumes its proof exactly once', () => {
    const h = fixture(); h.mount();
    assert.strictEqual(h.batch.consume([h.old], [h.fresh()])[0], h.old);
    assert.equal(h.listeners.size, 0);
    assert.notStrictEqual(h.batch.consume([h.old], [h.fresh()])[0], h.old);
});

for (const [label, change] of Object.entries({
    account: h => h.scope('account-2/epoch-2/card-1/chat-1'),
    session: h => h.scope('account-1/epoch-1/card-1/chat-2'),
    settings: h => h.settings({ enabled: true, allow_streaming: true }),
    content: h => { h.codes[0].textContent += '<p>new</p>'; },
    disconnectedWrapper: h => { h.wrapper.isConnected = false; },
    disconnectedFrame: h => { h.frame.isConnected = false; },
    missingBrowsingContext: h => { h.frame.contentWindow = null; },
    frameError: h => h.listeners.get('error')(),
    disposed: h => h.batch.disposed(h.wrapper, h.frame),
    explicitReload: h => h.batch.invalidate(),
    subsequentTransaction: h => h.batch.begin(),
})) test(`${label} cannot reuse a prior iframe row`, () => {
    const h = fixture(); h.mount(); change(h);
    const fresh = h.fresh();
    assert.strictEqual(h.batch.consume([h.old], [fresh])[0], fresh);
});

test('an unmounted source and a different wrapper never qualify as a live iframe', () => {
    const h = fixture(); h.batch.begin(); h.batch.captureSource(h.wrapper, h.codes[0].textContent);
    assert.notStrictEqual(h.batch.consume([h.old], [h.fresh()])[0], h.old);
    h.mount(); const fresh = { ...h.fresh(), elements: [{ ...h.wrapper }] };
    assert.strictEqual(h.batch.consume([h.old], [fresh])[0], fresh);
});

test('malformed scope/settings or DOM failure falls back to fresh rows', () => {
    for (const identity of [() => null, () => { throw Error('closed'); }]) {
        const h = fixture();
        const batch = createMessageIframeRenderBatch({ getScope: identity, getSettings: () => ({}) });
        batch.begin(); batch.captureSource(h.wrapper, 'x'); batch.mounted(h.wrapper, h.frame);
        const fresh = [h.fresh()]; assert.strictEqual(batch.consume([h.old], fresh), fresh);
    }
    const h = fixture(); h.mount(); h.wrapper.querySelector = () => { throw Error('detached'); };
    const fresh = [h.fresh()]; assert.strictEqual(h.batch.consume([h.old], fresh), fresh);
});

test('actual store starts proof before public CHAT_CHANGED handlers, reuses only at chatLoaded, and reloadAll invalidates', () => {
    const h = fixture(), events = new Map(), watches = [];
    const render = { enabled: true, allow_streaming: false, depth: 0, depth_ignore_hidden: false };
    const on = (type, fn, first = false) => {
        const handlers = events.get(type) || []; first ? handlers.unshift(fn) : handlers.push(fn); events.set(type, handlers);
    };
    const context = { createMessageIframeRenderBatch,
        wF: (name, setup) => setup, MF: () => ({ settings: { render } }), M: value => ({ value }),
        I: (read, fn, options) => { watches.push({ read, fn }); if (options.immediate) fn(read()); },
        k: { on, makeFirst: (type, fn) => on(type, fn, true) },
        A: Object.fromEntries(['CHAT_CHANGED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MORE_MESSAGES_LOADED'].map(key => [key,key])),
        S: { homer_bridge: { user_id: 'synthetic', app_id: 'a', conversation_id: 'c' } },
        se: () => 'c', He: 0, b: [{ avatar: 'a.png' }], We: null, window: { location: { origin: 'http://127.0.0.1' } },
        $: () => ({ length: 0 }), setTimeout: () => 0, d: () => 'explicit-reload',
        kI: rows => rows, AI: () => [h.fresh()], _: { reject: (rows, predicate) => rows.filter(row => !predicate(row)) },
    };
    vm.createContext(context); vm.runInContext(actualStore, context);
    const store = context.jI(), batch = context.homerMessageIframeBatch;
    let publicHooks = 0;
    on('CHAT_CHANGED', () => { publicHooks++; batch.captureSource(h.wrapper, h.codes[0].textContent); batch.mounted(h.wrapper,h.frame); store.runtimes.value = [h.old]; });
    for (const callback of events.get('CHAT_CHANGED')) callback();
    for (const callback of events.get('chatLoaded')) callback();
    assert.equal(publicHooks, 1); assert.strictEqual(store.runtimes.value[0], h.old);
    for (const callback of events.get('chatLoaded')) callback();
    assert.notStrictEqual(store.runtimes.value[0], h.old);
    for (const callback of events.get('CHAT_CHANGED')) callback();
    store.reloadAll();
    assert.equal(store.runtimes.value[0].reload_memo, 'explicit-reload');
    for (const callback of events.get('chatLoaded')) callback();
    assert.notStrictEqual(store.runtimes.value[0], h.old);
    for (const name of ['CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MORE_MESSAGES_LOADED']) assert.ok(events.has(name));
});

test('shipping component lifecycle and non-streaming default are wired, not model-stream settings', () => {
    assert.match(source, /allow_streaming:\$E\(\)\.default\(!1\)/);
    assert.match(source, /homerMessageIframeBatch\?\.captureSource\(n.element,source\)/);
    assert.match(source, /homerMessageIframeBatch\?\.mounted\(n.element,a.value\)/);
    assert.match(source, /homerMessageIframeBatch\?\.disposed\(n.element,a.value\)/);
    assert.match(source, /key:e\+t/);
});
