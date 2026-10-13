import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as greetings from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';
import { samePromptMessageSource, clearPromptMessageState, restoreAcknowledgedPromptStates } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';

const first = '```html\n<html><body><div>START</div><p>intro</p></body></html>\n```';
const alternate = '```html\n<body><button>NEXT</button></body>\n```';
const card = { data: { first_mes: 'START', alternate_greetings: ['NEXT'] } };
const rules = [{ findRegex: 'START', replaceString: first, disabled: false },
    { findRegex: 'NEXT', replaceString: alternate, disabled: false }];
const render = value => value === 'START' ? first : value === 'NEXT' ? alternate : value;
const restore = (...args) => {
    assert.equal(typeof greetings.restoreCanonicalGreeting, 'function', 'canonical local greetings need the same exact legacy recovery as cloud greetings');
    return greetings.restoreCanonicalGreeting(...args);
};
const canonical = (mes = first) => ({
    name: 'Fixture card', is_user: false, is_system: false,
    send_date: '2026-10-02T00:00:00.000Z', mes,
    swipes: [first, 'edited candidate', alternate], swipe_id: 0,
    swipe_info: [{ extra: { custom: 1 } }, { extra: { custom: 2 } }, { extra: { custom: 3 } }],
    extra: { homer_sync_id: 'fixture-message', homer_created_at: 17, author_field: { retained: true } },
    variables: [{ state: 'one' }, { state: 'two' }, { state: 'three' }],
});

test('old canonical local opening recovers source without mutating the stored row or metadata', () => {
    const saved = canonical(); const before = structuredClone(saved);
    const projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, 'START');
    assert.deepEqual(projected.swipes, ['START', 'edited candidate', 'NEXT']);
    assert.deepEqual(saved, before);
    for (const key of ['name', 'send_date', 'swipe_id', 'swipe_info', 'extra', 'variables']) assert.equal(projected[key], saved[key]);
});

test('selected alternate and its swipe index/order/info are preserved', () => {
    const saved = { ...canonical(alternate), swipe_id: 2 };
    const projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, 'NEXT'); assert.equal(projected.swipe_id, 2);
    assert.deepEqual(projected.swipes, ['START', 'edited candidate', 'NEXT']);
    assert.equal(projected.swipe_info, saved.swipe_info);
});

test('repair invalidates only derived active and changed-swipe display caches', () => {
    const saved = canonical();
    saved.extra.display_text = first;
    saved.extra.reasoning_display_text = 'unrelated reasoning';
    saved.swipe_info = [
        { send_date: 'first', extra: { display_text: first, retained: 'one' } },
        { send_date: 'edited', extra: { display_text: 'user editor display', retained: 'two' } },
        { send_date: 'last', extra: { display_text: alternate, retained: 'three' } },
    ];
    const before = structuredClone(saved);
    const projected = restore(card, saved, render, rules);
    assert.equal('display_text' in projected.extra, false);
    assert.equal(projected.extra.reasoning_display_text, 'unrelated reasoning');
    assert.equal(projected.extra.homer_sync_id, saved.extra.homer_sync_id);
    assert.equal(projected.extra.author_field, saved.extra.author_field);
    assert.equal('display_text' in projected.swipe_info[0].extra, false);
    assert.equal('display_text' in projected.swipe_info[2].extra, false);
    assert.equal(projected.swipe_info[1], saved.swipe_info[1]);
    assert.equal(projected.swipe_info[0].send_date, 'first');
    assert.equal(projected.swipe_info[2].extra.retained, 'three');
    assert.deepEqual(saved, before, 'derivative cache invalidation does not mutate persisted input');
});

test('raw unchanged active content keeps its display cache while unselected legacy swipe caches are invalidated', () => {
    const saved = { ...canonical('edited active content'), swipe_id: 1,
        extra: { homer_sync_id: 'edited-active', display_text: 'preserve current display' },
        swipe_info: [{ extra: { display_text: first } }, { extra: { display_text: 'current' } }, { extra: { display_text: alternate } }],
    };
    const projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, 'edited active content');
    assert.equal(projected.extra, saved.extra, 'do not discard current display for an untouched source');
    assert.equal(projected.swipe_info[1], saved.swipe_info[1]);
    assert.equal('display_text' in projected.swipe_info[0].extra, false);
    assert.equal('display_text' in projected.swipe_info[2].extra, false);
});

test('an active restored swipe invalidates stale display even when mes was already raw', () => {
    const saved = { ...canonical('START'), extra: { homer_sync_id: 'raw-mes-old-swipe', display_text: first } };
    const projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, 'START'); assert.equal(projected.swipe_id, 0);
    assert.equal('display_text' in projected.extra, false);
});

test('all canonical raw sources still invalidate an exact authored legacy active display cache', () => {
    const saved = { ...canonical('START'), swipes: ['START', 'edited candidate', 'NEXT'] };
    saved.extra.display_text = first;
    const before = structuredClone(saved), projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, 'START'); assert.equal(projected.swipes, saved.swipes);
    assert.equal('display_text' in projected.extra, false);
    assert.equal(projected.extra.author_field, saved.extra.author_field);
    assert.equal(projected.swipe_info, saved.swipe_info);
    assert.deepEqual(saved, before);
});

