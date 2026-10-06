import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from '../webview-compat/node_modules/esbuild/lib/main.js';
import * as preHelpers from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-ejs-pre.mjs';

const plugin = new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template/', import.meta.url);
const handlerSource = fs.readFileSync(new URL('src/modules/handler.ts', plugin), 'utf8');
const start = handlerSource.indexOf('async function handleMessageRender(');
const end = handlerSource.indexOf('// export for command', start);
assert.ok(start >= 0 && end > start, 'Actual message-render handler must be extracted');
const handler = transformSync(handlerSource.slice(start, end), { loader: 'ts', target: 'es2022' }).code;
const ejsScope = { module: { exports: {} }, exports: {} };
vm.runInNewContext(fs.readFileSync(new URL('src/3rdparty/ejs.js', plugin), 'utf8'), ejsScope);
const scriptSource = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const updateStart = scriptSource.indexOf('export function updateMessageBlock(');
const updateEnd = scriptSource.indexOf('\n}', updateStart) + 2;
assert.ok(updateStart >= 0 && updateEnd > updateStart, 'The actual runtime message updater must be extracted');
const nativeUpdater = scriptSource.slice(updateStart, updateEnd).replace('export function updateMessageBlock(', 'function actualUpdateMessageBlock(');

function harness({ html = '<pre><code>literal source</code></pre>', protect = true, user = false, before = '', after = '', fail = false,
    processed = true, raw = false, mes = 'canonical message', formatter = value => value, beforeEffect = () => {}, useNativeUpdater = false, domPresence = false } = {}) {
    let rendered = html;
    const writes = [], calls = [], events = [], effects = [], updates = [], formats = [], snapshots = [];
    let htmlReads = 0, textReads = 0;
    const message = { mes, name: 'Fixture', is_user: user, is_system: false, swipe_id: 0 };
    if (processed) message.is_ejs_processed = [true];
    const container = {
        text: () => { textReads++; return 'visible literal source'; },
        html(value) { if (arguments.length) { writes.push(value); rendered = value; } else { htmlReads++; } return rendered; },
    };
    container[0] = { fixture: 'actual selected message DOM' };
    container.length = 1;
    if (domPresence) Object.assign(container[0], {nodeType:1, ownerDocument:{createTreeWalker(){
        let next = {nodeType:3, length:3_000_000};
        return {nextNode(){const node=next;next=null;return node;}};
    }}});
    const parent = { find: () => container };
    const context = {
        settings: { enabled: true, render_enabled: true, depth_limit: -1, code_blocks_enabled: !protect, cache_enabled: 0, raw_message_evaluation_enabled: raw },
        STATE: {}, isFakeRun: false, runID: 0, chat: [message],
        $: () => parent,
        prepareContext: async () => ({ value: 'evaluated text' }),
        getEnabledWorldInfoEntries: async () => [],
        hasNonemptyDOMText: selection => preHelpers.hasNonemptyDOMText(selection),
        evaluateWIEntities: async (env, options) => {
            calls.push(options.decorator);
            if (options.decorator === '@@render_before') { beforeEffect(env); return before; }
            return after;
        },
        // Deterministic protection seam: the real handler must compare against
        // original DOM input, not the internal token emitted by this boundary.
        // Real DOMParser/protection and 3MB authored-card behavior are E2E gates.
        protectPreContent: raw => ({ content: 'HOMERLITERALPRE0END', restore: value => typeof value === 'string' ? value.replaceAll('HOMERLITERALPRE0END', raw) : value }),
        capturePreContent: node => {
            assert.equal(node, container[0], 'Capture must use the exact selected message DOM');
            snapshots.push(node);
            const rawHTML = rendered;
            return { rawHTML, content: 'HOMERLITERALPRE0END', restore: value => typeof value === 'string' ? value.replaceAll('HOMERLITERALPRE0END', rawHTML) : value };
        },
        FunctionSandbox: class { destroy() {} },
        applyRegex: (_env, content) => content,
        escapeReasoningBlocks: content => content,
        unescapeHtmlEntities: content => content,
        evalTemplateHandler: async (content, env, _where, options) => {
            calls.push('evaluate-body');
            return fail ? null : ejsScope.module.exports.render(content, env, options.options);
        },
        messageFormatting: (...args) => { formats.push(args); return formatter(...args); },
        getCurrentChatId: () => 'fixture-conversation',
        updateMessageBlock: (...args) => {
            updates.push(args); effects.push('message-block');
            if (useNativeUpdater) return context.actualUpdateMessageBlock(...args);
        },
        chatElement: { find: () => parent },
        updateReasoningUI: () => effects.push('reasoning'),
        addCopyToCodeBlocks: () => effects.push('copy'),
        appendMediaToMessage: () => effects.push('media'),
        event_types: { USER_MESSAGE_RENDERED: 'user-rendered', CHARACTER_MESSAGE_RENDERED: 'character-rendered' },
        eventSource: { emit: async (...args) => { events.push(args); } },
        checkAndSave: async () => effects.push('save'),
        updateTokens: () => effects.push('tokens'), console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    };
    vm.createContext(context); vm.runInContext(nativeUpdater, context); vm.runInContext(handler, context);
    return { context, message, writes, calls, events, effects, updates, formats, snapshots, htmlReads: () => htmlReads, textReads: () => textReads, rendered: () => rendered };
}

