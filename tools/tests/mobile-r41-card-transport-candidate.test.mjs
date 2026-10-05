import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCardTransportCache, CARD_TRANSPORT_TTL_MS, CARD_TRANSPORT_MAX_ROWS,
    CARD_TRANSPORT_MAX_BYTES } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';
import { createCardTransport } from '../../sillytavern-runtime/public/scripts/homer-card-transport.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

// Actual storage/adapter composition with only synthetic authoritative replies.
// This is not a network, native performance or server authorization test.
const OWNER = 'synthetic-owner', APP = 'synthetic-app', CHAT = 'synthetic-chat', AVATAR = 'synthetic.png';
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
const syntheticCard = large => ({ spec: 'chara_card_v2', data: { name: 'Synthetic complete card',
    first_mes: '<!doctype html><html><body>Synthetic</body></html>',
    description: large ? 'synthetic-source-'.repeat(210000) : 'Synthetic source',
    character_book: { entries: [{ id: 'world-1', keys: ['synthetic'], content: 'Complete world source', extensions: { future: [1, true] } }] },
    extensions: { regex_scripts: [{ id: 'regex-1', findRegex: '/synthetic/g', replaceString: '<p>Synthetic renderer</p>' }],
        tavern_helper: { scripts: [{ id: 'script-1', content: 'globalThis.syntheticOnly = true;' }] } },
}, future: { nested: [null, 'intact'] } });
const freshStats = { chat_size: 12, date_last_chat: 100 };

function fixture(kind, { large = false, timeout = 800 } = {}) {
    const indexedDB = cardTransportIDB(), databaseName = `candidate-${kind}`;
    let clock = 100, epoch = 0, content = syntheticCard(large), responseHook;
    if (kind !== 'session-card') content = { name: content.data.name, avatar: AVATAR, data: content.data,
        json_data: JSON.stringify(content), chat: 'synthetic-history', unknown: content.future };
    const id = kind === 'session-card' ? APP : AVATAR, calls = [], hints = [], writes = [];
    let cache = createCardTransportCache({ indexedDB, databaseName, now: () => clock });
    const storage = {
        read(owner, k, key, options) {
            assert.equal(options.allowExpiredCandidate, true, 'Only transport explicitly requests revalidation candidates');
            return cache.read(owner, k, key, { ...options, onRevision(hint) { hints.push(hint); options.onRevision(hint); } });
        },
        write(...args) { const pending = cache.write(...args); writes.push(pending); return pending; },
    };
    const api = createCardTransport({ storage, now: () => clock, readTimeoutMs: timeout });
    function body(known) {
        const revision = digest(content), hit = known === revision;
        if (kind === 'session-card') return { user: { id: OWNER }, launch: {
            app_id: APP, conversation_id: CHAT, bridge_token: 'synthetic-not-a-credential',
            messages: Array.from({ length: 13 }, (_, index) => ({ content: `synthetic message ${index}`, is_user: index % 2 === 1 })),
            card_transport: { version: 1, sha256: revision }, ...(hit ? {} : { card: clone(content) }),
        } };
        return { homer_character_transport: { version: 2, sha256: revision, ...(hit ? { not_modified: true } : {}) },
            fresh_stats: { ...freshStats, date_last_chat: 100 + calls.length }, ...(hit ? {} : { character: clone(content) }) };
    }
    async function online(path, config) {
        const known = config ? JSON.parse(config.body).card_sha256 || '' : new URL(path, 'http://synthetic.invalid').searchParams.get('card_sha256') || '';
        calls.push({ known, full: false });
        const value = responseHook ? await responseHook({ path, config, known, body: body(known) }) : body(known);
        if (kind === 'session-card') { calls.at(-1).full = Boolean(value?.launch?.card); return value; }
        if (value?.ok === false) return value;
        calls.at(-1).full = Boolean(value.character);
        return { ok: true, status: 200, json: async () => clone(value) };
    }
    const run = () => kind === 'session-card' ? api.session('/api/homer/session', {
        owner: OWNER, appId: APP, conversationId: CHAT, isCurrent: () => epoch === 0, request: online,
        validate: value => assert.equal(value.user.id, OWNER),
    }) : api.character(AVATAR, { owner: OWNER, headers: {}, isCurrent: () => epoch === 0, fetcher: online });
    return {
        indexedDB, databaseName, id, kind, calls, hints, writes, run,
        seed: () => cache.write(OWNER, kind, id, digest(content), content),
        rawRead: options => cache.read(OWNER, kind, id, options),
        reopen() { cache = createCardTransportCache({ indexedDB, databaseName, now: () => clock }); },
        age(milliseconds = CARD_TRANSPORT_TTL_MS) { clock += milliseconds; },
        stale() { epoch++; }, hook(value) { responseHook = value; },
        get content() { return clone(content); }, set content(value) { content = clone(value); },
        rows: store => indexedDB.dump(databaseName, store || 'entries'),
        cache: () => cache,
    };
}

