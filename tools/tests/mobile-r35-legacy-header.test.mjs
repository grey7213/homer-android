import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const clientSource = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../../sillytavern-runtime/src/endpoints/chats.js', import.meta.url), 'utf8');

function extract(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `Missing source boundary: ${startMarker}`);
    return source.slice(start, end).replace(/^export /gm, '');
}

const binder = extract(clientSource, 'export async function bindCharacterChatWithoutLoad(', '////////// OPTIMZED MAIN API');
const integrityCheck = extract(serverSource, 'async function checkChatIntegrity(', '\n/**');
const integrityError = extract(serverSource, 'class IntegrityMismatchError extends Error', '\n/**');
const saveChat = extract(serverSource, 'export async function trySaveChat(', "router.post('/save'");

function clientFixture(payload = {}, { ok = true, readError, networkError } = {}) {
    const calls = [];
    const cleared = [];
    let jsonReads = 0;
    const scope = {
        characters: [{ name: 'Fixture card', avatar: 'fixture-card.png' }], this_chid: 0,
        chat: [{ mes: 'existing in-memory message' }],
        isChatSaving: false, debounce_timeout: { extended: 1 },
        waitUntilCondition: async predicate => { assert.equal(predicate(), true); },
        clearChat: async options => { cleared.push(options); scope.chat.length = 0; },
        uuidv4: () => 'fresh-fixture-integrity', $: () => ({ val() {} }),
        getRequestHeaders: () => ({}), getCurrentChatId: () => 'Homer-fixture',
        loadItemizedPrompts: async () => {},
        prepareItemizedPrompts: chatId => ({ chatId, pending: Promise.resolve() }),
        applyPreparedItemizedPrompts: async preparation => scope.loadItemizedPrompts(preparation.chatId),
        fetch: async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            if (networkError) throw networkError;
            return { ok, json: async () => {
                jsonReads++;
                if (readError) throw readError;
                return payload;
            } };
        },
    };
    vm.createContext(scope);
    vm.runInContext(binder, scope);
    return { scope, calls, cleared, get jsonReads() { return jsonReads; } };
}

// The actual backend functions run against an in-memory filesystem only.
// This verifies the existing integrity contract without force or real data writes.
function serverFixture(header) {
    const path = '/fixtures/chat.jsonl';
    const files = new Map(header === undefined ? [] : [[path, JSON.stringify(header) + '\n' + JSON.stringify({ mes: 'old fixture message' })]]);
    const writes = [];
    const backups = [];
    const scope = {
        checkIntegrity: true,
        fs: { existsSync: target => files.has(target) },
        readFirstLine: async target => files.get(target).split('\n')[0],
        tryParse: text => { try { return JSON.parse(text); } catch { return null; } },
        tryWriteFileSync: (target, data) => { writes.push({ target, data }); files.set(target, data); },
        getBackupFunction: () => (...args) => backups.push(args),
        console: { debug() {} },
    };
    vm.createContext(scope);
    vm.runInContext(integrityCheck + '\n' + integrityError + '\n' + saveChat, scope);
    return { scope, files, writes, backups, path };
}

const persistedHeader = {
    user_name: 'Fixture user', character_name: 'Fixture card',
    chat_metadata: { integrity: 'persisted-fixture-integrity', custom: { enabled: true }, greeting: 2 },
};

test('current metadata-only object preserves integrity and extension metadata', async () => {
    const fixture = clientFixture({ chat_metadata: persistedHeader.chat_metadata });
    await fixture.scope.bindCharacterChatWithoutLoad('Homer-fixture');
    assert.equal(fixture.scope.chat_metadata.integrity, persistedHeader.chat_metadata.integrity);
    assert.equal(fixture.scope.chat_metadata.custom.enabled, true);
    assert.equal(fixture.scope.chat_metadata.greeting, 2);
    assert.equal(fixture.scope.chat.length, 0);
    assert.deepEqual(fixture.calls, [{ url: '/api/chats/get', body: {
        avatar_url: 'fixture-card.png', file_name: 'Homer-fixture', metadata_only: true,
    } }]);
});

test('legacy full JSONL array reads only its header, not messages', async () => {
    const message = { get mes() { throw new Error('Legacy messages must not be installed or formatted'); } };
    const fixture = clientFixture([persistedHeader, message]);
    const originalChat = fixture.scope.chat;
    const originalMessage = originalChat[0];
    await fixture.scope.bindCharacterChatWithoutLoad('Homer-fixture', { skipClear: true });
    assert.equal(fixture.scope.chat_metadata.integrity, persistedHeader.chat_metadata.integrity);
    assert.equal(fixture.scope.chat_metadata.custom.enabled, true);
    assert.equal(fixture.scope.chat_metadata.greeting, 2);
    assert.equal(fixture.scope.chat, originalChat);
    assert.equal(fixture.scope.chat[0], originalMessage);
    assert.equal(fixture.cleared.length, 0);
    assert.equal(fixture.calls.length, 1);
});

