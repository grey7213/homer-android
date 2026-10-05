import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCardTransportCache, clearCardTransportMemory, CARD_TRANSPORT_TTL_MS } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const owner = 'synthetic-owner';
const kind = 'session-card';
const id = 'synthetic-card';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
const source = () => ({ spec: 'chara_card_v2', data: { name: 'Synthetic source', first_mes: '字😀\u0000',
    character_book: { entries: [{ content: 'Complete synthetic worldbook', keys: ['fixture'] }] },
    extensions: { regex_scripts: [{ findRegex: '/fixture/g', replaceString: '<b>fixture</b>' }],
        unknown: { intact: ['unknown field', 17, false] } } } });

async function fixture() {
    clearCardTransportMemory();
    const indexedDB = cardTransportIDB(), databaseName = 'synthetic-hint-before-body';
    let clock = 100;
    const cache = createCardTransportCache({ indexedDB, databaseName, now: () => clock });
    const payload = source();
    await cache.write(owner, kind, id, digest(payload), payload);
    clearCardTransportMemory();
    const db = indexedDB.database(databaseName), originalTransaction = db.transaction;
    const events = [], controls = { failure: null };
    // Enforce the real IndexedDB request-event lifetime: the complete-body
    // request must be submitted synchronously while metadata success is active,
    // not in an awaited microtask, a timer or a second transaction. The shared
    // double already pumps requests appended inside an onsuccess callback.
    db.transaction = function (names, mode, options) {
        const tx = Reflect.apply(originalTransaction, this, [names, mode, options]);
        if (mode !== 'readonly') return tx;
        events.push('readonly-transaction');
        const originalObjectStore = tx.objectStore.bind(tx);
        let metadataCallbackActive = false;
        tx.objectStore = name => {
            const store = originalObjectStore(name), originalGet = store.get;
            store.get = key => {
                if (name === 'entries') {
                    assert.equal(metadataCallbackActive, true, 'body GET belongs to the synchronous metadata-success event');
                    events.push('body-queued');
                    if (controls.failure === 'body-submit') throw Error('Synthetic body submission failure');
                } else events.push('metadata-queued');
                const request = Reflect.apply(originalGet, store, [key]);
                if (controls.failure === `${name}-delivery`) {
                    Object.defineProperty(request, 'result', { configurable: true,
                        set() { throw Error(`Synthetic ${name} delivery failure`); } });
                }
                let callback;
                Object.defineProperty(request, 'onsuccess', { configurable: true,
                    set(value) { callback = value; }, get() {
                        return event => {
                            events.push(`${name}-success-start`);
                            if (name === 'metadata') metadataCallbackActive = true;
                            try { return callback?.(event); }
                            finally {
                                metadataCallbackActive = false;
                                events.push(`${name}-success-end`);
                            }
                        };
                    } });
                return request;
            };
            return store;
        };
        return tx;
    };
    indexedDB.trace.length = 0;
    return { cache, indexedDB, databaseName, events, controls, payload,
        get clock() { return clock; }, setClock(value) { clock = value; },
        read(options = {}, selectedOwner = owner) { return cache.read(selectedOwner, kind, id, options); },
        rows(store = 'entries') { return indexedDB.dump(databaseName, store); },
        alter(store, change) { const row = indexedDB.dump(databaseName, store)[0]; change(row); indexedDB.seed(databaseName, store, [owner, kind, id], row); } };
}

test('shipping read starts the revision hint before submitting the complete body in one active readonly transaction', async () => {
    const h = await fixture(); let capturedHint, bodyQueuedAtHint;
    const row = await h.read({ onRevision: hint => {
        capturedHint = hint; bodyQueuedAtHint = h.events.includes('body-queued');
        h.events.push('fresh-online-request-start');
    } });
    // Observer exceptions are intentionally ignored by shipping code, so its
    // contract assertions belong outside that callback rather than in a catch.
    assert.equal(Object.isFrozen(capturedHint), true);
    assert.deepEqual(Object.keys(capturedHint).sort(), ['owner', 'kind', 'id', 'entryId', 'revision', 'expiresAt'].sort());
    assert.equal(capturedHint.revision, digest(h.payload));
    assert.equal(bodyQueuedAtHint, false); assert.equal('payload' in capturedHint, false);
    assert.deepEqual(h.events, ['readonly-transaction', 'metadata-queued', 'metadata-success-start',
        'fresh-online-request-start', 'body-queued', 'metadata-success-end', 'entries-success-start', 'entries-success-end']);
    assert.deepEqual(row, { revision: digest(h.payload), payload: h.payload, expiresAt: 100 + CARD_TRANSPORT_TTL_MS });
    assert.equal(h.indexedDB.trace.filter(item => item.event === 'transaction').length, 1);
    assert.equal(h.indexedDB.trace.some(item => /cursor|put|delete/.test(item.operation || '')), false);
});