async function restored(h, result) { return h.kind === 'session-card' ? result.launch.card : result.json(); }

for (const kind of ['session-card', 'character-content-v2']) {
    test(`${kind}: exact 4h and multi-day bytes are only explicit SHA-verified online candidates`, async () => {
        const h = fixture(kind, { large: true }); await h.seed(); h.age();
        assert.equal(await h.rawRead(), null);
        const retained = h.rows(), metadata = h.rows('metadata');
        assert.equal(retained.length, 1); assert.equal(metadata.length, 1);
        h.reopen(); h.indexedDB.trace.length = 0;
        const value = await h.run();
        const actual = await restored(h, value);
        assert.deepEqual(kind === 'session-card' ? actual : { ...actual, chat_size: undefined, date_last_chat: undefined },
            kind === 'session-card' ? h.content : { ...h.content, chat_size: undefined, date_last_chat: undefined });
        if (kind === 'session-card') assert.equal(value.launch.messages.length, 13);
        else assert.equal(actual.date_last_chat, 101);
        assert.equal(h.calls.length, 1); assert.equal(h.calls[0].full, false);
        assert.equal(h.calls[0].known, digest(h.content)); assert.equal(h.writes.length, 0);
        assert.equal(h.hints[0].requiresOnlineConfirmation, true);
        assert.deepEqual(h.rows(), retained); assert.deepEqual(h.rows('metadata'), metadata);
        assert.ok(h.indexedDB.trace.filter(row => row.event === 'transaction').every(row => row.mode === 'readonly'));
        h.age(7 * 24 * 60 * 60 * 1000); h.reopen();
        await h.run(); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].full, false);
        assert.equal(h.writes.length, 0, 'A confirmed hit does not renew or rewrite multi-MiB bytes');
    });
    test(`${kind}: age crossing during authenticated reply does not reject explicitly verified content`, async () => {
        const h = fixture(kind); await h.seed();
        h.hook(({ body }) => { h.age(CARD_TRANSPORT_TTL_MS + 1); return body; });
        await h.run(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].full, false);
        assert.equal(h.writes.length, 0);
    });
    test(`${kind}: expired candidate never shadows a changed complete authoritative card`, async () => {
        const h = fixture(kind); await h.seed(); h.age(3 * CARD_TRANSPORT_TTL_MS);
        const changed = h.content; changed.data.character_book.entries[0].content = 'Changed complete world';
        changed.data.extensions.regex_scripts[0].replaceString = '<p>Changed renderer</p>'; h.content = changed;
        const value = await restored(h, await h.run());
        assert.equal(value.data.character_book.entries[0].content, 'Changed complete world');
        assert.equal(value.data.extensions.regex_scripts[0].replaceString, '<p>Changed renderer</p>');
        assert.equal(h.calls.length, 1); assert.equal(h.calls[0].full, true);
        assert.equal(h.writes.length, 1); await Promise.all(h.writes);
        assert.equal((await h.rawRead()).revision, digest(changed));
    });
    test(`${kind}: structurally valid expired corruption requires exactly one full fallback`, async () => {
        const h = fixture(kind); await h.seed(); h.age();
        h.cache().clearMemory(); // Cold IDB corruption; a valid server-confirmed L1 is independently tested.
        const row = h.rows()[0]; row.payload.data.name = 'Altered valid synthetic name';
        h.indexedDB.seed(h.databaseName, 'entries', row.key, row);
        const value = await restored(h, await h.run());
        assert.equal(value.data.name, h.content.data.name); assert.equal(h.calls.length, 2);
        assert.equal(h.calls[0].full, false); assert.equal(h.calls[1].known, '');
        assert.equal(h.calls[1].full, true); await Promise.all(h.writes);
    });
    for (const status of [401, 403, 404, 500, 'network']) {
        test(`${kind}: ${status} is authoritative even with readable expired complete bytes`, async () => {
            const h = fixture(kind); await h.seed(); h.age();
            assert.ok(await h.rawRead({ allowExpiredCandidate: true }));
            h.hook(() => {
                if (kind === 'session-card' || status === 'network') throw Error(`Synthetic ${status} rejection`);
                return { ok: false, status };
            });
            if (kind === 'session-card' || status === 'network') await assert.rejects(h.run(), new RegExp(String(status)));
            else assert.equal((await h.run()).status, status);
            assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
        });
    }
    test(`${kind}: account epoch changes after conditional read never restore or retry old candidates`, async () => {
        const h = fixture(kind); await h.seed(); h.age();
        h.hook(({ body }) => { h.stale(); return body; });
        await assert.rejects(h.run(), /账号或会话已变化/);
        assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
    });
    test(`${kind}: missing expired body under valid metadata still falls back once, never hint-only success`, async () => {
        const h = fixture(kind); await h.seed(); h.age();
        h.cache().clearMemory();
        h.indexedDB.database(h.databaseName).stores.get('entries').rows.clear();
        await h.run(); assert.equal(h.calls.length, 2);
        assert.equal(h.calls[0].full, false); assert.equal(h.calls[1].known, ''); assert.equal(h.calls[1].full, true);
        await Promise.all(h.writes);
    });
    test(`${kind}: future metadata/row time, disagreement and tampered scope do not supply conditional revisions`, async () => {
        for (const failure of ['future', 'timestamp-mismatch', 'owner', 'entryId']) {
            const h = fixture(kind); await h.seed();
            h.cache().clearMemory();
            const row = h.rows()[0], meta = h.rows('metadata')[0];
            if (failure === 'future') { row.expiresAt++; meta.expiresAt++; meta.lastStoredAt++; }
            if (failure === 'timestamp-mismatch') meta.expiresAt++;
            if (failure === 'owner') meta.owner = 'other-synthetic-owner';
            if (failure === 'entryId') meta.entryId = 'different-synthetic-entry';
            h.indexedDB.seed(h.databaseName, 'entries', row.key, row);
            h.indexedDB.seed(h.databaseName, 'metadata', row.key, meta);
            await h.run();
            if (failure !== 'entryId') assert.equal(h.calls[0].known, '', failure);
            else { assert.equal(h.calls.length, 2); assert.equal(h.calls[1].known, ''); }
            await Promise.all(h.writes);
        }
    });
}

