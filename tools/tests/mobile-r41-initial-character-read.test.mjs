import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const core = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(source, start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b).replace(/^export /gm, '');
}
const coreFunctions = section(core, 'const preparedCharacterReads =', 'export function getCharacterSource(');
const bridgeFunctions = section(bridge, 'async function importLaunchCardJson(', 'function normalizeOpeningMessage(');
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture({ status = 200, gate = null, jsonGate = null, readFailure = null, marker = null } = {}) {
    const calls = [], characters = [];
    const owner = 'synthetic-owner', app = 'synthetic-app', avatar = `homer-${app}.png`;
    const target = () => ({ avatar, name: '<b>Synthetic</b>', chat: 123,
        data: { extensions: { homer_bridge: { app_id: app, card_signature: 'synthetic-signature', ...marker } } } });
    let imported = false;
    const scope = {
        characters, session: { user: { id: owner } },
        launch: { app_id: app, conversation_id: 'synthetic-chat', card: { data: { name: 'Synthetic' } } },
        storageAccountEpoch: 0, storageOwner: owner,
        reconcileStorageAccount: () => scope.storageOwner,
        cardPreparations: { prepare: () => ({ signature: 'synthetic-signature' }) },
        cloneCardWithMarker: () => target(),
        File: globalThis.File, FormData: globalThis.FormData,
        DOMPurify: { sanitize: value => { calls.push('sanitize'); return value.replace(/<[^>]+>/g, ''); } },
        toastr: { error: () => calls.push('toast') }, t: strings => strings.join(''),
        performance: { mark() {} }, console: { debug() {} }, MODULE_ID: 'synthetic',
        syncLaunchCharacterAvatar: async () => { calls.push('avatar-sync'); },
        openLaunchCharacterChat: async () => { calls.push('activate'); },
        getRequestHeaders: () => ({ 'X-Test': 'synthetic-only' }),
        fetch: async (url, options) => {
            if (url === '/api/characters/import') {
                calls.push('import'); imported = true;
                return { ok: true, json: async () => ({ file_name: avatar }) };
            }
            assert.equal(url, '/api/characters/get');
            assert.equal(JSON.parse(options.body).avatar_url, avatar);
            calls.push('read');
            if (gate) await gate.promise;
            if (readFailure) throw readFailure;
            const code = imported ? 200 : status;
            return { ok: code === 200, status: code, json: async () => {
                calls.push('json');
                if (jsonGate) await jsonGate.promise;
                const value = target();
                if (imported) value.data.extensions.homer_bridge = { app_id: app, card_signature: 'synthetic-signature' };
                return value;
            } };
        },
        requestCachedCharacter: (name, options) => {
            assert.equal(options.owner, owner);
            return options.fetcher('/api/characters/get', {
                headers: options.headers, body: JSON.stringify({ avatar_url: name }),
            });
        },
    };
    scope.getContext = () => ({ characters, getOneCharacter: scope.getOneCharacter,
        getRequestHeaders: scope.getRequestHeaders });
    vm.createContext(scope);
    vm.runInContext(coreFunctions + '\n' + bridgeFunctions, scope);
    return { scope, calls, characters, owner, avatar, target,
        prepare: () => scope.prepareInitialCharacterRead(),
        consume: initialRead => scope.importLaunchCharacter({ reuseActiveCharacter: true, initialRead }),
        read: (preparedRead, options = {}) => scope.getOneCharacter(avatar, {
            addIfMissing: true, missingOk: true, cacheOwner: owner, preparedRead, ...options,
        }),
    };
}

test('initial preparation reads and parses once without publishing or normalizing the target', async () => {
    const h = fixture(), ticket = h.prepare();
    await ticket.read.pending;
    assert.deepEqual(h.calls, ['read', 'json']);
    assert.deepEqual(h.characters, []);
    await h.consume(ticket);
    assert.deepEqual(h.calls, ['read', 'json', 'sanitize', 'activate']);
    assert.equal(h.characters[0].name, 'Synthetic');
    assert.equal(h.characters[0].chat, '123');
});

test('a pending preparation does not mutate characters and its eventual consumption issues no second request', async () => {
    const gate = deferred(), h = fixture({ gate }), ticket = h.prepare();
    await tick();
    assert.deepEqual(h.calls, ['read']); assert.equal(h.characters.length, 0);
    gate.resolve(); await h.consume(ticket);
    assert.equal(h.calls.filter(x => x === 'read').length, 1);
    assert.equal(h.calls.filter(x => x === 'activate').length, 1);
});

