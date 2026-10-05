import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CODE_HIGHLIGHT_MAX_CHARS, readCopyableCodeText, shouldHighlightCode } from '../../sillytavern-runtime/public/scripts/homer-code-budget.mjs';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const start = source.indexOf('export function addCopyToCodeBlocks(');
const end = source.indexOf('\n/**', start);
assert.ok(start > 0 && end > start);
const actualFunction = source.slice(start, end).replace('export ', '');

class Element {
    constructor(tag = 'code') {
        this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = [];
        this.dataset = {}; this.listeners = new Map(); this.parentNode = null;
        const names = new Set();
        this.classList = { add: (...items) => items.forEach(x => names.add(x)), contains: x => names.has(x),
            toggle: (name, enabled) => enabled ? names.add(name) : names.delete(name) };
    }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get children() { return this.childNodes.filter(x => x.nodeType === 1); }
    get textContent() { return this.childNodes.map(x => x.textContent || '').join(''); }
    set textContent(value) { this.childNodes = [{ nodeType: 3, textContent: String(value), parentNode: this }]; }
    appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }
    remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(x => x !== this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
}

function fixture(texts) {
    const codes = texts.map(text => { const pre = new Element('pre'), code = new Element(); code.textContent = text; pre.appendChild(code); return code; });
    const highlighted = [], copied = [], notices = [];
    const scope = {
        readCopyableCodeText, shouldHighlightCode,
        $: () => ({ find: selector => { assert.equal(selector, 'pre code'); return { length: codes.length, get: i => codes[i] }; } }),
        hljs: { highlightElement: code => {
            assert.equal(code.children.length, 0, 'copy controls must not reach the highlighter');
            const text = code.textContent; highlighted.push(text);
            const span = new Element('span'); span.textContent = text; code.childNodes = []; code.appendChild(span);
            code.dataset.highlighted = 'yes'; code.classList.add('hljs');
        } },
        document: { createElement: tag => new Element(tag) },
        copyText: async text => copied.push(text),
        toastr: { info: text => notices.push(text) }, t: strings => strings[0],
    };
    vm.createContext(scope); vm.runInContext(actualFunction, scope);
    return { codes, highlighted, copied, notices, render: () => scope.addCopyToCodeBlocks({}) };
}
const buttons = code => code.children.filter(x => x.classList.contains('code-copy'));

test('syntax budget has a precise boundary and never truncates any string', () => {
    assert.equal(shouldHighlightCode('x'.repeat(CODE_HIGHLIGHT_MAX_CHARS)), true);
    assert.equal(shouldHighlightCode('x'.repeat(CODE_HIGHLIGHT_MAX_CHARS + 1)), false);
    assert.equal(shouldHighlightCode(''), true); assert.equal(shouldHighlightCode(null), false);
});

test('three-megabyte HTML stays complete and copies completely without syntax parsing', async () => {
    const text = '<html><script>' + 'x'.repeat(3 * 1024 * 1024) + '</script></html>';
    const f = fixture([text]); f.render();
    assert.equal(f.highlighted.length, 0); assert.equal(f.codes[0].textContent, text);
    assert.equal(f.codes[0].parentElement.classList.contains('homer-large-code-block'), true);
    assert.equal(f.codes[0].classList.contains('homer-large-code-block'), false);
    assert.equal(f.codes[0].classList.contains('hljs'), true); assert.equal(buttons(f.codes[0]).length, 1);
    await buttons(f.codes[0])[0].listeners.get('pointerup')();
    assert.equal(f.copied[0], text); assert.equal(f.notices.length, 1);
});

test('ordinary code still highlights and copying retains the source through highlight spans', async () => {
    const text = 'const value = "<tag>&";\n// comment'; const f = fixture([text]); f.render();
    assert.deepEqual(f.highlighted, [text]); assert.equal(buttons(f.codes[0]).length, 1);
    assert.equal(f.codes[0].parentElement.classList.contains('homer-large-code-block'), false);
    await buttons(f.codes[0])[0].listeners.get('pointerup')(); assert.equal(f.copied[0], text);
});

test('repeat rendering is idempotent and never highlights an existing copy control', async () => {
    const f = fixture(['small', 'x'.repeat(3 * 1024 * 1024)]); f.render();
    const original = f.codes.map(code => buttons(code)[0]);
    // A visual/accessibility label added to the icon is not source code.
    original.forEach(button => { button.textContent = 'Copy'; });
    for (let i = 0; i < 4; i++) f.render();
    assert.deepEqual(f.highlighted, ['small']);
    f.codes.forEach((code, i) => { assert.equal(buttons(code).length, 1); assert.equal(buttons(code)[0], original[i]); });
    await original[0].listeners.get('pointerup')(); assert.equal(f.copied[0], 'small');
});

test('legacy duplicate controls are removed without removing real highlighted code', () => {
    const f = fixture(['original']); f.render(); const first = buttons(f.codes[0])[0];
    const duplicate = new Element('i'); duplicate.classList.add('code-copy'); duplicate.textContent = 'not code';
    f.codes[0].appendChild(duplicate); f.render();
    assert.equal(buttons(f.codes[0]).length, 1); assert.equal(buttons(f.codes[0])[0], first);
    assert.equal(readCopyableCodeText(f.codes[0]), 'original'); assert.deepEqual(f.highlighted, ['original']);
});

test('copy reads the latest live code, while its click keeps the prior propagation behavior', async () => {
    const f = fixture(['before']); f.render(); const copy = buttons(f.codes[0])[0];
    f.codes[0].childNodes[0].textContent = 'after\n<>&';
    await copy.listeners.get('pointerup')(); assert.equal(f.copied[0], 'after\n<>&');
    let stopped = false; copy.listeners.get('click')({ stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
});

test('large code layout belongs only to PRE and is removed when that source becomes small', () => {
    const f = fixture(['x'.repeat(CODE_HIGHLIGHT_MAX_CHARS + 1)]); f.render();
    const pre = f.codes[0].parentElement;
    f.codes[0].childNodes[0].textContent = 'small'; f.render();
    assert.equal(pre.classList.contains('homer-large-code-block'), false);
    // A renderer replacing PRE cannot transfer the class to its new iframe.
    const iframe = new Element('iframe'); assert.equal(iframe.classList.contains('homer-large-code-block'), false);
    const css = fs.readFileSync(new URL('../../sillytavern-runtime/public/style.css', import.meta.url), 'utf8');
    assert.match(css, /pre\.homer-large-code-block\s*\{[^}]*max-height:\s*min\(40vh, 480px\);[^}]*overflow:\s*auto;/);
    assert.match(css, /pre\.homer-large-code-block > code\s*\{[^}]*white-space:\s*pre;[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;/);
});
