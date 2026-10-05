import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const plugin = resolve(root, 'sillytavern-runtime/public/scripts/extensions/third-party/js-slash-runner');
const helperFile = resolve(plugin, 'homer-frontend-marker.mjs');
const baseline = JSON.parse(readFileSync(new URL('./fixtures/jsrunner-marker338-baseline.json', import.meta.url)));
const bundle = readFileSync(resolve(plugin, 'dist/index.js'), 'utf8');
const acorn = createRequire(import.meta.url)(resolve(root, 'sillytavern-runtime/node_modules/acorn'));
const ast = acorn.parse(bundle, { ecmaVersion: 'latest', sourceType: 'module' });
const current = Object.fromEntries(ast.body.filter(n => n.type === 'FunctionDeclaration' && ['Bk', 'Q1', 'EI'].includes(n.id?.name)).map(n => [n.id.name, bundle.slice(n.start, n.end)]));
const oldPredicate = text => ['html>', '<head>', '<body'].some(marker => text.includes(marker));
// RED runs the shipping pre-change fallback, rather than testing an invented
// replacement. This seam does not claim native DOM or browser performance.
const hasFrontendMarkupText = existsSync(helperFile)
    ? (await import(pathToFileURL(helperFile))).hasFrontendMarkupText
    : (_node, fallback) => fallback();

function fixture(spec) {
    const stats = { reads: 0, joins: 0, fallback: 0, visited: 0 }, log = [];
    const doc = { createTreeWalker(node, mask) {
        assert.equal(mask, 12);
        const nodes = [];
        const walk = n => { for (const c of n.childNodes || []) { if ((1 << (c.nodeType - 1)) & mask) nodes.push(c); walk(c); } };
        walk(node);
        let index = 0;
        return { nextNode() { const value = nodes[index++] || null; if (value) stats.visited++; return value; } };
    } };
    const node = value => {
        if (typeof value === 'string') value = { type: 3, value };
        const result = { nodeType: value.type ?? 1, name: value.name || 'span', ownerDocument: doc, childNodes: [], className: value.className || '', hidden: false };
        if ([3, 4, 8, 7].includes(result.nodeType)) Object.defineProperty(result, 'nodeValue', { get() { stats.reads++; return value.value; } });
        result.childNodes = (value.children || []).map(node);
        result.childNodes.forEach(c => { c.parent = result; });
        // template content and shadow trees deliberately are not childNodes.
        if (value.content) result.content = node({ children: value.content });
        if (value.shadow) result.shadowRoot = node({ children: value.shadow });
        return result;
    };
    const pre = node({ name: 'pre', children: Array.isArray(spec) ? spec : [spec] });
    const getText = n => {
        if ([3, 4].includes(n.nodeType)) return n.nodeValue;
        if (![1, 9, 11].includes(n.nodeType)) return '';
        return (n.childNodes || []).map(getText).join('');
    };
    const fallback = () => { stats.fallback++; stats.joins++; return oldPredicate(getText(pre)); };
    return { stats, log, node, pre, doc, getText, fallback };
}

function jquery(h) {
    const matches = (n, selector) => selector === 'pre' ? n.name === 'pre'
        : selector === 'iframe' ? n.name === 'iframe'
            : selector.includes('TH-collapse-code-block-button') ? n.className === 'TH-collapse-code-block-button'
                : selector.includes('TH-render') ? n.className === 'TH-render' : false;
    function $(value) {
        if (value?._jq) return value;
        let values;
        if (typeof value === 'string' && value.startsWith('<div')) values = [h.node({ name: 'div', className: 'TH-collapse-code-block-button' })];
        else values = Array.isArray(value) ? value : value ? [value] : [];
        const result = { _jq: true, length: values.length, toArray: () => values, ...values,
            attr: key => key === 'mesid' ? values[0]?.mesid : undefined,
            parent: selector => $(values.map(n => n.parent).filter(n => n && matches(n, selector))),
            children: selector => $(values.flatMap(n => n.childNodes || []).filter(n => matches(n, selector))),
            closest: () => $(values.filter(n => n.inStreaming)),
            find(selector) { const found = []; const walk = n => { for (const c of n.childNodes || []) { if (matches(c, selector)) found.push(c); walk(c); } }; values.forEach(walk); return $(found); },
            filter: predicate => $(values.filter((n, i) => predicate(i, n))),
            map: callback => $((values.map((n, i) => callback(i, n)))),
            text(value) { if (value === undefined) { h.stats.joins++; return values.map(h.getText).join(''); } values.forEach(n => { n.label = value; }); h.log.push(['text', value]); return result; },
            wrap() { values.forEach(n => { const wrap = h.node({ name: 'div', className: 'TH-render' }); wrap.childNodes = [n]; n.parent = wrap; }); h.log.push(['wrap']); return result; },
            on: () => result,
            prependTo(target) { target.toArray().forEach(n => { n.childNodes.unshift(...values); values.forEach(c => { c.parent = n; }); }); h.log.push(['prepend']); return result; },
            addClass(name) { values.forEach(n => { n.hidden = true; }); h.log.push(['addClass', name, values.length]); return result; },
            removeClass: () => result, is: () => false,
        };
        return result;
    }
    return $;
}

