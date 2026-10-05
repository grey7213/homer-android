import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const core = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const slice = (text, start, end) => {
    const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, `Shipping function missing: ${start}`);
    return text.slice(a, b).replace(/^export /gm, '');
};
const turn = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture() {
    let clock = 100, valid = true, handler = null;
    const calls = [], clear = defer(), reads = [];
    const scope = JSON.stringify(['owner', 1, 'card', 'target']);
    const c = {
        Date: class extends Date { static now() { return clock; } }, setTimeout, clearTimeout,
        characters: [{ avatar: 'old.png', name: 'old', chat: 'Old' }, { avatar: 'new.png', name: 'new', chat: 'unused' }],
        this_chid: '0', name2: 'old', chat_metadata: { integrity: 'old' }, isChatSaving: false,
        is_send_press: false, selected_group: null, is_group_generating: false, debounce_timeout: { extended: 20 },
        waitUntilCondition: async condition => { if (!condition()) throw Error('save blocked'); },
        unshallowCharacter: async () => {}, cancelTtsPlay() {}, resetSelectedGroup() {},
        setCharacterId: value => { calls.push('publish'); c.this_chid = value; }, setCharacterName: value => { c.name2 = value; },
        uuidv4: () => 'fresh-integrity', $: () => ({ val() {} }), getRequestHeaders: () => ({}),
        getCurrentChatId: () => c.characters[c.this_chid]?.chat,
        clearChat: async () => { calls.push('clear'); await clear.promise; calls.push('cleared'); },
        prepareItemizedPrompts: name => { calls.push('read-prompts'); return { name, pending: Promise.resolve({ prompts: [] }) }; },
        applyPreparedItemizedPrompts: async () => { calls.push('apply-prompts'); },
        fetch: async (path, options) => {
            assert.equal(path, '/api/chats/get'); const body = JSON.parse(options.body);
            assert.equal(options.method, 'POST'); assert.equal(body.metadata_only, true);
            reads.push(body);
            return handler ? handler(reads.length) : { ok: true, json: async () => ({ chat_metadata: { integrity: 'prepared', intact: 7 } }) };
        },
    };
    vm.createContext(c);
    vm.runInContext(slice(core, 'export async function activateCharacterForChat(', '////////// OPTIMZED MAIN API'), c);
    // Actual getSettings fresh-response prefix, stopping before unrelated UI.
    const settingsPrefix = slice(core, 'export async function getSettings(', "    performance.mark('homer-settings-response');") + '\n}';
    Object.assign(c, { performance: { mark() {} }, reloadLoop() {}, toastr: { error() {} }, t: s => s.join('') });
    vm.runInContext(settingsPrefix, c);
    vm.runInContext('readonlyChatHeaderSupported = true;', c);
    const options = extra => ({ owner: 'owner', scope, expiresAt: clock + 1000, isCurrent: () => valid, ...extra });
    const prepare = extra => {
        const supplied = options(extra);
        return { ...supplied, ticket: c.prepareCharacterChatMirrorRead('new.png', 'Homer-target', supplied) };
    };
    return { c, calls, reads, clear, prepare, options, setHandler: fn => { handler = fn; },
        expire: () => { clock += 2000; }, invalidate: () => { valid = false; } };
}

test('opaque header preparation reads metadata only without publication, prompts or clear', async () => {
    const h = fixture(), p = h.prepare(); await turn();
    assert.ok(p.ticket); assert.equal(Object.keys(p.ticket).length, 0); assert.equal(Object.isFrozen(p.ticket), true);
    assert.equal(h.reads.length, 1); assert.deepEqual(h.calls, []);
    assert.equal(h.c.chat_metadata.integrity, 'old'); assert.equal(h.c.this_chid, '0');
});

test('actual activation consumes exact header once only after the existing save barrier', async () => {
    const h = fixture(), p = h.prepare(); await turn();
    const work = h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p });
    await turn(); assert.equal(h.c.chat_metadata.integrity, 'old'); assert.equal(h.c.this_chid, '0');
    assert.equal(h.calls.includes('apply-prompts'), false); assert.equal(h.reads.length, 1);
    h.clear.resolve(); await work;
    assert.equal(h.c.chat_metadata.integrity, 'prepared'); assert.equal(h.c.chat_metadata.intact, 7);
    assert.ok(h.calls.indexOf('cleared') < h.calls.indexOf('publish'));
    h.c.this_chid = '0'; await h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p });
    assert.equal(h.reads.length, 2, 'opaque ticket cannot be replayed');
});

