import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCardTransportCache, clearCardTransportMemory, CARD_TRANSPORT_TTL_MS } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';
import { createCardTransport } from '../../sillytavern-runtime/public/scripts/homer-card-transport.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const card = () => ({ spec: 'chara_card_v2', data: { name: 'Synthetic owned source',
    description: 'complete source 😀\ud800', character_book: { entries: [{ content: 'entire synthetic world', keys: ['synthetic'] }] },
    extensions: { regex_scripts: [{ findRegex: '/synthetic/g', replaceString: '<div>complete</div>' }] } },
    unknown: { future: [1, true, null] } });
const mirror = () => ({ avatar: 'synthetic.png', name: 'Synthetic owned source', data: card().data,
    json_data: JSON.stringify(card()), unknown: { intact: true } });
test.beforeEach(() => clearCardTransportMemory());
test.afterEach(() => clearCardTransportMemory());
function fixture(kind = 'session-card', payload = card()) {
    const indexedDB = cardTransportIDB(), databaseName = 'synthetic-owned-payload'; let clock = 100;
    const cache = createCardTransportCache({ indexedDB, databaseName, now: () => clock });
    const id = kind === 'session-card' ? 'synthetic-card' : 'synthetic.png';
    const options = { allowVerifiedMemory: true, allowExpiredCandidate: true, allowOwnedPayload: true };
    return { cache, indexedDB, databaseName, kind, id, payload, revision: hash(payload), options,
        write: () => cache.write('owner', kind, id, hash(payload), payload),
        read: (extra = {}) => cache.read('owner', kind, id, { ...options, ...extra }),
        consume: (row, extra = {}) => cache.consumePayload('owner', kind, id, row, { revision: hash(payload), ...extra }),
        tick(amount) { clock += amount; }, get clock() { return clock; } };
}
function sessionBody(h, extra = {}) {
    return { user: { id: 'owner' }, launch: { app_id: h.id, conversation_id: 'synthetic-chat', bridge_token: 'synthetic-only',
        card_transport: { version: 1, sha256: h.revision }, ...extra } };
}
function session(h, request, extra = {}) {
    return createCardTransport({ storage: h.cache, now: () => h.clock }).session('/api/homer/session', {
        owner: 'owner', appId: h.id, conversationId: 'synthetic-chat', request,
        validate: body => assert.equal(body.user.id, 'owner'), isCurrent: () => true, ...extra });
}
function withCloneObserver(observer, work) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value(value) {
        observer(value); return descriptor.value(value);
    } });
    return Promise.resolve().then(work).finally(() => Object.defineProperty(globalThis, 'structuredClone', descriptor));
}

test('valid L1 hint starts the real conditional request before its complete private clone', async () => {
    const h = fixture(); await h.write(); h.indexedDB.trace.length = 0; const order = []; let clones = 0;
    const body = await withCloneObserver(value => {
        if (value?.spec === 'chara_card_v2') { clones++; order.push('clone'); assert.equal(order[0], 'request'); }
    }, () => session(h, async path => { order.push('request'); assert.equal(new URL(path, 'http://fixture').searchParams.get('card_sha256'), h.revision); return sessionBody(h); }));
    assert.deepEqual(order, ['request', 'clone']); assert.equal(clones, 1); assert.deepEqual(body.launch.card, card());
    assert.deepEqual(h.indexedDB.trace, [], 'complete L1 use has no immediate IDB transactions');
});

test('hint-side logout fences the read before cloning and does not resurrect private memory', async () => {
    const h = fixture(); await h.write(); let clones = 0;
    const result = await withCloneObserver(value => { if (value?.spec === 'chara_card_v2') clones++; },
        () => h.read({ onRevision() { clearCardTransportMemory(); } }));
    assert.equal(result, null); assert.equal(clones, 0);
    assert.deepEqual((await h.read()).payload, card(), 'intact durable source still needs a new verified cold read');
});

test('logout during the isolated clone rejects that L1 result after copying', async () => {
    const h = fixture(); await h.write(); let cleared = false;
    const result = await withCloneObserver(value => { if (!cleared && value?.spec === 'chara_card_v2') { cleared = true; clearCardTransportMemory(); } }, () => h.read());
    assert.equal(cleared, true); assert.equal(result, null);
});

