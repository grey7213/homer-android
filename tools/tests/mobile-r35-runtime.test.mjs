import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { containsLegacyMacroSyntax, createMessageDepthBatch, getMessageDepth }
    from '../../sillytavern-runtime/public/scripts/homer-message-depth.mjs';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const extract = (start, end) => {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Source boundaries exist: ${start}`);
    return source.slice(first, last).replaceAll('export ', '');
};
const headlessSource = extract('export async function activateCharacterForChat(', '////////// OPTIMZED MAIN API');
const selectSource = extract('export async function selectCharacterById(', 'function getBackBlock()');
const legacySource = extract('export function substituteParamsLegacy(', '/** @typedef {import(\'./scripts/macros/engine/MacroRegistry.js\')');
const substituteSource = extract('export function substituteParams(content,', 'export function getStoppingStrings(');

function fixture(options = {}) {
    const calls = [];
    const scope = {
        characters: [{ name: 'Old', avatar: 'old.png', chat: 'Old-chat' }, { name: 'New', avatar: 'new.png', chat: 'Other-chat' }],
        this_chid: '0', name2: 'Old', chat_metadata: { integrity: 'old-integrity' },
        is_send_press: false, selected_group: null, is_group_generating: false, isChatSaving: false,
        this_edit_mes_id: 2, selected_button: 'character_edit', debounce_timeout: { extended: 20 },
        waitUntilCondition: async condition => { if (!condition()) throw new Error('save timeout'); },
        unshallowCharacter: async id => { calls.push(['unshallow', id]); },
        clearChat: async config => { calls.push(['clear', scope.this_chid, scope.getCurrentChatId(), config]); },
        cancelTtsPlay: () => calls.push(['tts']),
        resetSelectedGroup: () => { scope.selected_group = null; calls.push(['group-reset']); },
        setCharacterId: id => { scope.this_chid = String(id); calls.push(['character', String(id)]); },
        setCharacterName: name => { scope.name2 = name; },
        uuidv4: () => 'fresh-integrity',
        $: selector => ({ val(value) { calls.push(['control', selector, value]); } }),
        getRequestHeaders: () => ({}),
        getCurrentChatId: () => scope.characters[scope.this_chid]?.chat,
        loadItemizedPrompts: async id => calls.push(['load-prompts', id]),
        prepareItemizedPrompts: chatId => ({ chatId, pending: Promise.resolve() }),
        applyPreparedItemizedPrompts: async preparation => scope.loadItemizedPrompts(preparation.chatId),
        fetch: async (url, config) => { calls.push(['request', url, JSON.parse(config.body)]); return {
            ok: options.headerOk !== false,
            json: async () => options.header || { chat_metadata: { integrity: 'existing-integrity', card_state: { enabled: true } } },
        }; },
        eventSource: { emit: () => { throw new Error('Headless activation must not emit lifecycle events'); } },
        select_selected_character: () => { throw new Error('Headless activation must not bind editor'); },
        getChat: () => { throw new Error('Headless activation must not load provisional messages'); },
        saveSettingsDebounced: () => { throw new Error('Headless activation must not save hidden editor'); },
        toastr: { info() {} },
    };
    vm.createContext(scope);
    vm.runInContext(headlessSource, scope);
    return { scope, calls };
}

test('headless activation clears once under the old identity and binds the genuine mirror header', async () => {
    const { scope, calls } = fixture();
    const result = await scope.activateCharacterForChat(1, { chatName: 'Homer-target' });
    assert.equal(result.characterId, '1'); assert.equal(result.chatId, 'Homer-target');
    assert.equal(scope.name2, 'New'); assert.equal(scope.this_edit_mes_id, undefined);
    assert.equal(scope.chat_metadata.integrity, 'existing-integrity');
    assert.equal(scope.chat_metadata.card_state.enabled, true);
    const clears = calls.filter(x => x[0] === 'clear');
    assert.equal(clears.length, 1); assert.equal(clears[0][1], '0'); assert.equal(clears[0][2], 'Old-chat');
    assert.equal(clears[0][3].preserveItemizedPrompts, true);
    assert.deepEqual(calls.find(x => x[0] === 'request').slice(1), ['/api/chats/get', {
        avatar_url: 'new.png', file_name: 'Homer-target', metadata_only: true,
    }]);
    assert.deepEqual(calls.find(x => x[0] === 'load-prompts'), ['load-prompts', 'Homer-target']);
    assert.deepEqual(calls.filter(x => x[0] === 'control'), [['control', '#selected_chat_pole', 'Homer-target']]);
});

test('same character uses one clear and no editor; preview never reads normal mirror data', async () => {
    const { scope, calls } = fixture();
    await scope.activateCharacterForChat('0', { chatName: 'Preview', ephemeral: true });
    assert.equal(calls.filter(x => x[0] === 'clear').length, 1);
    assert.equal(calls.find(x => x[0] === 'clear')[3].preserveItemizedPrompts, false);
    assert.equal(calls.filter(x => ['request', 'load-prompts'].includes(x[0])).length, 0);
    assert.equal(scope.chat_metadata.integrity, 'fresh-integrity');
});

test('unshallow replacement is re-read and an incomplete card fails before clearing old chat', async () => {
    const good = fixture();
    good.scope.characters[1].shallow = true;
    good.scope.unshallowCharacter = async () => { good.scope.characters[1] = { name: 'Full', avatar: 'full.png' }; };
    await good.scope.activateCharacterForChat(1, { chatName: 'Target' });
    assert.equal(good.scope.name2, 'Full');
    assert.equal(good.calls.find(x => x[0] === 'request')[2].avatar_url, 'full.png');
    const broken = fixture(); broken.scope.characters[1].shallow = true;
    await assert.rejects(broken.scope.activateCharacterForChat(1, { chatName: 'Target' }), /完整读取/);
    assert.equal(broken.scope.this_chid, '0'); assert.equal(broken.calls.filter(x => x[0] === 'clear').length, 0);
});

test('missing target, generation, saving timeout and bad mirror header fail explicitly', async () => {
    const missing = fixture(); await assert.rejects(missing.scope.activateCharacterForChat(99, { chatName: 'Target' }), /角色不存在/);
    const invalid = fixture(); await assert.rejects(invalid.scope.activateCharacterForChat(1, { chatName: '' }), /标识无效/);
    const generating = fixture(); generating.scope.is_send_press = true;
    await assert.rejects(generating.scope.activateCharacterForChat(1, { chatName: 'Target' }), /正在生成/);
    const saving = fixture(); saving.scope.isChatSaving = true;
    await assert.rejects(saving.scope.activateCharacterForChat(1, { chatName: 'Target' }), /save timeout/);
    assert.equal(saving.calls.length, 0);
    const header = fixture({ headerOk: false });
    await assert.rejects(header.scope.activateCharacterForChat(1, { chatName: 'Target' }), /存档标识/);
});

test('generation beginning during unshallow is rejected before clearing', async () => {
    const { scope, calls } = fixture(); scope.unshallowCharacter = async () => { scope.is_send_press = true; };
    await assert.rejects(scope.activateCharacterForChat(1, { chatName: 'Target' }), /正在生成/);
    assert.equal(calls.length, 0); assert.equal(scope.this_chid, '0');
});

test('a save starting during the shallow-card request still gates clearing', async () => {
    const { scope, calls } = fixture(); scope.unshallowCharacter = async () => { scope.isChatSaving = true; };
    await assert.rejects(scope.activateCharacterForChat(1, { chatName: 'Target' }), /save timeout/);
    assert.equal(calls.length, 0); assert.equal(scope.this_chid, '0');
});

test('existing administrator selection retains its original editor defaults', async () => {
    const { scope } = fixture(); let editorCalls = 0;
    scope.select_selected_character = (id, options) => {
        editorCalls++; assert.equal(id, '0'); assert.equal(options.switchMenu, true); assert.equal(options.persistSelection, true);
    };
    vm.runInContext(selectSource, scope);
    await scope.selectCharacterById('0'); assert.equal(editorCalls, 1);
});

test('depth index exactly matches original ranks including hidden/system/truncated original indices', () => {
    const messages = [{}, { is_system: true }, { is_user: true }, {}, { is_system: true }, {}];
    const batch = createMessageDepthBatch(messages);
    for (const i of [-1, 0, 1, 2, 3, 4, 5, 6, NaN, 1.5, '2', null, '']) {
        assert.equal(batch.depth(i), getMessageDepth(messages, i));
    }
    assert.equal(batch.depth(3), 1); assert.equal(batch.depth(1), undefined);
});

test('one synchronous plain-message batch eliminates whole-chat scans per message', () => {
    const messages = Array.from({ length: 2000 }, (_, i) => ({ is_system: i % 7 === 0 }));
    let maps = 0, slices = 0;
    messages.map = function (...args) { maps++; return Array.prototype.map.apply(this, args); };
    messages.slice = function (...args) { slices++; return Array.prototype.slice.apply(this, args); };
    const batch = createMessageDepthBatch(messages);
    for (let i = 0; i < messages.length; i++) batch.depth(i);
    assert.equal(maps, 0); assert.equal(slices, 1);
});

test('append/remove/target replacement and explicit stateful-macro invalidation rebuild depths', () => {
    const messages = [{}, {}, {}], batch = createMessageDepthBatch(messages);
    assert.equal(batch.depth(0), 2); messages.push({}); assert.equal(batch.depth(0), 3);
    messages.pop(); assert.equal(batch.depth(0), 2);
    messages[0] = { is_system: true }; assert.equal(batch.depth(0), undefined);
    messages[1].is_system = true; batch.invalidate(); assert.equal(batch.depth(2), 0); assert.equal(batch.depth(1), undefined);
});

test('stateful flag accessors use the original live scan without extra getter evaluation', () => {
    let reads = 0;
    const messages = [{}, Object.defineProperty({}, 'is_system', { get() { reads++; return false; } }), {}];
    const batch = createMessageDepthBatch(messages); assert.equal(batch.depth(0), 2); assert.equal(reads, 1);
    assert.equal(batch.depth(0), 2); assert.equal(reads, 2);
    assert.equal(batch.depth(-1), undefined); assert.equal(reads, 3);
});

test('legacy macro marker detection covers custom/legacy syntax and does not classify CSS as a macro', () => {
    for (const text of ['{{custom}}', '{{setvar::x::1}}', '<uSeR>', '<bot>', '<char>', '<group>', '<charifnotgroup>']) {
        assert.equal(containsLegacyMacroSyntax(text), true);
    }
    assert.equal(containsLegacyMacroSyntax('.card { color: red; } <div>content</div>'), false);
    assert.equal(containsLegacyMacroSyntax('x'.repeat(3_000_000)), false);
});

function macroFixture(experimental = false) {
    let invalidations = 0, fieldReads = 0;
    const scope = {
        containsLegacyMacroSyntax, invalidateMessageDepthBatch: () => invalidations++,
        messageDepthBatch: {},
        power_user: { experimental_macro_engine: experimental }, name1: 'User', name2: 'Card', selected_group: null,
        accountStorage: { getItem: () => 'true' }, getGeneratingModel: () => 'model',
        getCharacterCardFields: () => { fieldReads++; return {}; },
        evaluateMacros: text => text, MacroEnvBuilder: { buildFromRawEnv: x => x }, MacroEngine: { evaluate: x => x },
    };
    vm.createContext(scope); vm.runInContext(`${legacySource}\n${substituteSource}`, scope);
    return { scope, invalidations: () => invalidations, fieldReads: () => fieldReads };
}

test('plain legacy substitution still eagerly evaluates card fields, without invalidating pure depth', () => {
    const f = macroFixture(); assert.equal(f.scope.substituteParams('plain'), 'plain');
    assert.equal(f.fieldReads(), 1); assert.equal(f.invalidations(), 0);
});

test('stateful character-field macros still execute and invalidate before handlers', () => {
    const f = macroFixture(); let handlerRuns = 0;
    f.scope.evaluateMacros = text => { if (text.includes('{{stateful}}')) { assert.ok(f.invalidations() > 0); handlerRuns++; } return text; };
    f.scope.getCharacterCardFields = () => { f.scope.substituteParams('{{stateful}}', { replaceCharacterCard: false }); return {}; };
    assert.equal(f.scope.substituteParams('plain'), 'plain'); assert.equal(handlerRuns, 1);
});

test('experimental arbitrary-text processors always invalidate and are not bypassed', () => {
    const f = macroFixture(true); let runs = 0;
    f.scope.MacroEngine.evaluate = text => { runs++; assert.ok(f.invalidations() > 0); return `${text}-processed`; };
    assert.equal(f.scope.substituteParams('plain'), 'plain-processed'); assert.equal(runs, 1);
});

test('render batch remains synchronous/finally-scoped and formatting pipeline is not cached', () => {
    const render = extract('export async function redisplayChat(', 'export function scrollOnMediaLoad()');
    assert.match(render, /finally\s*\{\s*messageDepthBatch = previousDepthBatch;/);
    assert.match(source, /mes = getRegexedString\(mes, regexPlacement,/);
    assert.match(source, /converter\.makeHtml\(/);
    assert.match(source, /DOMPurify\.sanitize\(/);
    assert.doesNotMatch(render, /cachedHTML|htmlCache|formattedCache/);
});

test('actual redisplayChat restores its previous batch on normal return and a renderer exception', async () => {
    const calls = [];
    const messageElement = () => ({ 0: { classList: { add() {} } } });
    const chain = { removeClass() {}, filter() { return this; }, nextAll() { return this; }, addBack() { return this; }, remove() {} };
    const scope = {
        chat: [{}, {}, {}], createMessageDepthBatch, getMessageDepth,
        chatElement: { find: () => chain, append() {} },
        performance: { now: () => 0 }, console: { info() {} },
        lodash: { range: () => [] }, applyCharacterTagsToMessageDivs() {}, refreshSwipeButtons() {}, applyStylePins() {}, updateEditArrowClasses() {},
        updateMessageElement: (_, { messageId }) => { calls.push(vm.runInContext(`messageDepthBatch.depth(${messageId})`, scope)); return messageElement(); },
    };
    vm.createContext(scope);
    vm.runInContext(`let messageDepthBatch = null;\n${extract('export async function redisplayChat(', 'export function scrollOnMediaLoad()')}`, scope);
    await scope.redisplayChat(); assert.deepEqual(calls, [2, 1, 0]);
    assert.equal(vm.runInContext('messageDepthBatch', scope), null);
    const previous = { retained: true }; scope.previous = previous;
    vm.runInContext('messageDepthBatch = previous', scope);
    scope.updateMessageElement = () => { throw new Error('renderer failure'); };
    await assert.rejects(scope.redisplayChat(), /renderer failure/);
    assert.equal(vm.runInContext('messageDepthBatch', scope), previous);
});
