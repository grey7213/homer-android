import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const runtime = new URL('../../sillytavern-runtime/', import.meta.url);
const require = createRequire(new URL('package.json', runtime));
const acorn = require('acorn');
const chevrotain = await import(new URL('node_modules/chevrotain/lib/src/api.js', runtime));
const read = path => fs.readFileSync(new URL(`public/${path}`, runtime), 'utf8');
const files = Object.fromEntries(['MacroLexer', 'MacroParser', 'MacroFlags', 'MacroRegistry', 'MacroCstWalker', 'MacroEngine']
    .map(name => [name, read(`scripts/macros/engine/${name}.js`)]));
const utils = read('scripts/utils.js');
const diagnostics = read('scripts/macros/engine/MacroDiagnostics.js');
const coreMacros = read('scripts/macros/definitions/core-macros.js');

function declaration(source, name) {
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const node = ast.body.map(item => item.declaration || item).find(item => item.id?.name === name);
    assert.ok(node, `actual product declaration ${name}`);
    return source.slice(node.start, node.end);
}
function executable(source) {
    return source.replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*\};\r?\n/gm, '').replace(/^export /gm, '');
}
const elseDeclaration = coreMacros.match(/^export const ELSE_MARKER = .*;$/m)?.[0].replace(/^export /, '');
assert.ok(elseDeclaration, 'actual core ELSE marker is extracted without registering unrelated browser macros');
const clone = value => JSON.parse(JSON.stringify(value));

function variables(events, scope) {
    const values = new Map();
    return {
        get: key => values.get(key),
        set(key, value) { events.push({ kind: 'variable', scope, op: 'set', key, value }); values.set(key, value); },
        inc(key) { const value = Number(values.get(key) || 0) + 1; events.push({ kind: 'variable', scope, op: 'inc', key, value }); values.set(key, value); return value; },
        dec(key) { const value = Number(values.get(key) || 0) - 1; events.push({ kind: 'variable', scope, op: 'dec', key, value }); values.set(key, value); return value; },
        add(key, amount) { const value = Number(values.get(key) || 0) + Number(amount); events.push({ kind: 'variable', scope, op: 'add', key, value }); values.set(key, value); return value; },
        entries: () => [...values.entries()],
    };
}

