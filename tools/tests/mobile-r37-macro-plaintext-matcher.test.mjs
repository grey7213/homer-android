import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// The shipping lexer versus its original regexp, not a reimplemented candidate
// or a text/result cache. Both lexers compile the actual MacroLexer class with
// the same TokenType identities, modes, configuration and actual Chevrotain.
// Only the compiled Plaintext matcher differs.
// Contract: consume the maximal nonempty prefix before '{{' at the supplied
// UTF-16 offset; return null at an opener/EOF. Chevrotain still owns locations,
// CRLF accounting, errors, recovery and mode transitions. The following actual
// Plaintext.OpenBrace token continues to own triple-brace behavior.
const runtimeRoot = new URL('../../.web-cache/tree/sillytavern-runtime/', import.meta.url);
const lexerUrl = new URL('public/scripts/macros/engine/MacroLexer.js', runtimeRoot);
const parserUrl = new URL('public/scripts/macros/engine/MacroParser.js', runtimeRoot);
const lexerSource = fs.readFileSync(lexerUrl, 'utf8');
const parserSource = fs.readFileSync(parserUrl, 'utf8');
const chevrotain = await import(new URL('node_modules/chevrotain/lib/src/api.js', runtimeRoot));
const primaryLexerUrl = new URL('node_modules/chevrotain/lib/src/scan/lexer.js', runtimeRoot);
const primaryLexerSource = fs.readFileSync(primaryLexerUrl, 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const sources = {
    lexer_sha256: hash(lexerSource), parser_sha256: hash(parserSource),
    chevrotain: chevrotain.VERSION, chevrotain_lexer_sha256: hash(primaryLexerSource),
};
function executable(source) {
    return source.replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*\};\r?\n/gm, '').replace(/^export /gm, '');
}
const lexerContext = vm.createContext({ chevrotain });
vm.runInContext(executable(lexerSource) + '\nglobalThis.candidateLexer = instance;', lexerContext, { filename: lexerUrl.pathname });
vm.runInContext(`
globalThis.matcher = Tokens.Plaintext.PATTERN;
globalThis.originalPlaintextPattern = /(?:[^{]|\\{(?!\\{))+/u;
Tokens.Plaintext.PATTERN = originalPlaintextPattern;
globalThis.oldLexer = new MacroLexer();
Tokens.Plaintext.PATTERN = matcher;`, lexerContext);

function actualParser(lexer) {
    const context = vm.createContext({ chevrotain, MacroLexer: lexer });
    vm.runInContext(executable(parserSource) + '\nglobalThis.parser = instance;', context, { filename: parserUrl.pathname });
    return context.parser;
}
const oldLexer = lexerContext.oldLexer;
const candidateLexer = lexerContext.candidateLexer;
const candidateParser = actualParser(candidateLexer);
// Both instances retain their separately compiled patterns; shared token
// metadata remains the shipping function throughout parser comparisons.
const oldParser = actualParser(oldLexer);
const tokenTypes = new Set(Object.values(oldLexer.def.modes).flat());

function normalize(value) {
    if (value === null || typeof value !== 'object' || tokenTypes.has(value)) return value;
    if (Array.isArray(value)) return Array.from(value, normalize);
    const result = {};
    if (typeof value.message === 'string') {
        result.name = value.name;
        result.message = value.message;
    }
    for (const key of Object.keys(value)) {
        if (key !== 'stack') result[key] = normalize(value[key]);
    }
    return result;
}
function parserState(parser) {
    return normalize({
        currIdx: parser.currIdx, ruleIndex: parser.RULE_STACK_IDX,
        occurrenceIndex: parser.RULE_OCCURRENCE_STACK_IDX,
        activeRules: parser.RULE_STACK.slice(0, parser.RULE_STACK_IDX + 1),
        activeOccurrences: parser.RULE_OCCURRENCE_STACK.slice(0, parser.RULE_OCCURRENCE_STACK_IDX + 1),
        cstStack: parser.CST_STACK, backtracking: parser.isBackTrackingStack,
        errors: parser.errors, input: parser.input,
    });
}
function equivalent(input, label) {
    const oldResult = oldLexer.tokenize(input);
    const candidateResult = candidateLexer.tokenize(input);
    // Direct equality retains exact shared TokenType object references and indexes,
    // every token image/location property, error message/location and group.
    assert.deepEqual(candidateResult, oldResult, `${label}: actual lexer`);
    assert.deepEqual(normalize(candidateParser.parseDocument(input)), normalize(oldParser.parseDocument(input)), `${label}: actual parser`);
    assert.deepEqual(parserState(candidateParser), parserState(oldParser), `${label}: parser reuse state`);
    return oldResult;
}