for (const [label, alter] of [
    ['owner', (h, p) => { p.owner = 'other'; }], ['scope', (h, p) => { p.scope = 'other'; }],
    ['expiry', h => h.expire()], ['current', h => h.invalidate()],
    ['forgery', (h, p) => { p.ticket = {}; }],
]) test(`optional ${label} mismatch falls back to selected original read`, async () => {
    const h = fixture(), p = h.prepare(); await turn(); alter(h, p);
    h.clear.resolve(); await h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p });
    assert.equal(h.reads.length, 2); assert.equal(h.c.chat_metadata.integrity, 'prepared');
});

for (const status of [401, 403, 500]) test(`optional HTTP ${status} does not replace selected fatal semantics`, async () => {
    const h = fixture(); h.setHandler(async () => ({ ok: false, status, json: async () => ({}) }));
    const p = h.prepare(); await turn(); h.clear.resolve();
    await assert.rejects(h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p }), /存档标识/);
    assert.equal(h.reads.length, 2); assert.equal(h.c.this_chid, '0'); assert.equal(h.c.chat_metadata.integrity, 'old');
});

test('a failed optional read recovers on successful selected read and preserves legacy integrity', async () => {
    const h = fixture(); h.setHandler(async n => ({ ok: n !== 1, json: async () => [{ chat_metadata: { integrity: 'legacy', custom: true } }, { mes: 'not retained' }] }));
    const p = h.prepare(); await turn(); h.clear.resolve();
    await h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p });
    assert.equal(h.reads.length, 2); assert.equal(h.c.chat_metadata.integrity, 'legacy');
});

test('late current invalidation during body read rejects the optional result', async () => {
    const h = fixture(), gate = defer();
    h.setHandler(async n => ({ ok: true, json: async () => n === 1 ? gate.promise : { chat_metadata: { integrity: 'fresh' } } }));
    const p = h.prepare(), work = h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p });
    h.clear.resolve(); await turn(); h.invalidate(); gate.resolve({ chat_metadata: { integrity: 'stale' } });
    await work; assert.equal(h.c.chat_metadata.integrity, 'fresh'); assert.equal(h.reads.length, 2);
});

test('invalidation after header settled but before old clear completes is rechecked at publication', async () => {
    const h = fixture(); h.setHandler(async n => ({ ok: true, json: async () => ({ chat_metadata: { integrity: n === 1 ? 'stale' : 'fresh' } }) }));
    const p = h.prepare(); await turn();
    const work = h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p });
    await turn(); h.invalidate(); h.clear.resolve(); await work;
    assert.equal(h.c.chat_metadata.integrity, 'fresh'); assert.equal(h.reads.length, 2);
});

test('unsettled optional reads are bounded by original deadline and late outcomes cannot publish', async () => {
    const h = fixture(), gate = defer();
    h.setHandler(async n => n === 1 ? gate.promise : ({ ok: true, json: async () => ({ chat_metadata: { integrity: 'selected' } }) }));
    const p = h.prepare({ expiresAt: 105 }); h.clear.resolve();
    await h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p });
    gate.resolve({ ok: true, json: async () => ({ chat_metadata: { integrity: 'late' } }) }); await turn();
    assert.equal(h.c.chat_metadata.integrity, 'selected'); assert.equal(h.reads.length, 2);
});

for (const field of ['avatar', 'chat']) test(`ticket cannot cross a different target ${field}`, async () => {
    const h = fixture(), p = h.prepare(); await turn(); h.clear.resolve();
    if (field === 'avatar') h.c.characters[1].avatar = 'another.png';
    await h.c.activateCharacterForChat(1, { chatName: field === 'chat' ? 'Homer-another' : 'Homer-target', preparedHeader: p });
    assert.equal(h.reads.length, 2);
});

test('old durable clear failure does not apply or publish a prepared header', async () => {
    const h = fixture(), p = h.prepare(); await turn(); h.c.clearChat = async () => { throw Error('old save failed'); };
    await assert.rejects(h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p }), /old save failed/);
    assert.equal(h.c.chat_metadata.integrity, 'old'); assert.equal(h.c.this_chid, '0');
});