// Execute the actual Registry/Engine/CST walker and actual Chevrotain Parser,
// not a mock macro evaluator. Only UI logging is replaced with diagnostics;
// the runtime error constructor and boolean helpers are actual pure functions.
// Variables and registered macro handlers are explicit synthetic extension
// hooks so output, execution order, counts and side effects can be compared.
function harness(originalRegex = false) {
    const events = [], warnings = [];
    const local = variables(events, 'local'), global = variables(events, 'global');
    const context = vm.createContext({
        chevrotain,
        console: { warn() {}, debug() {}, info() {}, error() {} },
        SillyTavern: { getContext: () => ({ variables: { local, global } }) },
    });
    for (const name of ['logMacroGeneralError', 'logMacroInternalError', 'logMacroRuntimeWarning', 'logMacroSyntaxWarning', 'logMacroRegisterError', 'logMacroRegisterWarning']) {
        context[name] = () => warnings.push(name);
    }
    vm.runInContext([declaration(utils, 'isFalseBoolean'), declaration(utils, 'isTrueBoolean'),
        declaration(diagnostics, 'inferMacroName'), declaration(diagnostics, 'createMacroRuntimeError'), elseDeclaration].join('\n'), context);
    vm.runInContext(`globalThis.MacroLexer = (() => {
        ${executable(files.MacroLexer)}
        globalThis.MACRO_IDENTIFIER_PATTERN = MACRO_IDENTIFIER_PATTERN;
        ${originalRegex ? `Tokens.Plaintext.PATTERN = /(?:[^{]|\\{(?!\\{))+/u; instance = new MacroLexer();` : ''}
        return instance;
    })();`, context);
    vm.runInContext(executable(files.MacroFlags), context);
    for (const name of ['MacroParser', 'MacroRegistry', 'MacroCstWalker', 'MacroEngine']) {
        vm.runInContext(`globalThis.${name} = (() => { ${executable(files[name])} return instance; })();`, context);
    }
    let executions = 0;
    function record(call) {
        events.push({ kind: 'macro', name: call.name, args: clone(call.args),
            offset: call.globalOffset, range: clone(call.range), flags: clone(call.flags),
            raw: call.rawOriginal, scoped: call.isScoped });
    }
    const register = (name, options) => {
        assert.ok(context.MacroRegistry.registerMacro(name, options), `actual registry accepts synthetic ${name}`);
    };
    register('track', { handler(call) { record(call); return `fresh-${++executions}`; } });
    register('echo', { unnamedArgs: 1, handler(call) { record(call); return call.args[0]; } });
    register('scope', { unnamedArgs: 1, handler(call) { record(call); return call.args[0]; } });
    register('recursive', { unnamedArgs: 1, delayArgResolution: true, handler(call) {
        record(call); return call.resolve(call.args[0], { offsetDelta: 2 });
    } });
    const env = { dynamicMacros: {}, functions: { postProcess(value) { events.push({ kind: 'postProcess', value }); return value; } } };
    warnings.length = 0;
    return {
        context, events, warnings, local, global,
        run(input, options) { return context.MacroEngine.evaluate(input, env, options); },
        snapshot: () => ({ events: clone(events), warnings: [...warnings], local: local.entries(), global: global.entries() }),
    };
}

function assertParity(input, configure = () => {}, { repeats = 1, options } = {}) {
    const original = harness(true), product = harness();
    configure(original); configure(product);
    const outputs = [];
    for (let index = 0; index < repeats; index++) {
        const expected = original.run(input, options), actual = product.run(input, options);
        assert.equal(actual, expected, 'actual complete macro pipeline output');
        assert.deepEqual(product.snapshot(), original.snapshot(), 'actual handler order, side effects, diagnostics and global offsets');
        outputs.push(actual);
    }
    return { original, product, outputs };
}

test('actual registered macros still execute freshly on every call, without cross-message result reuse', () => {
    const { outputs, product } = assertParity('prefix { literal } {{track}} suffix', () => {}, { repeats: 2 });
    assert.deepEqual(outputs, ['prefix { literal } fresh-1 suffix', 'prefix { literal } fresh-2 suffix']);
    assert.equal(product.events.filter(event => event.kind === 'macro').length, 2);
});

test('nested and scoped macros retain handler order, full literal whitespace and flags', () => {
    const nested = assertParity('😀{ {{echo::{{track}}}} }').product;
    assert.deepEqual(nested.events.filter(event => event.kind === 'macro').map(event => event.name), ['track', 'echo']);
    const scoped = assertParity('{{#scope}}  {{track}}\r\n  tail  {{/scope}}').product;
    const scope = scoped.events.find(event => event.kind === 'macro' && event.name === 'scope');
    assert.equal(scope.scoped, true); assert.equal(scope.flags.preserveWhitespace, true);
});

test('recursive macro evaluation retains contextOffset and actual source ranges', () => {
    const { product } = assertParity('before {{recursive::{{track}}}} after', () => {}, { options: { contextOffset: 31 } });
    const calls = product.events.filter(event => event.kind === 'macro');
    assert.ok(calls.some(event => event.name === 'recursive'));
    assert.ok(calls.some(event => event.name === 'track'));
    assert.ok(calls.every(event => event.offset >= 31));
});

test('real CST local/global variable shorthand still performs assignments and increments in order', () => {
    const { product } = assertParity('{{.count++}}/{{$counter+=2}}/{{.count++}}/{{$counter}}', () => {}, { repeats: 2 });
    assert.deepEqual(product.local.entries(), [['count', 4]]);
    assert.deepEqual(product.global.entries(), [['counter', 4]]);
    assert.equal(product.events.filter(event => event.kind === 'variable').length, 6);
});

test('custom pre/post processors are not bypassed and can introduce new live macros', () => {
    const { outputs, product } = assertParity('plain { text } @TRACK@', h => {
        h.context.MacroEngine.addPreProcessor(text => { h.events.push({ kind: 'pre' }); return text.replace('@TRACK@', '{{track}}'); });
        h.context.MacroEngine.addPostProcessor(text => { h.events.push({ kind: 'post' }); return `${text}!`; });
    }, { repeats: 2 });
    assert.deepEqual(outputs, ['plain { text } fresh-1!', 'plain { text } fresh-2!']);
    assert.deepEqual(product.events.filter(event => event.kind === 'pre' || event.kind === 'post').map(event => event.kind), ['pre', 'post', 'pre', 'post']);
});

test('actual malformed/unfinished macro recovery retains warnings and allows the next clean evaluation', () => {
    for (const input of ['{{', '{{{', '{{unknown::{{track}}', '{{track::unexpected}}', '{{echo | !bad}}']) {
        const { original, product } = assertParity(input);
        assert.equal(product.run('recovered {{track}}'), original.run('recovered {{track}}'));
        assert.deepEqual(product.snapshot(), original.snapshot());
    }
});

test('3 MiB synthetic plaintext with one real macro retains every byte and handler offset', () => {
    const prefix = 'x{literal}\r\n'.repeat(131_072), suffix = 'y'.repeat(1_600_000);
    const input = prefix + '{{track}}' + suffix;
    assert.ok(Buffer.byteLength(input, 'utf8') > 3 * 1024 * 1024);
    const { outputs, product } = assertParity(input);
    assert.equal(outputs[0], prefix + 'fresh-1' + suffix);
    assert.equal(product.events.find(event => event.kind === 'macro').offset, prefix.length);
});
