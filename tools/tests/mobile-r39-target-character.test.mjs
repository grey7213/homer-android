import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createCardPreparationCache } from '../../sillytavern-runtime/public/scripts/homer-stable-template.mjs';

// Actual shipping functions with controlled HTTP/DOM peripherals. These tests
// use only synthetic cards/principals and are not browser timing evidence.
const core = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(source, first, last) {
    const begin = source.indexOf(first), end = source.indexOf(last, begin + first.length);
    assert.ok(begin >= 0 && end > begin, `Shipping source boundaries: ${first}`);
    return source.slice(begin, end).replace(/^export /gm, '');
}
const readOne = section(core, 'export async function getOneCharacter(', 'export function getCharacterSource(');
const importer = section(bridge, 'async function importLaunchCardJson(', 'function normalizeOpeningMessage(');
const marker = section(bridge, 'function cloneCardWithMarker(', 'async function waitForStableCharacterForm(');
const firstLoad = section(core, 'async function firstLoadInit()', 'async function fixViewport()');
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
const OWNER = 'target-character-unit-owner';
const APP = 'target-character-unit-app';
const CONVERSATION = 'target-character-unit-conversation';
const avatarFor = app => `homer-${String(app || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'character'}.png`;

function harness({ app = APP, readStatus = 200, returnedAvatar, importAvatar, readFailure, readGate, jsonGate, postImportMarker } = {}) {
    const requests = [], opened = [], covers = [], characters = [];
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: 'Synthetic fixture', first_mes: 'Synthetic greeting',
        extensions: { fixture: { preserved: true } },
    } };
    const cardPreparations = createCardPreparationCache();
    const prepared = cardPreparations.prepare(JSON.stringify([OWNER, app]), card);
    const expectedAvatar = avatarFor(app);
    const target = (overrides = {}) => ({
        avatar: expectedAvatar, name: 'Synthetic fixture', chat: 'fixture-local-mirror',
        data: { name: 'Synthetic fixture', extensions: {
            fixture: { preserved: true }, homer_bridge: {
                source: 'homer-cloud', app_id: app, card_signature: prepared.signature,
            },
        } }, ...overrides,
    });
    let stored = target({ avatar: returnedAvatar || expectedAvatar });
    const scope = {
        console: { debug() {} }, performance: { mark() {} },
        File: globalThis.File, FormData: globalThis.FormData,
        DOMPurify: { sanitize: value => value },
        toastr: { error() {} }, t: strings => strings.join(''),
        session: { user: { id: OWNER, name: 'Synthetic owner' } },
        launch: { app_id: app, conversation_id: CONVERSATION, card },
        storageAccountEpoch: 0, storageOwner: OWNER, localRuntime: null,
        reconcileStorageAccount: () => scope.storageOwner,
        characters, cardPreparations, MODULE_ID: 'target-character-unit',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        // Cache behavior has its own tests; preserve the original controlled
        // character HTTP peripheral and all target/import assertions here.
        requestCachedCharacter: (avatar, { fetcher, headers }) => fetcher('/api/characters/get', {
            method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }),
        }),
        syncLaunchCharacterAvatar: async (character, changed) => {
            covers.push({ avatar: character.avatar, changed }); return true;
        },
        openLaunchCharacterChat: async (id, options = {}) => opened.push({ id, options, character: clone(characters[id]) }),
        fetch: async (path, options) => {
            if (path === '/api/characters/get') {
                requests.push({ kind: 'get', avatar: JSON.parse(options.body).avatar_url });
                if (readFailure) throw readFailure;
                if (readGate && !requests.some(item => item.kind === 'import')) await readGate.promise;
                const status = requests.some(item => item.kind === 'import') ? 200 : readStatus;
                const snapshot = clone(stored);
                if (postImportMarker && requests.some(item => item.kind === 'import')) {
                    Object.assign(snapshot.data.extensions.homer_bridge, postImportMarker);
                }
                return { ok: status === 200, status, statusText: `Fixture ${status}`, json: async () => {
                    if (jsonGate) { jsonGate.reached.resolve(); await jsonGate.promise; }
                    return snapshot;
                } };
            }
            assert.equal(path, '/api/characters/import', 'The lookup must never enumerate all characters');
            const source = JSON.parse(await options.body.get('avatar').text());
            const fileName = importAvatar || expectedAvatar;
            requests.push({ kind: 'import', avatar: fileName, source: clone(source) });
            stored = { ...source, avatar: fileName, chat: 'fixture-local-mirror' };
            return { ok: true, status: 200, json: async () => ({ file_name: fileName }) };
        },
    };
    const context = { characters, getRequestHeaders: scope.getRequestHeaders };
    scope.getContext = () => context;
    vm.createContext(scope);
    vm.runInContext(readOne + '\n' + marker + '\n' + importer, scope);
    context.getOneCharacter = (...args) => scope.getOneCharacter(...args);
    return { scope, requests, opened, covers, characters, expectedAvatar, target, prepared,
        run: () => scope.importLaunchCharacter({ reuseActiveCharacter: true }),
        read: options => scope.getOneCharacter(expectedAvatar, { addIfMissing: true, ...options }),
    };
}

