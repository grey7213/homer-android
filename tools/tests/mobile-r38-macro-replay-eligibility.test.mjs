import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const runtime = new URL('../../sillytavern-runtime/public/scripts/', import.meta.url);
const require = createRequire(new URL('../../sillytavern-runtime/package.json', import.meta.url));
const acorn = require('acorn');
const [engine, registry, environment, legacy, lexer, core, helper, envBuilder] = await Promise.all([
    'macros/engine/MacroEngine.js', 'macros/engine/MacroRegistry.js', 'macros/definitions/env-macros.js',
    'macros.js', 'macros/engine/MacroLexer.js', 'macros/definitions/core-macros.js',
    'homer-macro-replay-eligibility.mjs', 'macros/engine/MacroEnvBuilder.js',
].map(path => readFile(new URL(path, runtime), 'utf8')));

function declarations(source) {
    return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .map(node => node.declaration || node);
}
function declaration(source, name) {
    const node = declarations(source).find(node => node.id?.name === name
        || node.type === 'VariableDeclaration' && node.declarations.some(value => value.id?.name === name));
    assert.ok(node, `actual declaration ${name}`);
    return source.slice(node.start, node.end);
}
function harness(experimental = true) {
    const scope = {
        console: { warn() {} }, power_user: { experimental_macro_engine: experimental },
        name1: 'Reader', name2: 'Character', selected_group: false, groups: [], characters: [],
        getStringHash: () => 0, getGeneratingModel: () => 'synthetic-model',
        captures: { pre: [], post: [] },
        logMacroRegisterError: value => assert.fail(value.message), logMacroRegisterWarning() {},
        logMacroGeneralError: value => assert.fail(value.message), logMacroInternalError: value => assert.fail(value.message),
        logMacroRuntimeWarning() {}, logMacroSyntaxWarning: value => assert.fail(value.phase),
        // Only macro parsing is isolated for plaintext processor proofs; the
        // actual core/extension processor callbacks and registry run unchanged.
        MacroParser: { parseDocument: () => ({ cst: { children: {} }, lexingErrors: [], parserErrors: [] }) },
        MacroCstWalker: { evaluateDocument: ({ text }) => text },
    };
    vm.createContext(scope);
    vm.runInContext(declaration(lexer, 'MACRO_IDENTIFIER_PATTERN'), scope);
    vm.runInContext(declaration(core, 'ELSE_MARKER'), scope);
    for (const name of ['MacroCategory', 'MacroValueType', 'isIdentifierValid', 'detectMacroSource']) {
        vm.runInContext(declaration(registry, name), scope);
    }
    vm.runInContext(`globalThis.MacroRegistry = (() => {
        ${declaration(registry, 'MacroRegistry')}
        return new MacroRegistry();
    })()`, scope);
    vm.runInContext(`globalThis.MacroEngine = (() => {
        ${declaration(engine, 'MacroEngine')}
        class RecordingEngine extends MacroEngine {
            addPreProcessor(handler, options) {
                captures.pre.push({ handler, ...options });
                super.addPreProcessor(handler, options);
            }
            addPostProcessor(handler, options) {
                captures.post.push({ handler, ...options });
                super.addPostProcessor(handler, options);
            }
        }
        return new RecordingEngine();
    })()`, scope);
    vm.runInContext(`globalThis.MacrosParser = (() => {
        ${declaration(legacy, 'MacrosParser')}
        return MacrosParser;
    })()`, scope);
    vm.runInContext(declaration(envBuilder, 'env_provider_order'), scope);
    vm.runInContext(declaration(envBuilder, 'getGroupValue'), scope);
    vm.runInContext(`globalThis.MacroEnvBuilder = (() => {
        ${declaration(envBuilder, 'MacroEnvBuilder')}
        return new MacroEnvBuilder();
    })()`, scope);
    scope.macroSystem = { engine: scope.MacroEngine, registry: scope.MacroRegistry, envBuilder: scope.MacroEnvBuilder };
    for (const node of declarations(environment)) {
        if (node.type === 'VariableDeclaration' || node.type === 'FunctionDeclaration') {
            vm.runInContext(environment.slice(node.start, node.end), scope);
        }
    }
    vm.runInContext('registerEnvMacros()', scope);
    for (const node of declarations(helper)) {
        if (node.type === 'VariableDeclaration' || node.type === 'FunctionDeclaration') {
            vm.runInContext(helper.slice(node.start, node.end), scope);
        }
    }
    return {
        scope, registry: scope.MacroRegistry, engine: scope.MacroEngine, legacy: scope.MacrosParser,
        envBuilder: scope.MacroEnvBuilder,
        corePre: scope.captures.pre.slice(), corePost: scope.captures.post.slice(),
        marker: vm.runInContext('ELSE_MARKER', scope),
        guard: text => scope.assertDeterministicMacroReplayEligible(text),
    };
}