test('shipping product changes only actual compiled Plaintext matcher, with unchanged token identities/config/modes', t => {
    t.diagnostic(JSON.stringify(sources));
    assert.equal(chevrotain.VERSION, '11.2.0');
    assert.equal(oldLexer.tokens, candidateLexer.tokens);
    assert.equal(oldLexer.def, candidateLexer.def);
    assert.deepEqual(candidateLexer.config, oldLexer.config);
    for (const [mode, oldPatterns] of Object.entries(oldLexer.patternIdxToConfig)) {
        const nextPatterns = candidateLexer.patternIdxToConfig[mode];
        assert.equal(nextPatterns.length, oldPatterns.length);
        for (let index = 0; index < oldPatterns.length; index++) {
            const oldPattern = oldPatterns[index], nextPattern = nextPatterns[index];
            assert.equal(oldPattern.tokenType, nextPattern.tokenType);
            if (oldPattern.tokenType.name === 'Plaintext') {
                assert.equal(oldPattern.isCustom, false);
                assert.equal(nextPattern.isCustom, true);
                assert.equal(nextPattern.canLineTerminator, true);
            } else {
                assert.deepEqual(normalize(nextPattern), normalize(oldPattern));
            }
        }
    }
    assert.equal(oldLexer.hasCustom, true); // Existing ModePopper is already custom.
    assert.equal(candidateLexer.hasCustom, true);
    assert.deepEqual(candidateLexer.canModeBeOptimized, oldLexer.canModeBeOptimized);
    assert.equal(oldLexer.canModeBeOptimized[oldLexer.def.defaultMode], false);
});

test('custom matcher has exact maximal nonempty boundary at every UTF-16 offset, including lone surrogates', () => {
    const sticky = new RegExp(lexerContext.originalPlaintextPattern.source, 'y');
    const cases = ['', '{', '}', '{{', '{{{', '{{{{', 'a{b{{user}}z', '😀{中\r\n{{user}}\ud800x\udc00', 'x\u2028\u2029{z'];
    for (const input of cases) {
        for (let offset = 0; offset <= input.length; offset++) {
            sticky.lastIndex = offset;
            const oldMatch = sticky.exec(input);
            const nextMatch = lexerContext.matcher(input, offset);
            assert.equal(nextMatch?.[0] ?? null, oldMatch?.[0] ?? null, 'offset boundary');
            if (nextMatch) assert.ok(nextMatch[0].length > 0, 'never consume an empty match');
        }
    }
});

test('actual triple/quadruple opener precedence remains literal braces then macro, not a shifted opener', () => {
    for (let count = 2; count <= 8; count++) {
        const result = equivalent('{'.repeat(count) + 'user}} tail', `opener ${count}`);
        assert.deepEqual(result.tokens.map(token => [token.tokenType.name, token.image]), [
            ...Array.from({ length: count - 2 }, () => ['Plaintext.OpenBrace', '{']),
            ['Macro.Start', '{{'], ['Macro.Identifier', 'user'], ['Macro.End', '}}'], ['Plaintext', ' tail'],
        ]);
    }
});

test('full UTF-16 offsets and CR/LF/CRLF line/column locations preserve current U+2028/U+2029 behavior', () => {
    const input = '😀\r\n中{one\rtwo\n\u2028\u2029{{user}}\r\nend\ud800';
    const result = equivalent(input, 'unicode locations');
    const opener = result.tokens.find(token => token.tokenType.name === 'Macro.Start');
    assert.equal(opener.startOffset, input.indexOf('{{'));
    assert.equal(opener.startLine, 4);
    assert.equal(opener.startColumn, 3); // U+2028/U+2029 are not default Chevrotain line terminators.
    const tail = result.tokens.at(-1);
    assert.equal(tail.endOffset, input.length - 1);
    assert.equal(tail.endLine, 5);
    assert.equal(tail.endColumn, 4);
});

