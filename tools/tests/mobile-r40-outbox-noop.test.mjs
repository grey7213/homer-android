import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatOutbox } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { captureCloudSync, createCloudSyncQueue } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-cloud-sync.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const scope = (owner = 'test-owner', app = 'test-card', conversation = 'test-conversation') => JSON.stringify([owner, app, conversation]);
const snapshot = (text = 'unchanged text', id = scope()) => {
    const [, app_id, conversation_id] = JSON.parse(id);
    return { scope: id, body: JSON.stringify({ app_id, conversation_id, title: 'Isolated test',
        messages: [{ name: 'Test', is_user: false, mes: text, extra: {} }] }) };
};
const ack = (id = 'test-message', content = 'unchanged text') => ({ messages: [{ id, role: 'assistant', content }] });

function instrumentedFixture() {
    const indexedDB = transactionIDB(), databaseName = 'r40-outbox-noop';
    const metrics = { modes: [], puts: 0, gets: 0, cursors: 0, deletes: 0 };
    const seen = new WeakSet();
    let database, nextModeGate = null;
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
        const request = open(...args);
        let loaded;
        Object.defineProperty(request, 'onsuccess', {
            set(value) { loaded = value; },
            get() { return event => {
                database = request.result;
                if (!seen.has(database)) {
                    seen.add(database);
                    const transaction = database.transaction.bind(database);
                    database.transaction = (store, mode, options) => {
                        if (nextModeGate?.mode === mode) {
                            const scheduled = nextModeGate; nextModeGate = null;
                            const realGate = indexedDB.holdNextCommit();
                            realGate.reached.then(tx => scheduled.reached(tx));
                            scheduled.release = realGate.release;
                        }
                        metrics.modes.push({ mode, durability: options?.durability || null });
                        const tx = transaction(store, mode, options);
                        const objectStore = tx.objectStore.bind(tx);
                        tx.objectStore = (...names) => {
                            const actual = objectStore(...names);
                            return { ...actual,
                                get(...values) { metrics.gets++; return actual.get(...values); },
                                put(...values) { metrics.puts++; return actual.put(...values); },
                                delete(...values) { metrics.deletes++; return actual.delete(...values); },
                                index(...values) {
                                    const index = actual.index(...values);
                                    return { ...index, openCursor(...wanted) {
                                        metrics.cursors++; return index.openCursor(...wanted);
                                    } };
                                },
                            };
                        };
                        return tx;
                    };
                }
                loaded?.(event);
            }; },
        });
        return request;
    };
    return { indexedDB, databaseName, metrics,
        outbox: createChatOutbox({ indexedDB, databaseName }),
        reset() { metrics.modes.length = 0; metrics.puts = metrics.gets = metrics.cursors = metrics.deletes = 0; },
        holdNextModeCommit(mode) {
            let reached;
            const scheduled = { mode, reached: value => reached(value), release: null };
            const control = { reached: new Promise(resolve => { reached = resolve; }), release: () => scheduled.release?.() };
            nextModeGate = scheduled; return control;
        },
        writeRow(row) {
            return new Promise((resolve, reject) => {
                const tx = database.transaction('snapshots', 'readwrite', { durability: 'strict' });
                tx.oncomplete = resolve; tx.onabort = () => reject(new Error('test row write aborted'));
                tx.objectStore('snapshots').put(row);
            });
        },
    };
}

test('unchanged pending and acknowledged prepare use completed readonly transactions only', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    for (const acknowledged of [false, true]) {
        if (acknowledged) await h.outbox.cloudACK(first, ack());
        h.reset();
        const duplicate = await h.outbox.prepare(snapshot());
        assert.equal(duplicate.revision, first.revision);
        assert.equal(duplicate.commitId, first.commitId);
        assert.equal(duplicate.pending, !acknowledged);
        assert.deepEqual(h.metrics.modes, [{ mode: 'readonly', durability: null }]);
        assert.equal(h.metrics.puts + h.metrics.cursors + h.metrics.deletes, 0);
    }
});

