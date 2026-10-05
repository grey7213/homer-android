import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createRegexTemplateCache, fillRegexTemplate } from '../../sillytavern-runtime/public/scripts/homer-stable-template.mjs';
import { restoreCanonicalGreeting } from '../../sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';
import { createFrontendRuleBoundary } from '../../sillytavern-runtime/public/scripts/homer-html-fences.mjs';

const runtime = new URL('../../sillytavern-runtime/', import.meta.url);
const req = createRequire(new URL('package.json', runtime));
const acorn = req('acorn');
const engine = await readFile(new URL('public/scripts/extensions/regex/engine.js', runtime), 'utf8');
const utils = await readFile(new URL('public/scripts/utils.js', runtime), 'utf8');
const bridge = await readFile(new URL('public/scripts/extensions/homer-bridge/index.js', runtime), 'utf8');
function declaration(source, name) {
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const node = ast.body.map(node => node.declaration || node).find(node => node.id?.name === name);
    assert.ok(node, name);
    return source.slice(node.start, node.end);
}
function harness(rules) {
    const calls = [];
    const scope = {
        console: { warn() {}, debug() {} }, RegExp,
        name1: 'Reader', name2: 'Character',
        // Registry/provider/processor parity is covered with the real eligibility
        // helper in the separate eligibility and macro-parity tests.
        assertDeterministicMacroReplayEligible() {},
        extension_settings: { disabledExtensions: [] }, getRegexScripts: () => rules,
        officialDisplayRules: () => [], createFrontendRuleBoundary,
        substitute_find_regex: { NONE: 0, RAW: 1, ESCAPED: 2 },
        replacementTemplates: createRegexTemplateCache(), fillRegexTemplate,
        substituteParams: value => { calls.push(['replacement', value]); return value; },
        substituteParamsExtended: value => { calls.push(['find', value]); return value; },
        restoreCanonicalGreeting, launch: { card: { data: { first_mes: 'START' } } },
        regex_placement: { AI_OUTPUT: 2 },
    };
    vm.createContext(scope);
    vm.runInContext(declaration(utils, 'regexFromString'), scope);
    for (const name of ['RegexProvider', 'sanitizeRegexMacro', 'getRegexedString', 'runRegexScript', 'filterString']) {
        vm.runInContext(declaration(engine, name), scope);
    }
    // Before the product change, the actual functions ignore deterministicReplay.
    // Load the new pure seam only when present, so the old code reaches real RED assertions.
    if (engine.includes('function replayRegexParams(')) vm.runInContext(declaration(engine, 'replayRegexParams'), scope);
    vm.runInContext(declaration(bridge, 'normalizeOpeningMessage'), scope);
    return { scope, calls, render: (text, options = {}) => scope.getRegexedString(text, 2,
        { isMarkdown: true, depth: 0, deterministicReplay: true, ...options }) };
}
const rule = (changes = {}) => ({ findRegex: 'START', replaceString: '```html\n<html><body>START</body></html>\n```',
    placement: [2], markdownOnly: true, promptOnly: false, disabled: false,
    trimStrings: [], substituteRegex: 0, ...changes });
const legacy = rule().replaceString;