test('cold empty catalog reads the unchanged target only and does not import or upload its cover', async () => {
    const h = harness();
    await h.run();
    assert.deepEqual(h.requests.map(item => item.kind), ['get']);
    assert.equal(h.requests[0].avatar, h.expectedAvatar);
    assert.equal(h.characters.length, 1);
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0].character.data.extensions.homer_bridge.app_id, APP);
    assert.equal(h.covers.length, 0);
});

test('cold target 404 imports once then reads and opens that exact complete card', async () => {
    const h = harness({ readStatus: 404 });
    await h.run();
    assert.deepEqual(h.requests.map(item => item.kind), ['get', 'import', 'get']);
    assert.equal(h.requests.filter(item => item.kind === 'import').length, 1);
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0].character.data.extensions.fixture.preserved, true);
});

for (const status of [401, 403, 500]) {
    test(`cold target HTTP ${status} must reject instead of importing or opening a card`, async () => {
        const h = harness({ readStatus: status });
        await assert.rejects(h.run());
        assert.deepEqual(h.requests.map(item => item.kind), ['get']);
        assert.equal(h.opened.length, 0);
        assert.equal(h.characters.length, 0);
    });
    test(`getOneCharacter missingOk HTTP ${status} is not a missing target`, async () => {
        const h = harness({ readStatus: status });
        await assert.rejects(h.read({ missingOk: true }));
        assert.equal(h.characters.length, 0);
    });
}

test('getOneCharacter missingOk accepts only a genuine 404 and retains default legacy handling', async () => {
    const missing = harness({ readStatus: 404 });
    assert.equal(await missing.read({ missingOk: true }), -1);
    assert.equal(missing.characters.length, 0);
    const legacy = harness({ readStatus: 500 });
    assert.equal(await legacy.read(), -1, 'Do not change default callers into strict probes');
});

test('failed target transport is not mistaken for 404 and never imports', async () => {
    const h = harness({ readFailure: new Error('Synthetic transport unavailable') });
    await assert.rejects(h.run(), /Synthetic transport unavailable/);
    assert.deepEqual(h.requests.map(item => item.kind), ['get']);
    assert.equal(h.opened.length, 0);
});

test('target read returning another avatar rejects before adding or importing it', async () => {
    const h = harness({ returnedAvatar: 'different-fixture-avatar.png' });
    await assert.rejects(h.run());
    assert.deepEqual(h.requests.map(item => item.kind), ['get']);
    assert.equal(h.characters.length, 0);
    assert.equal(h.opened.length, 0);
});

test('warm unchanged target reuses its in-memory complete card without another GET or import', async () => {
    const h = harness();
    h.characters.push(h.target());
    await h.run();
    assert.equal(h.requests.length, 0);
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0].options.reuseActiveCharacter, true);
    assert.equal(h.covers.length, 0);
});

for (const mismatch of ['app', 'signature']) {
    test(`target ${mismatch} mismatch is refreshed from the verified launch, not reused`, async () => {
        const h = harness();
        const target = h.target();
        target.data.extensions.homer_bridge[mismatch === 'app' ? 'app_id' : 'card_signature'] = 'wrong-fixture-value';
        h.characters.push(target);
        await h.run();
        assert.deepEqual(h.requests.map(item => item.kind), ['import', 'get']);
        assert.equal(h.opened[0].options.reuseActiveCharacter, false);
        assert.equal(h.opened[0].character.data.extensions.homer_bridge.app_id, APP);
        assert.equal(h.opened[0].character.data.extensions.homer_bridge.card_signature, h.prepared.signature);
    });
}

test('colliding sanitized app IDs cannot reuse another app marker with equal source signature', async () => {
    // Use a real collision under the current sanitizer, not a guessed filename.
    const colliding = harness({ app: 'fixtureapp' });
    const collision = colliding.target();
    collision.data.extensions.homer_bridge.app_id = 'fixture/app';
    assert.equal(avatarFor('fixtureapp'), avatarFor('fixture/app'));
    colliding.characters.push(collision);
    await colliding.run();
    assert.deepEqual(colliding.requests.map(item => item.kind), ['import', 'get']);
    assert.equal(colliding.opened[0].character.data.extensions.homer_bridge.app_id, 'fixtureapp');
});

test('import returning an unexpected avatar must not bind that returned card', async () => {
    const h = harness({ readStatus: 404, importAvatar: 'unrequested-fixture-avatar.png' });
    await assert.rejects(h.run());
    assert.equal(h.opened.length, 0);
});

