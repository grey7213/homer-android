// Adopt an actual webpack-generated entry/map pair only after proving the
// baseline compiler differs solely in the two known 336 guard representations
// and that every non-entry compiler asset remains byte-identical.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { extractShippingHelpers } from './tests/helpers/ejs-shipping-helpers.mjs';
import { identityScanMappingPlan } from './repair_prompt_template_identity_sourcemap.mjs';

const root = resolve(import.meta.dirname, '..');
const extension = resolve(root, '.web-cache/tree/sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template');
const shipping = resolve(extension, 'dist');
const baseline = resolve(root, 'output/mobile-r41/ejs337-baseline-real');
const candidate = resolve(root, 'output/mobile-r41/ejs337-token-jump');
const sha = data => createHash('sha256').update(data).digest('hex');
const oldBundle = readFileSync(resolve(shipping, 'index.js'), 'utf8');
const oldMapBytes = readFileSync(resolve(shipping, 'index.js.map'));
assert.equal(sha(oldBundle), '1763a3c4fe604ee2d67406d90d70669f9200d62bd4f656fedfa774f2096ce581');
assert.equal(sha(oldMapBytes), 'ac8013fc7478f226e982f05b3d875edb7637b69f7951b68372ca9bc3ecebba21');
const oldMap = JSON.parse(oldMapBytes);
const rebuilt = readFileSync(resolve(baseline, 'index.js'), 'utf8');
const { unescape } = extractShippingHelpers(oldBundle).positions;
const canonical = (oldBundle.slice(0, unescape.start)
    + oldBundle.slice(unescape.test.argument.start, unescape.test.argument.end) + '?'
    + oldBundle.slice(unescape.alternate.start, unescape.alternate.end) + ':'
    + oldBundle.slice(unescape.consequent.start, unescape.consequent.end) + oldBundle.slice(unescape.end))
    .replace('if(!o.some(t=>e.includes(t)))', 'if(!o.some((t=>e.includes(t))))');
assert.equal(canonical, rebuilt, 'Rebuilding must not lose any previous manual product change');
let nonentry = 0;
for (const path of [baseline, candidate]) {
    const names = readdirSync(path);
    assert.deepEqual(names, readdirSync(candidate));
    for (const name of names.filter(name => !['index.js', 'index.js.map'].includes(name))) {
        assert.ok(readFileSync(resolve(path, name)).equals(readFileSync(resolve(shipping, name))), `Unrelated asset changed: ${name}`);
        if (path === candidate) nonentry++;
    }
}
const candidateMap = JSON.parse(readFileSync(resolve(candidate, 'index.js.map')));
const baselineMap = JSON.parse(readFileSync(resolve(baseline, 'index.js.map')));
assert.deepEqual(candidateMap.sources, oldMap.sources);
assert.deepEqual(baselineMap.sourcesContent, oldMap.sourcesContent);
const sourceIndex = candidateMap.sources.findIndex(name => name.endsWith('/src/utils/prompts.ts'));
candidateMap.sourcesContent.forEach((source, index) => {
    if (index !== sourceIndex) assert.equal(source, oldMap.sourcesContent[index], `Non-target source changed: ${candidateMap.sources[index]}`);
});
assert.equal(candidateMap.sourcesContent[sourceIndex], readFileSync(resolve(extension, 'src/utils/prompts.ts'), 'utf8'));

// Historical map proof stores only compressed mappings, source names and edit
// metadata, not a duplicate vendor bundle or all vendor sourcesContent.
const proofPath = resolve(root, 'tools/tests/fixtures/ejs-identity-map336-proof.json');
assert.equal(existsSync(proofPath), false, 'Never overwrite historical evidence');
const plan = identityScanMappingPlan(oldBundle, oldMap.sourcesContent[sourceIndex], oldMap);
const splitStart = oldBundle.indexOf('function(e,t){const n=[],i=[];let r="",a=0;', plan.edits[1].current);
const proof = {
    revision: 336,
    bundleSHA256: sha(oldBundle), mapSHA256: sha(oldMapBytes),
    mappingsGzipBase64: gzipSync(oldMap.mappings).toString('base64'), sources: oldMap.sources,
    plan,
    afterPositions: [
        { column: oldBundle.indexOf('const s=t.map', plan.edits[0].current) + 'const '.length, line: plan.currentSourceInsertions[1] + 2, sourceColumn: 10 },
        { column: splitStart, line: oldMap.sourcesContent[sourceIndex].replaceAll('\r\n', '\n').split('\n').indexOf('function splitNested(') + 1, sourceColumn: 0 },
        { column: oldBundle.indexOf('.join("")),p,"chat #"', splitStart), line: 34, sourceColumn: 19 },
    ],
};
writeFileSync(proofPath, JSON.stringify(proof) + '\n');
copyFileSync(resolve(candidate, 'index.js'), resolve(shipping, 'index.js'));
copyFileSync(resolve(candidate, 'index.js.map'), resolve(shipping, 'index.js.map'));
console.log(JSON.stringify({ nonentryByteIdentical: nonentry, oldBuildOnlyGuardFormatting: true,
    nonTargetSourcesIdentical: candidateMap.sources.length - 1, generatedEntryMapAdoptedTogether: true,
    bundleSHA256: sha(readFileSync(resolve(shipping, 'index.js'))), mapSHA256: sha(readFileSync(resolve(shipping, 'index.js.map'))) }));
