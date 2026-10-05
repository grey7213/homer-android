import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreCanonicalGreeting } from '../../sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';

const limit = 240000;
const document = '```html\n<html><body><div>' + 'x'.repeat(limit) + '</div><script>window.ready=true;</script></body></html>\n```';
const truncated = document.slice(0, limit);
const card = { data: { first_mes: 'INTRO', alternate_greetings: ['GAME'] } };
const render = value => value === 'GAME' ? document : value;

test('recover the exact historical 240000-character document prefix without changing the saved row', () => {
    const saved = { mes: truncated, is_user: false, swipe_id: 1, swipes: ['INTRO', truncated, 'GAME'],
        extra: { identity: 'owned', display_text: truncated },
        swipe_info: [{ extra: {} }, { extra: { display_text: truncated, author_state: 'kept' } }, { extra: {} }] };
    const before = structuredClone(saved);
    const result = restoreCanonicalGreeting(card, saved, render, [], { guardedReplay: true });
    assert.equal(result.mes, 'GAME');
    assert.deepEqual(result.swipes, ['INTRO', 'GAME', 'GAME']);
    assert.equal(result.swipe_id, 1);
    assert.equal(result.extra.identity, 'owned');
    assert.equal(Object.hasOwn(result.extra, 'display_text'), false);
    assert.equal(Object.hasOwn(result.swipe_info[1].extra, 'display_text'), false);
    assert.equal(result.swipe_info[1].extra.author_state, 'kept');
    assert.deepEqual(saved, before);
});

test('an exact truncated derived display is invalidated even if canonical mes is already raw', () => {
    const saved = { mes: 'GAME', is_user: false, extra: { display_text: truncated } };
    const result = restoreCanonicalGreeting(card, saved, render, [], { guardedReplay: true });
    assert.equal(result.mes, 'GAME');
    assert.equal(Object.hasOwn(result.extra, 'display_text'), false);
});

test('arbitrary partial HTML, user edits, ordinary source and user messages remain unchanged', () => {
    for (const mes of [document.slice(0, 10000), truncated.slice(0, -1),
        truncated.slice(0, -1) + 'y', truncated + 'edited', '```js\nconsole.log(1)\n```']) {
        const row = { mes, is_user: false };
        assert.equal(restoreCanonicalGreeting(card, row, render, [], { guardedReplay: true }), row);
    }
    const row = { mes: truncated, is_user: true };
    assert.equal(restoreCanonicalGreeting(card, row, render, [], { guardedReplay: true }), row);
});

test('two complete outputs with the same truncated prefix are ambiguous and not guessed', () => {
    const ambiguous = { data: { first_mes: 'A', alternate_greetings: ['B'] } };
    const row = { mes: truncated, is_user: false };
    assert.equal(restoreCanonicalGreeting(ambiguous, row,
        source => source === 'A' ? document : document.replace('window.ready=true', 'window.ready=false'),
        [], { guardedReplay: true }), row);
});

test('author-supplied incomplete HTML identity takes priority, even at the legacy limit', () => {
    const authored = { data: { first_mes: truncated, alternate_greetings: ['GAME'] } };
    const row = { mes: truncated, is_user: false };
    assert.equal(restoreCanonicalGreeting(authored, row, render, [], { guardedReplay: true }), row);
});

test('stateful or failed replay cannot manufacture a recovery', () => {
    const row = { mes: truncated, is_user: false };
    assert.equal(restoreCanonicalGreeting(card, row, () => { throw Error('Unsafe deterministic regex replay'); },
        [], { guardedReplay: true }), row);
});