test('display-only repair does not invent swipes or change any canonical message identifiers', () => {
    const saved = { mes: 'START', is_user: false, extra: { display_text: first, homer_sync_id: 'cache-only' }, send_date: 'retained' };
    const projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, 'START'); assert.equal('swipes' in projected, false);
    assert.equal('display_text' in projected.extra, false);
    assert.equal(projected.extra.homer_sync_id, 'cache-only'); assert.equal(projected.send_date, 'retained');
});

test('raw selected alternate and each matching raw swipe invalidate only their corresponding display caches', () => {
    const saved = { ...canonical('NEXT'), swipes: ['START', 'edited candidate', 'NEXT'], swipe_id: 2,
        extra: { display_text: alternate, homer_sync_id: 'raw-selected-alternate' },
        swipe_info: [{ extra: { display_text: first, retained: 1 } },
            { extra: { display_text: 'edited preview', retained: 2 } }, { extra: { display_text: alternate, retained: 3 } }],
    };
    const projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, saved.mes); assert.equal(projected.swipes, saved.swipes); assert.equal(projected.swipe_id, 2);
    assert.equal('display_text' in projected.extra, false);
    assert.equal('display_text' in projected.swipe_info[0].extra, false);
    assert.equal('display_text' in projected.swipe_info[2].extra, false);
    assert.equal(projected.swipe_info[1], saved.swipe_info[1]);
    assert.equal(projected.swipe_info[2].extra.retained, 3);
});

test('exact authored outputs from a different canonical source are not treated as this message cache', () => {
    const saved = { ...canonical('START'), swipes: ['START', 'edited candidate', 'NEXT'],
        extra: { display_text: alternate },
        swipe_info: [{ extra: { display_text: alternate } }, { extra: { display_text: first } }, { extra: { display_text: first } }],
    };
    assert.equal(restore(card, saved, render, rules), saved);
});

test('unknown or edited display-only values, arbitrary HTML and nonstring fields stay unchanged', () => {
    for (const display of [first + ' user edit', '<body>custom author display</body>', '<div>fragment</div>',
        'translated edited display', '', null, { retained: true }]) {
        const saved = { ...canonical('START'), swipes: ['START', 'edited candidate', 'NEXT'],
            extra: { display_text: display }, swipe_info: [{ extra: { display_text: display } }],
        };
        assert.equal(restore(card, saved, render, rules), saved);
    }
});

test('unknown edited caches also remain intact when a different exact legacy source is recovered', () => {
    const saved = canonical();
    saved.extra.display_text = '<body>my edited active preview</body>';
    saved.swipe_info[0].extra.display_text = 'my edited candidate preview';
    const projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, 'START');
    assert.equal(projected.extra, saved.extra);
    assert.equal(projected.swipe_info, saved.swipe_info);
});

test('display-only documents never replay dynamic rules or guess ambiguous authored outputs', () => {
    const saved = { ...canonical('START'), swipes: ['START', 'edited candidate', 'NEXT'], extra: { display_text: first } };
    for (const token of ['{{getvar::x}}', '{{setvar::x::1}}', '{{random::a::b}}', '{{time}}']) {
        let calls = 0;
        assert.equal(restore(card, saved, () => { calls++; return first; }, [{ replaceString: first + token }]), saved);
        assert.equal(calls, 0);
    }
    assert.equal(restore(card, saved, () => first, rules), saved);
    for (const role of [{ is_user: true }, { is_system: true }]) {
        let calls = 0;
        const roleMessage = { ...saved, ...role };
        assert.equal(restore(card, roleMessage, () => { calls++; return first; }, rules), roleMessage);
        assert.equal(calls, 0);
    }
});

test('source and display-only recovery share one authored output map and become render-free on a second pass', () => {
    const large = '```html\n<body><div>START</div>' + 'X'.repeat(3_000_000) + '</body>\n```';
    const saved = { ...canonical(large), swipes: [large, 'edited candidate', 'NEXT'],
        extra: { display_text: large },
        swipe_info: [{ extra: { display_text: large } }, { extra: { display_text: 'edited' } }, { extra: { display_text: alternate } }],
    };
    const calls = [];
    const counted = value => { calls.push(value); return value === 'START' ? large : alternate; };
    const projected = restore(card, saved, counted, []);
    assert.deepEqual(calls, ['START', 'NEXT'], 'never rerender the three-megabyte candidate for each metadata field');
    assert.equal(projected.mes, 'START');
    assert.equal('display_text' in projected.extra, false);
    assert.equal('display_text' in projected.swipe_info[0].extra, false);
    assert.equal('display_text' in projected.swipe_info[2].extra, false);
    calls.length = 0;
    assert.equal(restore(card, projected, counted, []), projected);
    assert.equal(calls.length, 0);
});