test('built-in name definitions and ordinary static text are eligible in both modes', () => {
    for (const experimental of [false, true]) {
        const h = harness(experimental);
        assert.doesNotThrow(() => h.guard('<body>static</body>'));
        assert.doesNotThrow(() => h.guard('<body>{{user}}:{{CHAR}}</body>'));
    }
});

test('experimental name overrides are inspected without calling handlers and unrelated overrides stay eligible', () => {
    for (const name of ['user', 'char']) {
        const h = harness();
        let calls = 0;
        h.registry.registerMacro(name, { category: 'names', handler: () => { calls++; return 'custom'; } });
        assert.doesNotThrow(() => h.guard('<body>static</body>'));
        assert.doesNotThrow(() => h.guard(`{{${name === 'user' ? 'char' : 'user'}}}`));
        assert.throws(() => h.guard(`{{${name}}}`), /Unsafe deterministic regex replay/);
        assert.equal(calls, 0);
    }
});

test('mutable built-in definitions with changed invocation shape cannot pass identity checking', () => {
    for (const mutate of [
        definition => { definition.minArgs = 1; },
        definition => { definition.maxArgs = 1; },
        definition => { definition.list = { min: 1, max: 1 }; },
        definition => { definition.unnamedArgDefs = [{ name: 'unexpected' }]; },
        definition => { definition.delayArgResolution = true; },
        definition => { definition.strictArgs = false; },
        definition => { definition.aliasOf = 'char'; },
    ]) {
        const h = harness();
        mutate(h.registry.getMacro('user'));
        assert.throws(() => h.guard('{{user}}'), /Unsafe deterministic regex replay/);
    }
    const h = harness();
    h.registry.unregisterMacro('char');
    assert.throws(() => h.guard('{{char}}'), /Unsafe deterministic regex replay/);
});

test('legacy registered names reject only their own tokens without executing the callback', () => {
    for (const name of ['user', 'char']) {
        const h = harness(false);
        let calls = 0;
        h.legacy.registerMacro(name, () => { calls++; return 'custom'; });
        assert.doesNotThrow(() => h.guard('<body>static</body>'));
        assert.doesNotThrow(() => h.guard(`{{${name === 'user' ? 'char' : 'user'}}}`));
        assert.throws(() => h.guard(`{{${name}}}`), /Unsafe deterministic regex replay/);
        assert.equal(calls, 0);
    }
});

test('extra experimental processors reject replay without execution and normal evaluation retains them', () => {
    for (const type of ['Pre', 'Post']) {
        const h = harness();
        let calls = 0;
        const handler = text => { calls++; return `${text}-processed`; };
        h.engine[`add${type}Processor`](handler, { priority: 100, source: 'core:unescape-braces' });
        assert.throws(() => h.guard('static'), /Unsafe deterministic regex replay/);
        assert.equal(calls, 0);
        assert.equal(h.engine.evaluate('static', {}), 'static-processed');
        assert.equal(calls, 1);
        h.engine[`remove${type}Processor`](handler);
        assert.doesNotThrow(() => h.guard('static'));
    }
});

test('same-count processors with forged metadata or changed priority cannot replace core identities', () => {
    for (const type of ['Pre', 'Post']) {
        const h = harness();
        const original = (type === 'Pre' ? h.corePre : h.corePost)[0];
        h.engine[`remove${type}Processor`](original.handler);
        h.engine[`add${type}Processor`](text => text, { priority: original.priority, source: original.source });
        assert.throws(() => h.guard('static'), /Unsafe deterministic regex replay/);
        const changedOrder = harness();
        const coreEntry = (type === 'Pre' ? changedOrder.corePre : changedOrder.corePost)[0];
        changedOrder.engine[`remove${type}Processor`](coreEntry.handler);
        changedOrder.engine[`add${type}Processor`](coreEntry.handler, { priority: 999, source: coreEntry.source });
        assert.throws(() => changedOrder.guard('static'), /Unsafe deterministic regex replay/);
    }
});