test('single-use consumption moves only the actual opt-in returned payload and leaves touch usable', async () => {
    const h = fixture(); await h.write(); const row = await h.read(), isolated = row.payload;
    assert.equal(h.consume(row), isolated); assert.equal(Object.hasOwn(row, 'payload'), false);
    assert.equal(h.consume(row), null); h.tick(1); assert.equal(h.cache.touch('owner', h.kind, h.id, row), true);
    assert.equal(h.cache.consumePayload('owner', h.kind, h.id, { ...row, payload: isolated }, { revision: h.revision }), null);
});

test('consumed live nested mutations cannot change another read, L1 bytes or persisted full source', async () => {
    const h = fixture(); await h.write(); const row = await h.read(), nextRow = await h.read();
    const live = h.consume(row); assert.notEqual(live, nextRow.payload);
    live.data.character_book.entries[0].content = 'mutated live'; live.unknown.future.push('mutated');
    assert.deepEqual(nextRow.payload, card()); assert.deepEqual((await h.read()).payload, card());
    assert.deepEqual(h.indexedDB.dump(h.databaseName, 'entries')[0].payload, card());
});

test('default/non-opt-in reads and another cache instance cannot claim payload ownership', async () => {
    const h = fixture(); await h.write(); const row = await h.cache.read('owner', h.kind, h.id);
    assert.equal(h.consume(row), null); assert.deepEqual(row.payload, card());
    const owned = await h.read(), other = createCardTransportCache({ indexedDB: h.indexedDB, databaseName: h.databaseName, now: () => h.clock });
    assert.equal(other.consumePayload('owner', h.kind, h.id, owned, { revision: h.revision }), null);
    assert.deepEqual(h.consume(owned), card());
});

test('wrong owner/kind/id/revision and copied rows do not consume the genuine ticket', async () => {
    const h = fixture(); await h.write(); const row = await h.read();
    for (const [owner, kind, id] of [['other', h.kind, h.id], ['owner', 'character-content-v2', h.id], ['owner', h.kind, 'other']]) {
        assert.equal(h.cache.consumePayload(owner, kind, id, row, { revision: h.revision }), null);
    }
    assert.equal(h.consume(row, { revision: 'f'.repeat(64) }), null);
    assert.equal(h.consume({ ...row }), null); assert.deepEqual(h.consume(row), card());
});

test('swapped payload references and changed result markers are rejected without affecting private source', async () => {
    for (const field of ['payload', 'revision', 'entryId', 'owner', 'expiresAt']) {
        const h = fixture(); await h.write(); const row = await h.read();
        row[field] = field === 'payload' ? card() : field === 'expiresAt' ? 1 : 'changed';
        assert.equal(h.consume(row), null); assert.deepEqual((await h.read()).payload, card());
        clearCardTransportMemory();
    }
});

test('global logout, current guard and strict expiry reject consumption while expired online candidate stays explicit', async () => {
    const h = fixture(); await h.write(); const row = await h.read();
    assert.equal(h.consume(row, { isCurrent: () => false }), null); clearCardTransportMemory(); assert.equal(h.consume(row), null);
    const strict = await h.cache.read('owner', h.kind, h.id, { allowVerifiedMemory: true, allowOwnedPayload: true });
    h.tick(CARD_TRANSPORT_TTL_MS); assert.equal(h.consume(strict), null);
    const candidate = await h.read(); assert.equal(candidate.requiresOnlineConfirmation, true);
    assert.deepEqual(h.consume(candidate), card());
});

test('a synchronous current callback clearing the account cannot consume the pre-clear payload', async () => {
    const h = fixture(); await h.write(); const row = await h.read();
    assert.equal(h.consume(row, { isCurrent() { clearCardTransportMemory(); return true; } }), null);
    assert.deepEqual(row.payload, card());
});

test('fully SHA-verified cold IDB result has independent ownership and preserves durable bytes', async () => {
    const h = fixture(); await h.write(); clearCardTransportMemory();
    const row = await h.read({ allowVerifiedMemory: false }), payload = h.consume(row); payload.data.description = 'live changed';
    assert.equal(h.consume(row), null); assert.deepEqual((await h.read()).payload, card());
    assert.deepEqual(h.indexedDB.dump(h.databaseName, 'entries')[0].payload, card());
});

