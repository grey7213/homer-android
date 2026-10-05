import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCardTransportCache, CARD_TRANSPORT_TTL_MS, CARD_TRANSPORT_MAX_BYTES,
    CARD_TRANSPORT_MAX_ROWS } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const revision = digit => String(digit).repeat(64);
const digest = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const card = () => ({ spec: 'chara_card_v2', data: { name: '合成角色', first_mes: 'Synthetic opening',
    character_book: { entries: [{ content: 'isolated world', keys: ['fixture'] }] }, extensions: { regex_scripts: [] } } });
function fixture() {
    const indexedDB = cardTransportIDB(), databaseName = 'synthetic-card-transport'; let clock = 100;
    return { indexedDB, databaseName, cache: createCardTransportCache({ indexedDB, databaseName, now: () => clock }),
        tick(value = 1) { clock += value; }, setClock(value) { clock = value; }, get clock() { return clock; },
        rows(store = 'entries') { return indexedDB.dump(databaseName, store); } };
}
const write = (h, id = 'card', payload = card(), owner = 'owner-a') => h.cache.write(owner, 'session-card', id, digest(payload), payload);
const read = (h, id = 'card', owner = 'owner-a') => h.cache.read(owner, 'session-card', id);
const flush = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

test('stores complete V2/V3/legacy and mirror payloads; exact read is readonly without a cursor', async () => {
    const h = fixture();
    for (const [id, payload] of [['v2', card()], ['v3', { ...card(), spec: 'chara_card_v3' }], ['legacy', { name: 'Legacy', first_mes: 'hello' }]]) {
        await write(h, id, payload);
        h.indexedDB.trace.length = 0;
        assert.deepEqual(await read(h, id), { revision: digest(payload), payload, expiresAt: 100 + CARD_TRANSPORT_TTL_MS });
        assert.equal(h.indexedDB.trace.filter(value => value.event === 'transaction').every(value => value.mode === 'readonly'), true);
        assert.equal(h.indexedDB.trace.some(value => /cursor/.test(value.operation || '')), false);
    }
    const mirror = { name: 'Mirror', avatar: 'fixture.png', data: { name: 'Mirror', extensions: { value: 'preserved' } } };
    await h.cache.write('owner-a', 'character-mirror', 'fixture.png', digest(mirror), mirror);
    assert.deepEqual((await h.cache.read('owner-a', 'character-mirror', 'fixture.png')).payload, mirror);
    const topName = { name: 'Top-level legacy name', data: { extensions: {} } };
    await write(h, 'top-name', topName); assert.deepEqual((await read(h, 'top-name')).payload, topName);
});

test('scope accepts Unicode and rejects missing/long owner/id or unsupported kind without opening DB', async () => {
    const h = fixture(); await write(h, '角色/一', card(), '账户一'); assert.ok(await read(h, '角色/一', '账户一'));
    const count = h.indexedDB.openCount;
    for (const values of [['', 'session-card', 'a'], ['a', 'bad', 'b'], ['a', 'session-card', ''], ['a'.repeat(201), 'session-card', 'b']]) {
        await assert.rejects(h.cache.read(...values), TypeError);
    }
    assert.equal(h.indexedDB.openCount, count);
});