test('no swipe array is invented for legacy single-message storage', () => {
    const saved = { mes: first, is_user: false, is_system: false, extra: { homer_sync_id: 'no-swipes' } };
    const projected = restore(card, saved, render, rules);
    assert.equal(projected.mes, 'START'); assert.equal('swipes' in projected, false);
    assert.equal(projected.extra, saved.extra);
});

test('edited HTML, normal code, ambiguous outputs and authored HTML remain untouched', () => {
    for (const mes of [first + ' edited', '```js\nconsole.log(1)\n```', 'START']) {
        const saved = { mes, is_user: false, is_system: false };
        assert.equal(restore(card, saved, render, rules), saved);
    }
    const saved = { mes: first, swipes: [first], is_user: false, is_system: false };
    assert.equal(restore(card, saved, () => first, rules), saved, 'ambiguous source is not guessed');
    assert.equal(restore({ data: { first_mes: first } }, saved, value => value, []), saved, 'author-written HTML is not stripped');
});

test('normalization is idempotent and does not execute macros to identify a legacy message', () => {
    const normalized = restore(card, canonical(), render, rules);
    assert.equal(restore(card, normalized, render, rules), normalized);
    for (const token of ['{{setvar::x::1}}', '{{random::a::b}}', '{{time}}', '{{getvar::x}}']) {
        let calls = 0; const saved = canonical();
        const dynamic = [{ findRegex: 'START', replaceString: first + token }];
        assert.equal(restore(card, saved, () => { calls++; return first; }, dynamic), saved);
        assert.equal(calls, 0);
    }
    let calls = 0;
    const saved = canonical();
    assert.equal(restore({ data: { first_mes: '{{incvar::x}}' } }, saved, () => { calls++; return first; }, []), saved);
    assert.equal(calls, 0);
});

test('user/system content is not interpreted as authored assistant opening', () => {
    for (const role of [{ is_user: true }, { is_system: true }]) {
        const saved = { ...canonical(), ...role };
        assert.equal(restore(card, saved, render, rules), saved);
    }
    const hidden = { ...canonical(), is_system: true, extra: { homer_hidden: true, homer_sync_id: 'hidden-assistant' } };
    assert.equal(restore(card, hidden, render, rules).mes, 'START', 'presentation-hidden assistant preserves its real role');
});

test('actual local_chat load branch projects only the cloned first assistant message', async () => {
    const bridge = await readFile(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
    const begin = bridge.indexOf('    const fromLocal = Array.isArray(launch.local_chat);');
    const end = bridge.indexOf('    delete launch.local_chat;', begin);
    assert(begin > 0 && end > begin, 'expected actual canonical local load branch');
    const original = [canonical(), { ...canonical(alternate), extra: { homer_sync_id: 'later-message' } }];
    const scope = {
        launch: { card, local_chat: original },
        cloneJsonValue: structuredClone,
        normalizeOpeningMessage: message => restore(card, message, render, rules),
        samePromptMessageSource, clearPromptMessageState, restoreAcknowledgedPromptStates,
    };
    vm.runInNewContext(`function project(){${bridge.slice(begin, end)}return messages}`, scope);
    const projected = scope.project();
    assert.equal(projected[0].mes, 'START', 'durable local load must not bypass the legacy source repair');
    assert.equal(projected[1].mes, alternate, 'later messages are never replaced');
    assert.equal(original[0].mes, first, 'the persisted local row is not migrated in place');
    assert.equal(projected[0].extra.homer_sync_id, 'fixture-message');
});

test('actual cloud adapter shares canonical repair without changing real message identity', async () => {
    const bridge = await readFile(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
    const begin = bridge.indexOf('function cloudMessageToDialogue(');
    const end = bridge.indexOf('\nfunction initialGreetingMessage(', begin);
    assert(begin > 0 && end > begin);
    let calls = 0;
    const scope = {
        runtimeVariables: {}, session: { user: { name: 'Fixture user' } }, launch: { card },
        greetingSwipes: greetings.greetingSwipes,
        restoreRenderedGreetings: greetings.restoreRenderedGreetings,
        canReplayGreetingRules: greetings.canReplayGreetingRules,
        getRegexScripts: () => rules, getRegexedString: render, regex_placement: { AI_OUTPUT: 2 },
        normalizeOpeningMessage: message => { calls++; return restore(card, message, render, rules); },
    };
    vm.runInNewContext(bridge.slice(begin, end), scope);
    const projected = scope.cloudMessageToDialogue({ role: 'assistant', id: 'cloud-fixture', content: alternate,
        swipes: [first, alternate], swipe_index: 1, created_at: 42 }, 0);
    assert.equal(calls, 1, 'cloud and local adapters must share the same recovery');
    assert.equal(projected.mes, 'NEXT'); assert.equal(projected.swipe_id, 1);
    assert.equal(projected.extra.homer_message_id, 'cloud-fixture');
    assert.equal(projected.extra.homer_created_at, 42);
    assert.equal(projected.send_date, new Date(42).toISOString());
    calls = 0;
    assert.equal(scope.cloudMessageToDialogue({ role: 'assistant', content: first }, 1).mes, first);
    assert.equal(calls, 0, 'later cloud messages are untouched');
});