test('mirror consumes one private clone and merges only fresh stats without storing or aliasing them', async () => {
    const h = fixture('character-content-v2', mirror()); await h.write(); let clones = 0, reads = 0;
    const response = await withCloneObserver(value => { if (value?.avatar === 'synthetic.png') clones++; }, () =>
        createCardTransport({ storage: h.cache, now: () => h.clock }).character(h.id, { owner: 'owner', isCurrent: () => true,
            fetcher: async (_path, options) => { reads++; assert.equal(JSON.parse(options.body).card_sha256, h.revision);
                return { ok: true, status: 200, json: async () => ({ homer_character_transport: { version: 2, sha256: h.revision, not_modified: true },
                    fresh_stats: { chat_size: 9, date_last_chat: 10 } }) }; } }));
    const live = await response.json(); assert.equal(reads, 1); assert.equal(clones, 1);
    assert.deepEqual(live, { ...mirror(), chat_size: 9, date_last_chat: 10 }); live.data.name = 'live changed';
    assert.deepEqual((await h.read()).payload, mirror());
});

test('production ownership does not bypass fresh authorization, current epoch or exact SHA', async () => {
    for (const variant of ['401', '403', '404', '500', 'owner', 'epoch', 'revision']) {
        const h = fixture(); await h.write(); let calls = 0, current = true, consumed = 0;
        const consume = h.cache.consumePayload.bind(h.cache);
        h.cache.consumePayload = (...args) => { consumed++; return consume(...args); };
        await assert.rejects(session(h, async () => {
            calls++; if (/^\d+$/.test(variant)) throw Error('HTTP ' + variant);
            const body = sessionBody(h); if (variant === 'owner') body.user.id = 'other';
            if (variant === 'epoch') current = false; if (variant === 'revision') body.launch.card_transport.sha256 = 'f'.repeat(64);
            return body;
        }, { isCurrent: () => current }));
        assert.equal(consumed, 0); assert.equal(calls, variant === 'revision' ? 2 : 1);
        clearCardTransportMemory();
    }
});

test('custom/legacy storage without ownership method keeps the defensive complete clone fallback', async () => {
    for (const method of ['absent', 'reject', 'throw']) {
        const h = fixture(), row = { payload: card(), revision: h.revision, expiresAt: 200 }; let clones = 0;
        const storage = { read: async () => row, write: async () => {} };
        if (method === 'reject') storage.consumePayload = () => null;
        if (method === 'throw') storage.consumePayload = () => { throw Error('unsupported'); };
        const body = await withCloneObserver(value => { if (value?.spec === 'chara_card_v2') clones++; }, () =>
            createCardTransport({ storage, now: () => h.clock }).session('/api/homer/session', {
                owner: 'owner', appId: h.id, conversationId: 'synthetic-chat', request: async () => sessionBody(h), validate() {}, isCurrent: () => true }));
        assert.equal(clones, 1); assert.notEqual(body.launch.card, row.payload); body.launch.card.data.name = 'live changed';
        assert.equal(row.payload.data.name, card().data.name);
    }
});

test('WebViews without structuredClone preserve owned isolation and no second JSON roundtrip', async () => {
    const h = fixture(); await h.write(); const cloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    const originalStringify = JSON.stringify, originalParse = JSON.parse; let serialized = 0, parsed = 0;
    try {
        Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: undefined });
        JSON.stringify = function(value, ...rest) { if (value?.spec === 'chara_card_v2') serialized++; return originalStringify.call(JSON, value, ...rest); };
        JSON.parse = function(value, ...rest) { if (String(value).startsWith('{"spec":"chara_card_v2"')) parsed++; return originalParse.call(JSON, value, ...rest); };
        const body = await session(h, async () => sessionBody(h)); assert.deepEqual(body.launch.card, card());
        body.launch.card.data.name = 'live changed'; assert.equal(serialized, 1); assert.equal(parsed, 1);
    } finally {
        JSON.stringify = originalStringify; JSON.parse = originalParse;
        Object.defineProperty(globalThis, 'structuredClone', cloneDescriptor);
    }
    assert.deepEqual((await h.read()).payload, card());
});
