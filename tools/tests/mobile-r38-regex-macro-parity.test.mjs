import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createRegexTemplateCache, fillRegexTemplate } from '../../sillytavern-runtime/public/scripts/homer-stable-template.mjs';
import { restoreCanonicalGreeting } from '../../sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';
import { createFrontendRuleBoundary } from '../../sillytavern-runtime/public/scripts/homer-html-fences.mjs';

const runtime = new URL('../../sillytavern-runtime/', import.meta.url);
const require = createRequire(new URL('package.json', runtime));
const acorn = require('acorn');
const [engine, macros, utils, eligibility] = await Promise.all([
    'scripts/extensions/regex/engine.js', 'scripts/macros.js', 'scripts/utils.js',
    'scripts/homer-macro-replay-eligibility.mjs',
].map(path => readFile(new URL(`public/${path}`, runtime), 'utf8')));

function declaration(source, name) {
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const node = ast.body.map(node => node.declaration || node).find(node => node.id?.name === name);
    assert.ok(node, `actual product declaration ${name}`);
    return source.slice(node.start, node.end);
}

function harness(rules) {
    const calls = [];
    // Only unrelated built-in factories are isolated. Name/angle substitution,
    // registered macro dispatch and sanitization run the actual legacy evaluator
    // and MacrosParser. This is not a full browser macro environment.
    const unrelatedMacro = () => ({ regex: /(?!)/, replace: () => assert.fail('unrelated macro executed') });
    const scope = {
        console: { warn() {}, debug() {} }, RegExp,
        name1: 'Reader', name2: 'Character', power_user: { experimental_macro_engine: false },
        extension_settings: { disabledExtensions: [] }, getRegexScripts: () => rules,
        officialDisplayRules: () => [], createFrontendRuleBoundary,
        substitute_find_regex: { NONE: 0, RAW: 1, ESCAPED: 2 },
        replacementTemplates: createRegexTemplateCache(), fillRegexTemplate,
        uuidv4: () => 'synthetic-macro-parity',
        getDiceRollMacro: unrelatedMacro, getInstructMacros: () => [], getVariableMacros: () => [],
        getTimeDiffMacro: unrelatedMacro, getBannedWordsMacro: unrelatedMacro,
        getRandomReplaceMacro: unrelatedMacro, getPickReplaceMacro: unrelatedMacro,
    };
    vm.createContext(scope);
    for (const name of ['escapeRegex', 'regexFromString']) vm.runInContext(declaration(utils, name), scope);
    vm.runInContext(declaration(macros, 'MacrosParser'), scope);
    vm.runInContext(declaration(macros, 'evaluateMacros'), scope);
    // This legacy-mode guard uses the real read-only MacrosParser.has lookup.
    // Experimental registry/processors/providers are covered by the helper suite.
    vm.runInContext(declaration(eligibility, 'assertDeterministicMacroReplayEligible'), scope);
    const registry = vm.runInContext('MacrosParser', scope);
    const evaluate = (text, options = {}) => scope.evaluateMacros(text, {
        user: scope.name1,
        char: options.name2Override ?? scope.name2,
        group: 'Fixture group',
    }, options.postProcessFn);
    scope.substituteParams = (text, options = {}) => {
        calls.push({ kind: 'replacement-or-trim', text, name2Override: options.name2Override });
        return evaluate(text, options);
    };
    scope.substituteParamsExtended = (text, _additionalMacros = {}, postProcessFn) => {
        calls.push({ kind: 'find', text });
        return evaluate(text, { postProcessFn });
    };
    for (const name of ['RegexProvider', 'sanitizeRegexMacro', 'getRegexedString', 'runRegexScript', 'filterString', 'replayRegexParams']) {
        vm.runInContext(declaration(engine, name), scope);
    }
    return {
        scope, calls, registry,
        render: (text, options = {}) => scope.getRegexedString(text, 2, { isMarkdown: true, depth: 0, ...options }),
    };
}

const rule = (changes = {}) => ({
    findRegex: 'START', replaceString: '<body>{{char}}:{{user}}</body>',
    placement: [2], markdownOnly: true, promptOnly: false, disabled: false,
    trimStrings: [], substituteRegex: 0, ...changes,
});

function assertParity(h, input, options, expected) {
    const live = h.render(input, options);
    assert.equal(live, expected, 'actual legacy evaluator output');
    assert.ok(h.calls.length > 0, 'default display path uses generic macro evaluation');
    h.calls.length = 0;
    assert.equal(h.render(input, { ...options, deterministicReplay: true }), live);
    assert.equal(h.calls.length, 0, 'pure identification never enters generic macro evaluation');
}

