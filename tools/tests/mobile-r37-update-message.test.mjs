import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scriptSource = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const start = scriptSource.indexOf('export function updateMessageBlock(');
const end = scriptSource.indexOf('\n}', start) + 2;
assert.ok(start >= 0 && end > start, 'The actual runtime updateMessageBlock must be extracted');
const updateSource = scriptSource.slice(start, end).replace(/^export /, '');

// This is a behavioral unit seam, not a browser DOM/timing test. The actual
// production updater is executed; the jQuery getter/setter records whether it
// would tear down the current children, while formatting has explicit fixtures.
function harness({ html = '<p>same</p>', format = value => value } = {}) {
    let currentHtml = html;
    let children = { kind: 'existing message children' };
    let reads = 0;
    const writes = [], formats = [], effects = [];
    const text = {
        html(value) {
            if (arguments.length) {
                writes.push(value);
                currentHtml = value;
                children = { kind: 'rebuilt message children' };
            } else reads += 1;
            return currentHtml;
        },
    };
    const element = { find(selector) { assert.equal(selector, '.mes_text'); return text; } };
    const context = {
        chatElement: { find(selector) { assert.equal(selector, '[mesid="0"]'); return element; } },
        messageFormatting(...args) { formats.push(args); return format(...args); },
        updateReasoningUI(value) { assert.equal(value, element); effects.push('reasoning'); },
        addCopyToCodeBlocks(value) { assert.equal(value, element); effects.push('copy'); },
        appendMediaToMessage(_message, value) { assert.equal(value, element); effects.push('media'); },
    };
    vm.createContext(context);
    vm.runInContext(updateSource, context);
    const message = { mes: '<p>same</p>', name: 'Fixture', is_system: false, is_user: false, extra: {} };
    return { context, message, writes, formats, effects, reads: () => reads, html: () => currentHtml, children: () => children };
}

test('opt-in exact final formatting preserves current children but runs formatting and all follow-up effects', () => {
    const h = harness();
    const children = h.children();
    h.context.updateMessageBlock(0, h.message, { skipUnchangedFormatting: true });
    assert.equal(h.formats.length, 1);
    assert.equal(h.reads(), 1);
    assert.deepEqual(h.writes, []);
    assert.equal(h.children(), children);
    assert.deepEqual(h.effects, ['reasoning', 'copy', 'media']);
});

test('unchanged raw with changed formatting context still rebuilds using the new display output', () => {
    const h = harness({ html: '<b>old setting</b>', format: () => '<b>new setting</b>' });
    const raw = h.message.mes;
    h.context.updateMessageBlock(0, h.message, { skipUnchangedFormatting: true });
    assert.equal(h.message.mes, raw);
    assert.deepEqual(h.writes, ['<b>new setting</b>']);
    assert.equal(h.formats.length, 1);
    assert.deepEqual(h.effects, ['reasoning', 'copy', 'media']);
});

test('existing card iframe or helper markup that differs from final formatting keeps the ordinary redraw', () => {
    const h = harness({ html: '<div class="TH-render"><iframe></iframe><pre hidden><code>source</code></pre></div>', format: () => '<pre><code>source</code></pre>' });
    const children = h.children();
    h.context.updateMessageBlock(0, h.message, { skipUnchangedFormatting: true });
    assert.deepEqual(h.writes, ['<pre><code>source</code></pre>']);
    assert.notEqual(h.children(), children);
});

test('default caller behavior still writes even when HTML is unchanged without reading current markup', () => {
    const h = harness();
    h.context.updateMessageBlock(0, h.message);
    assert.deepEqual(h.writes, ['<p>same</p>']);
    assert.equal(h.formats.length, 1);
    assert.equal(h.reads(), 0);
});

test('explicit rerenderMessage false still runs follow-up effects without formatting or reading markup', () => {
    const h = harness();
    h.context.updateMessageBlock(0, h.message, { rerenderMessage: false, skipUnchangedFormatting: true });
    assert.equal(h.formats.length, 0);
    assert.equal(h.reads(), 0);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.effects, ['reasoning', 'copy', 'media']);
});

test('display_text precedence and formatter arguments remain unchanged', () => {
    const h = harness({ html: '<p>display cache</p>' });
    h.message.extra.display_text = '<p>display cache</p>';
    h.context.updateMessageBlock(0, h.message, { skipUnchangedFormatting: true });
    const args = h.formats[0];
    assert.deepEqual(Array.from(args.slice(0, 5)), ['<p>display cache</p>', 'Fixture', false, false, 0]);
    assert.equal(args[6], false);
    assert.deepEqual(h.writes, []);
});

test('formatter side effects still execute once before comparing its current real output', () => {
    let h;
    h = harness({ format: value => { h.message.extra.format_ran = true; return value; } });
    h.context.updateMessageBlock(0, h.message, { skipUnchangedFormatting: true });
    assert.equal(h.message.extra.format_ran, true);
    assert.equal(h.formats.length, 1);
    assert.deepEqual(h.writes, []);
});

test('empty formatted output and large literal markup use exact comparison without keeping an HTML cache', () => {
    const empty = harness({ html: '', format: () => '' });
    empty.context.updateMessageBlock(0, empty.message, { skipUnchangedFormatting: true });
    assert.deepEqual(empty.writes, []);
    const html = '<pre><code>' + 'synthetic literal '.repeat(190000) + '</code></pre>';
    const large = harness({ html, format: () => html });
    large.context.updateMessageBlock(0, large.message, { skipUnchangedFormatting: true });
    assert.equal(large.formats.length, 1);
    assert.deepEqual(large.writes, []);
});
