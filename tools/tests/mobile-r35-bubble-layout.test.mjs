import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../frontend/assets/js/tavo-chat-ui.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../frontend/assets/css/tavo-chat-ui.css', import.meta.url), 'utf8');
function harness(live = false) {
    const calls = [], added = [];
    const classes = () => ({ add(...names) { added.push(...names); }, toggle() {}, *[Symbol.iterator]() { yield 'original-component-class'; } });
    const body = { replaceChildren(value) { calls.push(['body', value]); } };
    const parts = Object.fromEntries(['.tav-message', '.tav-bubble-wrapper', '.tav-bubble', '.tav-bubble-content'].map(name => [name, { classList: classes() }]));
    class Bubble {
        constructor(item) { this.item = item; this.el = { classList: classes(), querySelector: name => name === '.tav-bubble-content-body' ? body : parts[name] }; }
        setBubbleContentWidth() { throw Error('unexpected forced layout'); }
        build() { calls.push(['build']); this.setBubbleContentWidth(); }
        dispose() { calls.push(['dispose']); }
    }
    const destination = { classList: classes(), append() { calls.push(['chrome']); } };
    const content = { classList: classes(), parentElement: destination, querySelector: () => live ? {} : null };
    const element = { classList: classes(), querySelector: name => name === '.mes_text' ? content : destination };
    // This unit harness isolates builder ownership. Real presentation metadata,
    // CSS and iframe preservation are exercised by mobile_r45_presentation.py.
    const context = { updateMessagePresentation() {}, decorated: new Map(), window: { tav: { item: { MessageBubbleItem: Bubble } } } };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('export function decorateTavoMessage('), source.indexOf('export async function mountTavoComposer(')).replace(/^export /, ''), context);
    return { context, element, content, calls, added, Bubble };
}

test('ordinary bubble uses the actual builder and same body without irrelevant viewport layout', () => {
    const h = harness();
    assert.equal(h.context.decorateTavoMessage(h.element, { id: 'fixture' }), true);
    assert.deepEqual(h.calls.map(x => x[0]), ['build', 'body', 'chrome']);
    assert.equal(h.calls[1][1], h.content);
    assert.throws(() => new h.Bubble({}).setBubbleContentWidth(), /unexpected forced layout/, 'the original prototype is not modified');
});

test('live card receives original chrome classes in place, never iframe reparenting', () => {
    const h = harness(true);
    assert.equal(h.context.decorateTavoMessage(h.element, { id: 'fixture' }), true);
    assert.deepEqual(h.calls.map(x => x[0]), ['build', 'dispose']);
    assert.ok(h.added.includes('homer-tavo-live-content'));
    assert.ok(h.added.includes('original-component-class'));
});

test('host stylesheet retains responsive bubble, live card, and editor width bounds', () => {
    assert.match(css, /\.homer-tavo-chrome \.tav-message\{[^}]*max-width:calc\(100% - 12px\)!important/);
    assert.match(css, /\.homer-tavo-chrome \.tav-bubble-content\{[^}]*width:auto!important/);
    assert.match(css, /\.homer-tavo-live-message>\.mes_block\{[^}]*max-width:calc\(100% - 12px\)!important/);
    assert.match(css, /\.homer-message-editing[^}]+width:100%!important/);
});
