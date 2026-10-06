import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '../webview-compat/node_modules/esbuild/lib/main.js';
import { nodesOf } from './helpers/ejs-shipping-helpers.mjs';

const root = resolve(import.meta.dirname, '../..');
const plugin = resolve(root, 'sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template');
const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/ejs-render337-baseline.json')));
const captureSource = readFileSync(resolve(root, 'sillytavern-runtime/public/scripts/homer-ejs-pre.mjs'), 'utf8');
const handlerSource = readFileSync(resolve(plugin, 'src/modules/handler.ts'), 'utf8');
const evaluateSource = readFileSync(resolve(plugin, 'src/utils/evaluate.ts'), 'utf8');
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const current = {
    capture: captureSource,
    handler: section(handlerSource, 'async function handleMessageRender(', '// export for command'),
    evaluate: section(evaluateSource, 'export async function evaluateWIEntities(', 'export async function evalTemplateWI('),
};

// Deterministic DOM-shaped seam for the ACTUAL capture function, not a browser
// or parser fidelity claim. The existing real-DOM browser gate remains separate.
const htmlNS = 'http://www.w3.org/1999/xhtml';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
class Element {
    constructor(name, document, children = []) { this.nodeType = 1; this.namespaceURI = htmlNS; this.localName = name; this.ownerDocument = document; this.childNodes = []; children.forEach(node => this.appendChild(node)); }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get firstElementChild() { return this.children[0] || null; }
    appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }
    get innerHTML() { return this.childNodes.map(node => node.outerHTML ?? escape(node.data)).join(''); }
    get outerHTML() { return `<${this.localName}>${this.innerHTML}</${this.localName}>`; }
    querySelectorAll(name) { const all = []; const walk = node => { for (const child of node.childNodes || []) { if (child.localName === name) all.push(child); if (child.localName !== 'template') walk(child); } }; walk(this); return all; }
    replaceWith(node) { const siblings = this.parentNode.childNodes; const index = siblings.indexOf(this); assert.ok(index >= 0); siblings.splice(index, 1, node); node.parentNode = this.parentNode; }
}
class Document {
    constructor() { this.implementation = { createHTMLDocument: () => new Document() }; }
    createTextNode(data) { return { nodeType: 3, data, childNodes: [], ownerDocument: this }; }
    importNode(node, deep) { const result = node.nodeType === 3 ? this.createTextNode(node.data) : new Element(node.localName, this); if (deep && node.childNodes) node.childNodes.forEach(child => result.appendChild(this.importNode(child, true))); return result; }
}
function dom(spec = {}) {
    const doc = new Document(), text = value => doc.createTextNode(value), element = (name, children) => new Element(name, doc, children);
    let children = [element('p', [text(spec.prefix || 'before')]), element('pre', [element('code', [text(spec.body || 'literal source KEY')])]), element('p', [text('after')])];
    if (spec.nested) children[1].appendChild(element('pre', [text('nested HOMERLITERALPREX')]));
    if (spec.noPre) children = [element('p', [text('plain')])];
    if (spec.fallback) children.unshift(element('style', [text('body{}')]));
    return element('div', children);
}
function captureVM(source) {
    const context = vm.createContext({ DOMParser: class { parseFromString() { return { body: dom({ noPre: true }) }; } } });
    vm.runInContext(source.replaceAll('export function ', 'function ') + '\nglobalThis.capture=capturePreContent;', context);
    vm.runInContext('globalThis.restores=0;const replace=String.prototype.replaceAll;String.prototype.replaceAll=function(...args){restores++;return Reflect.apply(replace,this,args);};', context);
    return { capture: node => context.capture(node), reset: () => { context.restores = 0; }, get restores() { return context.restores; } };
}