test('strict names, numbered/named captures and match trimming equal actual legacy output', () => {
    const h = harness([rule({ findRegex: '/(?<word>START)/',
        replaceString: '<body>{{CHAR}}|{{user}}|$0|$1|$<word>|{{match}}</body>', trimStrings: ['T'] })]);
    assertParity(h, 'START', {}, '<body>Character|Reader|SAR|SAR|SAR|SAR</body>');
    h.scope.name1 = 'Second reader';
    h.scope.name2 = 'Second character';
    assertParity(h, 'START', {}, '<body>Second character|Second reader|SAR|SAR|SAR|SAR</body>');
});

test('raw and escaped name searches keep global names despite a characterOverride', () => {
    for (const [substituteRegex, characterName] of [[1, 'PlainName'], [2, 'A+B(.*)']]) {
        const h = harness([rule({ findRegex: '/{{char}}/', substituteRegex,
            replaceString: '<body>{{char}}|{{user}}|$0</body>' })]);
        h.scope.name2 = characterName;
        assertParity(h, characterName, { characterOverride: 'Trim-only override' },
            `<body>${characterName}|Reader|${characterName}</body>`);
        assert.equal(h.render('not the character', { characterOverride: 'not the character', deterministicReplay: true }),
            'not the character', 'find substitution must not acquire the trim override');
    }
});

test('trim characterOverride uses nullish fallback and preserves an empty override', () => {
    for (const [options, captured] of [
        [{}, 'SpeakerSTART'],
        [{ characterOverride: null }, 'SpeakerSTART'],
        [{ characterOverride: 'Speaker' }, 'STARTCharacter'],
        [{ characterOverride: '' }, 'SpeakerSTARTCharacter'],
    ]) {
        const h = harness([rule({ findRegex: '/(SpeakerSTARTCharacter)/',
            replaceString: '<body>{{char}}:$1</body>', trimStrings: ['{{char}}'] })]);
        assertParity(h, 'SpeakerSTARTCharacter', options, `<body>Character:${captured}</body>`);
    }
});

test('legacy angle aliases retain live semantics but cannot authorize reverse recovery', () => {
    for (const [token, name] of [
        ['<USER>', 'Reader'], ['<BOT>', 'Character'], ['<CHAR>', 'Character'],
        ['<CHARIFNOTGROUP>', 'Fixture group'], ['<GROUP>', 'Fixture group'],
    ]) {
        const rules = [rule({ replaceString: `<body>${token}</body>` })];
        const h = harness(rules);
        assert.equal(h.render('START'), `<body>${name}</body>`, token);
        assert.ok(h.calls.length > 0);
        h.calls.length = 0;
        assert.throws(() => h.render('START', { deterministicReplay: true }), /Unsafe deterministic regex replay/);
        for (const mes of [`<body>${token}</body>`, `<body>${name}</body>`]) {
            const saved = { mes, is_user: false };
            assert.equal(restoreCanonicalGreeting({ data: { first_mes: 'START' } }, saved,
                raw => h.render(raw, { deterministicReplay: true }), rules, { guardedReplay: true }), saved);
        }
        assert.equal(h.calls.length, 0);
    }
});

test('spaced and unknown curly syntax stays live legacy text and fails closed in replay', () => {
    for (const token of ['{{ user }}', '{{ char }}', '{{ match }}', '{{fixtureMissing::value}}']) {
        const h = harness([rule({ replaceString: `<body>${token}</body>` })]);
        assert.equal(h.render('START'), `<body>${token}</body>`);
        assert.ok(h.calls.length > 0);
        h.calls.length = 0;
        assert.throws(() => h.render('START', { deterministicReplay: true }), /Unsafe deterministic regex replay/);
        assert.equal(h.calls.length, 0);
    }
});

test('registered generic macros still execute normally and never execute during pure replay', () => {
    const h = harness([rule({ replaceString: '<body>{{fixtureCounter}}</body>' })]);
    let effects = 0;
    h.registry.registerMacro('fixtureCounter', () => { effects++; return 'live registered value'; });
    assert.throws(() => h.render('START', { deterministicReplay: true }), /Unsafe deterministic regex replay/);
    assert.equal(effects, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.render('START'), '<body>live registered value</body>');
    assert.equal(effects, 1);
    assert.equal(h.calls.length, 1);
});