test('message presence guard does not read the full DOM string, while all render phases still execute', async () => {
    const h = harness({domPresence:true});
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.textReads(), 0);
    assert.deepEqual(h.calls, ['@@render_before', 'evaluate-body', '@@render_after']);
    assert.equal(h.snapshots.length, 1);
});

test('presence predicate keeps an unsupported collection text fallback with the original receiver', () => {
    let calls=0;
    const selection={0:{nodeType:1,ownerDocument:{}},length:1,text(){assert.equal(this,selection);calls++;return ' ';}};
    assert.equal(typeof preHelpers.hasNonemptyDOMText,'function');
    assert.equal(preHelpers.hasNonemptyDOMText(selection),true);
    assert.equal(calls,1);
});

test('presence predicate uses nonempty character length, not trimming or full string getters', () => {
    const node=length=>({nodeType:3,length,get textContent(){throw Error('Unnecessary textContent getter');},get data(){throw Error('Unnecessary full data getter');}});
    assert.equal(typeof preHelpers.hasNonemptyDOMText,'function');
    assert.equal(preHelpers.hasNonemptyDOMText({0:node(0),1:node(1),length:2}),true);
    assert.equal(preHelpers.hasNonemptyDOMText({0:node(0),length:1}),false);
    assert.equal(preHelpers.hasNonemptyDOMText({length:0}),false);
});

test('presence fallback preserves thrown errors and never calls the original method twice', () => {
    let calls=0;
    const error=Error('original fallback failure');
    const selection={0:{nodeType:1,ownerDocument:{}},length:1,text(){assert.equal(this,selection);calls++;throw error;}};
    assert.throws(()=>preHelpers.hasNonemptyDOMText(selection),value=>value===error);
    assert.equal(calls,1);
    assert.throws(()=>preHelpers.hasNonemptyDOMText({0:{nodeType:1,ownerDocument:{}},length:1}),TypeError);
});

test('unsupported document traversal retains the collection method and receiver', () => {
    let calls=0;
    const selection={0:{nodeType:9,createTreeWalker(){throw Error('Document must use its original method');}},length:1,
        text(){assert.equal(this,selection);calls++;return 'document text';}};
    assert.equal(preHelpers.hasNonemptyDOMText(selection),true);
    assert.equal(calls,1);
});

test('protected handler captures one live snapshot without serializing the original DOM before capture', async () => {
    const h = harness();
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.snapshots.length, 1);
    assert.equal(h.htmlReads(), 0);
    assert.deepEqual(h.calls, ['@@render_before', 'evaluate-body', '@@render_after']);
    assert.equal(h.rendered(), '<pre><code>literal source</code></pre>');
    assert.deepEqual(h.writes, []);
});

test('code evaluation enabled retains the ordinary current-DOM formatting path', async () => {
    const h = harness({ protect: false });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.htmlReads(), 1);
    assert.deepEqual(h.calls, ['@@render_before', 'evaluate-body', '@@render_after']);
});

test('protected static code keeps DOM without a duplicate render notification, but all template phases run', async () => {
    const h = harness();
    await h.context.handleMessageRender('0', 'preload', true);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.calls, ['@@render_before', 'evaluate-body', '@@render_after']);
    assert.deepEqual(h.events, []);
    assert.equal(h.context.isFakeRun, false);
    assert.equal(h.message.is_ejs_processed[0], true);
});

test('large protected source survives byte-for-byte without a redundant DOM write', async () => {
    const html = '<pre><code>' + 'fixture-literal '.repeat(220000) + '</code></pre>';
    const h = harness({ html });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.rendered(), html); assert.equal(h.writes.length, 0);
    assert.equal(h.events.length, 0);
});

test('unprotected unchanged ordinary code keeps its original DOM without a duplicate notification', async () => {
    const h = harness({ protect: false });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.writes.length, 0); assert.equal(h.events.length, 0);
});

test('EJS changing the output still replaces DOM and refreshes reasoning, copy and media', async () => {
    const h = harness({ protect: false, html: '<p>&lt;%= value %&gt;</p>' });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.deepEqual(h.writes, ['<p>evaluated text</p>']);
    assert.deepEqual(h.effects, ['reasoning', 'copy', 'media']);
});

test('world-info render additions still apply around restored literal code', async () => {
    const h = harness({ before: '<p>before</p>', after: '<p>after</p>' });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.deepEqual(h.writes, ['<p>before</p><pre><code>literal source</code></pre><p>after</p>']);
    assert.deepEqual(h.effects, ['reasoning', 'copy', 'media']);
    assert.equal(h.events.length, 1);
});

