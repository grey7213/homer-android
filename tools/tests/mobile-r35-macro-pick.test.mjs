import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/macros.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const functionSource = source.slice(source.indexOf('function getPickReplaceMacro('), source.indexOf('/**\n * @returns {Macro} The dire roll macro', source.indexOf('function getPickReplaceMacro(')));
// Use the original hash algorithm and original eager implementation as the
// oracle, not a second reimplementation of seed/offset/list parsing semantics.
const utils = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/utils.js', import.meta.url), 'utf8');
const hashSource = utils.slice(utils.indexOf('export function getStringHash('), utils.indexOf('/**', utils.indexOf('export function getStringHash('))).replace(/^export /, '');
function harness(eager = false) {
    const hashes = [], seeds = [], metadata = {};
    const context = { metadata, hashes, seeds, seedrandom: seed => { seeds.push(seed); return () => (seed % 1000) / 1000; } };
    vm.createContext(context);
    vm.runInContext(hashSource + '\nconst originalHash = getStringHash; getStringHash = value => { hashes.push(value); return originalHash(value); };\n' +
        'function getChatIdHash() { return metadata.chat_id_hash ||= getStringHash("fixture-chat"); }\n' +
        (eager ? functionSource.replace('let rawContentHash;', 'const rawContentHash = getStringHash(rawContent);').replace('rawContentHash ??= getStringHash(rawContent)', 'rawContentHash') : functionSource), context);
    return context;
}

test('large plain template skips raw hashing but preserves eager chat metadata initialization', () => {
    const h = harness(), raw = 'x'.repeat(3_000_000);
    h.getPickReplaceMacro(raw);
    assert.deepEqual(h.hashes, ['fixture-chat']);
    assert.ok(h.metadata.chat_id_hash);
});

test('picks preserve original deterministic seeds, offsets and escaped-comma parsing', () => {
    const raw = '{{pick::alpha::beta::gamma}} then {{pick a\\,b,c,d}}';
    const lazy = harness(), original = harness(true);
    const run = h => { const macro = h.getPickReplaceMacro(raw); return raw.replace(macro.regex, macro.replace); };
    assert.equal(run(lazy), run(original));
    assert.deepEqual(lazy.seeds, original.seeds);
    assert.equal(lazy.hashes.filter(value => value === raw).length, 1);
});

test('pick introduced by an earlier environment macro still hashes the original raw content', () => {
    const raw = '{{injected}}', rendered = 'prefix {{pick::one::two}}';
    const lazy = harness(), original = harness(true);
    const run = h => { const macro = h.getPickReplaceMacro(raw); return rendered.replace(macro.regex, macro.replace); };
    assert.equal(run(lazy), run(original));
    assert.deepEqual(lazy.seeds, original.seeds);
    assert.ok(lazy.hashes.includes(raw));
    assert.equal(lazy.hashes.includes(rendered), false);
});
