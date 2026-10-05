import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function activateCharacterForChat(');
const end = source.indexOf('////////// OPTIMZED MAIN API', start);
assert.ok(start >= 0 && end > start);
const functions = source.slice(start, end).replaceAll('export ', '');
const promptSource = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/itemized-prompts.js', import.meta.url), 'utf8');
const promptStart = promptSource.indexOf('export function prepareItemizedPrompts(');
const promptEnd = promptSource.indexOf('export async function saveItemizedPrompts(', promptStart);
assert.ok(promptStart >= 0 && promptEnd > promptStart);
const promptFunctions = promptSource.slice(promptStart, promptEnd).replaceAll('export ', '');
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(options = {}) {
    const calls = [], clear = deferred(), header = deferred();
    const oldMetadata = { integrity: 'old-integrity', oldState: true };
    const scope = {
        characters: [{ name: 'Old', avatar: 'old.png', chat: 'Old-chat' }, { name: 'New', avatar: 'new.png', chat: 'Other-chat' }],
        this_chid: '0', name2: 'Old', chat_metadata: oldMetadata,
        is_send_press: false, selected_group: null, is_group_generating: false, isChatSaving: false,
        this_edit_mes_id: 1, selected_button: '', debounce_timeout: { extended: 20 },
        waitUntilCondition: async condition => { if (!condition()) throw Error('save blocked'); },
        unshallowCharacter: async id => { calls.push(['full-card', id]); await options.onFullCard?.(scope); },
        clearChat: async config => {
            calls.push(['clear', scope.this_chid, scope.getCurrentChatId(), config]);
            await clear.promise;
            calls.push(['clear-complete', scope.this_chid, scope.getCurrentChatId()]);
        },
        cancelTtsPlay: () => calls.push(['tts']), resetSelectedGroup: () => { scope.selected_group = null; },
        setCharacterId: id => { scope.this_chid = String(id); calls.push(['publish-character', String(id)]); },
        setCharacterName: name => { scope.name2 = name; }, uuidv4: () => 'new-integrity',
        $: () => ({ val: value => calls.push(['selected-chat', value]) }),
        getRequestHeaders: () => ({ 'X-Test': 'synthetic-only' }),
        getCurrentChatId: () => scope.characters[scope.this_chid]?.chat,
        loadItemizedPrompts: async id => calls.push(['load-prompts', id, scope.getCurrentChatId()]),
        prepareItemizedPrompts: chatId => {
            calls.push(['read-prompts', chatId, scope.getCurrentChatId()]);
            return { chatId, pending: Promise.resolve({ prompts: [] }) };
        },
        applyPreparedItemizedPrompts: async preparation => scope.loadItemizedPrompts(preparation.chatId),
        fetch: async (url, config) => {
            calls.push(['metadata-read', url, JSON.parse(config.body)]);
            const response = await header.promise;
            return { ok: response.ok !== false, json: async () => {
                if (response.jsonError) throw response.jsonError;
                return response.payload;
            } };
        },
    };
    vm.createContext(scope); vm.runInContext(functions, scope);
    return { scope, calls, clear, header, oldMetadata };
}

test('cross-card metadata starts while the original chat is still being cleared/saved', async () => {
    const h = fixture(), work = h.scope.activateCharacterForChat(1, { chatName: 'Homer-target' });
    await tick();
    assert.equal(h.calls.filter(c => c[0] === 'metadata-read').length, 1);
    assert.ok(h.calls.findIndex(c => c[0] === 'metadata-read') < h.calls.findIndex(c => c[0] === 'clear'));
    assert.equal(h.scope.this_chid, '0'); assert.equal(h.scope.chat_metadata, h.oldMetadata);
    h.header.resolve({ payload: { chat_metadata: { integrity: 'target-integrity', retained: true } } });
    await tick();
    assert.equal(h.scope.this_chid, '0', 'A ready target read cannot bypass the old durable clear');
    assert.equal(h.calls.filter(c => c[0] === 'load-prompts').length, 0);
    h.clear.resolve(); await work;
    assert.equal(h.calls.filter(c => c[0] === 'metadata-read').length, 1, 'The binder consumes this one read, not another GET');
    assert.equal(h.scope.chat_metadata.integrity, 'target-integrity');
    assert.equal(h.scope.chat_metadata.retained, true);
    assert.deepEqual(h.calls.find(c => c[0] === 'clear').slice(1, 3), ['0', 'Old-chat']);
    assert.deepEqual(h.calls.find(c => c[0] === 'load-prompts'), ['load-prompts', 'Homer-target', 'Homer-target']);
});

test('direct same-card binder also overlaps metadata, but does not install target state before both gates', async () => {
    const h = fixture(), work = h.scope.bindCharacterChatWithoutLoad('Homer-other');
    await tick();
    assert.equal(h.calls.filter(c => c[0] === 'metadata-read').length, 1);
    assert.equal(h.scope.characters[0].chat, 'Old-chat');
    h.clear.resolve(); await tick();
    assert.equal(h.scope.chat_metadata, h.oldMetadata);
    assert.equal(h.scope.characters[0].chat, 'Old-chat');
    h.header.resolve({ payload: [{ chat_metadata: { integrity: 'legacy-integrity', custom: 2 } }, { mes: 'unused legacy message' }] });
    await work;
    assert.equal(h.scope.chat_metadata.integrity, 'legacy-integrity');
    assert.equal(h.scope.chat_metadata.custom, 2);
    assert.equal(h.calls.filter(c => c[0] === 'metadata-read').length, 1);
});

test('old clear/save failure never applies an already fulfilled target mirror', async () => {
    const h = fixture(), work = h.scope.activateCharacterForChat(1, { chatName: 'Homer-target' });
    const rejected = assert.rejects(work, /old save failed/);
    await tick(); h.header.resolve({ payload: { chat_metadata: { integrity: 'target-integrity' } } });
    h.clear.reject(Error('old save failed')); await rejected;
    assert.equal(h.scope.this_chid, '0'); assert.equal(h.scope.chat_metadata, h.oldMetadata);
    assert.equal(h.calls.filter(c => c[0] === 'load-prompts').length, 0);
});

for (const [name, failure] of [
    ['HTTP', { ok: false }], ['JSON', { jsonError: new SyntaxError('bad JSON') }],
]) {
    test(`${name} metadata failure never publishes target role or metadata`, async () => {
        const h = fixture(), work = h.scope.activateCharacterForChat(1, { chatName: 'Homer-target' });
        const rejected = assert.rejects(work, /存档标识|bad JSON/);
        await tick(); h.header.resolve(failure); h.clear.resolve(); await rejected;
        assert.equal(h.scope.this_chid, '0'); assert.equal(h.scope.chat_metadata, h.oldMetadata);
        assert.equal(h.calls.filter(c => c[0] === 'load-prompts').length, 0);
    });
}

test('an early rejected target read remains handled when the old clear itself fails', async () => {
    const h = fixture(), work = h.scope.activateCharacterForChat(1, { chatName: 'Homer-target' });
    const rejected = assert.rejects(work, /old failure/);
    await tick(); h.header.reject(Error('metadata unavailable')); await tick();
    h.clear.reject(Error('old failure')); await rejected; await tick();
    assert.equal(h.scope.this_chid, '0'); assert.equal(h.scope.chat_metadata, h.oldMetadata);
});

test('ephemeral administrator activation clears normally without preparing any normal mirror read', async () => {
    const h = fixture(), work = h.scope.activateCharacterForChat(1, { chatName: 'Preview', ephemeral: true });
    await tick(); assert.equal(h.calls.filter(c => c[0] === 'metadata-read').length, 0);
    h.clear.resolve(); await work;
    assert.equal(h.scope.chat_metadata.integrity, 'new-integrity');
    assert.equal(h.calls.filter(c => c[0] === 'load-prompts').length, 0);
    assert.equal(h.calls.find(c => c[0] === 'clear')[3].preserveItemizedPrompts, false);
});

test('full-card validation and existing save/generation checks still precede target reads', async () => {
    for (const config of [
        { onFullCard: scope => { scope.characters[1].shallow = true; } },
        { onFullCard: scope => { scope.is_send_press = true; } },
        { onFullCard: scope => { scope.isChatSaving = true; } },
    ]) {
        const h = fixture(config);
        await assert.rejects(h.scope.activateCharacterForChat(1, { chatName: 'Homer-target' }), /完整读取|正在生成|save blocked/);
        assert.equal(h.calls.filter(c => c[0] === 'metadata-read').length, 0);
        assert.equal(h.calls.filter(c => c[0] === 'clear').length, 0);
    }
});

test('same-ID prompt preparation stays behind its old save, even while metadata reads overlap', async () => {
    const h = fixture(), work = h.scope.bindCharacterChatWithoutLoad('Old-chat');
    await tick();
    assert.equal(h.calls.filter(c => c[0] === 'metadata-read').length, 1);
    assert.equal(h.calls.filter(c => c[0] === 'read-prompts').length, 0);
    h.header.resolve({ payload: { chat_metadata: { integrity: 'same-integrity' } } });
    h.clear.resolve(); await work;
    assert.ok(h.calls.findIndex(c => c[0] === 'clear-complete') < h.calls.findIndex(c => c[0] === 'read-prompts'));
    assert.deepEqual(h.calls.find(c => c[0] === 'load-prompts'), ['load-prompts', 'Old-chat', 'Old-chat']);
});

test('both independent read outcomes settle before publishing the target metadata and loaded event', async () => {
    for (const headerFirst of [true, false]) {
        const h = fixture(), prompts = deferred();
        h.scope.prepareItemizedPrompts = chatId => {
            h.calls.push(['read-prompts', chatId]);
            return { chatId, pending: prompts.promise };
        };
        const work = h.scope.activateCharacterForChat(1, { chatName: 'Homer-target' });
        await tick(); h.clear.resolve();
        const releaseHeader = () => h.header.resolve({ payload: { chat_metadata: { integrity: 'target-integrity' } } });
        const releasePrompts = () => prompts.resolve({ prompts: [] });
        (headerFirst ? releaseHeader : releasePrompts)(); await tick();
        assert.equal(h.scope.chat_metadata, h.oldMetadata);
        assert.equal(h.scope.this_chid, '0');
        assert.equal(h.calls.filter(c => c[0] === 'load-prompts').length, 0);
        (headerFirst ? releasePrompts : releaseHeader)(); await work;
        assert.equal(h.scope.chat_metadata.integrity, 'target-integrity');
        assert.equal(h.calls.filter(c => c[0] === 'read-prompts').length, 1);
        assert.equal(h.calls.filter(c => c[0] === 'load-prompts').length, 1);
    }
});

for (const [name, payload] of [['empty object', {}], ['empty array', []], ['null', null]]) {
    test(`${name} mirror headers retain the genuine new identity fallback`, async () => {
        const h = fixture(), work = h.scope.activateCharacterForChat(1, { chatName: 'Homer-new' });
        await tick(); h.header.resolve({ payload }); h.clear.resolve(); await work;
        assert.equal(h.scope.chat_metadata.integrity, 'new-integrity');
        assert.equal(h.calls.filter(c => c[0] === 'metadata-read').length, 1);
    });
}

for (const sameChat of [false, true]) {
    test(`actual prompt loaded event sees only fully bound metadata (${sameChat ? 'same' : 'cross'} chat)`, async () => {
        const h = fixture(), targetId = sameChat ? 'Old-chat' : 'Homer-target';
        const oldPrompts = [{ mesId: 0, rawPrompt: 'synthetic unsaved old prompt' }];
        const targetPrompts = [{ mesId: 1, rawPrompt: 'synthetic persisted target prompt' }];
        let storedPrompts = sameChat ? [] : targetPrompts;
        h.scope.itemizedPrompts = oldPrompts;
        h.scope.promptStorage = { getItem: async chatId => {
            h.calls.push(['actual-read-prompts', chatId]);
            return storedPrompts;
        } };
        h.scope.event_types = { ITEMIZED_PROMPTS_LOADED: 'itemized-loaded' };
        h.scope.eventSource = { emit: async (type, payload) => {
            h.calls.push(['actual-loaded-event', type, payload.chatId]);
            assert.equal(h.scope.getCurrentChatId(), targetId);
            assert.equal(h.scope.this_chid, sameChat ? '0' : '1');
            assert.equal(h.scope.chat_metadata.integrity, 'target-integrity');
            assert.equal(h.scope.chat_metadata.retained, true);
            assert.equal(h.scope.itemizedPrompts, sameChat ? oldPrompts : targetPrompts);
        } };
        // The product's legacy error handling catches listener failures, so
        // collect them explicitly: an assertion in a listener must fail this test.
        const eventFailures = [];
        const emit = h.scope.eventSource.emit;
        h.scope.eventSource.emit = async (...args) => {
            try { await emit(...args); } catch (error) { eventFailures.push(error); throw error; }
        };
        h.scope.console = { log: () => {} };
        h.scope.clearChat = async () => {
            h.calls.push(['actual-save-start']);
            await h.clear.promise;
            if (sameChat) storedPrompts = oldPrompts;
            h.calls.push(['actual-save-complete']);
        };
        vm.runInContext(promptFunctions, h.scope);
        const work = sameChat
            ? h.scope.bindCharacterChatWithoutLoad(targetId)
            : h.scope.activateCharacterForChat(1, { chatName: targetId });
        await tick();
        assert.equal(h.calls.filter(c => c[0] === 'actual-read-prompts').length, sameChat ? 0 : 1);
        assert.equal(h.scope.itemizedPrompts, oldPrompts);
        h.header.resolve({ payload: { chat_metadata: { integrity: 'target-integrity', retained: true } } });
        await tick();
        assert.equal(h.scope.chat_metadata, h.oldMetadata);
        assert.equal(h.calls.filter(c => c[0] === 'actual-loaded-event').length, 0);
        h.clear.resolve();
        await work;
        assert.deepEqual(eventFailures, []);
        assert.equal(h.calls.filter(c => c[0] === 'actual-read-prompts').length, 1);
        assert.equal(h.calls.filter(c => c[0] === 'actual-loaded-event').length, 1);
        if (sameChat) {
            assert.ok(h.calls.findIndex(c => c[0] === 'actual-save-complete')
                < h.calls.findIndex(c => c[0] === 'actual-read-prompts'));
        }
    });
}