test('identical ACK does not rewrite, prune, age or advance its existing storage revision', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    await h.outbox.cloudACK(first, ack());
    const original = h.indexedDB.dump(h.databaseName);
    h.reset();
    assert.deepEqual(await h.outbox.cloudACK(first, ack()), { applied: false, revision: first.revision, unchanged: true });
    assert.deepEqual(h.metrics.modes, [{ mode: 'readonly', durability: null }]);
    assert.equal(h.metrics.puts + h.metrics.cursors + h.metrics.deletes, 0);
    assert.deepEqual(h.indexedDB.dump(h.databaseName), original);
});

test('different allowed ACK metadata still performs the strict write and stores the new IDs', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    await h.outbox.cloudACK(first, ack('old-id'));
    h.reset();
    assert.deepEqual(await h.outbox.cloudACK(first, ack('new-id')), { applied: true, revision: first.revision });
    assert.deepEqual(h.metrics.modes, [{ mode: 'readonly', durability: null }, { mode: 'readwrite', durability: 'strict' }]);
    assert.equal(h.metrics.puts, 1);
    assert.equal(h.metrics.cursors, 1);
    assert.equal((await h.outbox.read(first.scope)).ackPayload.messages[0].id, 'new-id');
});

test('the unchanged-body fast path does not settle at readonly request success', async () => {
    const h = instrumentedFixture(); await h.outbox.prepare(snapshot());
    const gate = h.holdNextModeCommit('readonly');
    let settled = false;
    const work = h.outbox.prepare(snapshot()).then(value => { settled = true; return value; });
    await gate.reached;
    assert.equal(settled, false);
    gate.release(); await work;
    assert.equal(settled, true);
});

test('the identical-ACK fast path likewise waits for readonly transaction completion', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    await h.outbox.cloudACK(first, ack());
    const gate = h.holdNextModeCommit('readonly');
    let settled = false;
    const work = h.outbox.cloudACK(first, ack()).then(value => { settled = true; return value; });
    await gate.reached; assert.equal(settled, false);
    gate.release(); await work; assert.equal(settled, true);
});

test('changed content still waits for its strict write transaction and rollback keeps the old row', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    const gate = h.holdNextModeCommit('readwrite');
    let settled = false;
    const work = h.outbox.prepare(snapshot('changed')).then(value => { settled = true; return value; });
    const tx = await gate.reached;
    assert.equal(settled, false);
    assert.equal(h.indexedDB.dump(h.databaseName)[0].body, first.body);
    tx.abort(); gate.release();
    await assert.rejects(work, /aborted/);
    assert.equal(settled, false);
    assert.equal(h.indexedDB.dump(h.databaseName)[0].body, first.body);
});

test('concurrent changed prepares recheck inside the write transaction without losing revisions', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    const [second, third] = await Promise.all([h.outbox.prepare(snapshot('second')), h.outbox.prepare(snapshot('third'))]);
    assert.equal(second.revision, first.revision + 1);
    assert.equal(third.revision, second.revision + 1);
    assert.equal((await h.outbox.read(first.scope)).body, third.body);
});

test('overlapping identical ACKs are idempotent even when both readonly prechecks see pending', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    h.reset();
    const results = await Promise.all([h.outbox.cloudACK(first, ack()), h.outbox.cloudACK(first, ack())]);
    assert.equal(results.filter(result => result.applied).length, 1);
    assert.equal(results.filter(result => result.unchanged).length, 1);
    assert.equal(h.metrics.puts, 1);
    assert.equal(h.metrics.cursors, 1);
    assert.equal((await h.outbox.read(first.scope)).pending, false);
});