test('core unescape and ELSE cleanup inputs are rejected only in the experimental mode', () => {
    const h = harness();
    for (const [input, output] of [['a\\{b\\}', 'a{b}'], [`a${h.marker}b`, 'ab']]) {
        assert.equal(h.engine.evaluate(input, {}), output, 'actual core processor changes the text');
        assert.throws(() => h.guard(input), /Unsafe deterministic regex replay/);
        assert.doesNotThrow(() => harness(false).guard(input), 'legacy has no corresponding core processors');
    }
});

test('post-interpolation checks reject newly assembled escaped braces and ELSE markers', () => {
    const h = harness();
    assert.doesNotThrow(() => h.guard('{{user}}{'));
    assert.doesNotThrow(() => h.guard('\\'));
    assert.throws(() => h.guard('\\{'), /Unsafe deterministic regex replay/);
    const half = Math.floor(h.marker.length / 2);
    assert.doesNotThrow(() => h.guard(h.marker.slice(0, half)));
    assert.doesNotThrow(() => h.guard(h.marker.slice(half)));
    assert.throws(() => h.guard(h.marker), /Unsafe deterministic regex replay/);
});

test('experimental core trim cannot consume a macro assembled from separate safe names', () => {
    const h = harness();
    assert.doesNotThrow(() => h.guard('<body>{{char}}{{user}}</body>'));
    for (const name of ['{', '{trim}}']) assert.doesNotThrow(() => h.guard(name));
    const assembled = '<body>{{trim}}</body>';
    assert.equal(h.engine.evaluate(assembled, {}), '<body></body>', 'actual core postprocessor removes the assembled token');
    assert.throws(() => h.guard(assembled), /Unsafe deterministic regex replay/);
});

test('experimental environment providers reject replay without calls and retain normal environment behavior', () => {
    const h = harness();
    let calls = 0;
    h.envBuilder.registerProvider(env => {
        calls++;
        env.names.user = 'provider name';
        env.dynamicMacros.user = 'provider dynamic value';
        env.functions.postProcess = text => `${text}-provider`;
    });
    for (const text of ['static', '{{user}}', '{{char}}']) {
        assert.throws(() => h.guard(text), /Unsafe deterministic regex replay/);
    }
    assert.equal(calls, 0, 'eligibility must not evaluate an environment provider');
    assert.equal(h.envBuilder.hasProviders(), true);
    assert.equal(calls, 0, 'read-only provider inventory must not evaluate it either');
    const env = h.envBuilder.buildFromRawEnv({ content: 'static' });
    assert.equal(calls, 1, 'normal environment building still invokes the provider');
    assert.equal(env.names.user, 'provider name');
    assert.equal(env.dynamicMacros.user, 'provider dynamic value');
    assert.equal(env.functions.postProcess('static'), 'static-provider');

    const legacyMode = harness(false);
    legacyMode.envBuilder.registerProvider(() => assert.fail('legacy does not use experimental providers'));
    assert.doesNotThrow(() => legacyMode.guard('static {{user}}'));
});

test('registered match macros reject only retained match tokens without evaluating handlers', () => {
    for (const experimental of [false, true]) {
        for (const key of ['match', 'MATCH', 'MaTcH']) {
            const h = harness(experimental);
            assert.doesNotThrow(() => h.guard('unregistered {{match}} placeholder'));
            let calls = 0;
            const handler = () => { calls++; return 'custom match'; };
            if (experimental) h.registry.registerMacro(key, { handler });
            else h.legacy.registerMacro(key, handler);
            assert.doesNotThrow(() => h.guard('static document'));
            assert.doesNotThrow(() => h.guard('{{user}}'));
            assert.throws(() => h.guard('retained {{MaTcH}} token'), /Unsafe deterministic regex replay/);
            assert.equal(calls, 0);
        }
    }
});
