import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { extractShippingHelpers } from './helpers/ejs-shipping-helpers.mjs';

const root = resolve(import.meta.dirname, '../..');
const extension = resolve(root, 'sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template');
const require = createRequire(import.meta.url);
const { transformSync } = require(resolve(root, 'tools/webview-compat/node_modules/esbuild'));
const lodash = require(resolve(root, 'sillytavern-runtime/node_modules/lodash'));
const source = readFileSync(resolve(extension, 'src/utils/prompts.ts'), 'utf8').replaceAll('\r\n', '\n');
const bundle = readFileSync(resolve(extension, 'dist/index.js'), 'utf8');

function makeVM(code) {
    const context = vm.createContext({ _: lodash, exports: {}, module: { exports: {} } });
    vm.runInContext(code, context);
    vm.runInContext(`
        globalThis.scanStats = { starts: 0, execs: 0 };
        const starts = String.prototype.startsWith, exec = RegExp.prototype.exec;
        String.prototype.startsWith = function (...args) { scanStats.starts++; return Reflect.apply(starts, this, args); };
        RegExp.prototype.exec = function (...args) { scanStats.execs++; return Reflect.apply(exec, this, args); };
    `, context);
    return {
        run(name, ...args) {
            context.testArgs = args;
            context.scanStats.starts = context.scanStats.execs = 0;
            return vm.runInContext(`testFunctions[${JSON.stringify(name)}](...testArgs)`, context);
        },
        get stats() { return { ...context.scanStats }; },
    };
}

const compiled = transformSync(source.replace(/^import .*;\n/gm, '') + '\nexport { splitNested };', { loader: 'ts', format: 'cjs', target: 'es2022' });
const implementations = [
    ['source', makeVM(compiled.code + '\nglobalThis.testFunctions=module.exports;')],
    ['shipping', makeVM(extractShippingHelpers(bundle).code)],
];
const baseline = makeVM(readFileSync(resolve(import.meta.dirname, 'fixtures/ejs-prompts-shipping336.js'), 'utf8'));
const unescapeCases = [
    '', 'plain &amp; \ud800 中文😀 \udfff', '%&gt;close-only', '&lt;%unclosed &amp;',
    '&LT;%case%&GT;', '&lt;% &amp; %&gt;', '%&gt;&lt;%x%&gt;%&gt;',
    'A&lt;%one &lt;% two &amp; %&gt; three%&gt;Z',
    '&lt;% __append(`&amp; <pre>literal%&gt;</pre>`) %&gt;',
    '<pre><code>&lt;% literal \\ `%&gt; ${x}</code></pre>',
];
const wrapCases = [
    ['', []], ['</thinking>close-only', ['thinking']], ['<thinking>unclosed', ['thinking']],
    ['<THINKING>case</THINKING>', ['thinking']], ['<thinking>x</think>tail</thinking>', ['think', 'thinking']],
    ['<thinking>A<think>B</thinking>C</think>', ['thinking', 'think']],
    ['<thinking>\ud800%\\` ${x}😀\udfff</thinking>', ['thinking']],
    ['<pre><code>&lt;% x %&gt;</code></pre><thinking>raw</thinking>', ['thinking']],
    ['<thinking>no-op</thinking>', []], ['<>empty</>', ['']],
    ['[[think]]x[[/think]]', ['think'], { openDelimiter: '[[', closeDelimiter: ']]', delimiter: '?' }],
    ['\\(a+.)x\\(/a+.)', ['a+.'], { openDelimiter: '\\(', closeDelimiter: ')' }],
    ['<x>a<x>y>nested</x>y>b</x>', ['x', 'x>y']],
    ['<x>a<x>y>nested</x>y>b</x>', ['x>y', 'x']],
    ['</x>opening-wins<//x>', ['/x', 'x']],
    ['<think>x</think>', ['think'], { openDelimiter: '', closeDelimiter: '', delimiter: '' }],
];
let seed = 0x41e337;
function random(max) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; }
const atoms = ['x', '&amp;', '\ud800', '\udfff', '😀', '\\` ${x}', '&lt;%', '%&gt;', '<pre>', '</pre>', '<thinking>', '</thinking>', '<think>', '</think>', '<x>', '<x>y>', '</x>', '</x>y>'];
const randomInputs = Array.from({ length: 400 }, () => Array.from({ length: random(100) }, () => atoms[random(atoms.length)]).join(''));
const customCases = Array.from({ length: 150 }, () => {
    const characters = ['x', '', '/', ']', '[', '+', '.', '*', '?', '^', '$', '(', ')', '{', '}', '|', '\\', '\n', '\ud800', '\udfff'];
    const literal = () => Array.from({ length: random(5) + 1 }, () => characters[random(characters.length)]).join('');
    const opts = { openDelimiter: literal(), closeDelimiter: literal(), delimiter: literal() };
    const blocks = [literal(), literal(), literal()];
    const od = opts.openDelimiter || '<', cd = opts.closeDelimiter || '>';
    const tokens = [...blocks.map(tag => od + tag + cd), ...blocks.map(tag => od + '/' + tag + cd), 'body\ud800😀\udfff', '`%${x}'];
    return [Array.from({ length: 40 }, () => tokens[random(tokens.length)]).join(''), blocks, opts];
});