test('no observer still reads and validates the complete body in the original readonly transaction', async () => {
    const h = await fixture(), row = await h.read();
    assert.deepEqual(row.payload, h.payload);
    assert.deepEqual(h.events.slice(0, 5), ['readonly-transaction', 'metadata-queued', 'metadata-success-start', 'body-queued', 'metadata-success-end']);
    assert.equal(h.indexedDB.trace.filter(item => item.event === 'transaction').length, 1);
});

test('throwing optional hint does not abort or defer the complete body request', async () => {
    const h = await fixture();
    const row = await h.read({ onRevision() { h.events.push('hint-throws'); throw Error('Synthetic observer failure'); } });
    assert.deepEqual(row.payload, h.payload);
    assert.ok(h.events.indexOf('hint-throws') < h.events.indexOf('body-queued'));
    assert.equal(h.indexedDB.trace.some(item => item.event === 'transaction-abort'), false);
});

test('the result remains pending until its original transaction commits', async () => {
    const h = await fixture(), gate = h.indexedDB.holdNextCommit('readonly');
    let settled = false, hints = 0;
    const reading = h.read({ onRevision() { hints++; } }).then(row => { settled = true; return row; });
    await gate.reached;
    assert.equal(hints, 1); assert.equal(settled, false);
    assert.equal(h.events.filter(event => event === 'readonly-transaction').length, 1);
    gate.release(); assert.deepEqual((await reading).payload, h.payload);
});

test('global account invalidation in the hint cannot admit memory or issue owned/touch tickets', async () => {
    const h = await fixture();
    const row = await h.read({ allowOwnedPayload: true, allowExpiredCandidate: true,
        onRevision() { clearCardTransportMemory(); } });
    assert.deepEqual(row.payload, h.payload, 'standalone durable source read is not an authorization decision');
    assert.equal(h.cache.consumePayload(owner, kind, id, row, { revision: row.revision, isCurrent: () => true }), null);
    assert.equal(h.cache.touch(owner, kind, id, row, { isCurrent: () => true }), false);
    h.events.length = 0; h.indexedDB.trace.length = 0;
    assert.deepEqual((await h.read({ allowVerifiedMemory: true })).payload, h.payload);
    assert.equal(h.events.filter(event => event === 'body-queued').length, 1, 'a late read cannot resurrect invalidated L1');
});

test('invalid metadata never hints, but the same transaction still reads the whole row before rejecting it', async t => {
    for (const [name, change] of [
        ['owner', meta => { meta.owner = 'other-owner'; }],
        ['key', meta => { meta.key = ['other-owner', kind, id]; }],
        ['entry', meta => { meta.entryId = ''; }],
        ['revision', meta => { meta.revision = 'bad-revision'; }],
        ['future', meta => { meta.expiresAt++; }],
        ['bytes', meta => { meta.bytes = 0; }],
    ]) await t.test(name, async () => {
        const h = await fixture(); h.alter('metadata', change);
        let hints = 0;
        assert.equal(await h.read({ onRevision() { hints++; } }), null);
        assert.equal(hints, 0);
        assert.equal(h.events.filter(event => event === 'body-queued').length, 1);
    });
});

test('foreign-owner lookup never emits an original owner hint or returns their source', async () => {
    const h = await fixture(); let hints = 0;
    assert.equal(await h.read({ onRevision() { hints++; } }, 'other-owner'), null);
    assert.equal(hints, 0);
    assert.equal(h.events.filter(event => event === 'body-queued').length, 1);
    assert.deepEqual((await h.read()).payload, h.payload);
});