test('actual bridge recovers legacy source despite an unmatched dynamic replacement', () => {
    const h = harness([rule(), rule({ findRegex: 'NOT_PRESENT', replaceString: '{{setvar::x::1}}' })]);
    const saved = { mes: legacy, is_user: false, extra: { identity: 'fixture' } };
    const restored = h.scope.normalizeOpeningMessage(saved);
    assert.equal(restored.mes, 'START');
    assert.equal(restored.extra, saved.extra);
    assert.equal(saved.mes, legacy);
    assert.deepEqual(h.calls, [], 'identification never enters macro processors or eager card-field macros');
});
test('pure replay preserves captures, trim, escaped names, and skips generic macro engines', () => {
    const h = harness([rule({ findRegex: '/(START)/', replaceString: '<body>{{char}}:{{user}}:$1:{{match}}</body>', trimStrings: ['T'] })]);
    assert.equal(h.render('START'), '<body>Character:Reader:SAR:SAR</body>');
    assert.deepEqual(h.calls, []);
    const names = harness([rule({ findRegex: '/{{char}}/', substituteRegex: 2, replaceString: '<body>{{user}}</body>' })]);
    names.scope.name2 = 'A+B';
    assert.equal(names.render('A+B'), '<body>Reader</body>');
    assert.deepEqual(names.calls, []);
});
test('normal display path retains ordinary macro processing and names are not cached', () => {
    const h = harness([rule({ replaceString: '<body>{{user}}</body>' })]);
    assert.equal(h.render('START'), '<body>Reader</body>');
    h.scope.name1 = 'Other reader';
    assert.equal(h.render('START'), '<body>Other reader</body>');
    h.render('START', { deterministicReplay: false });
    assert.equal(h.calls.length, 1);
});
test('matched unsafe replacement, trim, capture and interpolated name fail closed before macro execution', () => {
    for (const changes of [
        { replaceString: '<body>{{setvar::x::1}}</body>' },
        { replaceString: '<body>$0</body>', trimStrings: ['{{getvar::x}}'] },
        { findRegex: '/(.+)/', replaceString: '<body>$1</body>' },
        { replaceString: '<body>{{user}}</body>' },
    ]) {
        const h = harness([rule(changes)]);
        const input = changes.findRegex ? '{{incvar::x}}' : 'START';
        if (changes.replaceString === '<body>{{user}}</body>') h.scope.name1 = '{{setvar::x::1}}';
        assert.throws(() => h.render(input), /Unsafe deterministic regex replay/);
        assert.deepEqual(h.calls, []);
    }
});
test('dynamic substituted find is rejected before generic macro evaluation even when unmatched', () => {
    for (const substituteRegex of [1, 2]) {
        const h = harness([rule({ findRegex: '/{{getvar::x}}/', substituteRegex })]);
        assert.throws(() => h.render('START'), /Unsafe deterministic regex replay/);
        assert.deepEqual(h.calls, []);
    }
});
test('wrong placement, depth, prompt, disabled and unmatched trim rules do not block safe replay', () => {
    for (const changes of [
        { placement: [1] }, { minDepth: 1 }, { maxDepth: 0, minDepth: 1 },
        { markdownOnly: false, promptOnly: true }, { disabled: true },
        { findRegex: 'NOT_PRESENT', trimStrings: ['{{setvar::x::1}}'] },
    ]) {
        const h = harness([rule(), rule({ replaceString: '{{random::a::b}}', ...changes })]);
        assert.equal(h.scope.normalizeOpeningMessage({ mes: legacy, is_user: false }).mes, 'START');
        assert.deepEqual(h.calls, []);
    }
});
test('CRLF-only legacy differences recover exact source and invalidate only matching display fields', () => {
    const h = harness([rule()]);
    const crlf = legacy.replaceAll('\n', '\r\n');
    const saved = { mes: crlf, swipes: [crlf], is_user: false, extra: { display_text: crlf, identity: 'fixture' },
        swipe_info: [{ extra: { display_text: crlf, author_state: 'kept' } }] };
    const result = h.scope.normalizeOpeningMessage(saved);
    assert.equal(result.mes, 'START');
    assert.deepEqual([...result.swipes], ['START']);
    assert.equal('display_text' in result.extra, false);
    assert.equal(result.extra.identity, 'fixture');
    assert.equal('display_text' in result.swipe_info[0].extra, false);
    assert.equal(result.swipe_info[0].extra.author_state, 'kept');
    assert.equal(saved.mes, crlf);
});
test('newline equivalence never collapses ambiguous originals or user edits', () => {
    const saved = { mes: legacy, is_user: false };
    const card = { data: { first_mes: 'A', alternate_greetings: ['B'] } };
    assert.equal(restoreCanonicalGreeting(card, saved, raw => raw === 'A' ? legacy : legacy.replaceAll('\n', '\r\n'), []), saved);
    const h = harness([rule()]);
    for (const mes of [legacy.replace('</body>', '<!--edited--></body>'), legacy + '\nnew note', '```js\nlet a=1;\n```']) {
        const row = { mes, is_user: false };
        assert.equal(h.scope.normalizeOpeningMessage(row), row);
    }
});
test('authored HTML identity takes precedence over another opening output including transport newlines', () => {
    for (const authored of [legacy, legacy.replaceAll('\n', '\r\n')]) {
        const card = { data: { first_mes: authored, alternate_greetings: ['TRIGGER'] } };
        const saved = { mes: authored, swipes: [authored], is_user: false,
            extra: { display_text: authored }, swipe_info: [{ extra: { display_text: authored } }] };
        const render = raw => raw === 'TRIGGER' ? (authored.includes('\r\n') ? legacy : legacy.replaceAll('\n', '\r\n')) : raw;
        assert.equal(restoreCanonicalGreeting(card, saved, render, []), saved);
    }
});
test('unsupported legacy-angle and engine-dependent spaced macros cannot identify a document', () => {
    for (const token of ['<USER>', '<BOT>', '<CHAR>', '<CHARIFNOTGROUP>', '<GROUP>', '{{ user }}', '{{ char }}']) {
        const h = harness([rule({ replaceString: `<body>${token}</body>` })]);
        assert.throws(() => h.render('START'), /Unsafe deterministic regex replay/);
        const saved = { mes: `<body>${token}</body>`, is_user: false };
        assert.equal(h.scope.normalizeOpeningMessage(saved), saved);
        assert.deepEqual(h.calls, []);
    }
    const h = harness([rule({ replaceString: '<body>{{user}}</body>' })]);
    h.scope.name1 = '<BOT>';
    assert.throws(() => h.render('START'), /Unsafe deterministic regex replay/);
    assert.deepEqual(h.calls, []);
});