test('actual upstream static lexer fixtures preserve token/error/CST contracts without browser or fixture content export', t => {
    const source = fs.readFileSync(new URL('tests/frontend/MacroLexer.e2e.js', runtimeRoot), 'utf8');
    const literals = [...source.matchAll(/const input = ('(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*");/g)];
    assert.ok(literals.length >= 20, 'actual static upstream corpus is loaded');
    t.diagnostic(`actual upstream static literal fixtures: ${literals.length}`);
    literals.forEach((match, index) => equivalent(vm.runInNewContext(match[1]), `upstream fixture ${index}`));
});

test('nested/filter/variable/unfinished/error-recovery modes preserve actual errors and subsequent clean parser state', () => {
    const cases = [
        '', '{{user}}', '{{!?#/macro::x::{{user}}|upper}}', '{{// comment {{user}} }}',
        '{{.name++}} {{$counter??= {{user}}}}', '{{.my-var-=x}} {{$g||=fallback}}',
        '{{macro:a="x" b=2|trim::arg}}', '{{macro | Iam$peci@l}}', '{{macro || output}}',
        '{{macro | 2invalid}}', '{{|macro}}', '{{{', '{{unfinished::{{nested}}',
        '{{.}} plain {{user}}', '{{macro a\\|b}}', 'before{\ud800{{macro | !bad}}\r\nafter',
    ];
    let lexErrors = 0, parseErrors = 0;
    cases.forEach((input, index) => {
        const result = equivalent(input, `mode fixture ${index}`);
        lexErrors += result.errors.length;
        parseErrors += oldParser.errors.length;
        equivalent('reset\r\n{{user}} done', `reset after ${index}`);
        assert.equal(oldParser.errors.length, 0);
        assert.equal(candidateParser.errors.length, 0);
    });
    assert.ok(lexErrors > 0, 'real Chevrotain error recovery exercised');
    assert.ok(parseErrors > 0, 'real parser recovery exercised');
});

test('exhaustive short brace/plain combinations preserve actual token locations/errors/CST and state', () => {
    let count = 0;
    function visit(prefix, remaining) {
        equivalent(prefix, `short exhaustive ${count++}`);
        if (remaining > 0) for (const next of ['{', '}', 'x']) visit(prefix + next, remaining - 1);
    }
    visit('', 5);
    assert.equal(count, 364);
});

test('bounded deterministic Unicode/macro/error fuzz compares actual lexer and parser, not a second parser model', () => {
    let seed = 0x37c0ffee;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const fragments = ['{', '}', '{{', '}}', '{{{', 'x', ' ', '\r', '\n', '\r\n', '\u2028', '\u2029', '😀', '中', '\ud800', '\udc00', '\0', '\t', '|', '::', '\\|', '.', '$', '?', '='];
    const macros = ['{{user}}', '{{pick::one::two}}', '{{.x++}}', '{{$g??=fallback}}', '{{macro | !bad}}', '{{macro | Iam$peci@l}}', '{{unfinished::', '{{macro::{{user}}::x|trim}}'];
    for (let index = 0; index < 2500; index++) {
        let input = '';
        const length = random() % 40;
        for (let part = 0; part < length; part++) input += fragments[random() % fragments.length];
        if (index % 3 === 0) input += macros[random() % macros.length];
        equivalent(input, `seeded synthetic ${index}`);
    }
});

test('3.3MB synthetic tokenize-only comparison is opt-in desktop Node evidence, never a device speed assertion', { skip: process.env.HOMER_MACRO_MATCHER_BENCHMARK !== '1' }, t => {
    const size = 3_300_000;
    const unit = '<p data-synthetic="1">alpha { beta } gamma</p>\r\n';
    const plain = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const input = plain.slice(0, size / 2) + '{{user}}' + plain.slice(size / 2 + 8);
    assert.equal(input.length, size);
    assert.equal(Buffer.byteLength(input, 'utf8'), size);
    equivalent(input, '3.3MB synthetic equivalence');
    // One untimed warm-up per implementation. Alternate order across seven pairs;
    // compare the same generated input, excluding assertions and parser work.
    oldLexer.tokenize(input);
    candidateLexer.tokenize(input);
    const oldMs = [], candidateMs = [];
    const timed = (lexer, samples) => {
        const start = performance.now();
        const result = lexer.tokenize(input);
        samples.push(performance.now() - start);
        assert.equal(result.errors.length, 0);
        assert.equal(result.tokens.length, 5);
    };
    for (let index = 0; index < 7; index++) {
        if (index % 2 === 0) { timed(oldLexer, oldMs); timed(candidateLexer, candidateMs); }
        else { timed(candidateLexer, candidateMs); timed(oldLexer, oldMs); }
    }
    const median = samples => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];
    t.diagnostic(JSON.stringify({
        evidence: 'synthetic desktop Node tokenize-only; not native/WebView/chat latency',
        input_kind: 'generated ASCII HTML-like plaintext with one macro, CRLF and isolated braces',
        utf8_bytes: size, code_units: input.length, input_sha256: hash(input),
        node: process.version, platform: process.platform, arch: process.arch, ...sources,
        rounds: 7, old_ms: oldMs, candidate_ms: candidateMs,
        old_median_ms: median(oldMs), candidate_median_ms: median(candidateMs),
        no_speed_assertion: true,
    }));
});
