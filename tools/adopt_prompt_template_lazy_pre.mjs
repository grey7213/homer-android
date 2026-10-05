// R338: retain the actual compiler closure; only handler/evaluator sources may
// differ and every non-entry asset must remain byte-identical to R337.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extension = resolve(root, '.web-cache/tree/sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template');
const shipping = resolve(extension, 'dist');
const candidate = resolve(root, 'output/mobile-r41/ejs338-lazy-pre');
const baseline = resolve(root, 'output/mobile-r41/ejs337-token-jump');
const sha = data => createHash('sha256').update(data).digest('hex');
assert.equal(sha(readFileSync(resolve(shipping, 'index.js'))), '7bebe498d0b26414ca7b4266fb2a965afb78b9f847d8e3ee4bcd7403d2577e37');
assert.equal(sha(readFileSync(resolve(shipping, 'index.js.map'))), 'da3c53d72c27260aa4f12fc09a2ad52dc46ad1421af0cab03a8ffb43a346993b');
for (const name of ['index.js', 'index.js.map']) {
    assert.ok(readFileSync(resolve(shipping, name)).equals(readFileSync(resolve(baseline, name))), 'Previous shipping pair equals its real compiler output');
}
let unchangedAssets = 0;
assert.deepEqual(readdirSync(candidate), readdirSync(baseline));
for (const name of readdirSync(candidate).filter(name => !['index.js', 'index.js.map'].includes(name))) {
    assert.ok(readFileSync(resolve(shipping, name)).equals(readFileSync(resolve(candidate, name))), `Unrelated compiled asset changed: ${name}`);
    unchangedAssets++;
}
const oldMap = JSON.parse(readFileSync(resolve(shipping, 'index.js.map')));
const newMap = JSON.parse(readFileSync(resolve(candidate, 'index.js.map')));
assert.deepEqual(newMap.sources, oldMap.sources);
const targets = ['src/modules/handler.ts', 'src/utils/evaluate.ts'];
for (let index = 0; index < newMap.sources.length; index++) {
    const target = targets.find(name => newMap.sources[index].endsWith('/' + name));
    assert.equal(newMap.sourcesContent[index], target ? readFileSync(resolve(extension, target), 'utf8') : oldMap.sourcesContent[index]);
}
for (const name of ['index.js', 'index.js.map']) copyFileSync(resolve(candidate, name), resolve(shipping, name));
console.log(JSON.stringify({ nonentryByteIdentical: unchangedAssets, nonTargetSourcesIdentical: newMap.sources.length - targets.length,
    generatedEntryMapAdoptedTogether: true, bundleSHA256: sha(readFileSync(resolve(shipping, 'index.js'))), mapSHA256: sha(readFileSync(resolve(shipping, 'index.js.map'))) }));
