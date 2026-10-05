import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const extensionRoot = new URL('../../sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template/', import.meta.url);
const require = createRequire(new URL('package.json', extensionRoot));
const { parse } = require('acorn');
const source = fs.readFileSync(new URL('src/utils/prompts.ts', extensionRoot), 'utf8');
const bundle = fs.readFileSync(new URL('dist/index.js', extensionRoot), 'utf8');
const warning = '[Prompt Template] token statistics unavailable; previous counters retained.';
const start = source.indexOf('export function updateTokens(');
const end = source.indexOf('\n/**', start);
assert.ok(start >= 0 && end > start);
const sourceFunction = source.slice(start, end)
    .replace('export function', 'function')
    .replace("prompts: string, type: 'send' | 'receive'", 'prompts, type');

const ast = parse(bundle, { ecmaVersion: 'latest', sourceType: 'module' });
let warningAncestors;
function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && node.value === warning) warningAncestors = ancestors;
    for (const [key, value] of Object.entries(node)) {
        if (key === 'start' || key === 'end') continue;
        if (Array.isArray(value)) for (const child of value) visit(child, [...ancestors, node]);
        else if (value && typeof value === 'object') visit(value, [...ancestors, node]);
    }
}
visit(ast);
assert.ok(warningAncestors, 'The actual loaded bundle must contain the failure handling');
const bundleFunctionNode = [...warningAncestors].reverse().find(node => node.type === 'FunctionDeclaration');
assert.ok(bundleFunctionNode?.id?.name, 'Find the compiled updateTokens function, not a reconstructed fixture');
const bundleFunction = bundle.slice(bundleFunctionNode.start, bundleFunctionNode.end);
assert.match(bundleFunction, /window\.setTimeout/);
const imports = ast.body.filter(node => node.type === 'ImportDeclaration');
function namespaceFor(pathSuffix) {
    const declaration = imports.find(node => node.source.value.endsWith(pathSuffix));
    const namespace = declaration?.specifiers.find(node => node.type === 'ImportNamespaceSpecifier');
    assert.ok(namespace?.local?.name, `Missing compiled namespace: ${pathSuffix}`);
    return namespace.local.name;
}
const tokenizerNamespace = namespaceFor('/tokenizers.js');
const settingsNamespace = namespaceFor('/extensions.js');
function compiledMemberOwner(propertyName) {
    let owner;
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'MemberExpression' && !node.computed
            && node.property.name === propertyName && node.object.type === 'Identifier') owner = node.object.name;
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') walk(value);
        }
    }
    walk(bundleFunctionNode);
    assert.ok(owner, `Missing actual compiled dependency: ${propertyName}`);
    return owner;
}
const compiledTokenizerNamespace = compiledMemberOwner('getTokenCountAsync');
const compiledSettingsNamespace = compiledMemberOwner('extension_settings');
const implementations = [
    { label: 'source', code: sourceFunction, name: 'updateTokens' },
    { label: 'actual production bundle', code: bundleFunction, name: bundleFunctionNode.id.name },
];

function fixture(implementation, tokenize) {
    const timers = [];
    const logs = [];
    const warnings = [];
    const calls = [];
    const counters = { LAST_SEND_TOKENS: 21, LAST_SEND_CHARS: 84, LAST_RECEIVE_TOKENS: 32, LAST_RECEIVE_CHARS: 128 };
    const settings = { variables: { global: counters } };
    const count = text => { calls.push(text); return tokenize(text); };
    const scope = {
        window: { setTimeout: callback => { timers.push(callback); } },
        console: { log: (...args) => logs.push(args), warn: (...args) => warnings.push(args) },
        getTokenCountAsync: count, extension_settings: settings,
        [tokenizerNamespace]: { getTokenCountAsync: count },
        [settingsNamespace]: { extension_settings: settings },
        [compiledTokenizerNamespace]: { getTokenCountAsync: count },
        [compiledSettingsNamespace]: { extension_settings: settings },
    };
    vm.createContext(scope);
    vm.runInContext(implementation.code, scope);
    const run = (text, type) => scope[implementation.name](text, type);
    const settle = async () => {
        while (timers.length) timers.shift()();
        // Rejections must have their own handler before the next event-loop turn.
        // node:test fails a test that leaks an unhandled rejection here.
        await new Promise(resolve => setImmediate(resolve));
    };
    return { run, settle, calls, counters, logs, warnings, timers };
}

