import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { extractShippingHelpers } from './helpers/ejs-shipping-helpers.mjs';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const { transformSync } = require(resolve(root, 'tools/webview-compat/node_modules/esbuild'));
const lodash = require(resolve(root, 'sillytavern-runtime/node_modules/lodash'));
const extension = resolve(root, 'sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template');
const source = readFileSync(resolve(extension, 'src/utils/prompts.ts'), 'utf8').replaceAll('\r\n', '\n');
const bundle = readFileSync(resolve(extension, 'dist/index.js'), 'utf8');
const sourceUnescapeGuard = '    if (!html.includes(\'&lt;%\')) return html;\n';
const sourceWrapGuard = '    if (!openTags.some(tag => content.includes(tag))) return content;\n';
const distUnescapeGuard = '!y.includes("&lt;%")?y:';
const distWrapGuard = 'if(!o.some(t=>e.includes(t)))return e;';

function makeVM(code) {
    const context = vm.createContext({ _: lodash, exports: {}, module: { exports: {} } });
    vm.runInContext(code, context);
    vm.runInContext(`
      globalThis.scanStats = { count: 0, failOnScan: false };
      const originalStartsWith = String.prototype.startsWith;
      String.prototype.startsWith = function (...args) {
        scanStats.count++;
        if (scanStats.failOnScan) throw new Error('unexpected per-character scanner');
        return Reflect.apply(originalStartsWith, this, args);
      };
    `, context);
    return {
        run(name, ...args) {
            context.testArgs = args;
            return vm.runInContext(`testFunctions[${JSON.stringify(name)}](...testArgs)`, context);
        },
        noScan(name, ...args) {
            context.scanStats.count = 0;
            context.scanStats.failOnScan = true;
            try {
                const value = this.run(name, ...args);
                assert.equal(context.scanStats.count, 0);
                return value;
            } finally { context.scanStats.failOnScan = false; }
        },
        get scans() { return context.scanStats.count; },
    };
}

function sourceVM(removeGuards = false) {
    let input = source.replace(/^import .*;\n/gm, '');
    if (removeGuards) input = input.replace(sourceUnescapeGuard, '').replace(sourceWrapGuard, '');
    const { code } = transformSync(input, { loader: 'ts', format: 'cjs', target: 'es2022' });
    return makeVM(`${code}\nglobalThis.testFunctions = module.exports;`);
}

function bundleVM(removeGuards = false) {
    // Preserve the old actual shipping baseline while extracting today's
    // expressions by syntax, independently of compiler inlining/naming.
    if (removeGuards) return makeVM(readFileSync(resolve(import.meta.dirname,
        'fixtures/ejs-prompts-shipping336.js'), 'utf8').replace(distUnescapeGuard, '').replace(distWrapGuard, ''));
    return makeVM(extractShippingHelpers(bundle).code);
}

const implementations = [
    ['source', sourceVM(), sourceVM(true)],
    ['shipping bundle', bundleVM(), bundleVM(true)],
];
const textCases = [
    '', 'plain 中文 😀 &amp; <div>HTML</div>', 'a'.repeat(4096),
    '%&gt; close-only &amp; %&gt;', '&LT;% uppercase &amp; %&GT;',
    '&lt;% unclosed &amp;', '&lt;% &amp; %&gt;',
    'before &lt;% &lt;% nested &amp; %&gt; after %&gt; tail',
    '%&gt;&lt;% __append(`&amp;`) %&gt;',
    '&lt;% __append(`literal &amp;`) %&gt;&lt;%= "&quot;" %&gt;',
    '&lt;% __APPEND(`&amp;`) %&gt; &lt;% &apos; &#39; &lt; &gt; %&gt;',
];
const wrapCases = [
    ['', ['thinking']],
    ['pure text '.repeat(512), ['thinking', 'think']],
    ['</thinking>close-only', ['thinking']],
    ['<thinking>unclosed', ['thinking']],
    ['<THINKING>case-sensitive</THINKING>', ['thinking']],
    ['A<thinking>raw ` ${x} % \\ 😀</thinking>Z', ['thinking']],
    ['<thinking>A<think>B</think>C</thinking>', ['thinking', 'think']],
    ['<thinking>mismatch</think><think>tail</thinking>', ['thinking', 'think']],
    ['<thinking>A</thinking><think>B</think>', ['thinking', 'think']],
    ['<thinking>literal</thinking>', []],
    ['[]body[/]', [''], { openDelimiter: '[', closeDelimiter: ']' }],
    ['[[think]]x`%[[/think]]', ['think'], { openDelimiter: '[[', closeDelimiter: ']]', delimiter: '?' }],
    ['&lt;reasoning&gt;A&amp;B&lt;/reasoning&gt;', ['reasoning'], { openDelimiter: '&lt;', closeDelimiter: '&gt;' }],
    ['<think>A</think>', ['think'], { openDelimiter: '', closeDelimiter: '', delimiter: '' }],
];

for (const [name, implementation, baseline] of implementations) {
    test(`${name}: unescape matches guard-removed shipping baseline for delimiters and malformed input`, () => {
        for (const input of textCases) {
            assert.equal(implementation.run('unescapeHtmlEntities', input), baseline.run('unescapeHtmlEntities', input));
        }
    });
    test(`${name}: escape matches baseline for nested, mismatched, unclosed and custom delimiters`, () => {
        for (const [input, blocks, options] of wrapCases) {
            assert.equal(implementation.run('wrapEscapeBlocks', input, blocks, options),
                baseline.run('wrapEscapeBlocks', input, blocks, options));
        }
        for (const options of [{}, { disableMarkup: 'literal' }, { options: { openDelimiter: '&lt;', closeDelimiter: '&gt;' } }]) {
            const input = '<literal>x%</literal><thinking>a`</thinking><think>b</think><reasoning>c</reasoning>';
            assert.equal(implementation.run('escapeReasoningBlocks', input, options),
                baseline.run('escapeReasoningBlocks', input, options));
        }
    });
    test(`${name}: multi-MB unescape without exact opener bypasses every startsWith scan`, () => {
        const input = ('plain &amp; %&gt; &LT;% 中文😀\n').repeat(150000);
        assert.ok(input.length > 3 * 1024 * 1024);
        assert.equal(implementation.noScan('unescapeHtmlEntities', input), input);
    });
    test(`${name}: multi-MB reasoning without any exact opener bypasses every startsWith scan`, () => {
        const input = ('<div>literal</div></thinking><THINK> 😀\n').repeat(100000);
        assert.ok(input.length > 3 * 1024 * 1024);
        assert.equal(implementation.noScan('escapeReasoningBlocks', input), input);
        assert.equal(implementation.noScan('wrapEscapeBlocks', input, []), input);
    });
    test(`${name}: actual marked content still reaches original scanner`, () => {
        const before = implementation.scans;
        implementation.run('unescapeHtmlEntities', '&lt;%= "&amp;" %&gt;');
        implementation.run('wrapEscapeBlocks', '<thinking>x</thinking>', ['thinking']);
        assert.ok(implementation.scans > before);
    });
}

test('TS source and actual shipping bundle agree for all edge cases', () => {
    for (const input of textCases) {
        assert.equal(implementations[0][1].run('unescapeHtmlEntities', input), implementations[1][1].run('unescapeHtmlEntities', input));
    }
    for (const [input, blocks, options] of wrapCases) {
        assert.equal(implementations[0][1].run('wrapEscapeBlocks', input, blocks, options),
            implementations[1][1].run('wrapEscapeBlocks', input, blocks, options));
    }
});