function shipping(functions, h, render = { allow_streaming: false }) {
    const $ = jquery(h);
    const _ = value => ({ map(fn) { value = value.map(fn); return this; }, filter(fn) { value = value.filter(fn); return this; }, value: () => value });
    const context = { $, _, MF: () => ({ settings: { render } }), hasFrontendMarkupText };
    vm.createContext(context);
    vm.runInContext(Object.values(functions).join('\n'), context);
    return { ...context, $ };
}

test('literal detector preserves every marker split, ignored comments, nested text and exact case', () => {
    for (const marker of ['html>', '<head>', '<body']) for (let a = 0; a <= marker.length; a++) for (let b = a; b <= marker.length; b++) {
        const h = fixture([marker.slice(0, a), { type: 8, value: 'ignored' }, { name: 'b', children: [marker.slice(a, b)] }, '', { type: 4, value: marker.slice(b) }]);
        assert.equal(hasFrontendMarkupText(h.pre, h.fallback), oldPredicate(h.getText(h.pre)));
    }
    for (const spec of [[], ['xhtml>y'], ['HTML>'], ['<HEAD>'], ['&lt;body'], [{ type: 8, value: '<body' }], [{ type: 7, value: '<body' }], [{ name: 'script', children: ['<body'] }], [{ name: 'style', children: ['<head>'] }], [{ name: 'template', content: ['<body'] }], [{ shadow: ['<body'] }], ['<bo', { name: 'br' }, 'dy'], ['\ud800<he', 'ad>\udfff']]) {
        const h = fixture(spec);
        assert.equal(hasFrontendMarkupText(h.pre, h.fallback), oldPredicate(h.getText(h.pre)));
    }
});

test('early marker avoids reading following multi-MB nodes or concatenating DOM text', () => {
    const h = fixture(['<!doctype html>', 'x'.repeat(3 * 1024 * 1024)]);
    assert.equal(hasFrontendMarkupText(h.pre, h.fallback), true);
    assert.equal(h.stats.reads, 1);
    assert.equal(h.stats.joins, 0);
    assert.equal(h.stats.fallback, 0);
});

test('no marker visits every node once without constructing full text', () => {
    const h = fixture(['a'.repeat(3 * 1024 * 1024), '', '<HE', 'AD>', { type: 8, value: '<body' }, 'last']);
    assert.equal(hasFrontendMarkupText(h.pre, h.fallback), false);
    assert.equal(h.stats.reads, 5);
    assert.equal(h.stats.joins, 0);
});

test('unsupported roots and failed walkers preserve caller fallback receiver/result', () => {
    for (const value of [null, {}, [], { nodeType: 3 }, { nodeType: 9 }, { nodeType: 1, ownerDocument: {} }, { nodeType: 1, ownerDocument: { createTreeWalker() { throw Error('unsupported'); } } }]) {
        let calls = 0;
        assert.equal(hasFrontendMarkupText(value, () => { calls++; return true; }), true);
        assert.equal(calls, 1);
    }
    const h = fixture([{ type: 3, value: null }]);
    let calls = 0;
    assert.throws(() => hasFrontendMarkupText(h.pre, () => { calls++; throw Error('original fallback error'); }), /original fallback error/);
    assert.equal(calls, 1, 'a failing original fallback is not invoked twice');
});

test('seeded fragmented text is exactly equivalent to original literal predicate', () => {
    let seed = 339;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const tokens = ['h', 'tml>', '<', 'body', '<head>', 'HTML>', '&lt;', '\ud800', '\udfff', '', 'x'];
    for (let i = 0; i < 400; i++) {
        const parts = Array.from({ length: Math.floor(random() * 45) }, () => {
            const value = tokens[Math.floor(random() * tokens.length)];
            const kind = Math.floor(random() * 5);
            return kind === 0 ? { type: 8, value } : kind === 1 ? { type: 4, value } : kind === 2 ? { name: 'b', children: [value] } : value;
        });
        const h = fixture(parts);
        assert.equal(hasFrontendMarkupText(h.pre, h.fallback), oldPredicate(h.getText(h.pre)), `seeded sample ${i}`);
    }
});

