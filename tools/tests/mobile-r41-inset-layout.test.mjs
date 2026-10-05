import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../frontend/assets/js/tavo-chat-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('export function setTavoHostInsets(');
const end = source.indexOf('export function loadTavoUi(', start);
assert.ok(start >= 0 && end > start);
const actualFunction = source.slice(start, end).replace('export function ', 'function ');

function harness({ enabled = true, initialTop = '48px', initialBottom = '72px', position = 500, missingChat = false } = {}) {
    const properties = new Map([['--homer-host-top', initialTop], ['--homer-host-bottom', initialBottom]]);
    const trace = [], reads = [], scrollWrites = [];
    const chat = {};
    for (const [name, value] of [['scrollHeight', 1000], ['clientHeight', 500]]) {
        Object.defineProperty(chat, name, { get() { trace.push(name); reads.push(name); return value; } });
    }
    Object.defineProperty(chat, 'scrollTop', {
        get() { trace.push('scrollTop'); reads.push('scrollTop'); return position; },
        set(value) { scrollWrites.push(value); position = value; },
    });
    const context = {
        window: { innerHeight: 844 },
        document: { documentElement: {
            classList: { contains: name => enabled && name === 'homer-host-chrome' },
            style: {
                getPropertyValue: key => properties.get(key) || '',
                setProperty(key, value) { trace.push(`write:${key}`); properties.set(key, value); },
            },
        } },
        resetTavoDocumentViewport() { trace.push('resetViewport'); },
        localElementById: id => { assert.equal(id, 'chat'); trace.push('lookupChat'); return missingChat ? null : chat; },
    };
    vm.createContext(context); vm.runInContext(actualFunction, context);
    return { run: value => context.setTavoHostInsets(value), properties, trace, reads, scrollWrites };
}

test('same insets never read card geometry, including repeated host notifications', () => {
    const h = harness();
    h.run({ top: 48, bottom: 72 }); h.run({ top: '48', bottom: '72' }); h.run();
    assert.deepEqual(h.reads, []); assert.deepEqual(h.scrollWrites, []);
    assert.deepEqual(h.trace, ['resetViewport', 'resetViewport', 'resetViewport']);
});

test('changed insets capture the old bottom position before writes and retain bottom anchoring', () => {
    const h = harness(); h.run({ top: 60, bottom: 80 });
    assert.equal(h.properties.get('--homer-host-top'), '60px');
    assert.equal(h.properties.get('--homer-host-bottom'), '80px');
    assert.ok(h.trace.indexOf('clientHeight') < h.trace.indexOf('write:--homer-host-top'));
    assert.deepEqual(h.scrollWrites, [500]);
    const before = h.reads.length; h.run({ top: 60, bottom: 80 });
    assert.equal(h.reads.length, before); assert.deepEqual(h.scrollWrites, [500]);
});

test('reader scrolled above the bottom is not moved when the keyboard changes insets', () => {
    const h = harness({ position: 140 }); h.run({ top: 48, bottom: 330 });
    assert.deepEqual(h.scrollWrites, []); assert.equal(h.properties.get('--homer-host-bottom'), '330px');
});

test('invalid and out-of-range dimensions preserve existing fallback and clamping behavior', () => {
    const h = harness(); h.run({ top: Infinity, bottom: NaN });
    assert.deepEqual(h.reads, []);
    h.run({ top: -10, bottom: 4000 });
    assert.equal(h.properties.get('--homer-host-top'), '0px');
    assert.equal(h.properties.get('--homer-host-bottom'), '844px');
});

test('non-host document is untouched and missing chat does not prevent real inset updates', () => {
    const plain = harness({ enabled: false }); plain.run({ top: 60, bottom: 80 });
    assert.deepEqual(plain.trace, []);
    const empty = harness({ missingChat: true }); empty.run({ top: 60, bottom: 80 });
    assert.deepEqual(empty.reads, []); assert.deepEqual(empty.scrollWrites, []);
    assert.equal(empty.properties.get('--homer-host-bottom'), '80px');
});