test('same active target and saving cannot start a speculative header read', () => {
    const h = fixture(); h.c.this_chid = '1'; h.c.characters[1].chat = 'Homer-target';
    assert.equal(h.prepare().ticket, null); h.c.this_chid = '0'; h.c.isChatSaving = true;
    assert.equal(h.prepare().ticket, null); assert.equal(h.reads.length, 0);
});

test('only a successful fresh settings response with strict true enables speculation', async () => {
    const h = fixture();
    for (const value of [undefined, false, 1, 'true']) {
        await h.c.getSettings(null, Promise.resolve({ ok: true, json: async () => ({ homer_capabilities: { readonly_chat_header: value } }) }));
        assert.equal(h.prepare().ticket, null);
    }
    await h.c.getSettings(null, Promise.resolve({ ok: true, json: async () => ({ homer_capabilities: { readonly_chat_header: true } }) }));
    assert.ok(h.prepare().ticket);
    await assert.rejects(h.c.getSettings(null, Promise.resolve({ ok: false })), /getting settings/);
    assert.equal(h.prepare().ticket, null);
    await h.c.getSettings(null, Promise.resolve({ ok: true, json: async () => ({ homer_capabilities: { readonly_chat_header: true } }) }));
    await assert.rejects(h.c.getSettings(null, Promise.reject(Error('offline'))), /offline/);
    assert.equal(h.prepare().ticket, null);
});

test('a completed actual save invalidates optional headers even when isChatSaving is false again', async () => {
    const h = fixture(), p = h.prepare(); await turn();
    const savePrefix = slice(core, 'export async function saveChat(', '    characters[this_chid].date_last_chat = Date.now();') + '\n}';
    Object.assign(h.c, { neutralCharacterName: 'neutral' }); vm.runInContext(savePrefix, h.c);
    await h.c.saveChat();
    assert.equal(h.c.isChatSaving, false);
    h.clear.resolve(); await h.c.activateCharacterForChat(1, { chatName: 'Homer-target', preparedHeader: p });
    assert.equal(h.reads.length, 2);
});

test('administrator preview neither consumes nor reads normal mirror headers', async () => {
    const h = fixture(), p = h.prepare(); await turn(); h.clear.resolve();
    await h.c.activateCharacterForChat(1, { chatName: 'Homer-target', ephemeral: true, preparedHeader: p });
    assert.equal(h.reads.length, 1); assert.equal(h.c.chat_metadata.integrity, 'fresh-integrity');
    assert.equal(h.calls.includes('read-prompts'), false);
});

function bridgeFixture() {
    const h = fixture(), c = h.c;
    const payload = { user: { id: 'owner' }, launch: { app_id: 'card', conversation_id: 'target',
        card: { data: { name: 'synthetic' } }, bridge_token: 'synthetic-only' } };
    const scope = JSON.stringify(['owner', 'card', 'target']), stamp = { version: 0 };
    Object.assign(c, {
        session: payload, launch: payload.launch, storageAccountEpoch: 1, requestedAppId: '', requestedConversationId: '',
        adminPreviewRequested: false, adminBinding: false,
        SESSION_CACHE_TTL_MS: 1000,
        reconcileStorageAccount: () => 'owner', sessionPrefetchCache: new Map(), sessionReadFences: new WeakMap(),
        storageAckStamps: new Map([[scope, stamp]]), storageAckKey: value => value,
        storageAckStamp: () => stamp, prepareCharacterRead: () => ({ pending: Promise.resolve({ value: { ok: true } }) }),
        getContext: () => ({ characters: c.characters }),
    });
    c.sessionReadFences.set(payload, { raw: true, owner: 'owner', epoch: 1, scope, stamp, version: 0 });
    const entry = { promise: Promise.resolve(payload), expiresAt: 1100 };
    c.sessionPrefetchCache.set('card::target', entry);
    vm.runInContext(slice(bridge, 'function sessionCacheKey(', 'function prepareColdConversation('), c);
    vm.runInContext(slice(bridge, 'function prepareLaunchMirrorHeader(', 'function prepareInitialCharacterRead('), c);
    return { ...h, payload, stamp, scope, entry };
}

