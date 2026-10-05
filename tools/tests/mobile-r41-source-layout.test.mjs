import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deferScrollUntilSourceLayoutRelease, holdLargeSourceLayout, SOURCE_LAYOUT_HOLD_CLASS } from '../../sillytavern-runtime/public/scripts/homer-source-layout.mjs';

function root(present = false) {
    const names = new Set(present ? [SOURCE_LAYOUT_HOLD_CLASS] : []);
    return { textContent: '完整源码'.repeat(700000), classList: {
        contains: name => names.has(name), add: name => names.add(name), remove: name => names.delete(name),
    } };
}
test('temporary layout hold preserves the full live source and releases exactly once', () => {
    const element = root(), original = element.textContent;
    const release = holdLargeSourceLayout(element);
    assert.equal(element.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), true);
    assert.equal(element.textContent, original);
    release(); release();
    assert.equal(element.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
    assert.equal(element.textContent, original);
});
test('nested and independent chat roots retain their own holds until the last release', () => {
    const a = root(), b = root();
    const first = holdLargeSourceLayout(a), second = holdLargeSourceLayout(a), other = holdLargeSourceLayout(b);
    first(); first();
    assert.equal(a.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), true);
    other(); assert.equal(b.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
    second(); assert.equal(a.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
});
test('an existing class is not owned or removed by the hydration helper', () => {
    const element = root(true); holdLargeSourceLayout(element)();
    assert.equal(element.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), true);
});
test('missing chat DOM is harmless and rejected rendering still releases its hold', async () => {
    holdLargeSourceLayout(null)(); holdLargeSourceLayout(undefined)();
    const element = root();
    await assert.rejects((async () => {
        const release = holdLargeSourceLayout(element);
        try { await Promise.reject(new Error('renderer failed')); } finally { release(); }
    })(), /renderer failed/);
    assert.equal(element.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
});
test('a lease retains only the latest scroll and flushes after its last release', async () => {
    const element = root(), original = element.textContent, calls = [];
    const first = holdLargeSourceLayout(element), second = holdLargeSourceLayout(element);
    assert.equal(deferScrollUntilSourceLayoutRelease(element, () => calls.push('superseded')), true);
    assert.equal(deferScrollUntilSourceLayoutRelease(element, () => {
        assert.equal(element.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
        assert.equal(element.textContent, original);
        calls.push('final');
    }), true);
    first(); first();
    await Promise.resolve();
    assert.deepEqual(calls, []);
    second(); second();
    assert.deepEqual(calls, []);
    await Promise.resolve();
    assert.deepEqual(calls, ['final']);
    assert.equal(deferScrollUntilSourceLayoutRelease(element, () => calls.push('outside')), false);
});
test('independent roots flush independently and a class alone does not defer scrolling', async () => {
    const a = root(), b = root(), external = root(true), calls = [];
    const releaseA = holdLargeSourceLayout(a), releaseB = holdLargeSourceLayout(b);
    assert.equal(deferScrollUntilSourceLayoutRelease(null, () => {}), false);
    assert.equal(deferScrollUntilSourceLayoutRelease(undefined, () => {}), false);
    assert.equal(deferScrollUntilSourceLayoutRelease(external, () => {}), false);
    assert.equal(deferScrollUntilSourceLayoutRelease(a, null), false);
    deferScrollUntilSourceLayoutRelease(a, () => calls.push('a'));
    deferScrollUntilSourceLayoutRelease(b, () => calls.push('b'));
    releaseB(); await Promise.resolve();
    assert.deepEqual(calls, ['b']);
    assert.equal(a.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), true);
    releaseA(); await Promise.resolve();
    assert.deepEqual(calls, ['b', 'a']);
});
test('deferred scroll errors cannot mask a rejected render and leave the next lease usable', async () => {
    const element = root(), warnings = [], originalWarn = console.warn;
    console.warn = message => warnings.push(message);
    try {
        const renderError = new Error('synthetic renderer failure');
        await assert.rejects((async () => {
            const release = holdLargeSourceLayout(element);
            deferScrollUntilSourceLayoutRelease(element, () => { throw new Error('synthetic scroll failure'); });
            try { throw renderError; } finally { release(); }
        })(), error => error === renderError);
        await Promise.resolve(); await Promise.resolve();
        assert.equal(warnings.length, 1);
        assert.equal(element.classList.contains(SOURCE_LAYOUT_HOLD_CLASS), false);
        let recovered = 0;
        const release = holdLargeSourceLayout(element);
        deferScrollUntilSourceLayoutRelease(element, () => recovered++);
        release(); await Promise.resolve();
        assert.equal(recovered, 1);
    } finally {
        console.warn = originalWarn;
    }
});
test('shipping scope covers print and original awaited render events, then unconditionally releases before scroll', () => {
    const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
    const body = bridge.slice(bridge.indexOf('async function loadCloudChat('), bridge.indexOf('\nfunction serializeChat('));
    const positions = ['holdLargeSourceLayout()', 'await context.printMessages(',
        'await eventSource.emit(event_types.CHAT_CHANGED', 'await eventSource.emit(event_types.CHAT_LOADED',
        'releaseSourceLayout()', 'scrollChatToBottom('].map(text => body.indexOf(text));
    assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])));
    assert.match(body, /finally\s*\{\s*suppressSync = previousSuppressSync;\s*releaseSourceLayout\(\);/);
    const css = fs.readFileSync(new URL('../../sillytavern-runtime/public/style.css', import.meta.url), 'utf8');
    assert.match(css, /#chat\.homer-preparing-source-layout pre\.homer-large-code-block > code\s*\{\s*content-visibility: hidden;/);
    assert.doesNotMatch(css, /#chat\.homer-preparing-source-layout[^{}]*language-/);
    assert.doesNotMatch(css, /#chat\.homer-preparing-source-layout[^}]*\biframe\b/);
});