for (const status of [200, 404]) {
    for (const change of ['logout-epoch', 'another-owner']) {
        test(`held target HTTP ${status} after ${change} cannot add, import or open the old card`, async () => {
            const gate = deferred(), h = harness({ readStatus: status, readGate: gate });
            const running = h.run();
            const rejected = assert.rejects(running);
            assert.equal(h.requests.length, 1, 'The actual target probe is waiting');
            if (change === 'logout-epoch') h.scope.storageAccountEpoch++;
            else h.scope.storageOwner = 'different-synthetic-owner';
            // Account invalidation does not replace these live objects in
            // production. Reference-only guards must not pass this scenario.
            assert.equal(h.scope.session.user.id, OWNER);
            assert.equal(h.scope.launch.app_id, APP);
            gate.resolve();
            await rejected;
            assert.deepEqual(h.requests.map(item => item.kind), ['get']);
            assert.equal(h.characters.length, 0, 'Reject before mutating the character array');
            assert.equal(h.opened.length, 0);
        });
    }
}

test('owner change while target JSON resolves is rejected before the character array write', async () => {
    const gate = deferred(); gate.reached = deferred();
    const h = harness({ jsonGate: gate });
    const running = h.run(), rejected = assert.rejects(running);
    await gate.reached.promise;
    h.scope.storageOwner = 'another-synthetic-owner';
    h.scope.storageAccountEpoch++;
    gate.resolve();
    await rejected;
    assert.deepEqual(h.requests.map(item => item.kind), ['get']);
    assert.equal(h.characters.length, 0);
    assert.equal(h.opened.length, 0);
});

for (const marker of [{ app_id: 'another-synthetic-app' }, { card_signature: 'another-synthetic-revision' }]) {
    test(`post-import exact avatar with mismatching ${Object.keys(marker)[0]} is not activated`, async () => {
        const h = harness({ readStatus: 404, postImportMarker: marker });
        await assert.rejects(h.run());
        assert.deepEqual(h.requests.map(item => item.kind), ['get', 'import', 'get']);
        assert.equal(h.opened.length, 0);
    });
}

function initHarness(embedded) {
    const calls = [];
    const element = () => ({ classList: { add() {} }, setAttribute() {}, prepend() {}, appendChild() {} });
    const scope = {
        URLSearchParams,
        window: { location: { search: embedded ? '?homer_embed=1' : '' },
            dispatchEvent: event => calls.push(`event:${event.type}`) },
        document: { createElement: element },
        performance: { mark: name => calls.push(name) },
        CustomEvent: class { constructor(type) { this.type = type; } },
        loader: { createOverlay: element, ToastMode: { NONE: 'none' }, show: () => ({ hide: async () => {} }) },
        ToolManager: { initToolSlashCommands() {} }, showdown: {}, user_avatar: 'synthetic.png',
        eventSource: { emit: async event => calls.push(`event:${event}`) },
        event_types: { APP_INITIALIZED: 'APP_INITIALIZED', APP_READY: 'APP_READY' },
        toastr: { error() {} }, t: strings => strings.join(''),
        fetch: async path => {
            assert.equal(path, '/csrf-token');
            return { ok: true, json: async () => ({ token: 'synthetic-csrf-not-a-secret' }) };
        },
        fetchSettingsResponse: async () => ({ fixture: true }),
    };
    // All unqualified function peripherals are harmless recorded stubs. The
    // firstLoadInit implementation, its embedded branch and event order run
    // unchanged; this is not an alternate initialization implementation.
    for (const match of firstLoad.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = match[1];
        if (['if', 'catch', 'function', 'firstLoadInit', 'Error', 'URLSearchParams', 'CustomEvent'].includes(name)
            || Object.hasOwn(scope, name)) continue;
        scope[name] = async (..._args) => calls.push(name);
    }
    vm.createContext(scope);
    vm.runInContext(firstLoad, scope);
    return { calls, run: () => scope.firstLoadInit() };
}

test('embedded firstLoadInit reaches core-ready without scanning the whole character catalog', async () => {
    const h = initHarness(true);
    await h.run();
    assert.equal(h.calls.includes('getCharacters'), false);
    assert.ok(h.calls.includes('getSettings'));
    assert.ok(h.calls.includes('initExtensions'));
    assert.ok(h.calls.includes('initPresetManager'));
    assert.ok(h.calls.includes('event:homer:runtime-core-ready'));
    assert.ok(h.calls.indexOf('getSettings') < h.calls.indexOf('event:homer:runtime-core-ready'));
});

test('standalone firstLoadInit retains the normal character catalog and its original ready lifecycle', async () => {
    const h = initHarness(false);
    await h.run();
    assert.equal(h.calls.filter(name => name === 'getCharacters').length, 1);
    assert.equal(h.calls.includes('event:homer:runtime-core-ready'), false);
    assert.ok(h.calls.includes('event:APP_READY'));
});