for (const implementation of implementations) {
    test(`${implementation.label}: offline jqXHR rejection is handled without a fake zero or private log`, async () => {
        const rejected = { status: 0, readyState: 0, statusText: 'error', responseText: 'fixture response that must not be logged' };
        const current = fixture(implementation, () => Promise.reject(rejected));
        const before = { ...current.counters };
        assert.equal(current.run('fixture message that must not be logged', 'receive'), undefined);
        assert.equal(current.calls.length, 0, 'The statistics read is still supplementary background work');
        await current.settle();
        assert.deepEqual(current.counters, before);
        assert.equal(current.logs.length, 0, 'A failed count is never reported as success');
        assert.deepEqual(current.warnings, [[warning]], 'No error object, response or message source enters the log');
        assert.equal(current.calls.length, 1, 'No automatic tokenizer request retry is added');
    });

    test(`${implementation.label}: a rejected send read also preserves both directions and their lengths`, async () => {
        const current = fixture(implementation, () => Promise.reject(new TypeError('fixture network unavailable')));
        const before = { ...current.counters };
        current.run('fixture send', 'send');
        await current.settle();
        assert.deepEqual(current.counters, before);
        assert.deepEqual(current.warnings, [[warning]]);
    });

    test(`${implementation.label}: a later successful count still updates its genuine value after failure`, async () => {
        let attempt = 0;
        const current = fixture(implementation, () => ++attempt === 1 ? Promise.reject({ status: 0 }) : Promise.resolve(47));
        current.run('first fixture', 'receive');
        await current.settle();
        current.run('second fixture', 'receive');
        await current.settle();
        assert.equal(current.counters.LAST_RECEIVE_TOKENS, 47);
        assert.equal(current.counters.LAST_RECEIVE_CHARS, 'second fixture'.length);
        assert.equal(current.counters.LAST_SEND_TOKENS, 21);
        assert.equal(current.counters.LAST_SEND_CHARS, 84);
        assert.equal(current.logs.length, 1);
        assert.equal(current.warnings.length, 1);
        assert.equal(current.calls.length, 2);
    });

    test(`${implementation.label}: successful send and receive statistics keep the original asynchronous behavior`, async () => {
        const current = fixture(implementation, text => Promise.resolve(text.startsWith('send') ? 19 : 29));
        current.run('send fixture', 'send');
        current.run('receive fixture', 'receive');
        assert.equal(current.calls.length, 0);
        await current.settle();
        assert.deepEqual(current.counters, {
            LAST_SEND_TOKENS: 19, LAST_SEND_CHARS: 'send fixture'.length,
            LAST_RECEIVE_TOKENS: 29, LAST_RECEIVE_CHARS: 'receive fixture'.length,
        });
        assert.equal(current.logs.length, 2);
        assert.equal(current.warnings.length, 0);
    });
}

test('the loaded bundle source map is rebuilt from this exact source, not a logger suppression patch', () => {
    const map = JSON.parse(fs.readFileSync(new URL('dist/index.js.map', extensionRoot), 'utf8'));
    const index = map.sources.findIndex(name => name.endsWith('/src/utils/prompts.ts'));
    assert.ok(index >= 0);
    assert.equal(map.sourcesContent[index], source);
    assert.match(sourceFunction, /getTokenCountAsync\(prompts\)\.then/);
    assert.match(bundleFunction, /\.catch\(/);
});
