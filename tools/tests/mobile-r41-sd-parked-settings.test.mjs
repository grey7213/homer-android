import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/stable-diffusion/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function onChatChanged()');
const end = source.indexOf('async function onCharacterPromptInput()', start);
assert.ok(start >= 0 && end > start, 'Use the actual shipped SD handlers');
const actualHandlers = source.slice(start, end);

function harness({ hidden = true, inert = true, parked = true, supportsFieldSizing = false,
    settingsVisible = false, character = 0, group = null, display = 'none', savedPositive = '', savedNegative = '' } = {}) {
    const calls = [], values = new Map(), checked = new Map();
    const parking = parked ? { hidden, inert } : null;
    const block = { style: { display }, closest(selector) {
        assert.equal(selector, '.homer-internal-parking'); return parking;
    } };
    const settings = { closest: block.closest };
    const nodes = new Map([['#sd_character_prompt_block', block], ['.sd_settings', settings]]);
    const controls = new Map();
    const c = {
        this_chid: character, selected_group: group,
        extension_settings: { sd: { character_prompts: { synthetic: savedPositive }, character_negative_prompts: { synthetic: savedNegative } } },
        getCharaFilename: () => 'synthetic',
        getContext: () => ({ characters: [{ data: { extensions: { sd_character_prompt: { positive: 'Shared positive', negative: 'Shared negative' } } } }] }),
        CSS: { supports: () => supportsFieldSizing },
        resetScrollHeight: async element => { calls.push(`height:${element.selector}`); },
        $: selector => {
            if (!controls.has(selector)) {
                const node = nodes.get(selector);
                const control = { 0: node, length: node ? 1 : 0, selector,
                    show() { calls.push('show'); if (node) node.style.display = ''; return control; },
                    hide() { calls.push('hide'); if (node) node.style.display = 'none'; return control; },
                    val(value) { values.set(selector, value); return control; },
                    prop(name, value) { checked.set(`${selector}:${name}`, value); return control; },
                    is(value) { assert.equal(value, ':visible'); calls.push('visible'); return settingsVisible; },
                };
                controls.set(selector, control);
            }
            return controls.get(selector);
        },
    };
    vm.createContext(c); vm.runInContext(actualHandlers, c);
    return { c, calls, values, checked, block, parking,
        run: () => c.onChatChanged(), adjust: () => c.adjustElementScrollHeight() };
}

test('physical hidden and inert parking avoids layout probes while retaining shared prompts and controls', async () => {
    const h = harness(); await h.run();
    assert.deepEqual(h.calls, []);
    assert.equal(h.block.style.display, '');
    assert.equal(h.values.get('#sd_character_prompt'), 'Shared positive');
    assert.equal(h.values.get('#sd_character_negative_prompt'), 'Shared negative');
    assert.equal(h.checked.get('#sd_character_prompt_share:checked'), true);
    assert.equal(h.c.extension_settings.sd.character_prompts.synthetic, 'Shared positive');
    assert.equal(h.c.extension_settings.sd.character_negative_prompts.synthetic, 'Shared negative');
});

test('parked settings preserve existing per-character prompts rather than replacing them with shared values', async () => {
    const h = harness({ savedPositive: 'Saved positive', savedNegative: 'Saved negative' }); await h.run();
    assert.deepEqual(h.calls, []);
    assert.equal(h.values.get('#sd_character_prompt'), 'Saved positive');
    assert.equal(h.values.get('#sd_character_negative_prompt'), 'Saved negative');
    assert.equal(h.c.extension_settings.sd.character_prompts.synthetic, 'Saved positive');
});

for (const mode of [{ character: undefined }, { group: 'synthetic-group' }]) {
    test(`parked unavailable character/group remains hidden and makes no layout or prompt changes (${JSON.stringify(mode)})`, async () => {
        const h = harness(mode);
        if (Object.hasOwn(mode, 'character')) h.c.this_chid = undefined;
        await h.run();
        assert.deepEqual(h.calls, []); assert.equal(h.block.style.display, 'none');
        assert.equal(h.values.size, 0); assert.equal(h.checked.size, 0);
    });
}

for (const mode of [{ hidden: false }, { inert: false }, { parked: false }]) {
    test(`anything other than physical hidden plus inert parking keeps the complete visible handler (${JSON.stringify(mode)})`, async () => {
        const h = harness({ ...mode, settingsVisible: true }); await h.run();
        assert.deepEqual(h.calls, ['show', 'visible', 'height:#sd_prompt_prefix', 'height:#sd_negative_prompt',
            'height:#sd_character_prompt', 'height:#sd_character_negative_prompt']);
        assert.equal(h.values.get('#sd_character_prompt'), 'Shared positive');
    });
}

test('unparking immediately restores original show and all textarea height adjustments', async () => {
    const h = harness({ settingsVisible: true }); await h.run();
    h.parking.hidden = false; await h.run();
    assert.deepEqual(h.calls, ['show', 'visible', 'height:#sd_prompt_prefix', 'height:#sd_negative_prompt',
        'height:#sd_character_prompt', 'height:#sd_character_negative_prompt']);
    assert.equal(h.block.style.display, '');
});

test('modern field sizing and ordinary hidden standalone settings retain original short circuits', async () => {
    const modern = harness({ parked: false, supportsFieldSizing: true, settingsVisible: true }); await modern.run();
    assert.deepEqual(modern.calls, ['show']);
    const hiddenStandalone = harness({ parked: false, settingsVisible: false }); await hiddenStandalone.run();
    assert.deepEqual(hiddenStandalone.calls, ['show', 'visible']);
});

test('direct height adjustment checks physical parking before querying geometric visibility', async () => {
    const h = harness({ settingsVisible: true }); await h.adjust();
    assert.deepEqual(h.calls, []);
});

test('standalone unavailable character/group preserves the old hide handler', async () => {
    const h = harness({ parked: false, group: 'synthetic-group' }); await h.run();
    assert.deepEqual(h.calls, ['hide']); assert.equal(h.values.size, 0);
});

test('shipping registration and shared prompt persistence remain in the original CHAT_CHANGED lifecycle', () => {
    assert.match(source, /eventSource\.on\(event_types\.CHAT_CHANGED, onChatChanged\)/);
    assert.match(actualHandlers, /extension_settings\.sd\.character_prompts\[key\] = characterPrompt/);
    assert.match(actualHandlers, /extension_settings\.sd\.character_negative_prompts\[key\] = negativePrompt/);
});