test('unsafe angle syntax in substituted find, trim and captures never enters macro evaluation', () => {
    for (const [changes, input, options, expected] of [
        [{ findRegex: '/<CHAR>/', substituteRegex: 1 }, 'Character', {}, '<body>Character:Reader</body>'],
        [{ findRegex: '/<CHAR>/', substituteRegex: 2 }, 'Character', {}, '<body>Character:Reader</body>'],
        [{ findRegex: '/(SpeakerSTART)/', replaceString: '<body>$1</body>', trimStrings: ['<CHAR>'] },
            'SpeakerSTART', { characterOverride: 'Speaker' }, '<body>START</body>'],
        [{ findRegex: '/(.+)/', replaceString: '<body>$1</body>' }, '<USER>', {}, '<body>Reader</body>'],
    ]) {
        const h = harness([rule(changes)]);
        assert.throws(() => h.render(input, { ...options, deterministicReplay: true }), /Unsafe deterministic regex replay/);
        assert.equal(h.calls.length, 0);
        assert.equal(h.render(input, options), expected);
        assert.ok(h.calls.length > 0);
    }
});

test('interpolated names containing macros remain live engine inputs but cannot identify a greeting', () => {
    for (const [name, expected] of [['<BOT>', '<BOT>'], ['{{fixtureCounter}}', 'registered name']]) {
        const h = harness([rule({ replaceString: '<body>{{user}}</body>' })]);
        h.scope.name1 = name;
        let effects = 0;
        h.registry.registerMacro('fixtureCounter', () => { effects++; return 'registered name'; });
        assert.throws(() => h.render('START', { deterministicReplay: true }), /Unsafe deterministic regex replay/);
        assert.equal(effects, 0);
        assert.equal(h.calls.length, 0);
        assert.equal(h.render('START'), `<body>${expected}</body>`);
        assert.equal(effects, name === '{{fixtureCounter}}' ? 1 : 0);
    }
});

test('registered name overrides reject only replayed name tokens without invoking their handlers', () => {
    const rules = [rule({ replaceString: '<body>static document</body>' })];
    const h = harness(rules);
    let effects = 0;
    for (const name of ['user', 'char']) {
        const handler = () => { effects++; return `registered ${name}`; };
        h.registry.registerMacro(name, handler);
        assert.equal(h.registry.has(name), true);
        assert.equal(h.registry.get(name), handler, 'registry lookup reads the callback without executing it');
    }
    assert.equal(effects, 0);
    assert.equal(h.render('START', { deterministicReplay: true }), '<body>static document</body>',
        'unrelated name registry overrides must not block a static replacement');
    assert.equal(h.calls.length, 0);
    for (const name of ['user', 'char']) {
        rules[0] = rule({ replaceString: `<body>{{${name}}}</body>` });
        effects = 0;
        h.calls.length = 0;
        assert.throws(() => h.render('START', { deterministicReplay: true }), /Unsafe deterministic regex replay/,
            `${name} is no longer a built-in environment-name lookup`);
        assert.equal(effects, 0, 'replay cannot execute a custom name handler to discover its result');
        assert.equal(h.calls.length, 0);
        assert.equal(h.render('START'), `<body>registered ${name}</body>`);
        assert.equal(effects, 1, 'ordinary display retains the actual registered override');
    }
});

test('retained match captures honor case-insensitive live legacy registrations but reject replay', () => {
    for (const key of ['match', 'MATCH', 'MaTcH']) {
        const h = harness([rule({ findRegex: '/(.+)/', replaceString: '<body>$1</body>' })]);
        let effects = 0;
        h.registry.registerMacro(key, () => { effects++; return 'custom match'; });
        assert.throws(() => h.render('{{match}}', { deterministicReplay: true }), /Unsafe deterministic regex replay/);
        assert.equal(effects, 0);
        assert.equal(h.calls.length, 0);
        assert.equal(h.render('{{match}}'), '<body>custom match</body>');
        assert.equal(effects, 1);
    }
});

test('names cannot assemble a post-env legacy macro that pure replay would mistake for edited text', () => {
    const h = harness([rule({ replaceString: '<body>{{char}}{{user}}</body>' })]);
    h.scope.name2 = '{';
    h.scope.name1 = '{reverse:drawer}}';
    assert.throws(() => h.render('START', { deterministicReplay: true }), /Unsafe deterministic regex replay/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.render('START'), '<body>reward</body>', 'legacy post-env macros run after both name substitutions');
});