test('actual capture defers reconstruction, memoizes exact snapshot and does not read later live DOM', async () => {
    const h = captureVM(current.capture), node = dom({ body: 'x'.repeat(3 * 1024 * 1024) });
    const original = node.innerHTML;
    const capture = h.capture(node);
    assert.equal(h.restores, 0, 'capture must not eagerly reconstruct full raw HTML');
    assert.equal(capture.identityRestoresRaw, true);
    await Promise.resolve(); node.childNodes = [node.ownerDocument.createTextNode('ASYNC DOM MUTATION')];
    assert.equal(capture.rawHTML, original);
    assert.ok(h.restores > 0);
    h.reset(); assert.equal(capture.rawHTML, original); assert.equal(capture.restore(capture.content), original);
    assert.equal(h.restores, 0, 'exact raw/identity restores use one private memo');
});
test('actual capture retains old outputs for nested PRE, collisions, unknown values and parser fallback', () => {
    for (const spec of [{}, { nested: true }, { prefix: 'HOMERLITERALPRE', body: 'HOMERLITERALPREX' }, { noPre: true }, { fallback: true }]) {
        const node = dom(spec), old = captureVM(baseline.capture).capture(node), h = captureVM(current.capture), now = h.capture(node);
        assert.equal(now.content, old.content); assert.equal(now.rawHTML, old.rawHTML);
        if (spec.fallback) assert.notEqual(now.identityRestoresRaw, true, 'parser-normalized content is not certified as original DOM');
        for (const output of [now.content, now.content + '<p>changed</p>', now.content + now.content,
            now.content.replace(/HOMERLITERALPREX*\d+END/g, ''), null, undefined, 42, '']) {
            assert.equal(now.restore(output), old.restore(output));
        }
    }
});

function harness(implementation, spec = {}) {
    const node = dom(spec), original = node.innerHTML, cap = captureVM(implementation.capture);
    let rendered = original, rawReads = 0, resolveCalls = 0;
    const log = [], writes = [], events = [], errors = [];
    const entries = (spec.hooks || []).map(row => ({ comment: '', content: 'hook', decorators: [row.phase], ...row }));
    const message = { mes: 'canonical', name: 'fixture', is_user: !!spec.user, swipe_id: 0, is_ejs_processed: [true] };
    const container = { 0: node, length: 1, html(value) { if (arguments.length) { rendered = value; writes.push(value); } return rendered; }, text: () => 'visible' };
    const parent = { find: () => container };
    const context = {
        settings: { enabled: true, render_enabled: true, depth_limit: -1, code_blocks_enabled: false, render_loader_enabled: spec.loaders !== false },
        STATE: {}, isFakeRun: false, runID: 0, chat: [message], $: () => parent,
        hasNonemptyDOMText: () => true,
        prepareContext: async () => { log.push('context'); return {}; },
        getEnabledWorldInfoEntries: async () => { log.push('world-read'); return entries; },
        capturePreContent: element => {
            log.push('capture'); const value = cap.capture(element); const descriptor = Object.getOwnPropertyDescriptor(value, 'rawHTML');
            return { ...Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([key]) => key !== 'rawHTML').map(([key, desc]) => [key, desc.value])),
                get rawHTML() { rawReads++; return descriptor.get ? descriptor.get.call(value) : descriptor.value; },
                restore(output) { resolveCalls++; return value.restore(output); } };
        },
        WorldInfoDecorators: class {
            constructor(entry) { this.entry = entry; this.arguments = []; if (entry.throwFilter && context.phase === 'after') throw Error('filter failed'); }
            get isEnabled() { return !this.entry.disable; }
            has(decorator) { return this.entry.decorators.includes(decorator); }
            async isConditionFiltedEntry() { log.push('condition:' + this.entry.phase); return !!this.entry.filtered; }
        },
        selectActivatedEntries: (rows, content) => { log.push(['select', rows.map(row => row.phase), content]); return rows.filter(row => !row.key || String(content).includes(row.key)); },
        applyRegex: (_env, content, opts) => { log.push(opts.worldinfo ? 'hook-regex' : 'body-regex'); return content; },
        substituteParams: content => { log.push('substitute'); return content; },
        _: { merge: Object.assign },
        escapeReasoningBlocks: value => value, unescapeHtmlEntities: value => value,
        evalTemplateHandler: async (content, env, where) => {
            if (where.startsWith('worldinfo')) { log.push('hook:' + env.world_info.phase); return env.world_info.output ?? ''; }
            log.push('body'); context.phase = 'after';
            await Promise.resolve(); if (spec.domMutation) node.childNodes = [node.ownerDocument.createTextNode('async mutation')];
            return Object.hasOwn(spec, 'bodyOutput') ? spec.bodyOutput : spec.bodyTransform ? spec.bodyTransform(content) : content;
        },
        phase: 'before', FunctionSandbox: class { destroy() { log.push('destroy'); } },
        messageFormatting: value => value, getCurrentChatId: () => 'test-chat', updateMessageBlock() {},
        updateReasoningUI: () => log.push('reasoning'), addCopyToCodeBlocks: () => log.push('copy'), appendMediaToMessage: () => log.push('media'),
        event_types: { USER_MESSAGE_RENDERED: 'user', CHARACTER_MESSAGE_RENDERED: 'assistant' }, eventSource: { emit: async (...args) => { events.push(args); } },
        checkAndSave: async () => log.push('save'), updateTokens: () => log.push('tokens'), renderInFrame: value => value,
        console: { debug() {}, info() {}, log() {}, warn() {}, error: (...args) => errors.push(String(args.at(-1)?.message || args.at(-1))) },
    };
    vm.createContext(context);
    const code = transformSync(implementation.evaluate.replace('export async function', 'async function') + '\n' + implementation.handler, { loader: 'ts', target: 'es2022' }).code;
    vm.runInContext(code, context);
    return { context, async run() { await context.handleMessageRender('0', 'preload', true); return { rendered, writes, events, errors,
        // Empty candidate selection gets no text in the lazy path. Its result,
        // calls and position stay identical; candidate selectors retain bytes.
        log: log.map(row => Array.isArray(row) && row[0] === 'select' && row[1].length === 0 ? ['select', [], '<unused>'] : row),
        processed: message.is_ejs_processed[0], rawReads, resolveCalls, restores: cap.restores }; } };
}