test('valid revision metadata is never enough: complete altered source fails its full SHA', async () => {
    const h = await fixture(); h.alter('entries', row => { row.payload.data.extensions.unknown.intact[0] = 'changed'; });
    let hints = 0;
    assert.equal(await h.read({ onRevision() { hints++; } }), null);
    assert.equal(hints, 1);
    assert.equal(h.events.filter(event => event === 'body-queued').length, 1);
});

test('missing metadata/body preserve the original cache-miss contract without a second readonly transaction', async t => {
    for (const missing of ['metadata', 'entries']) await t.test(missing, async () => {
        const h = await fixture();
        h.indexedDB.database(h.databaseName).stores.get(missing).rows.clear();
        let hints = 0;
        assert.equal(await h.read({ onRevision() { hints++; } }), null);
        assert.equal(hints, missing === 'entries' ? 1 : 0);
        assert.equal(h.events.filter(event => event === 'readonly-transaction').length, 1);
        assert.equal(h.events.filter(event => event === 'body-queued').length, 1);
    });
});

test('metadata error aborts before body submission and the original storage error propagates', async () => {
    const h = await fixture(); h.controls.failure = 'metadata-delivery';
    await assert.rejects(h.read(), /Synthetic metadata delivery failure/);
    assert.equal(h.events.includes('body-queued'), false);
    assert.ok(h.indexedDB.trace.some(item => item.event === 'transaction-abort'));
});

test('synchronous body submission failure aborts the same transaction without swallowing the error', async () => {
    const h = await fixture(); h.controls.failure = 'body-submit';
    await assert.rejects(h.read(), /Synthetic body submission failure/);
    assert.equal(h.events.filter(event => event === 'readonly-transaction').length, 1);
    assert.ok(h.indexedDB.trace.some(item => item.event === 'transaction-abort'));
});

test('asynchronous full-body delivery failure still rejects, never returning a metadata-only result', async () => {
    const h = await fixture(); h.controls.failure = 'entries-delivery';
    await assert.rejects(h.read(), /Synthetic entries delivery failure/);
    assert.equal(h.events.filter(event => event === 'body-queued').length, 1);
    assert.ok(h.indexedDB.trace.some(item => item.event === 'transaction-abort'));
});

test('TTL crossing during the hint remains a default-read miss, while explicit online candidates retain exact original expiry', async () => {
    const h = await fixture(), expiry = 100 + CARD_TRANSPORT_TTL_MS;
    assert.equal(await h.read({ onRevision() { h.setClock(expiry); } }), null);
    assert.equal(h.rows().length, 1, 'expiry alone does not delete complete source bytes');
    let hint;
    const row = await h.read({ allowExpiredCandidate: true, onRevision(value) { hint = value; } });
    assert.deepEqual(row.payload, h.payload); assert.equal(row.expiresAt, expiry);
    assert.equal(row.requiresOnlineConfirmation, true); assert.equal(hint.requiresOnlineConfirmation, true);
});

test('revision-hint ordering does not create an LRU write; authorized touch stays deferred, metadata-only and never extends TTL', async () => {
    const h = await fixture(), before = h.rows('metadata')[0];
    const row = await h.read({ allowExpiredCandidate: true });
    assert.deepEqual(h.rows('metadata')[0], before);
    h.indexedDB.trace.length = 0; h.setClock(150);
    assert.equal(h.cache.touch(owner, kind, id, row, { isCurrent: () => true }), true);
    assert.deepEqual(h.indexedDB.trace, [], 'verified-use touch queues only bounded metadata work');
    await new Promise(resolve => setTimeout(resolve, 150)); await turn();
    const after = h.rows('metadata')[0];
    assert.equal(after.expiresAt, before.expiresAt); assert.equal(after.lastStoredAt, before.lastStoredAt);
    assert.equal(after.lastUsedAt, 150);
    assert.ok(h.indexedDB.trace.every(item => !item.store || item.store === 'metadata'));
    clearCardTransportMemory();
});
