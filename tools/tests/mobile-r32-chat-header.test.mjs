import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function bindCharacterChatWithoutLoad(');
const fn = source.slice(start, source.indexOf('////////// OPTIMZED MAIN API', start)).replace('export ', '');
function fixture(header = {}, ok = true) {
    const calls = [];
    const scope = { characters: [{ name: 'Card', avatar: 'card.png' }], this_chid: 0,
        isChatSaving: false, debounce_timeout: { extended: 1 },
        waitUntilCondition: async () => {}, clearChat: async () => {},
        uuidv4: () => 'new-id', $: () => ({ val() {} }),
        getRequestHeaders: () => ({}), getCurrentChatId: () => 'chat', loadItemizedPrompts: async () => {},
        fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok, json: async () => header }; },
    };
    vm.createContext(scope); vm.runInContext(fn, scope);
    return { scope, calls };
}
test('reopen preserves local integrity without reading messages', async () => {
    const { scope, calls } = fixture({ chat_metadata: { integrity: 'existing-id', extension: { enabled: true } } });
    await scope.bindCharacterChatWithoutLoad('Homer-existing');
    assert.equal(scope.chat_metadata.integrity, 'existing-id');
    assert.equal(scope.chat_metadata.extension.enabled, true);
    assert.deepEqual(calls[0], { url: '/api/chats/get', body: { avatar_url: 'card.png', file_name: 'Homer-existing', metadata_only: true } });
});
test('new mirrors receive an identity but read failures never overwrite the old one', async () => {
    const fresh = fixture(); await fresh.scope.bindCharacterChatWithoutLoad('new');
    assert.equal(fresh.scope.chat_metadata.integrity, 'new-id');
    const broken = fixture({}, false);
    await assert.rejects(broken.scope.bindCharacterChatWithoutLoad('existing'), /存档标识/);
});
test('ephemeral admin preview does not read normal conversation metadata', async () => {
    const { scope, calls } = fixture(); await scope.bindCharacterChatWithoutLoad('preview', { ephemeral: true });
    assert.equal(calls.length, 0);
});