test('actual handler/evaluator execute all phases but never reconstruct an unchanged protected body with zero after candidates', async () => {
    const result = await harness(current, { body: 'x'.repeat(3 * 1024 * 1024) }).run();
    assert.equal(result.rawReads, 0); assert.equal(result.resolveCalls, 0); assert.equal(result.restores, 0);
    assert.deepEqual(result.writes, []); assert.deepEqual(result.events, []); assert.equal(result.processed, true);
    assert.ok(result.log.includes('context') && result.log.includes('world-read') && result.log.includes('body'));
    assert.equal(result.log.filter(row => Array.isArray(row) && row[0] === 'select').length, 2);
});
test('actual handler/evaluator match old side effects, writes and hook selection for every fallback', async () => {
    const cases = [
        {}, { domMutation: true }, { loaders: false }, { noPre: true }, { fallback: true }, { nested: true },
        { prefix: 'HOMERLITERALPRE', body: 'HOMERLITERALPREX' },
        { bodyOutput: null }, { bodyOutput: undefined }, { bodyOutput: '' }, { bodyOutput: 42 },
        { bodyTransform: content => content + '<p>new</p>' },
        { hooks: [{ phase: '@@render_before', output: '<b>before</b>' }] },
        { hooks: [{ phase: '@@render_after', key: 'KEY', output: '<b>after</b>' }] },
        { hooks: [{ phase: '@@render_after', key: 'not-there', output: 'never' }] },
        { hooks: [{ phase: '@@render_after', filtered: true, output: 'never' }] },
        { hooks: [{ phase: '@@render_after', disable: true, output: 'never' }] },
        { hooks: [{ phase: '@@render_after', throwFilter: true }] },
        { hooks: [{ phase: '@@render_before', output: 'before' }, { phase: '@@render_after', output: 'after' }], user: true },
    ];
    for (const spec of cases) {
        const old = await harness(baseline, spec).run(), now = await harness(current, spec).run();
        for (const key of ['rendered', 'writes', 'events', 'errors', 'log', 'processed']) assert.deepEqual(now[key], old[key], `${JSON.stringify(spec)} ${key}`);
        if ((spec.hooks || []).some(row => row.phase === '@@render_after' && !row.disable && !row.throwFilter)) assert.ok(now.resolveCalls > 0, 'Any after candidate materializes full output before selection');
    }
});
test('shipping sourcemap embeds the exact current handler and evaluator sources', () => {
    const map = JSON.parse(readFileSync(resolve(plugin, 'dist/index.js.map')));
    for (const [file, source] of [['src/modules/handler.ts', handlerSource], ['src/utils/evaluate.ts', evaluateSource]]) {
        assert.equal(map.sourcesContent[map.sources.findIndex(name => name.endsWith(file))].replaceAll('\r\n', '\n'), source.replaceAll('\r\n', '\n'));
    }
});