test('a newer revision winning after ACK readonly check cannot be cleared by its later write', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    const gate = h.holdNextModeCommit('readonly');
    const work = h.outbox.cloudACK(first, ack());
    await gate.reached;
    const changed = snapshot('a concurrently saved message');
    const row = { ...h.indexedDB.dump(h.databaseName)[0], body: changed.body,
        revision: first.revision + 1, commitId: 'test-other-writer', pending: 1 };
    const otherWrite = h.writeRow(row);
    gate.release(); await otherWrite;
    assert.deepEqual(await work, { applied: false, revision: first.revision + 1 });
    const restored = await h.outbox.read(first.scope);
    assert.equal(restored.body, changed.body);
    assert.equal(restored.pending, true);
});

test('a competing same-body prepare winning after readonly check retains that exact commit identity', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    const gate = h.holdNextModeCommit('readonly');
    const next = snapshot('next message'), work = h.outbox.prepare(next);
    await gate.reached;
    const row = { ...h.indexedDB.dump(h.databaseName)[0], body: next.body,
        revision: first.revision + 1, commitId: 'test-other-writer', pending: 1 };
    const otherWrite = h.writeRow(row);
    gate.release(); await otherWrite;
    h.reset();
    const actual = await work;
    assert.equal(actual.revision, row.revision);
    assert.equal(actual.commitId, row.commitId);
    assert.equal(h.metrics.puts, 0);
});

test('late stale ACK takes no write lock and cannot cross owner/card/conversation boundaries', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    const latest = await h.outbox.prepare(snapshot('latest'));
    h.reset();
    assert.deepEqual(await h.outbox.cloudACK(first, ack()), { applied: false, revision: latest.revision });
    for (const foreign of [scope('other-owner'), scope('test-owner', 'other-card'), scope('test-owner', 'test-card', 'other-conversation')]) {
        assert.deepEqual(await h.outbox.cloudACK({ ...latest, scope: foreign }, ack()), { applied: false, revision: 0 });
    }
    assert.equal(h.metrics.modes.some(value => value.mode === 'readwrite'), false);
    assert.equal((await h.outbox.read(first.scope)).pending, true);
});

test('extension ACK no-op remains independent from pending chat and ignores unsafe response fields', async () => {
    const h = instrumentedFixture(), first = await h.outbox.prepare(snapshot());
    const extension = { scope: scope(), body: JSON.stringify({ app_id: 'test-card', conversation_id: 'test-conversation',
        extension_settings: { memory: { enabled: true } } }) };
    const settings = await h.outbox.prepare(extension, 'extension-settings');
    await h.outbox.cloudACK(settings, {});
    h.reset();
    assert.deepEqual(await h.outbox.cloudACK(settings, { headers: 'not stored', arbitrary: 'not stored' }),
        { applied: false, revision: settings.revision, unchanged: true });
    assert.equal(h.metrics.puts + h.metrics.cursors, 0);
    assert.equal((await h.outbox.read(first.scope)).pending, true);
    assert.equal((await h.outbox.read(first.scope, 'extension-settings')).pending, false);
});

test('actual cloud queue skipped-body path no longer rewrites the already acknowledged outbox row', async () => {
    const h = instrumentedFixture();
    let sends = 0;
    const queue = createCloudSyncQueue(async value => {
        sends++;
        const response = ack(); await h.outbox.cloudACK(value.committed, response); return response;
    });
    const stored = snapshot();
    const first = captureCloudSync(stored.scope, JSON.parse(stored.body)); first.committed = await h.outbox.prepare(first);
    await queue.enqueue(first);
    h.reset();
    const duplicate = captureCloudSync(stored.scope, JSON.parse(stored.body)); duplicate.committed = await h.outbox.prepare(duplicate);
    const result = await queue.enqueue(duplicate);
    assert.equal(result.skipped, true);
    assert.deepEqual(await h.outbox.cloudACK(duplicate.committed, result.response),
        { applied: false, revision: first.committed.revision, unchanged: true });
    assert.equal(sends, 1);
    assert.deepEqual(h.metrics.modes, [{ mode: 'readonly', durability: null }, { mode: 'readonly', durability: null }]);
    assert.equal(h.metrics.puts + h.metrics.cursors + h.metrics.deletes, 0);
});