for (const [label, implementation] of implementations) {
    test(`${label}: exact old shipping differential, malformed/UTF16/PRE/literal and seeded inputs`, () => {
        for (const input of [...unescapeCases, ...randomInputs]) {
            assert.equal(implementation.run('unescapeHtmlEntities', input), baseline.run('unescapeHtmlEntities', input));
        }
        for (const [input, blocks, opts] of [...wrapCases, ...customCases]) {
            assert.equal(implementation.run('wrapEscapeBlocks', input, blocks, opts), baseline.run('wrapEscapeBlocks', input, blocks, opts));
        }
        for (const input of randomInputs) {
            for (const blocks of [['thinking', 'think'], ['x', 'x>y'], ['x>y', 'x'], ['x', '/x'], []]) {
                assert.equal(implementation.run('wrapEscapeBlocks', input, blocks), baseline.run('wrapEscapeBlocks', input, blocks));
            }
        }
        for (const opts of [{}, { disableMarkup: 'pre' }, { disableMarkup: '' }, { options: { openDelimiter: '[', closeDelimiter: ']' } }]) {
            for (const input of unescapeCases) assert.equal(implementation.run('escapeReasoningBlocks', input, opts), baseline.run('escapeReasoningBlocks', input, opts));
        }
    });
    test(`${label}: unknown/stateful generic matcher retains each old call index and result`, () => {
        for (const input of ['a[b]c', '\ud800a[b]😀\udfff', '[[x]tail', 'plain']) {
            const calls = [], oldCalls = [];
            const matcher = output => (text, index) => {
                output.push(index);
                if (text[index] === '[') return { type: 'open', value: 'OPEN', len: 1 };
                if (text[index] === ']') return { type: 'close', value: 'CLOSE', len: 1 };
                return null;
            };
            assert.deepEqual(Array.from(implementation.run('splitNested', input, matcher(calls))), Array.from(baseline.run('splitNested', input, matcher(oldCalls))));
            assert.deepEqual(calls, oldCalls);
        }
    });
    test(`${label}: sparse multi-MB marked content bypasses per-code-unit matching`, () => {
        const body = 'text &amp; 中文😀\ud800\udfff '.repeat(180000);
        assert.ok(body.length > 3 * 1024 * 1024);
        const input = body + '&lt;% "&amp;" %&gt;' + body;
        assert.equal(implementation.run('unescapeHtmlEntities', input), body + '&lt;% "&" %&gt;' + body);
        assert.ok(implementation.stats.starts < 40, JSON.stringify(implementation.stats));
        assert.ok(implementation.stats.execs < 40, JSON.stringify(implementation.stats));
        const wrapped = '<thinking>' + body + '</thinking>' + body;
        assert.equal(implementation.run('wrapEscapeBlocks', wrapped, ['thinking']), baseline.run('wrapEscapeBlocks', wrapped, ['thinking']));
        assert.ok(implementation.stats.starts < 40, JSON.stringify(implementation.stats));
    });
    test(`${label}: dense tokens have bounded single-direction scanner operations`, () => {
        const count = 6000;
        const input = '&lt;%x%&gt;'.repeat(count);
        assert.equal(implementation.run('unescapeHtmlEntities', input), input);
        assert.ok(implementation.stats.starts <= count * 10 + 10);
        assert.ok(implementation.stats.execs <= count * 5 + 10);
        const wrapped = '<think>x</think>'.repeat(count);
        assert.equal(implementation.run('wrapEscapeBlocks', wrapped, ['thinking', 'think']), baseline.run('wrapEscapeBlocks', wrapped, ['thinking', 'think']));
        // Two opening checks and four closing checks per pair; body positions
        // never reach the matcher. Tag precedence itself remains unchanged.
        assert.ok(implementation.stats.starts <= count * 6 + 10);
        assert.ok(implementation.stats.execs <= count * 10 + 10);
    });
}
