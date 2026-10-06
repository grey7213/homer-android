import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { BASELINE_MAPPING_SHA256, invertIdentityScanMappings } from '../repair_prompt_template_identity_sourcemap.mjs';
import { extractShippingHelpers, nodesOf } from './helpers/ejs-shipping-helpers.mjs';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const { TraceMap, originalPositionFor } = require(resolve(root, 'sillytavern-runtime/node_modules/@jridgewell/trace-mapping'));
const extension = resolve(root, 'sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template');
const bundle = readFileSync(resolve(extension, 'dist/index.js'), 'utf8');
const source = readFileSync(resolve(extension, 'src/utils/prompts.ts'), 'utf8');
const map = JSON.parse(readFileSync(resolve(extension, 'dist/index.js.map'), 'utf8'));
const trace = new TraceMap(map);
const sourceIndex = map.sources.findIndex(name => name.endsWith('/src/utils/prompts.ts'));
const lines = source.replaceAll('\r\n', '\n').split('\n');
const { positions } = extractShippingHelpers(bundle);
const proof = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/ejs-identity-map336-proof.json')));
const historicalMap = { version: 3, sources: proof.sources, names: [], mappings: gunzipSync(Buffer.from(proof.mappingsGzipBase64, 'base64')).toString() };
const historicalTrace = new TraceMap(historicalMap);

// Preserve all three 336 surgical-map assertions against its exact historical
// mappings. A new compiler must instead map the CURRENT code accurately.
test('336 historical proof maps every inserted guard token', () => {
    assert.equal(proof.revision, 336);
    for (const [column, index, line, sourceColumn] of proof.plan.added) {
        const actual = originalPositionFor(historicalTrace, { line: 1, column });
        assert.equal(actual.source, historicalTrace.resolvedSources[index]);
        assert.equal(actual.line, line + 1);
        assert.equal(actual.column, sourceColumn);
    }
});
test('336 historical mappings after each insertion retain correct original source positions', () => {
    for (const { column, line, sourceColumn } of proof.afterPositions) {
        const actual = originalPositionFor(historicalTrace, { line: 1, column });
        assert.equal(actual.source, historicalTrace.resolvedSources[proof.plan.sourceIndex]);
        assert.equal(actual.line, line);
        assert.equal(actual.column, sourceColumn);
    }
});
test('336 inverse mapping offsets still recover every pre-edit segment, including non-target modules', () => {
    const original = invertIdentityScanMappings(historicalMap, proof.plan);
    assert.equal(createHash('sha256').update(original).digest('hex'), BASELINE_MAPPING_SHA256);
});

function check(node, sourceLine, token) {
    assert.ok(node, `Actual generated token missing: ${token}`);
    const line = lines.findIndex(text => text.includes(sourceLine));
    assert.ok(line >= 0, `Original source line missing: ${sourceLine}`);
    const actual = originalPositionFor(trace, { line: 1, column: node.start });
    assert.equal(actual.source, trace.resolvedSources[sourceIndex]);
    assert.equal(actual.line, line + 1);
    assert.equal(actual.column, lines[line].indexOf(token));
}
const all = (node, predicate) => nodesOf(node, predicate);
const property = (node, name) => node.type === 'MemberExpression' && node.property.name === name;

test('actual current shipping map embeds exact TS and traces both guards and literal token scanners', () => {
    assert.equal(map.sourcesContent[sourceIndex].replaceAll('\r\n', '\n'), source.replaceAll('\r\n', '\n'));
    check(all(positions.unescape, node => property(node, 'includes'))[0].object, "if (!html.includes('&lt;%'))", 'html');
    check(all(positions.wrap, node => property(node, 'some'))[0].object, 'if (!openTags.some', 'openTags');
    check(all(positions.unescape, node => node.type === 'Literal' && node.regex?.pattern === '&lt;%|%&gt;')[0], 'const tokens = /&lt;%|%&gt;/g;', '/&lt;%');
    check(all(positions.wrap, node => node.type === 'NewExpression' && node.callee.name === 'RegExp')[0], 'const tokens = new RegExp', 'new RegExp');
    check(all(positions.split, node => property(node, 'slice'))[0].object, 'buffer += input.slice(i, next);', 'input');
    check(all(positions.wrap, node => property(node, 'exec'))[0].object, 'const next = tokens.exec(content);', 'tokens');
});
test('actual current map retains source positions after jumps, matcher call and tail join', () => {
    check(positions.split, 'function splitNested(', 'function');
    const matcherCall = all(positions.split, node => node.type === 'CallExpression' && node.callee.type === 'Identifier'
        && node.arguments.length === 2 && node.start > all(positions.split, n => property(n, 'slice'))[0].end).at(-1);
    check(matcherCall?.callee, 'const match = matchToken(input, i);', 'matchToken');
    check(all(positions.unescape, node => property(node, 'join'))[0].property, "}).join('');", 'join');
    assert.ok(map.sourcesContent[sourceIndex].includes('token statistics unavailable; previous counters retained.'), 'Prior token failure handling retained');
});
