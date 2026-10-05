// Deterministic source-map companion to the two R41 identity-scan insertions.
// No product code is generated or changed here. All existing mapping segments
// retain their source/name/column, apart from the two inserted source lines and
// generated columns. The inverse digest checks every old segment, not samples.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const { decode, encode } = require(resolve(root, 'sillytavern-runtime/node_modules/@jridgewell/sourcemap-codec'));
export const BASELINE_MAPPING_SHA256 = 'ae8b35eacc2b74cbdd3bba7685109eebafb571f69e4e9bf556634237f16be2e5';
const sha = value => createHash('sha256').update(value).digest('hex');
const wrapGuard = 'if(!o.some(t=>e.includes(t)))return e;';
const wrapInsertion = wrapGuard + 'const ';
const unescapeInsertion = '!y.includes("&lt;%")?y:';
const sourceUnescape = "    if (!html.includes('&lt;%')) return html;";
const sourceWrap = '    if (!openTags.some(tag => content.includes(tag))) return content;';
const splitAnchor = 'function(e,t){const n=[],i=[];let r="",a=0;';

function once(text, token) {
    const index = text.indexOf(token);
    assert.ok(index >= 0 && text.indexOf(token, index + 1) < 0, 'Expected a unique source-map edit anchor');
    return index;
}

export function identityScanMappingPlan(bundle, source, map) {
    const sourceIndex = map.sources.findIndex(name => name.endsWith('/src/utils/prompts.ts'));
    assert.ok(sourceIndex >= 0);
    const lines = source.replaceAll('\r\n', '\n').split('\n');
    const unescapeLine = lines.indexOf(sourceUnescape), wrapLine = lines.indexOf(sourceWrap);
    assert.ok(unescapeLine > 0 && wrapLine > unescapeLine);
    const oldSource = lines.filter((_, index) => index !== unescapeLine && index !== wrapLine).join('\n');
    const original = bundle.replace(';' + wrapInsertion + 's=', ',s=').replace(unescapeInsertion, '');
    const edits = [
        { old: once(original, 'o=t.map((e=>"".concat(i).concat(e).concat(r))),s=t.map')
            + 'o=t.map((e=>"".concat(i).concat(e).concat(r))),'.length,
          current: once(bundle, wrapInsertion), length: wrapInsertion.length },
        { old: once(original, splitAnchor), current: once(bundle, unescapeInsertion), length: unescapeInsertion.length },
    ];
    assert.ok(edits[0].old < edits[1].old);
    assert.equal(edits[0].current, edits[0].old);
    assert.equal(edits[1].current, edits[1].old + edits[0].length);
    assert.equal(bundle.slice(0, edits[1].current).includes('\n'), false, 'These exact edits are on generated line 1');
    const added = [];
    const mark = (offset, generatedColumn, line, sourceColumn) => {
        assert.ok(generatedColumn >= 0 && sourceColumn >= 0);
        added.push([offset + generatedColumn, sourceIndex, line, sourceColumn]);
    };
    const w = lines[wrapLine], u = lines[unescapeLine];
    for (const [generated, originalColumn] of [
        [0, w.indexOf('if')], [wrapGuard.indexOf('o.'), w.indexOf('openTags')],
        [wrapGuard.indexOf('some'), w.indexOf('some')], [wrapGuard.indexOf('t=>'), w.indexOf('tag =>')],
        [wrapGuard.indexOf('=>'), w.indexOf('=>')], [wrapGuard.indexOf('e.includes'), w.indexOf('content.includes')],
        [wrapGuard.indexOf('includes'), w.indexOf('includes')], [wrapGuard.indexOf('(t)') + 1, w.lastIndexOf('tag')],
        [wrapGuard.indexOf('return'), w.indexOf('return')], [wrapGuard.indexOf('return e') + 7, w.lastIndexOf('content')],
    ]) mark(edits[0].current, generated, wrapLine, originalColumn);
    mark(edits[0].current, wrapInsertion.indexOf('const'), wrapLine + 1, lines[wrapLine + 1].indexOf('const'));
    for (const [generated, originalColumn] of [
        [0, u.indexOf('!')], [1, u.indexOf('html')], [unescapeInsertion.indexOf('includes'), u.indexOf('includes')],
        [unescapeInsertion.indexOf('"'), u.indexOf("'&lt;%'")],
        [unescapeInsertion.indexOf('?'), u.indexOf('return')],
        [unescapeInsertion.indexOf('?') + 1, u.lastIndexOf('html')],
        [unescapeInsertion.indexOf(':'), u.indexOf(';')],
    ]) mark(edits[1].current, generated, unescapeLine, originalColumn);
    return { sourceIndex, oldSource, edits, added, oldSourceInsertions: [unescapeLine, wrapLine - 1],
        currentSourceInsertions: [unescapeLine, wrapLine] };
}

