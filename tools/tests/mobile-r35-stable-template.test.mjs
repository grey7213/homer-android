import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardPreparationCache, fingerprintCardJson, createRegexTemplateCache, fillRegexTemplate }
    from '../../sillytavern-runtime/public/scripts/homer-stable-template.mjs';

test('unchanged complete card source hashes once, without reusing a mutable clone', () => {
    let count = 0;
    const cache = createCardPreparationCache({ fingerprint: text => { count++; return fingerprintCardJson(text); } });
    const card = { data: { name: 'fixture', extensions: { regex_scripts: [{ replaceString: 'x'.repeat(3_023_349) }] } } };
    const first = cache.prepare('account:card', card);
    const same = cache.prepare('account:card', JSON.parse(JSON.stringify(card)));
    assert.equal(same.reused, true); assert.equal(count, 1);
    assert.equal(same.signature, first.signature);
    const clone = JSON.parse(same.json); clone.data.name = 'mutated';
    assert.equal(cache.prepare('account:card', card).reused, true);
    card.data.name = 'new revision';
    assert.equal(cache.prepare('account:card', card).reused, false); assert.equal(count, 2);
});

test('card signature remains byte-for-byte canonical v2; accounts and LRU are isolated', () => {
    const card = { a: undefined, b: [NaN, 12], data: { name: 'fixture' } };
    const cache = createCardPreparationCache({ maxEntries: 2 });
    assert.equal(cache.prepare('one:A', card).signature, fingerprintCardJson(JSON.stringify(JSON.parse(JSON.stringify(card)))));
    assert.equal(cache.prepare('two:A', card).reused, false);
    cache.prepare('one:B', {});
    assert.equal(cache.prepare('one:A', card).reused, false);
    cache.clear(); assert.equal(cache.prepare('one:A', card).reused, false);
});

test('over-budget preparation is not retained', () => {
    const cache = createCardPreparationCache({ maxChars: 5 });
    assert.equal(cache.prepare('one', { text: 'large' }).reused, false);
    assert.equal(cache.prepare('one', { text: 'large' }).reused, false);
});

const canonical = (source, args, filter) => source.replace(/{{match}}/gi, '$0').replaceAll(/\$(\d+)|\$<([^>]+)>/g,
    (_, num, name) => { const groups = args[args.length - 1]; const value = num ? args[Number(num)] : groups && typeof groups === 'object' && groups[name]; return value ? filter(value) : ''; });
test('prepared templates preserve canonical captures, trim and remaining macro tokens', () => {
    const cache = createRegexTemplateCache();
    const source = 'begin {{MATCH}} / $0 $1 $01 $2 $99 $<named> $$1 $& {{getvar::live}} end';
    const script = { replaceString: source };
    const args = ['matched', 'group1', '', 0, 'whole input', { named: 'name-value' }];
    const filter = text => text.replaceAll('group', 'trim');
    assert.equal(fillRegexTemplate(cache.get(script), args, filter), canonical(source, args, filter));
    assert.equal(cache.get(script), cache.get(script));
    const parts = cache.get(script); script.replaceString += ' changed';
    assert.notEqual(parts, cache.get(script));
});

test('large static replacement is prepared once but dynamic capture/trim is never cached', () => {
    const cache = createRegexTemplateCache();
    const script = { replaceString: 'x'.repeat(3_023_349) + '$1' };
    const parts = cache.get(script);
    assert.equal(cache.get(script), parts);
    let called = 0;
    assert.ok(fillRegexTemplate(parts, ['all', 'first'], text => { called++; return text; }).endsWith('first'));
    assert.ok(fillRegexTemplate(parts, ['all', 'second'], text => { called++; return text; }).endsWith('second'));
    assert.equal(called, 2);
});

test('regex-template LRU never changes oversized replacement behavior', () => {
    const cache = createRegexTemplateCache({ maxEntries: 1, maxChars: 5 });
    const a = { replaceString: 'a$0' }, b = { replaceString: 'b$0' };
    const first = cache.get(a); cache.get(b); assert.notEqual(cache.get(a), first);
    const large = { replaceString: 'too large $1' };
    assert.equal(fillRegexTemplate(cache.get(large), ['all', 'value'], x => x), 'too large value');
    assert.notEqual(cache.get(large), cache.get(large));
});
