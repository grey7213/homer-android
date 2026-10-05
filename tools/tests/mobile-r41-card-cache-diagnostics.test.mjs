import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCardTransportCache, CARD_TRANSPORT_TTL_MS } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';
import { createCardTransport } from '../../sillytavern-runtime/public/scripts/homer-card-transport.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

// Synthetic unit data only; no product identities, card bytes or credentials.
const card = { name: 'Synthetic diagnostics', data: { name: 'Synthetic diagnostics', extensions: {} } };
const revision = createHash('sha256').update(JSON.stringify(card)).digest('hex');
const owner = 'synthetic-owner-private-sentinel', id = 'synthetic-card-private-sentinel';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const indexedDB = cardTransportIDB(), databaseName = 'synthetic-diagnostic-db'; let clock = 100;
    const cache = createCardTransportCache({ indexedDB, databaseName, now: () => clock });
    return { indexedDB, databaseName, cache, write: () => cache.write(owner, 'session-card', id, revision, card),
        read: options => cache.read(owner, 'session-card', id, options),
        seed(store, change) { const row = indexedDB.dump(databaseName, store)[0]; change(row); indexedDB.seed(databaseName, store, row.key, row); },
        get clock() { return clock; },
        expire() { clock += CARD_TRANSPORT_TTL_MS; } };
}
async function observe(flag, action, { throwing = false, throwingFlag = false } = {}) {
    const beforeFlag = Object.getOwnPropertyDescriptor(globalThis, '__HOMER_CARD_CACHE_DIAGNOSTICS__');
    const beforePerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance'), marks = [];
    try {
        Object.defineProperty(globalThis, '__HOMER_CARD_CACHE_DIAGNOSTICS__', throwingFlag
            ? { configurable: true, get() { throw Error('Synthetic flag unavailable'); } }
            : { configurable: true, writable: true, value: flag });
        Object.defineProperty(globalThis, 'performance', { configurable: true, value: { mark(name) {
            if (throwing) throw Error('Synthetic observer unavailable'); marks.push(name);
        } } });
        await action(marks);
        for (const name of marks) {
            assert.match(name, /^homer-card-(cache|transport):(session-card|character-mirror|character-content-v2):[a-z-]+$/);
            for (const privateValue of [owner, id, revision, card.name]) assert.ok(!name.includes(privateValue));
        }
        return marks;
    } finally {
        if (beforeFlag) Object.defineProperty(globalThis, '__HOMER_CARD_CACHE_DIAGNOSTICS__', beforeFlag);
        else delete globalThis.__HOMER_CARD_CACHE_DIAGNOSTICS__;
        if (beforePerformance) Object.defineProperty(globalThis, 'performance', beforePerformance);
        else delete globalThis.performance;
    }
}
const cacheMark = reason => `homer-card-cache:session-card:${reason}`;
const transportMark = reason => `homer-card-transport:session-card:${reason}`;
const onlineBody = (hit = false) => ({ user: { id: owner }, launch: { app_id: id, conversation_id: 'synthetic-chat',
    bridge_token: 'synthetic-not-a-credential', card_transport: { version: 1, sha256: revision }, ...(hit ? {} : { card: structuredClone(card) }) } });
function session(storage, { timeout = 20, request = async () => onlineBody(), ownerValue = owner, current = () => true } = {}) {
    const api = createCardTransport({ storage, now: () => 100, readTimeoutMs: timeout });
    return api.session('/api/homer/session', { owner: ownerValue, appId: id, conversationId: 'synthetic-chat', request,
        validate() {}, isCurrent: current });
}

for (const flag of [undefined, false, 1, 'true']) test(`diagnostics are completely opt-in: ${String(flag)}`, async () => {
    const marks = await observe(flag, async () => {
        const h = fixture(); await h.write(); assert.deepEqual((await h.read()).payload, card);
        assert.deepEqual((await session(h.cache, { request: async () => onlineBody(true) })).launch.card, card);
    });
    assert.deepEqual(marks, []);
});

test('enabled valid read marks actual metadata, digest and verification without identity values', async () => {
    const marks = await observe(true, async () => {
        const h = fixture(); await h.write(); let hinted = false;
        assert.deepEqual((await h.read({ onRevision() { hinted = true; } })).payload, card); assert.equal(hinted, true);
    });
    for (const reason of ['read-start', 'metadata-valid', 'hint-emitted', 'digest-start', 'read-verified']) assert.ok(marks.includes(cacheMark(reason)));
    assert.ok(!marks.includes(cacheMark('row-invalid')));
});

test('explicit expired candidates have separate fixed anonymous marks, not a cache rejection', async () => {
    const marks = await observe(true, async () => {
        const h = fixture(); await h.write(); h.expire();
        assert.equal(await h.read(), null);
        const api = createCardTransport({ storage: h.cache, now: () => h.clock });
        const value = await api.session('/api/homer/session', { owner, appId: id, conversationId: 'synthetic-chat',
            validate() {}, isCurrent: () => true, request: async () => onlineBody(true) });
        assert.deepEqual(value.launch.card, card);
    });
    for (const reason of ['metadata-expired', 'expired-retained', 'metadata-expired-candidate',
        'row-expired-candidate', 'post-digest-expired-candidate', 'read-verified']) {
        assert.ok(marks.includes(cacheMark(reason)), reason);
    }
    for (const reason of ['expired-candidate-hint', 'expired-candidate-verified', 'restore-accepted']) {
        assert.ok(marks.includes(transportMark(reason)), reason);
    }
    assert.ok(!marks.includes(cacheMark('row-invalid')));
    assert.ok(!marks.includes(transportMark('restore-retry')));
});