export function invertIdentityScanMappings(map, plan) {
    const added = new Map(plan.added.map(segment => [segment[0], segment]));
    const found = new Set();
    const mappings = decode(map.mappings).map((line, lineIndex) => line.flatMap(segment => {
        if (lineIndex === 0 && added.has(segment[0])) {
            assert.deepEqual(segment, added.get(segment[0]), 'Inserted code must map to the actual guard source');
            found.add(segment[0]);
            return [];
        }
        const original = [...segment];
        if (lineIndex === 0) original[0] -= plan.edits.reduce((n, edit) => n + (segment[0] >= edit.current + edit.length ? edit.length : 0), 0);
        if (segment.length > 1 && segment[1] === plan.sourceIndex) {
            assert.ok(!plan.currentSourceInsertions.includes(segment[2]), 'Only inserted segments may use a new source line');
            original[2] -= plan.currentSourceInsertions.filter(line => segment[2] > line).length;
        }
        return [original];
    }));
    assert.equal(found.size, added.size);
    return encode(mappings);
}

export function repairIdentityScanMap(map, plan, source) {
    assert.equal(sha(map.mappings), BASELINE_MAPPING_SHA256, 'Do not overwrite an unknown map revision');
    assert.equal(map.sourcesContent[plan.sourceIndex].replaceAll('\r\n', '\n'), plan.oldSource);
    const mappings = decode(map.mappings).map((line, lineIndex) => line.map(segment => {
        const next = [...segment];
        if (lineIndex === 0) next[0] += plan.edits.reduce((n, edit) => n + (segment[0] >= edit.old ? edit.length : 0), 0);
        if (segment.length > 1 && segment[1] === plan.sourceIndex) {
            next[2] += plan.oldSourceInsertions.filter(line => segment[2] >= line).length;
        }
        return next;
    }));
    assert.ok(plan.added.every(added => !mappings[0].some(segment => segment[0] === added[0])));
    mappings[0].push(...plan.added);
    mappings[0].sort((a, b) => a[0] - b[0]);
    const sourcesContent = [...map.sourcesContent];
    sourcesContent[plan.sourceIndex] = source;
    const result = { ...map, sourcesContent, mappings: encode(mappings) };
    assert.equal(invertIdentityScanMappings(result, plan), map.mappings, 'Every original mapping must be reversible');
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const extension = resolve(root, 'sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template');
    const mapPath = resolve(extension, 'dist/index.js.map');
    const bundle = readFileSync(resolve(extension, 'dist/index.js'), 'utf8');
    const source = readFileSync(resolve(extension, 'src/utils/prompts.ts'), 'utf8');
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    const plan = identityScanMappingPlan(bundle, source, map);
    const updated = repairIdentityScanMap(map, plan, source);
    writeFileSync(mapPath, JSON.stringify(updated));
    console.log(JSON.stringify({ addedSegments: plan.added.length, originalMappingsInverseExact: true,
        bundleUnchanged: true, mapSHA256: sha(readFileSync(mapPath)) }));
}