test('failed evaluation leaves readable source intact without a DOM write', async () => {
    const h = harness({ fail: true });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.writes.length, 0);
    assert.equal(h.rendered(), '<pre><code>literal source</code></pre>');
    assert.equal(h.events.length, 0);
});

test('changed user code keeps user-only render notification and non-dry save behavior', async () => {
    const h = harness({ user: true, before: '<p>new user render output</p>' });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.deepEqual(h.events, [['user-rendered', '0']]);
    assert.equal(h.writes.length, 1);
    await h.context.handleMessageRender('0', 'updated', false);
    assert.deepEqual(h.effects.slice(-2), ['save', 'tokens']);
});

test('changed ordinary markup does not emit a code-block rerender, and system messages keep their boundary', async () => {
    const plain = harness({ protect: false, html: '<p>&lt;%= value %&gt;</p>' });
    await plain.context.handleMessageRender('0', 'preload', true);
    assert.equal(plain.writes.length, 1); assert.equal(plain.events.length, 0);
    const system = harness({ before: '<p>new system render output</p>' });
    system.message.is_system = true;
    await system.context.handleMessageRender('0', 'preload', true);
    assert.equal(system.writes.length, 1); assert.equal(system.events.length, 0);
});

test('first preload without a processed marker runs permanent evaluation without rebuilding identical final formatting', async () => {
    const h = harness({ html: '<p>canonical message</p>', protect: false, processed: false, raw: true,
        formatter: value => `<p>${value}</p>`, useNativeUpdater: true });
    assert.equal(Object.hasOwn(h.message, 'is_ejs_processed'), false);
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.context.STATE.isDryRun, false);
    assert.equal(h.message.is_ejs_processed[0], true);
    assert.deepEqual(h.calls, ['@@render_before', 'evaluate-body', 'evaluate-body', '@@render_after']);
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0][2].skipUnchangedFormatting, true);
    assert.equal(h.formats.length, 1);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.effects, ['message-block', 'reasoning', 'copy', 'media', 'save', 'tokens']);
    assert.deepEqual(h.events, []);
});

test('permanent raw changes still replace the real formatted message and save its processed state', async () => {
    const h = harness({ html: '<p>before evaluation</p>', protect: false, processed: false, raw: true,
        mes: '<%= value %>', formatter: value => `<p>${value}</p>`, useNativeUpdater: true });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.message.mes, 'evaluated text');
    assert.deepEqual(h.writes, ['<p>evaluated text</p>']);
    assert.equal(h.formats.length, 1);
    assert.equal(h.message.is_ejs_processed[0], true);
    assert.deepEqual(h.effects.slice(-2), ['save', 'tokens']);
});

test('world-info context effects refresh native formatting even when permanent raw output is unchanged', async () => {
    const view = { value: 'old' };
    const h = harness({ html: '<b>old</b>', protect: false, processed: false, raw: true,
        beforeEffect: () => { ejsScope.module.exports.render('<% view.value = "new"; %>', { view }); },
        formatter: () => `<b>${view.value}</b>`, useNativeUpdater: true });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.equal(h.message.mes, 'canonical message');
    assert.deepEqual(h.writes, ['<b>new</b>']);
    assert.equal(h.formats.length, 1);
    assert.deepEqual(h.calls, ['@@render_before', 'evaluate-body', 'evaluate-body', '@@render_after']);
});

test('first permanent pass refreshes existing helper frame markup when current formatting is genuinely different', async () => {
    const formatted = '<pre><code>canonical source</code></pre>';
    const h = harness({ html: '<div class="TH-render"><iframe></iframe><pre hidden><code>canonical source</code></pre></div>',
        processed: false, raw: true, formatter: () => formatted, useNativeUpdater: true });
    await h.context.handleMessageRender('0', 'preload', true);
    assert.deepEqual(h.writes, [formatted]);
    assert.equal(h.formats.length, 1);
    assert.equal(h.message.is_ejs_processed[0], true);
    assert.deepEqual(h.events, []);
});

test('normal webpack bundle embeds the exact current handler source, including the changed-markup boundary', () => {
    const sourceMap = JSON.parse(fs.readFileSync(new URL('dist/index.js.map', plugin), 'utf8'));
    const index = sourceMap.sources.findIndex(value => value.endsWith('src/modules/handler.ts'));
    assert.ok(index >= 0, 'Webpack sourcemap contains the actual handler');
    assert.equal(sourceMap.sourcesContent[index].replaceAll('\r\n', '\n'), handlerSource.replaceAll('\r\n', '\n'), 'Source and distributed plugin must be built together');
    assert.ok(handlerSource.includes("if (finalMarkupChanged && newContent?.includes('<pre>') && isDryRun)"));
});