test('default expired reads and an unrelated write keep intact legacy rows without DB schema or row migration', async () => {
    const h = fixture('session-card'); await h.seed(); const before = h.rows()[0];
    // These exact fields are the previous shipped IDB v1 format. No candidate
    // flag is persisted; it belongs only to the explicit read result/hint.
    assert.deepEqual(Object.keys(before).sort(), ['key', 'owner', 'kind', 'id', 'entryId', 'revision', 'payload', 'expiresAt'].sort());
    h.age(2 * CARD_TRANSPORT_TTL_MS); h.reopen(); assert.equal(await h.rawRead(), null);
    const other = { name: 'Other synthetic card' };
    await h.cache().write('other-synthetic-owner', 'session-card', 'other-card', digest(other), other);
    assert.equal(h.rows().length, 2); assert.deepEqual(h.rows().find(row => row.id === APP), before);
    const candidate = await h.rawRead({ allowExpiredCandidate: true });
    assert.equal(candidate.requiresOnlineConfirmation, true); assert.deepEqual(candidate.payload, h.content);
    assert.equal(await h.cache().read('other-synthetic-owner', 'session-card', APP, { allowExpiredCandidate: true }), null);
    assert.equal(await h.cache().read(OWNER, 'character-content-v2', APP, { allowExpiredCandidate: true }), null);
});