for (const failure of ['missing', 'expired', 'metadata-invalid', 'shape-invalid', 'digest-mismatch']) test(`actual cache rejection is marked: ${failure}`, async () => {
    const marks = await observe(true, async () => {
        const h = fixture();
        if (failure !== 'missing') await h.write();
        if (failure === 'expired') h.expire();
        if (failure === 'metadata-invalid') h.seed('metadata', row => { row.bytes = -1; });
        if (failure === 'shape-invalid') h.seed('entries', row => { row.payload.name = ''; row.payload.data.name = ''; });
        if (failure === 'digest-mismatch') h.seed('entries', row => { row.payload.data.name = 'Changed valid synthetic shape'; });
        assert.equal(await h.read(), null);
    });
    const reason = { missing: 'metadata-missing', expired: 'metadata-expired', 'metadata-invalid': 'metadata-invalid',
        'shape-invalid': 'row-invalid', 'digest-mismatch': 'digest-mismatch' }[failure];
    assert.ok(marks.includes(cacheMark(reason))); assert.ok(!marks.includes(cacheMark('read-verified')));
});

test('IDB failure still rejects and marks a fixed error category', async () => {
    const marks = await observe(true, async () => {
        const h = fixture(); h.indexedDB.openError = true; await assert.rejects(h.read(), /open failure/);
    });
    assert.ok(marks.includes(cacheMark('idb-error')));
});

test('valid orphan metadata is distinguished from a missing complete entry', async () => {
    const marks = await observe(true, async () => {
        const h = fixture(); await h.write();
        h.indexedDB.database(h.databaseName).stores.get('entries').rows.clear();
        assert.equal(await h.read({ onRevision() {} }), null);
    });
    assert.ok(marks.includes(cacheMark('hint-emitted')));
    assert.ok(marks.includes(cacheMark('row-missing')));
    assert.ok(!marks.includes(cacheMark('read-verified')));
});

for (const mode of ['mark-throws', 'flag-throws']) test(`observer failure cannot alter successful reads or authoritative rejection: ${mode}`, async () => {
    await observe(true, async () => {
        const h = fixture(); await h.write(); assert.deepEqual((await h.read()).payload, card);
        assert.deepEqual((await session(h.cache, { request: async () => onlineBody(true) })).launch.card, card);
        await assert.rejects(session(h.cache, { request: async () => { throw Error('Synthetic HTTP 401'); } }), /401/);
        const corrupted = fixture(); await corrupted.write();
        corrupted.seed('entries', row => { row.payload.data.name = 'Corrupted synthetic source'; });
        assert.equal(await corrupted.read(), null);
    }, { throwing: mode === 'mark-throws', throwingFlag: mode === 'flag-throws' });
});

test('startup deadline and late cache read remain separate from body restoration deadline', async () => {
    const marks = await observe(true, async () => {
        const pendingRead = deferred(); let requests = 0;
        const storage = { read: () => pendingRead.promise, write: async () => true };
        const value = await session(storage, { timeout: 5, request: async () => { requests++; return onlineBody(); } });
        assert.deepEqual(value.launch.card, card); assert.equal(requests, 1);
        pendingRead.resolve(null); await turn();
    });
    assert.ok(marks.includes(transportMark('startup-deadline')));
    assert.ok(marks.includes(transportMark('network-without-revision')));
    assert.ok(!marks.includes(transportMark('body-wait-deadline')));
});

test('conditional body timeout retains one full fallback, with fixed deadline/retry marks', async () => {
    const marks = await observe(true, async () => {
        const pendingRead = deferred(); let requests = 0;
        const storage = { read(_owner, kind, key, { onRevision }) {
            onRevision({ owner, kind, id: key, entryId: 'synthetic-entry', revision, expiresAt: 500 }); return pendingRead.promise;
        }, write: async () => true };
        const value = await session(storage, { timeout: 5, request: async () => onlineBody(++requests === 1) });
        assert.deepEqual(value.launch.card, card); assert.equal(requests, 2); pendingRead.resolve(null); await turn();
    });
    for (const reason of ['hint-accepted', 'network-with-revision', 'body-wait-start', 'body-wait-deadline', 'restore-retry']) assert.ok(marks.includes(transportMark(reason)));
    assert.ok(!marks.includes(transportMark('startup-deadline')));
});

test('missing owner uses online authority without issuing a cache read', async () => {
    const marks = await observe(true, async () => {
        let reads = 0;
        const storage = { read: async () => { reads++; return null; }, write: async () => true };
        assert.deepEqual((await session(storage, { ownerValue: '' })).launch.card, card); assert.equal(reads, 0);
    });
    assert.ok(marks.includes(transportMark('owner-missing')));
});

test('authoritative HTTP rejection and stale account guard are never converted into cache success', async () => {
    const marks = await observe(true, async () => {
        const storage = { read: async () => null, write: async () => true };
        await assert.rejects(session(storage, { request: async () => { throw Error('Synthetic HTTP 403'); } }), /403/);
        await assert.rejects(session(storage, { current: () => false }), /账号或会话已变化/);
    });
    assert.ok(marks.includes(transportMark('online-or-auth-rejected')));
});

test('mirror HTTP rejection remains the identical response with its fixed rejection mark', async () => {
    const rejected = { ok: false, status: 403 };
    const marks = await observe(true, async () => {
        const storage = { read: async () => null, write: async () => true };
        const api = createCardTransport({ storage, now: () => 100 });
        const actual = await api.character('synthetic-private-avatar.png', { owner, headers: {}, fetcher: async () => rejected });
        assert.equal(actual, rejected);
    });
    assert.ok(marks.includes('homer-card-transport:character-content-v2:online-or-auth-rejected'));
});