for (const [label, payload] of [['object', {}], ['array', []], ['empty header', [{}]], ['null', null]]) {
    test(`empty ${label} retains the newly created mirror identity`, async () => {
        const fixture = clientFixture(payload);
        await fixture.scope.bindCharacterChatWithoutLoad('Homer-new');
        assert.equal(fixture.scope.chat_metadata.integrity, 'fresh-fixture-integrity');
        assert.equal(fixture.calls.length, 1);
    });
}

test('legacy header without integrity preserves other metadata and creates an identity', async () => {
    const fixture = clientFixture([{ chat_metadata: { custom: { enabled: true } } }]);
    await fixture.scope.bindCharacterChatWithoutLoad('Homer-fixture');
    assert.equal(fixture.scope.chat_metadata.integrity, 'fresh-fixture-integrity');
    assert.equal(fixture.scope.chat_metadata.custom.enabled, true);
});

test('HTTP failure rejects without consuming JSON, retrying or requesting force', async () => {
    const fixture = clientFixture([persistedHeader], { ok: false });
    await assert.rejects(fixture.scope.bindCharacterChatWithoutLoad('Homer-fixture'), /存档标识/);
    assert.equal(fixture.jsonReads, 0);
    assert.equal(fixture.calls.length, 1);
    assert.equal('force' in fixture.calls[0].body, false);
});

test('invalid JSON and network failure reject rather than claiming a successful bind', async () => {
    const invalid = clientFixture({}, { readError: new SyntaxError('fixture invalid JSON') });
    await assert.rejects(invalid.scope.bindCharacterChatWithoutLoad('Homer-fixture'), /fixture invalid JSON/);
    assert.equal(invalid.calls.length, 1);
    const unavailable = clientFixture({}, { networkError: new Error('fixture unavailable') });
    await assert.rejects(unavailable.scope.bindCharacterChatWithoutLoad('Homer-fixture'), /fixture unavailable/);
    assert.equal(unavailable.jsonReads, 0);
    assert.equal(unavailable.calls.length, 1);
});

test('ephemeral admin preview never reads or installs a normal mirror header', async () => {
    const fixture = clientFixture([persistedHeader]);
    await fixture.scope.bindCharacterChatWithoutLoad('preview-fixture', { ephemeral: true });
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.scope.chat_metadata.integrity, 'fresh-fixture-integrity');
});

for (const [label, payload] of [['object', { chat_metadata: persistedHeader.chat_metadata }], ['legacy array', [persistedHeader, { mes: 'old fixture message' }]]]) {
    test(`${label} reopen passes the actual backend save integrity check without force`, async () => {
        const client = clientFixture(payload);
        await client.scope.bindCharacterChatWithoutLoad('Homer-fixture');
        const server = serverFixture(persistedHeader);
        const nextChat = [{ chat_metadata: client.scope.chat_metadata }, { mes: 'new fixture reply' }];
        await server.scope.trySaveChat(nextChat, server.path, false, 'fixture-handle', 'fixture-card', '/fixtures/backups');
        assert.equal(server.writes.length, 1);
        assert.equal(server.backups.length, 1);
        const savedHeader = JSON.parse(server.files.get(server.path).split('\n')[0]);
        assert.equal(savedHeader.chat_metadata.integrity, persistedHeader.chat_metadata.integrity);
        assert.equal(savedHeader.chat_metadata.custom.enabled, true);
        assert.equal(server.files.get(server.path).split('\n').length, 2);
    });
}

test('a wrong token is still rejected by the actual backend and cannot overwrite the mirror', async () => {
    const server = serverFixture(persistedHeader);
    const original = server.files.get(server.path);
    await assert.rejects(server.scope.trySaveChat([
        { chat_metadata: { integrity: 'wrong-fixture-integrity' } }, { mes: 'rejected fixture reply' },
    ], server.path, false, 'fixture-handle', 'fixture-card', '/fixtures/backups'), /integrity check failed/);
    assert.equal(server.writes.length, 0);
    assert.equal(server.backups.length, 0);
    assert.equal(server.files.get(server.path), original);
});

test('an empty legacy response can create a genuinely new mirror under normal integrity rules', async () => {
    const client = clientFixture([]);
    await client.scope.bindCharacterChatWithoutLoad('Homer-new');
    const server = serverFixture();
    await server.scope.trySaveChat([{ chat_metadata: client.scope.chat_metadata }, { mes: 'first fixture greeting' }],
        server.path, false, 'fixture-handle', 'fixture-card', '/fixtures/backups');
    assert.equal(server.writes.length, 1);
    assert.equal(JSON.parse(server.files.get(server.path).split('\n')[0]).chat_metadata.integrity, 'fresh-fixture-integrity');
});