test('expired bytes remain within global eight-row and 32MiB last-stored limits; capacity misses read full online', async () => {
    const h = fixture('session-card'); await h.seed(); h.age(2 * CARD_TRANSPORT_TTL_MS);
    const large = { name: 'Synthetic capacity body', description: 'x'.repeat(5 * 1024 * 1024) };
    for (let i = 0; i < CARD_TRANSPORT_MAX_ROWS; i++) {
        h.age(1); await h.cache().write(OWNER, 'session-card', `capacity-${i}`, digest(large), large);
    }
    const rows = h.rows('metadata');
    assert.ok(rows.length <= CARD_TRANSPORT_MAX_ROWS);
    assert.ok(rows.reduce((sum, row) => sum + row.bytes, 0) <= CARD_TRANSPORT_MAX_BYTES);
    assert.equal(await h.rawRead({ allowExpiredCandidate: true }), null);
    await h.run(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].known, ''); assert.equal(h.calls[0].full, true);
    await Promise.all(h.writes);
    assert.equal(h.indexedDB.trace.some(row => row.store === 'entries' && /cursor/.test(row.operation || '')), false);
});

test('late corrupt cleanup cannot remove a replacement from another cache instance at the same scoped key', async () => {
    const h = fixture('session-card'); await h.seed(); h.age();
    const corrupt = h.rows()[0]; corrupt.payload.data.name = 'Altered valid synthetic shape';
    h.indexedDB.seed(h.databaseName, 'entries', corrupt.key, corrupt);
    const gate = h.indexedDB.holdNextCommit('readonly');
    const pending = h.rawRead({ allowExpiredCandidate: true }); await gate.reached;
    h.reopen(); const replacement = h.seed(); gate.release();
    assert.equal(await pending, null); await replacement; await turn();
    assert.equal((await h.rawRead()).payload.data.name, h.content.data.name);
});

test('candidate scope/clock markers are not accepted from a foreign or unlabeled expired storage result', async () => {
    for (const marker of ['none', 'owner', 'kind', 'id', 'future', 'infinite']) {
        const card = syntheticCard(false), revision = digest(card);
        const row = { revision, payload: card, expiresAt: 500, owner: OWNER, kind: 'session-card', id: APP,
            entryId: 'synthetic-entry', requiresOnlineConfirmation: true };
        if (marker === 'none') delete row.requiresOnlineConfirmation;
        if (marker === 'owner') row.owner = 'other-owner';
        if (marker === 'kind') row.kind = 'character-content-v2';
        if (marker === 'id') row.id = 'other-card';
        if (marker === 'future') row.expiresAt = 1000 + CARD_TRANSPORT_TTL_MS + 1;
        if (marker === 'infinite') row.expiresAt = Infinity;
        let calls = 0;
        const api = createCardTransport({ storage: { read: async () => clone(row), write: async () => true }, now: () => 1000 });
        const value = await api.session('/api/homer/session', { owner: OWNER, appId: APP, conversationId: CHAT,
            isCurrent: () => true, validate() {}, request: async path => {
                calls++;
                return { user: { id: OWNER }, launch: { app_id: APP, conversation_id: CHAT, bridge_token: 'synthetic-only',
                    card_transport: { version: 1, sha256: revision }, ...(path.includes('card_sha256') ? {} : { card: clone(card) }) } };
            } });
        assert.deepEqual(value.launch.card, card); assert.equal(calls, 1, marker);
    }
});
