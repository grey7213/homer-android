import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { createCardPreparationCache, fingerprintCardJson } from '../../sillytavern-runtime/public/scripts/homer-stable-template.mjs';

const server = readFileSync(new URL('../../sillytavern-runtime/src/endpoints/characters.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const _ = createRequire(new URL('../../sillytavern-runtime/package.json', import.meta.url))('lodash');
console.log('Actual source SHA256:', JSON.stringify(Object.fromEntries(Object.entries({ server, bridge, core }).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]))));

function section(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Shipping source boundaries: ${start}`);
    return source.slice(first, last);
}
const helperAt = server.indexOf('function getHomerShallowMarker(');
const projectionAt = server.indexOf('const calculateDataSize =');
const projectionSource = server.slice(helperAt < 0 ? projectionAt : Math.min(helperAt, projectionAt), server.indexOf('const processCharacter =', projectionAt));
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const avatarFor = id => `homer-${String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'character'}.png`;

function card(description = 'Fixture authored source') {
    return { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Fixture card',
        description, first_mes: 'Fixture opening', extensions: { regex_scripts: [{ findRegex: 'fixture', replaceString: 'Fixture authored replacement' }] } } };
}
function fullCharacter({ appId = 'fixture-app', sourceCard = card(), marker = null, avatar = avatarFor(appId) } = {}) {
    return { name: 'Fixture card', avatar, chat: 'Fixture previous chat', fav: false, tags: ['fixture'],
        date_added: 123, create_date: 'fixture-date', date_last_chat: 456, chat_size: 100, data_size: 200,
        json_data: 'Fixture raw JSON must not appear in the projection', description: 'Fixture full source',
        data: { ...plain(sourceCard.data), character_version: '1', creator: 'Fixture creator', creator_notes: 'Fixture notes', tags: ['fixture'],
            extensions: { ...plain(sourceCard.data.extensions), fav: true, world: 'Fixture world',
                homer_bridge: marker ?? { app_id: appId, source: 'homer-cloud', card_signature: fingerprintCardJson(JSON.stringify(sourceCard)),
                    imported_at: 'fixture-time', private_author_source: 'Fixture excluded metadata' } } } };
}
function providerScope(extra = {}) {
    const scope = vm.createContext({ _, console, ...extra });
    vm.runInContext(projectionSource + '\nthis.project = toShallow;', scope);
    return scope;
}
const oldProjection = value => ({ shallow: true, name: value.name, avatar: value.avatar, chat: value.chat,
    fav: value.fav, date_added: value.date_added, create_date: value.create_date, date_last_chat: value.date_last_chat,
    chat_size: value.chat_size, data_size: value.data_size, tags: value.tags,
    data: { name: _.get(value, 'data.name', ''), character_version: _.get(value, 'data.character_version', ''),
        creator: _.get(value, 'data.creator', ''), creator_notes: _.get(value, 'data.creator_notes', ''), tags: _.get(value, 'data.tags', []),
        extensions: { fav: _.get(value, 'data.extensions.fav', false), world: _.get(value, 'data.extensions.world', '') } } });

test('valid imported marker adds only app ID and revision signature; ordinary projection bytes stay intact', () => {
    const value = fullCharacter(), before = JSON.stringify(value), projected = providerScope().project(value);
    assert.deepEqual(plain(projected.data.extensions.homer_bridge), { app_id: 'fixture-app', card_signature: value.data.extensions.homer_bridge.card_signature });
    const legacy = plain(projected); delete legacy.data.extensions.homer_bridge;
    assert.equal(JSON.stringify(legacy), JSON.stringify(oldProjection(value)));
    assert.equal(JSON.stringify(value), before, 'Projection must not modify canonical imported card data');
    for (const forbidden of ['imported_at', 'private_author_source', 'regex_scripts', 'json_data', 'source']) assert.ok(!JSON.stringify(projected).includes('"' + forbidden + '"'));
});

test('non-Homer source, mismatched real avatar and missing marker keep exact previous JSON projection', () => {
    const values = [fullCharacter({ marker: { source: 'other', app_id: 'fixture-app', card_signature: 'valid' } }),
        fullCharacter({ avatar: 'ordinary.png' }), fullCharacter({ avatar: 'homer-another-app.png' }), fullCharacter({ avatar: '../homer-fixture-app.png' })];
    const absent = fullCharacter(); delete absent.data.extensions.homer_bridge; values.push(absent);
    for (const value of values) assert.equal(JSON.stringify(providerScope().project(value)), JSON.stringify(oldProjection(value)));
});

test('missing or null data/extension namespaces retain the old default projection bytes', () => {
    const absentData = fullCharacter(); delete absentData.data;
    const nullData = fullCharacter(); nullData.data = null;
    const absentExtensions = fullCharacter(); delete absentExtensions.data.extensions;
    const nullExtensions = fullCharacter(); nullExtensions.data.extensions = null;
    for (const value of [absentData, nullData, absentExtensions, nullExtensions]) assert.equal(JSON.stringify(providerScope().project(value)), JSON.stringify(oldProjection(value)));
});

test('app ID and signature invalid JSON types and lengths never expose marker fields', () => {
    const markers = [null, [], 'homer-cloud', 7, true,
        ...[null, {}, [], true, '', NaN, Infinity, -Infinity, 'x'.repeat(161)].map(app_id => ({ source: 'homer-cloud', app_id, card_signature: 'valid' })),
        ...[null, {}, [], false, 7, '', 's'.repeat(161)].map(card_signature => ({ source: 'homer-cloud', app_id: 'fixture-app', card_signature })),
    ];
    for (const marker of markers) {
        const value = fullCharacter(); value.data.extensions.homer_bridge = marker;
        assert.equal(JSON.stringify(providerScope().project(value)), JSON.stringify(oldProjection(value)));
    }
});

test('numeric, sanitized, maximum-length and fallback app IDs bind to their exact actual avatar', () => {
    for (const appId of [0, 42, -3.5, 'fixture/with spaces', 'x'.repeat(160), '!!!']) {
        const marker = { source: 'homer-cloud', app_id: appId, card_signature: 's'.repeat(160) };
        const value = fullCharacter({ appId, marker });
        assert.deepEqual(plain(providerScope().project(value).data.extensions.homer_bridge), { app_id: String(appId), card_signature: marker.card_signature });
        value.avatar += '.bak'; assert.equal(JSON.stringify(providerScope().project(value)), JSON.stringify(oldProjection(value)));
    }
});

test('JSON prototype/constructor keys are neither spread nor allowed to alter the output prototype', () => {
    const value = fullCharacter();
    value.data.extensions.homer_bridge = JSON.parse('{"source":"homer-cloud","app_id":"fixture-app","card_signature":"valid","__proto__":{"r37Polluted":true},"constructor":{"prototype":{"r37Polluted":true}},"prototype":{"r37Polluted":true}}');
    const projected = providerScope().project(value);
    assert.deepEqual(plain(projected.data.extensions.homer_bridge), { app_id: 'fixture-app', card_signature: 'valid' });
    assert.equal(Object.hasOwn(projected.data.extensions.homer_bridge, '__proto__'), false);
    assert.equal(Object.hasOwn(projected.data.extensions.homer_bridge, 'constructor'), false);
    assert.equal(projected.data.extensions.homer_bridge.r37Polluted, undefined); assert.equal({}.r37Polluted, undefined);
});

test('actual /all and processCharacter project only the authenticated user directory', async () => {
    const lists = new Map([['owner-a/characters', ['homer-fixture-app.png']], ['owner-b/characters', ['homer-fixture-app.png']]]);
    const rawCards = new Map([['owner-a/characters/homer-fixture-app.png', fullCharacter({ marker: { source: 'homer-cloud', app_id: 'fixture-app', card_signature: 'owner-a-revision' } })],
        ['owner-b/characters/homer-fixture-app.png', fullCharacter({ marker: { source: 'homer-cloud', app_id: 'fixture-app', card_signature: 'owner-b-revision' } })]]);
    const reads = [], routes = new Map();
    const scope = providerScope({ path: path.posix, useShallowCharacters: true,
        router: { post(name, handler) { routes.set(name, handler); } },
        fs: { readdirSync: directory => lists.get(directory) || [], statSync: () => ({ ctimeMs: 123 }), existsSync: directory => lists.has(directory) },
        readCharacterData: async file => { reads.push(file); return JSON.stringify(rawCards.get(file)); }, getCharaCardV2: value => value,
    });
    vm.runInContext(section(server, 'const calculateChatSize =', '// Calculate the total string length')
        + section(server, 'const processCharacter =', 'function getCharaCardV2(')
        + section(server, "router.post('/all',", "router.post('/get',") + '\nthis.process = processCharacter;', scope);
    for (const owner of ['owner-a', 'owner-b']) {
        let result;
        await routes.get('/all')({ user: { directories: { characters: owner + '/characters', chats: owner + '/chats' } } }, { send(value) { result = value; } });
        assert.equal(result.length, 1); assert.equal(result[0].data.extensions.homer_bridge.card_signature, owner + '-revision');
        assert.equal(result[0].json_data, undefined); assert.equal(reads.at(-1), owner + '/characters/homer-fixture-app.png');
        const full = await scope.process('homer-fixture-app.png', { characters: owner + '/characters', chats: owner + '/chats' }, { shallow: false });
        assert.equal(full.data.extensions.homer_bridge.source, 'homer-cloud');
        assert.equal(full.data.extensions.homer_bridge.card_signature, owner + '-revision');
        assert.equal(typeof full.json_data, 'string'); assert.ok(full.data.extensions.regex_scripts.length);
    }
});

function importerHarness({ sourceCard = card(), storedCard = sourceCard, owner = 'fixture-owner', appId = 'fixture-app', storedAppId = appId, marker = null, projection = true, ephemeral = false } = {}) {
    const imported = fullCharacter({ appId: storedAppId, sourceCard: storedCard, marker });
    const projected = projection ? plain(providerScope().project(imported)) : plain(imported);
    const calls = [], scopes = [], characters = [projected], serverCards = new Map([[imported.avatar, plain(imported)]]);
    const preparations = createCardPreparationCache();
    const state = { chatId: '', chatMetadata: {}, chat: [] };
    let scope;
    const context = { characters, ...state,
        get characterId() { return scope.this_chid; },
        getOneCharacter: (...args) => scope.getOneCharacter(...args),
    };
    scope = vm.createContext({ console, characters, this_chid: undefined, selected_group: null, is_group_generating: false,
        is_send_press: false, isChatSaving: false, chat_metadata: {},
        session: { user: { id: owner } }, launch: { app_id: appId, conversation_id: 'fixture-conversation', card: plain(sourceCard), admin_preview: ephemeral },
        reconcileStorageAccount: () => owner, storageAccountEpoch: 0,
        cardPreparations: { prepare(key, value) { scopes.push(key); return preparations.prepare(key, value); } },
        getContext: () => context, getCurrentChatId: () => context.chatId, pendingCardScriptCharacter: null,
        DOMPurify: { sanitize: value => value }, toastr: { error() {} }, getRequestHeaders: () => ({}),
        requestCachedCharacter: (avatar, { fetcher, headers }) => fetcher('/api/characters/get', {
            method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }),
        }),
        fetch: async (url, options) => {
            assert.equal(url, '/api/characters/get'); const avatar = JSON.parse(options.body).avatar_url; calls.push(['get', avatar]);
            return { ok: serverCards.has(avatar), json: async () => plain(serverCards.get(avatar)) };
        },
        importLaunchCardJson: async (value, preservedName) => {
            calls.push(['import', preservedName]); const avatar = preservedName + '.png';
            serverCards.set(avatar, { name: value.name, avatar, chat: 'Fixture imported chat', data: plain(value.data) }); return avatar;
        },
        syncLaunchCharacterAvatar: async (value, force) => { calls.push(['avatar', value.avatar, force]); },
        enableEmbeddedCardCapabilities: value => calls.push(['capabilities', Boolean(value.shallow)]),
        ensureEmbeddedWorldInfo: async (id, value) => { assert.equal(value.shallow, undefined); assert.equal(value.data.description, sourceCard.data.description); calls.push(['world', id]); },
        installCsrfAjaxBridge: () => calls.push(['csrf']), setOnlineStatus: () => calls.push(['online']), conversationModelSettings: () => ({ model_id: 'fixture-model' }),
        performance: { mark: name => calls.push(['mark', name]) },
        waitUntilCondition: async () => { throw new Error('Idle activation must not introduce a save wait'); }, debounce_timeout: { extended: 1 },
        cancelTtsPlay: () => calls.push(['cancel-tts']),
        clearChat: async options => { calls.push(['clear', plain(options)]); }, resetSelectedGroup: () => calls.push(['reset-group']),
        setCharacterId: id => { scope.this_chid = id; calls.push(['character', id]); }, setCharacterName: name => calls.push(['name', name]),
        bindCharacterChatWithoutLoad: async (name, options) => { context.chatId = name; calls.push(['bind', name, plain(options)]); },
        prepareCharacterChatMirror: (avatar, fileName) => ({ avatar, fileName, pending: Promise.resolve({ header: {} }),
            prompts: { chatId: fileName, pending: Promise.resolve() } }),
        prepareItemizedPrompts: chatId => ({ chatId, pending: Promise.resolve() }),
    });
    vm.runInContext([
        section(bridge, 'function cloneCardWithMarker(', 'async function waitForStableCharacterForm('),
        section(bridge, 'async function importLaunchCharacter(', 'function normalizeOpeningMessage('),
        section(bridge, 'async function openLaunchCharacterChat(', 'function getManagedCoverUrl('),
        section(bridge, 'function hasCanonicalConversationScope(', 'function assertCanonicalConversationScope('),
        section(core, 'export async function getOneCharacter(', 'export function getCharacterSource('),
        section(core, 'export async function unshallowCharacter(', 'export async function getChat('),
        section(core, 'export async function activateCharacterForChat(', 'export async function bindCharacterChatWithoutLoad('),
    ].join('\n').replace(/^export /gm, ''), scope);
    return { scope, calls, scopes, characters, imported, context, serverCards,
        run(options) { return scope.importLaunchCharacter(options); } };
}

test('unchanged actual shallow catalog causes zero imports but retains full GET, activation, clear, bind and world lifecycle', async () => {
    const h = importerHarness(); await h.run();
    assert.equal(h.calls.filter(call => call[0] === 'import').length, 0);
    assert.equal(h.calls.filter(call => call[0] === 'avatar').length, 0);
    assert.equal(h.calls.filter(call => call[0] === 'get').length, 1);
    assert.equal(h.characters[0].shallow, undefined); assert.equal(h.scope.this_chid, '0');
    assert.ok(h.calls.some(call => call[0] === 'clear' && call[1].clearData === true && call[1].preserveItemizedPrompts === true));
    assert.ok(h.calls.some(call => call[0] === 'bind' && call[2].skipClear === true));
    assert.ok(h.calls.some(call => call[0] === 'world')); assert.equal(h.scope.pendingCardScriptCharacter, h.characters[0]);
    assert.equal(h.context.chatId, 'Homer-fixture-conversation');
});

test('numeric zero uses the real importer fallback avatar, with no import and a normal complete GET/activation', async () => {
    const h = importerHarness({ appId: 0 });
    assert.equal(h.imported.avatar, 'homer-character.png');
    assert.equal(h.characters[0].data.extensions.homer_bridge.app_id, '0');
    await h.run();
    assert.equal(h.calls.filter(call => call[0] === 'import').length, 0);
    assert.equal(h.calls.filter(call => call[0] === 'avatar').length, 0);
    assert.deepEqual(h.calls.filter(call => call[0] === 'get'), [['get', 'homer-character.png']]);
    assert.equal(h.characters[0].shallow, undefined);
    assert.equal(h.characters[0].data.extensions.homer_bridge.app_id, 0);
    assert.ok(h.calls.some(call => call[0] === 'clear'));
    assert.ok(h.calls.some(call => call[0] === 'bind'));
    assert.ok(h.calls.some(call => call[0] === 'world'));
    assert.equal(h.scope.pendingCardScriptCharacter, h.characters[0]);
});

for (const [kind, storedAppId, appId] of [
    ['sanitized', 'fixture/app', 'fixtureapp'],
    ['truncated', 'x'.repeat(80) + '-old', 'x'.repeat(80) + '-new'],
]) {
    for (const projection of [true, false]) {
        test(`${kind} avatar collision from ${projection ? 'actual shallow catalog' : 'warm complete entry'} reimports the new app marker and passes the actual canonical scope predicate`, async () => {
            assert.notEqual(storedAppId, appId);
            assert.equal(avatarFor(storedAppId), avatarFor(appId));
            const h = importerHarness({ storedAppId, appId, projection });
            assert.equal(h.characters[0].data.extensions.homer_bridge.card_signature, fingerprintCardJson(JSON.stringify(h.scope.launch.card)));
            await h.run({ reuseActiveCharacter: true });
            assert.equal(h.characters[0].data.extensions.homer_bridge.app_id, appId, 'The activated full card must own the new application, even when authored JSON and filename coincide');
            assert.equal(h.calls.filter(call => call[0] === 'import').length, 1);
            assert.equal(h.calls.filter(call => call[0] === 'get').length, 1);
            assert.equal(h.calls.filter(call => call[0] === 'avatar').length, 1);
            assert.ok(h.calls.some(call => call[0] === 'clear'));
            assert.ok(h.calls.some(call => call[0] === 'world'));
            assert.equal(h.scope.pendingCardScriptCharacter, h.characters[0]);
            // Hydration's conversation marker is modeled here; the shipping predicate
            // independently validates the resulting full character app marker too.
            h.context.chatMetadata.homer_bridge = { user_id: 'fixture-owner', app_id: appId,
                conversation_id: 'fixture-conversation', runtime: 'dialogue' };
            assert.equal(h.scope.hasCanonicalConversationScope(h.context), true);
        });
    }
}

test('same app and version with changed authored source still reimports its fresh signature', async () => {
    const h = importerHarness({ storedCard: card('Fixture old authored source'), sourceCard: card('Fixture changed authored source') });
    await h.run(); assert.equal(h.calls.filter(call => call[0] === 'import').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'get').length, 1); assert.equal(h.calls.filter(call => call[0] === 'avatar').length, 1);
    assert.equal(h.characters[0].data.extensions.homer_bridge.card_signature, fingerprintCardJson(JSON.stringify(h.scope.launch.card)));
    assert.ok(h.calls.some(call => call[0] === 'world')); assert.equal(h.scope.pendingCardScriptCharacter, h.characters[0]);
});

test('already complete unchanged entries retain the existing warm no-import/no-full-read path and activation', async () => {
    const h = importerHarness({ projection: false }); await h.run();
    assert.equal(h.calls.filter(call => ['import', 'get', 'avatar'].includes(call[0])).length, 0);
    assert.ok(h.calls.some(call => call[0] === 'clear')); assert.ok(h.calls.some(call => call[0] === 'world'));
    assert.equal(h.scope.pendingCardScriptCharacter, h.characters[0]);
});

test('a rejected marker retains the old normal reimport path rather than bypassing validation', async () => {
    const h = importerHarness({ marker: { source: 'not-homer', app_id: 'fixture-app', card_signature: fingerprintCardJson(JSON.stringify(card())) } });
    await h.run(); assert.equal(h.calls.filter(call => call[0] === 'import').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'get').length, 1); assert.ok(h.calls.some(call => call[0] === 'world'));
});

test('actual preparations remain owner/app scoped and separate catalog objects do not cross owners', async () => {
    const a = importerHarness({ owner: 'owner-a' }), b = importerHarness({ owner: 'owner-b' });
    await a.run(); await b.run();
    assert.equal(a.scopes[0], JSON.stringify(['owner-a', 'fixture-app'])); assert.equal(b.scopes[0], JSON.stringify(['owner-b', 'fixture-app']));
    assert.notEqual(a.characters[0], b.characters[0]); assert.equal(a.calls.filter(call => call[0] === 'import').length, 0);
    assert.equal(b.calls.filter(call => call[0] === 'import').length, 0);
});

test('unchanged shallow preview still performs ephemeral activation instead of ordinary persistence', async () => {
    const h = importerHarness({ ephemeral: true }); await h.run();
    assert.equal(h.calls.filter(call => call[0] === 'import').length, 0);
    assert.ok(h.calls.some(call => call[0] === 'clear' && call[1].preserveItemizedPrompts === false));
    assert.ok(h.calls.some(call => call[0] === 'bind' && call[2].ephemeral === true));
});

test('shallow full-read failure fails activation without importing or enabling incomplete scripts', async () => {
    const h = importerHarness(); h.serverCards.clear();
    await assert.rejects(h.run(), /完整读取/);
    assert.equal(h.calls.filter(call => call[0] === 'import').length, 0);
    assert.equal(h.calls.filter(call => ['world', 'clear', 'character', 'bind'].includes(call[0])).length, 0);
    assert.equal(h.scope.pendingCardScriptCharacter, null);
});