test('actual Q1 folding and EI selection match original shipping including multi-root fallback', () => {
    for (const spec of [['<!doctype html>', 'x'.repeat(3 * 1024 * 1024)], ['plain'], ['<bo', 'dy'], [{ type: 8, value: '<body' }]]) {
        for (const mode of ['frontend_only', 'all']) {
            const before = fixture(spec), after = fixture(spec);
            shipping(baseline.functions, before).Q1(jquery(before)(before.pre), mode, false);
            shipping(current, after).Q1(jquery(after)(after.pre), mode, false);
            assert.deepEqual(after.log, before.log);
            assert.equal(after.pre.hidden, before.pre.hidden);
        }
        const summaries = [];
        for (const functions of [baseline.functions, current]) {
            const h = fixture(spec), mes = h.node({ name: 'div' }); mes.mesid = '2'; mes.childNodes = [h.pre]; h.pre.parent = mes;
            const s = shipping(functions, h), rows = s.EI(s.$([mes]), 'memo');
            summaries.push({ rows: rows.map(r => ({ id: r.message_id, memo: r.reload_memo, count: r.elements.length })), log: h.log });
        }
        assert.equal(JSON.stringify(summaries[1]), JSON.stringify(summaries[0]));
    }
    const h = fixture(['<bo']), other = h.node({ name: 'pre', children: ['dy'] }), s = shipping(current, h);
    s.Q1(s.$([h.pre, other]), 'frontend_only', false);
    assert.ok(h.log.some(row => row[0] === 'text' && row[1] === '显示前端代码块'));
    assert.equal(h.stats.joins, 1, 'multiple roots keep original concatenating jQuery receiver');
});

test('actual folding early exits and iframe streaming exclusion stay unchanged', () => {
    for (const existingButton of [false, true]) for (const streaming of [false, true]) {
        const outputs = [];
        for (const functions of [baseline.functions, current]) {
            const h = fixture(['<body']), wrapper = h.node({ name: 'div', className: 'TH-render' });
            wrapper.childNodes.push(h.pre); h.pre.parent = wrapper; h.pre.inStreaming = streaming;
            if (existingButton) wrapper.childNodes.push(h.node({ name: 'div', className: 'TH-collapse-code-block-button' }));
            const s = shipping(functions, h, { allow_streaming: true });
            s.Q1(s.$(h.pre), 'frontend_only', streaming);
            const mes = h.node({ name: 'div' }); mes.mesid = '4'; mes.childNodes = [wrapper]; wrapper.parent = mes;
            const rows = s.EI(s.$([mes]), 'memo');
            outputs.push({ log: h.log, hidden: h.pre.hidden, count: rows.length, reused: rows.length ? rows[0].elements[0] === wrapper : false });
        }
        assert.deepEqual(outputs[1], outputs[0]);
    }
});

test('actual shipping Q1 and EI use bounded detector, preserve other bytes and original Bk', () => {
    assert.ok(current.Q1.includes('hasFrontendMarkupText('));
    assert.ok(current.EI.includes('hasFrontendMarkupText('));
    assert.equal(current.Bk, baseline.functions.Bk);
    for (const name of ['Q1', 'EI']) {
        const h = fixture(['<!doctype html>', 'x'.repeat(3 * 1024 * 1024)]), s = shipping(current, h);
        if (name === 'Q1') s.Q1(s.$(h.pre), 'frontend_only', false);
        else { const mes = h.node({ name: 'div' }); mes.mesid = '2'; mes.childNodes = [h.pre]; h.pre.parent = mes; s.EI(s.$([mes]), 'memo'); }
        assert.equal(h.stats.reads, 1, `${name} reads only the first marker node`);
        assert.equal(h.stats.joins, 0, `${name} does not concatenate the full DOM text`);
    }
    let restored = bundle.replace('import{hasFrontendMarkupText}from"../homer-frontend-marker.mjs";\n', '');
    for (const name of ['Q1', 'EI']) restored = restored.replace(current[name], baseline.functions[name]);
    assert.equal(createHash('sha256').update(restored).digest('hex'), baseline.bundle_sha256, 'all non-target bundle bytes exact');
});