test('rejects invalid revision, card shape and session/token/user envelope before writing', async () => {
    const h = fixture();
    for (const payload of [[], null, {}, { data: [] }, { name: '' }, { name: 'Not a card', token: 'isolated sentinel' },
        { ...card(), user: {} }, { ...card(), session: {} }, { ...card(), launch: {} }, { ...card(), messages: [] },
        { name: 'Upper-case token field', TOKEN: 'isolated sentinel' }, { ...card(), spec: 'unknown' }]) {
        await assert.rejects(write(h, 'bad', payload), TypeError);
    }
    for (const invalid of ['a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64), null]) await assert.rejects(h.cache.write('a', 'session-card', 'b', invalid, card()), TypeError);
    await assert.rejects(h.cache.write('a', 'character-mirror', 'b', revision(1), { name: 'Mirror' }), TypeError);
    assert.equal(h.indexedDB.openCount, 0);
});

test('captures write before first await and reading structured clone cannot mutate persisted bytes', async () => {
    const h = fixture(), input = card(), pending = write(h, 'card', input); input.data.name = 'mutated'; await pending;
    const stored = await read(h); assert.equal(stored.payload.data.name, '合成角色');
    stored.payload.data.name = 'another mutation'; assert.equal((await read(h)).payload.data.name, '合成角色');
});

test('writer reuses one JSON capture and UTF8 encoding, including complete multi-MiB special-character source', async () => {
    const h = fixture(), input = card();
    input.data.first_mes = '';
    input.data.description = '字😀\u0000\ud800-x-\udfff\n'.repeat(180000);
    const original = JSON.stringify(input), expectedRevision = digest(input);
    const originalStringify = JSON.stringify, originalEncode = TextEncoder.prototype.encode;
    let stringifyCalls = 0, encodeCalls = 0, pending;
    try {
        JSON.stringify = function (...args) { stringifyCalls++; return Reflect.apply(originalStringify, JSON, args); };
        TextEncoder.prototype.encode = function (...args) { encodeCalls++; return Reflect.apply(originalEncode, this, args); };
        // Only the synchronous snapshot path is instrumented; fake-IDB storage
        // bookkeeping uses JSON too and is not part of the product capture.
        pending = h.cache.write('owner-a', 'session-card', 'captured-once', expectedRevision, input);
    } finally {
        JSON.stringify = originalStringify; TextEncoder.prototype.encode = originalEncode;
    }
    assert.equal(stringifyCalls, 1); assert.equal(encodeCalls, 1);
    input.data.name = 'Mutated after invocation'; input.data.description = 'Changed source';
    await pending;
    const stored = h.rows().find(row => row.id === 'captured-once');
    assert.equal(JSON.stringify(stored.payload), original); assert.equal(stored.revision, expectedRevision);
    assert.equal(h.rows('metadata')[0].bytes, Buffer.byteLength(original, 'utf8'));
    const reopened = await read(h, 'captured-once');
    assert.equal(JSON.stringify(reopened.payload), original); assert.equal(reopened.revision, expectedRevision);
});

test('writer rejects a complete-byte SHA mismatch before opening IDB even with empty and Unicode fields', async () => {
    const h = fixture(), input = card();
    input.data.first_mes = ''; input.data.description = '\u0000字😀\ud800-x-\udfff';
    const valid = digest(input), mismatch = `${valid[0] === '0' ? '1' : '0'}${valid.slice(1)}`;
    await assert.rejects(h.cache.write('owner-a', 'session-card', 'wrong-bytes', mismatch, input), /content revision mismatch/);
    assert.equal(h.indexedDB.openCount, 0); assert.equal(h.rows().length, 0);
});

test('write and read wait for transaction completion; successful requests followed by abort roll back', async () => {
    const h = fixture(), writeGate = h.indexedDB.holdNextCommit('readwrite'); let settled = false;
    const pending = write(h).then(value => { settled = true; return value; }); const tx = await writeGate.reached;
    assert.equal(settled, false); tx.abort(); writeGate.release(); await assert.rejects(pending, /aborted/);
    assert.equal(h.rows().length, 0); await write(h);
    const readGate = h.indexedDB.holdNextCommit('readonly'); settled = false;
    const reading = read(h).then(value => { settled = true; return value; }); await readGate.reached;
    assert.equal(settled, false); readGate.release(); assert.ok(await reading); assert.equal(settled, true);
});

test('exact TTL is a default-read miss, but intact scoped source bytes remain bounded candidates', async () => {
    const h = fixture(); await write(h); h.tick(10); await write(h, 'other', card(), 'owner-b');
    h.setClock(100 + CARD_TRANSPORT_TTL_MS); assert.equal(await read(h), null);
    await flush();
    assert.equal(h.rows().length, 2); assert.ok(await read(h, 'other', 'owner-b'));
    const candidate = await h.cache.read('owner-a', 'session-card', 'card', { allowExpiredCandidate: true });
    assert.deepEqual(candidate.payload, card()); assert.equal(candidate.requiresOnlineConfirmation, true);
    assert.equal(candidate.owner, 'owner-a'); assert.equal(candidate.id, 'card');
});

test('corrupt revision/name/key/metadata is a cache miss, never a session or another owner', async () => {
    for (const corrupt of ['revision', 'payload', 'key', 'metadata']) {
        const h = fixture(); await write(h); await write(h, 'other', card(), 'owner-b');
        const row = h.rows()[0];
        if (corrupt === 'revision') row.revision = 'INVALID';
        if (corrupt === 'payload') row.payload = { name: 'Fixture', session: {} };
        if (corrupt === 'key') { row.key = []; row.key.push(row.key); }
        if (corrupt === 'metadata') {
            const meta = h.rows('metadata')[0]; meta.bytes = -1; h.indexedDB.seed(h.databaseName, 'metadata', ['owner-a', 'session-card', 'card'], meta);
        } else h.indexedDB.seed(h.databaseName, 'entries', ['owner-a', 'session-card', 'card'], row);
        assert.equal(await read(h), null); assert.ok(await read(h, 'other', 'owner-b'));
    }
});

test('late corrupt cleanup cannot delete a concurrently replaced valid cached card', async () => {
    const h = fixture(); await write(h);
    const corrupted = h.rows()[0]; corrupted.payload.data.first_mes = 'Altered valid synthetic shape';
    h.indexedDB.seed(h.databaseName, 'entries', corrupted.key, corrupted);
    const gate = h.indexedDB.holdNextCommit('readonly'), reading = read(h); await gate.reached;
    const replacement = write(h); gate.release(); assert.equal(await reading, null); await replacement;
    assert.ok(await read(h));
});

test('global eight-row last-stored eviction scans metadata only; repeated read is not an LRU write', async () => {
    const h = fixture();
    for (let i = 0; i <= CARD_TRANSPORT_MAX_ROWS; i++) { h.tick(); await write(h, String(i), card(), i % 2 ? 'owner-b' : 'owner-a'); }
    assert.equal(h.rows().length, CARD_TRANSPORT_MAX_ROWS); assert.equal(await read(h, '0'), null);
    assert.equal(h.indexedDB.trace.some(value => value.store === 'entries' && /cursor/.test(value.operation || '')), false);
    assert.equal(h.indexedDB.trace.some(value => value.store === 'metadata' && value.operation === 'cursor'), true);
    h.tick(); await write(h, '1', card(), 'owner-b'); h.tick(); await write(h, '9');
    assert.ok(await read(h, '1', 'owner-b')); assert.equal(await read(h, '2'), null);
});

test('32MiB UTF8 payload budget evicts old data, and a single oversize payload is never stored', async () => {
    const h = fixture(), payload = { name: 'Large synthetic fixture', description: '字'.repeat(3 * 1024 * 1024) };
    for (let i = 0; i < 4; i++) { h.tick(); await write(h, String(i), payload); }
    assert.equal(h.rows().length, 3); assert.equal(await read(h, '0'), null);
    assert.ok(h.rows('metadata').reduce((sum, row) => sum + row.bytes, 0) <= CARD_TRANSPORT_MAX_BYTES);
    const before = h.rows('metadata').length;
    assert.equal(await write(h, 'oversize', { name: 'Oversize', description: 'x'.repeat(CARD_TRANSPORT_MAX_BYTES) }), false);
    assert.equal(h.rows('metadata').length, before);
});

test('remove/clearOwner isolate kind/id/owner and never access the outbox or login storage', async () => {
    const h = fixture(); await write(h); await write(h, 'card', card(), 'owner-b'); await write(h, 'other');
    const mirror = { name: 'Mirror', avatar: 'fixture.png' };
    await h.cache.write('owner-a', 'character-mirror', 'card', digest(mirror), mirror);
    await h.cache.remove('owner-a', 'session-card', 'card'); assert.equal(await read(h), null);
    assert.ok(await h.cache.read('owner-a', 'character-mirror', 'card'));
    assert.equal(await h.cache.clearOwner('owner-a'), 2); assert.ok(await read(h, 'card', 'owner-b'));
    assert.deepEqual([...h.indexedDB.database(h.databaseName).stores.keys()].sort(), ['entries', 'metadata']);
});

test('unavailable/failed/blocked DB opens can retry, failed writes remain atomic, old WebViews fall back', async () => {
    const h = fixture(); h.indexedDB.openError = true; await assert.rejects(write(h), /open failure/);
    h.indexedDB.openError = false; h.indexedDB.blockNextOpen = true; await assert.rejects(write(h), /blocked/);
    assert.equal(h.indexedDB.closeCount, 1); h.indexedDB.strictUnsupported = true; assert.equal(await write(h), true);
    h.indexedDB.failNextPut = true; await assert.rejects(write(h, 'new'), /quota/); assert.equal(h.rows().length, 1);
    assert.ok(await read(h)); assert.ok(h.indexedDB.openCount >= 3);
    await assert.rejects(createCardTransportCache({ indexedDB: null }).read('a', 'session-card', 'b'), /unavailable/);
});

test('new cache instance reopens durable data with full owner and kind isolation', async () => {
    const h = fixture(); await write(h);
    const reopened = createCardTransportCache({ indexedDB: h.indexedDB, databaseName: h.databaseName, now: () => h.clock });
    assert.ok(await reopened.read('owner-a', 'session-card', 'card'));
    assert.equal(await reopened.read('owner-b', 'session-card', 'card'), null);
    assert.equal(await reopened.read('owner-a', 'character-mirror', 'card'), null);
});

test('cyclic/non-JSON corruption is a miss and owner clear removes metadata/body orphans without body cursors', async () => {
    const h = fixture(); await write(h);
    const corrupted = h.rows()[0]; corrupted.payload.data.extensions.loop = corrupted.payload;
    h.indexedDB.seed(h.databaseName, 'entries', corrupted.key, corrupted);
    assert.equal(await read(h), null);
    await write(h, 'orphan');
    const db = h.indexedDB.database(h.databaseName), key = JSON.stringify(['owner-a', 'session-card', 'orphan']);
    db.stores.get('metadata').rows.delete(key);
    h.indexedDB.trace.length = 0;
    assert.ok(await h.cache.clearOwner('owner-a') >= 1);
    assert.equal(h.rows().length + h.rows('metadata').length, 0);
    assert.equal(h.indexedDB.trace.some(value => value.operation === 'cursor'), false);
});

test('valid-shape altered content with unchanged revision and metadata is rejected in all card cache namespaces', async () => {
    for (const kind of ['session-card', 'character-mirror', 'character-content-v2']) {
        const h = fixture(), payload = kind === 'session-card' ? card() : { name: 'Mirror', avatar: 'fixture.png', data: card().data };
        await h.cache.write('owner-a', kind, 'corrupt', digest(payload), payload);
        await write(h, 'other', card(), 'owner-b');
        const row = h.rows().find(value => value.owner === 'owner-a');
        row.payload.data.first_mes = 'Altered but structurally valid';
        h.indexedDB.seed(h.databaseName, 'entries', row.key, row);
        assert.equal(await h.cache.read('owner-a', kind, 'corrupt'), null);
        assert.ok(await read(h, 'other', 'owner-b'));
        for (let i = 0; i < 30 && h.rows().length !== 1; i++) await flush();
        assert.equal(h.rows().length, 1);
    }
});

test('writer cannot retain an unrelated valid-format revision; complete JSON source digest is required', async () => {
    const h = fixture();
    await assert.rejects(h.cache.write('owner-a', 'session-card', 'wrong', revision(1), card()), /content revision mismatch/);
    assert.equal(h.indexedDB.openCount, 0);
    const payload = card(); payload.data.extensions.extra = { unicode: '字😀', nul: '\u0000', lone: '\ud800' };
    assert.equal(await write(h, 'exact', payload), true);
    assert.deepEqual((await read(h, 'exact')).payload, payload);
});

test('v2 character content is an isolated namespace, requires avatar, and never silently strips digest fields', async () => {
    const h = fixture(), old = { name: 'Mirror', avatar: 'fixture.png', data: { name: 'Mirror' }, date_last_chat: 1, chat_size: 42 };
    const stable = { name: 'Mirror', avatar: 'fixture.png', data: { name: 'Mirror' } };
    await h.cache.write('owner-a', 'character-mirror', 'fixture.png', digest(old), old);
    assert.equal(await h.cache.read('owner-a', 'character-content-v2', 'fixture.png'), null);
    await h.cache.write('owner-a', 'character-content-v2', 'fixture.png', digest(stable), stable);
    assert.deepEqual((await h.cache.read('owner-a', 'character-content-v2', 'fixture.png')).payload, stable);
    assert.deepEqual((await h.cache.read('owner-a', 'character-mirror', 'fixture.png')).payload, old);
    await assert.rejects(h.cache.write('owner-a', 'character-content-v2', 'invalid', digest({ name: 'Missing avatar' }), { name: 'Missing avatar' }), TypeError);
    // Cache verifies the complete received payload. The client/server protocol,
    // not this storage module, owns the explicit stable/statistics separation.
    await assert.rejects(h.cache.write('owner-a', 'character-content-v2', 'wrong', digest(stable), old), /content revision mismatch/);
    assert.equal(await h.cache.clearOwner('owner-a'), 2);
});

test('small revision hint precedes full read completion, from metadata first in the same readonly snapshot', async () => {
    const h = fixture(), payload = card(); await write(h, 'card', payload);
    const gate = h.indexedDB.holdNextCommit('readonly'), hints = [];
    h.indexedDB.trace.length = 0;
    let settled = false;
    const pending = h.cache.read('owner-a', 'session-card', 'card', { onRevision: hint => {
        assert.equal(Object.isFrozen(hint), true);
        assert.deepEqual(Object.keys(hint).sort(), ['entryId', 'expiresAt', 'id', 'kind', 'owner', 'revision'].sort());
        hints.push(hint);
    } }).then(row => { settled = true; return row; });
    await gate.reached;
    assert.equal(settled, false); assert.equal(hints.length, 1);
    assert.equal(hints[0].revision, digest(payload)); assert.equal(hints[0].owner, 'owner-a');
    assert.deepEqual(h.indexedDB.trace.filter(item => item.operation === 'get').map(item => item.store), ['metadata', 'entries']);
    gate.release();
    assert.deepEqual(await pending, { revision: digest(payload), payload, expiresAt: 100 + CARD_TRANSPORT_TTL_MS });
});

test('invalid metadata scope, entry ID, revision, TTL or byte budget never emits a revision hint', async () => {
    const mutations = [meta => { meta.owner = 'owner-b'; }, meta => { meta.kind = 'character-mirror'; },
        meta => { meta.id = 'other'; }, meta => { meta.key = ['owner-b', 'session-card', 'card']; },
        meta => { meta.entryId = ''; }, meta => { meta.entryId = 'x'.repeat(201); },
        meta => { meta.revision = 'INVALID'; }, meta => { meta.expiresAt = 100; },
        meta => { meta.expiresAt = 101 + CARD_TRANSPORT_TTL_MS; }, meta => { meta.bytes = -1; },
        meta => { meta.bytes = CARD_TRANSPORT_MAX_BYTES + 1; }, meta => { meta.lastStoredAt = NaN; }];
    for (const mutate of mutations) {
        const h = fixture(); await write(h);
        const meta = h.rows('metadata')[0]; mutate(meta);
        h.indexedDB.seed(h.databaseName, 'metadata', ['owner-a', 'session-card', 'card'], meta);
        const hints = [];
        assert.equal(await h.cache.read('owner-a', 'session-card', 'card', { onRevision: hint => hints.push(hint) }), null);
        assert.deepEqual(hints, []);
    }
});

test('a revision hint is not intact-body evidence: corruption still fails the complete digest', async () => {
    const h = fixture(); await write(h);
    const row = h.rows()[0]; row.payload.data.first_mes = 'Structurally valid but altered';
    h.indexedDB.seed(h.databaseName, 'entries', row.key, row);
    const hints = [];
    assert.equal(await h.cache.read('owner-a', 'session-card', 'card', { onRevision: hint => hints.push(hint) }), null);
    assert.equal(hints.length, 1); assert.equal(hints[0].revision, row.revision);
});

test('orphan metadata can only hint, while missing body remains a cache miss', async () => {
    const h = fixture(); await write(h);
    h.indexedDB.database(h.databaseName).stores.get('entries').rows.delete(JSON.stringify(['owner-a', 'session-card', 'card']));
    const hints = [];
    assert.equal(await h.cache.read('owner-a', 'session-card', 'card', { onRevision: hint => hints.push(hint) }), null);
    assert.equal(hints.length, 1);
});

test('optional revision callback failure cannot abort the original complete read contract', async () => {
    const h = fixture(); await write(h);
    const result = await h.cache.read('owner-a', 'session-card', 'card', { onRevision: () => { throw Error('Synthetic observer failure'); } });
    assert.deepEqual(result.payload, card()); assert.equal(result.revision, digest(card()));
});