test('actual compiled lazy guards and content resolution trace to the exact current source positions', () => {
    const require = createRequire(import.meta.url);
    const acorn = require(resolve(root, 'sillytavern-runtime/node_modules/acorn'));
    const { TraceMap, originalPositionFor } = require(resolve(root, 'sillytavern-runtime/node_modules/@jridgewell/trace-mapping'));
    const bundle = readFileSync(resolve(plugin, 'dist/index.js'), 'utf8');
    const map = JSON.parse(readFileSync(resolve(plugin, 'dist/index.js.map'))), trace = new TraceMap(map);
    const ast = acorn.parse(bundle, { ecmaVersion: 'latest', sourceType: 'module' });
    const functions = nodesOf(ast, node => node.type === 'FunctionDeclaration');
    function findFunction(file, source, signature) {
        const line = source.replaceAll('\r\n', '\n').split('\n').findIndex(text => text.includes(signature)) + 1;
        const matches = functions.filter(node => { const pos = originalPositionFor(trace, { line: 1, column: node.start }); return pos.source?.endsWith(file) && pos.line === line; });
        assert.equal(matches.length, 1); return matches[0];
    }
    function check(node, file, source, lineText, token) {
        assert.ok(node); const lines = source.replaceAll('\r\n', '\n').split('\n');
        const line = lines.findIndex(text => text.includes(lineText)); assert.ok(line >= 0);
        const position = originalPositionFor(trace, { line: 1, column: node.start });
        assert.ok(position.source?.endsWith(file)); assert.equal(position.line, line + 1); assert.equal(position.column, lines[line].indexOf(token));
    }
    const handler = findFunction('src/modules/handler.ts', handlerSource, 'async function handleMessageRender(');
    const evaluator = findFunction('src/utils/evaluate.ts', evaluateSource, 'export async function evaluateWIEntities(');
    const certificate = nodesOf(handler, node => node.type === 'MemberExpression' && node.property.name === 'identityRestoresRaw');
    assert.equal(certificate.length, 1);
    check(certificate[0].property, 'src/modules/handler.ts', handlerSource, 'literalCode?.identityRestoresRaw === true', 'identityRestoresRaw');
    const nonempty = nodesOf(evaluator, node => node.type === 'BinaryExpression' && node.operator === '>' && node.right.value === 0
        && node.left.type === 'MemberExpression' && node.left.property.name === 'length');
    assert.equal(nonempty.length, 1);
    check(nonempty[0].left.object, 'src/utils/evaluate.ts', evaluateSource, 'resolveContent && candidates.length > 0', 'candidates');
    const resolverCalls = nodesOf(evaluator, node => node.type === 'Property' && node.key.name === 'content'
        && node.value.type === 'CallExpression' && node.value.callee.type === 'Identifier' && node.value.arguments.length === 0).map(node => node.value);
    assert.equal(resolverCalls.length, 1);
    check(resolverCalls[0].callee, 'src/utils/evaluate.ts', evaluateSource, 'content: resolveContent()', 'resolveContent');
});
