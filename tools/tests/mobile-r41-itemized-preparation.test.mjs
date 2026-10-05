import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/itemized-prompts.js', import.meta.url), 'utf8');
const start = source.indexOf('export function prepareItemizedPrompts(');
const end = source.indexOf('export async function saveItemizedPrompts(', start);
assert.ok(start >= 0 && end > start);
const functions = source.slice(start, end).replaceAll('export ', '');
function fixture({ failRead = false, failEvent = false, empty = false } = {}) {
    const old = [{ mesId: 0, rawPrompt: 'synthetic old prompt' }], target = [{ mesId: 1, rawPrompt: 'synthetic target prompt' }];
    const calls = [];
    const scope = {
        itemizedPrompts: old,
        promptStorage: { getItem: async chatId => {
            calls.push(['read', chatId]); if (failRead) throw Error('synthetic storage error');
            return empty ? null : target;
        } },
        event_types: { ITEMIZED_PROMPTS_LOADED: 'loaded' },
        eventSource: { emit: async (type, value) => {
            calls.push(['event', type, value.chatId]); if (failEvent) throw Error('synthetic listener error');
        } },
        console: { log: () => calls.push(['handled-error']) },
    };
    vm.createContext(scope); vm.runInContext(functions, scope);
    return { scope, calls, old, target };
}
test('preparing target prompts neither mutates the active array nor emits loaded events', async () => {
    const h = fixture(), preparation = h.scope.prepareItemizedPrompts('target');
    await preparation.pending;
    assert.equal(h.scope.itemizedPrompts, h.old); assert.deepEqual(h.calls, [['read', 'target']]);
    await h.scope.applyPreparedItemizedPrompts(preparation);
    assert.equal(h.scope.itemizedPrompts, h.target);
    assert.deepEqual(h.calls, [['read', 'target'], ['event', 'loaded', 'target']]);
});
test('legacy load API still reads, replaces the array and emits exactly once', async () => {
    const h = fixture(); await h.scope.loadItemizedPrompts('target');
    assert.equal(h.scope.itemizedPrompts, h.target);
    assert.deepEqual(h.calls, [['read', 'target'], ['event', 'loaded', 'target']]);
});
test('read failure settles without side effects, then applies the original empty fallback without an event', async () => {
    const h = fixture({ failRead: true }), preparation = h.scope.prepareItemizedPrompts('target');
    await preparation.pending;
    assert.equal(h.scope.itemizedPrompts, h.old); assert.deepEqual(h.calls, [['read', 'target']]);
    await h.scope.applyPreparedItemizedPrompts(preparation);
    assert.equal(h.scope.itemizedPrompts.length, 0);
    assert.deepEqual(h.calls, [['read', 'target'], ['handled-error']]);
});
test('loaded listener failure keeps the old load API error fallback instead of rejecting', async () => {
    const h = fixture({ failEvent: true }); await h.scope.loadItemizedPrompts('target');
    assert.equal(h.scope.itemizedPrompts.length, 0);
    assert.deepEqual(h.calls, [['read', 'target'], ['event', 'loaded', 'target'], ['handled-error']]);
});
test('missing chat ID resets without a storage read or loaded event; empty storage still emits loaded', async () => {
    const missing = fixture(); await missing.scope.loadItemizedPrompts('');
    assert.equal(missing.scope.itemizedPrompts.length, 0); assert.deepEqual(missing.calls, []);
    const empty = fixture({ empty: true }); await empty.scope.loadItemizedPrompts('target');
    assert.equal(empty.scope.itemizedPrompts.length, 0);
    assert.deepEqual(empty.calls, [['read', 'target'], ['event', 'loaded', 'target']]);
});