test('cold bridge starts bounded header read beside session/character but applies no state', async () => {
    const h = bridgeFixture(); const descriptor = h.c.prepareColdCharacterRead('card', 'target', 900);
    assert.ok(descriptor.headerRead); assert.equal(h.reads.length, 1); assert.deepEqual(h.calls, []);
    await descriptor.pending;
    const selected = h.c.prepareLaunchMirrorHeader(descriptor);
    assert.equal(selected.ticket, descriptor.headerRead); assert.equal(h.reads.length, 1);
});

for (const label of ['local_chat', 'local_pending', 'ack', 'epoch', 'expired', 'wrong-payload', 'cancelled', 'admin']) {
    test(`cold bridge ${label} cannot reuse prepared header`, async () => {
        const h = bridgeFixture(), descriptor = h.c.prepareColdCharacterRead('card', 'target', 900); await descriptor.pending;
        if (label.startsWith('local_')) h.payload.launch[label] = label === 'local_chat' ? [] : false;
        if (label === 'ack') h.stamp.version++;
        if (label === 'epoch') h.c.storageAccountEpoch++;
        if (label === 'expired') h.expire();
        if (label === 'wrong-payload') h.c.session = { ...h.payload };
        if (label === 'cancelled') descriptor.cancelled = true;
        if (label === 'admin') h.payload.launch.admin_preview = true;
        assert.equal(h.c.prepareLaunchMirrorHeader(descriptor), null);
    });
}

test('selected bridge preparation is guarded by session identity and fresh ack generation', () => {
    const h = bridgeFixture(), selected = h.c.prepareLaunchMirrorHeader();
    assert.ok(selected.ticket); assert.equal(selected.isCurrent(), true); h.stamp.version++;
    assert.equal(selected.isCurrent(), false);
});

for (const field of ['app_id', 'conversation_id', 'owner']) test(`same-object ${field} mutation invalidates a selected header`, () => {
    const h = bridgeFixture(), selected = h.c.prepareLaunchMirrorHeader();
    if (field === 'owner') h.payload.user.id = 'another';
    else h.payload.launch[field] = 'another';
    assert.equal(selected.isCurrent(), false);
});

test('source-changing reimport never receives an optional old mirror header', () => {
    const body = slice(bridge, 'async function importLaunchCharacter(', 'function normalizeOpeningMessage(');
    assert.match(body, /preparedHeader:\s*metadataChanged\s*\?\s*null\s*:\s*preparedHeader/);
    assert.match(body, /await openLaunchCharacterChat\(characterId\);/);
});

for (const variant of ['unchanged', 'signature-change', 'app-collision', 'missing']) {
    test(`actual import marker validation ${variant} preserves or discards prepared header correctly`, async () => {
        const h = bridgeFixture(), selected = h.c.prepareLaunchMirrorHeader(), opens = [], imports = [];
        const validCharacter = () => ({ avatar: 'homer-card.png', data: { extensions: { homer_bridge: { app_id: 'card', card_signature: 'current' } } } });
        const chars = variant === 'missing' ? [] : [validCharacter()];
        if (variant === 'signature-change') chars[0].data.extensions.homer_bridge.card_signature = 'old';
        if (variant === 'app-collision') chars[0].data.extensions.homer_bridge.app_id = 'another';
        Object.assign(h.c, {
            getContext: () => ({ characters: chars, getOneCharacter: async () => chars.length ? 0 : -1 }),
            cardPreparations: { prepare: () => ({ signature: 'current' }) }, cloneCardWithMarker: value => value,
            importLaunchCardJson: async () => { imports.push(true); chars[0] = validCharacter(); return 'homer-card.png'; },
            syncLaunchCharacterAvatar: async () => {}, openLaunchCharacterChat: async (id, options) => opens.push(options),
            performance: { mark() {} }, MODULE_ID: 'test',
        });
        vm.runInContext(slice(bridge, 'async function importLaunchCharacter(', 'function normalizeOpeningMessage('), h.c);
        await h.c.importLaunchCharacter({ preparedHeader: selected });
        assert.equal(opens.length, 1);
        if (variant === 'unchanged') { assert.equal(opens[0].preparedHeader, selected); assert.equal(imports.length, 0); }
        else { assert.equal(opens[0]?.preparedHeader ?? null, null); assert.equal(imports.length, 1); }
    });
}