for (const change of ['owner', 'epoch', 'session', 'launch']) {
    test(`prepared target cannot publish after ${change} changes`, async () => {
        const gate = deferred(), h = fixture({ gate }), ticket = h.prepare();
        if (change === 'owner') h.scope.storageOwner = 'another-owner';
        if (change === 'epoch') h.scope.storageAccountEpoch++;
        if (change === 'session') h.scope.session = { ...h.scope.session };
        if (change === 'launch') h.scope.launch = { ...h.scope.launch };
        gate.resolve(); await ticket.read.pending;
        await assert.rejects(h.consume(ticket), /账号|票据/);
        assert.equal(h.characters.length, 0); assert.deepEqual(h.calls, ['read']);
    });
    test(`in-flight consumption cannot publish when ${change} changes during its awaited read`, async () => {
        const gate = deferred(), h = fixture({ gate }), ticket = h.prepare();
        const work = h.consume(ticket), rejected = assert.rejects(work, /账号|票据/);
        await tick();
        if (change === 'owner') h.scope.storageOwner = 'another-owner';
        if (change === 'epoch') h.scope.storageAccountEpoch++;
        if (change === 'session') h.scope.session = { ...h.scope.session };
        if (change === 'launch') h.scope.launch = { ...h.scope.launch };
        gate.resolve(); await rejected;
        assert.equal(h.characters.length, 0); assert.deepEqual(h.calls, ['read']);
    });
}

test('account change during JSON parsing settles safely and is rejected before any publication', async () => {
    const jsonGate = deferred(), h = fixture({ jsonGate }), ticket = h.prepare();
    await tick(); assert.ok(h.calls.includes('json'));
    h.scope.storageAccountEpoch++; jsonGate.resolve();
    await ticket.read.pending; await assert.rejects(h.consume(ticket));
    assert.equal(h.characters.length, 0); assert.ok(!h.calls.includes('activate'));
});

test('discarding an early failed preparation after hydration failure cannot leave an unhandled rejection', async () => {
    const gate = deferred(), h = fixture({ gate }), ticket = h.prepare();
    gate.reject(Error('synthetic transport unavailable'));
    const outcome = await ticket.read.pending;
    assert.match(outcome.error.message, /synthetic transport/);
    assert.deepEqual(h.characters, []); assert.deepEqual(h.calls, ['read']);
});

for (const status of [401, 403, 500]) {
    test(`prepared HTTP ${status} is never treated as a missing card or imported`, async () => {
        const h = fixture({ status }), ticket = h.prepare();
        await assert.rejects(h.consume(ticket), new RegExp(`HTTP ${status}`));
        assert.deepEqual(h.calls, ['read']); assert.equal(h.characters.length, 0);
    });
}

test('prepared genuine 404 follows the original import, fresh read and activation path', async () => {
    const h = fixture({ status: 404 }), ticket = h.prepare();
    await h.consume(ticket);
    assert.deepEqual(h.calls, ['read', 'import', 'read', 'json', 'sanitize', 'avatar-sync', 'activate']);
});

test('a mismatched persisted revision is still imported and read again before activation', async () => {
    const h = fixture({ marker: { card_signature: 'old-signature' } }), ticket = h.prepare();
    await h.consume(ticket);
    assert.deepEqual(h.calls, ['read', 'json', 'sanitize', 'import', 'read', 'json', 'sanitize', 'avatar-sync', 'activate']);
});

test('core read ticket rejects substituted avatar, owner, unknown identity and repeat consumption', async () => {
    const h = fixture(), ticket = h.prepare(); await ticket.read.pending;
    await assert.rejects(h.scope.getOneCharacter('another.png', { preparedRead: ticket.read, cacheOwner: h.owner }), /票据/);
    await assert.rejects(h.read(ticket.read, { cacheOwner: 'other' }), /票据/);
    await assert.rejects(h.read({ ...ticket.read }), /票据/);
    assert.equal(await h.read(ticket.read), 0);
    await assert.rejects(h.read(ticket.read), /票据/);
    assert.equal(h.calls.filter(x => x === 'read').length, 1);
});

test('existing complete or shallow targets and administrator/empty/unauthenticated launches never prepare', () => {
    for (const change of [
        h => h.characters.push(h.target()),
        h => h.characters.push({ ...h.target(), shallow: true }),
        h => { h.scope.launch.admin_preview = true; },
        h => { h.scope.launch = null; },
        h => { h.scope.launch.card = null; },
        h => { h.scope.storageOwner = ''; },
        h => { h.scope.session.user.id = 'another'; },
    ]) {
        const h = fixture(); change(h);
        assert.equal(h.prepare(), null); assert.deepEqual(h.calls, []);
    }
});

test('bootstrap starts only the explicit target read before state/UI waits and consumes after extension readiness', () => {
    const bootstrap = section(bridge, 'async function bootstrapLaunch(', 'async function ');
    const preparedAt = bootstrap.indexOf('const initialCharacterRead = prepareInitialCharacterRead(preparedResources?.character)');
    assert.ok(preparedAt > bootstrap.indexOf('launch = session.launch'));
    assert.ok(preparedAt < bootstrap.indexOf('const modelCatalogWork = loadRuntimeUiData'));
    assert.ok(preparedAt < bootstrap.indexOf('await Promise.all([loadRuntimeState'));
    assert.ok(bootstrap.indexOf('await administratorExtensionsPromise') < bootstrap.indexOf('initialRead: initialCharacterRead'));
    const switcher = section(bridge, 'async function switchConversation(', 'function ');
    assert.ok(!switcher.includes('prepareInitialCharacterRead'));
});
