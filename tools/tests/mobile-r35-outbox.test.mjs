import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatOutbox, OUTBOX_ACK_MAX_ROWS, OUTBOX_ACK_MAX_BYTES } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const scope = (owner = 'owner-a', app = 'card-a', conv = 'conversation-a') => JSON.stringify([owner, app, conv]);
const snapshot = (text = 'test text', id = scope()) => {
    const [, app_id, conversation_id] = JSON.parse(id);
    return { scope: id, body: JSON.stringify({ app_id, conversation_id, title: 'Test conversation',
        messages: [{ name: 'Test', is_user: false, mes: text, extra: { display_text: text } }] }) };
};
const ack = text => ({ messages: [{ id: 'test-message', role: 'assistant', content: text }] });
const fixture = () => {
    const indexedDB = transactionIDB(), databaseName = 'unit-outbox';
    return { indexedDB, databaseName, outbox: createChatOutbox({ indexedDB, databaseName }) };
};

test('prepare resolves only after transaction completion, not request success', async () => {
    const { indexedDB, outbox } = fixture(), gate = indexedDB.holdNextCommit();
    let settled = false;
    const work = outbox.prepare(snapshot()).then(value => { settled = true; return value; });
    await gate.reached;
    assert.equal(settled, false);
    assert.equal(indexedDB.dump('unit-outbox').length, 0);
    assert.ok(indexedDB.trace.includes('request-success'));
    gate.release();
    const committed = await work;
    assert.equal(committed.pending, true);
    assert.equal(indexedDB.dump('unit-outbox').length, 1);
    assert.equal(indexedDB.trace.at(-1), 'transaction-complete');
});

test('capture is immutable and same body preserves revision and identity', async () => {
    const { outbox } = fixture(), original = snapshot('first');
    const first = outbox.prepare(original);
    original.body = snapshot('mutated').body;
    const committed = await first;
    assert.equal(JSON.parse(committed.body).messages[0].mes, 'first');
    const duplicate = await outbox.prepare(snapshot('first'));
    assert.equal(duplicate.revision, committed.revision);
    assert.equal(duplicate.commitId, committed.commitId);
    const newer = await outbox.prepare(snapshot('second'));
    assert.equal(newer.revision, committed.revision + 1);
    assert.notEqual(newer.commitId, committed.commitId);
});

test('quota failure rolls back and never becomes a local ACK', async () => {
    const { indexedDB, outbox } = fixture();
    const first = await outbox.prepare(snapshot('first'));
    indexedDB.failNextPut = true;
    await assert.rejects(outbox.prepare(snapshot('not committed')), { name: 'QuotaExceededError' });
    const restored = await outbox.read(first.scope);
    assert.equal(restored.body, first.body);
    assert.equal(restored.revision, first.revision);
    assert.equal(restored.pending, true);
});

test('explicit transaction abort after successful requests still rejects and rolls back', async () => {
    const { indexedDB, outbox } = fixture(), gate = indexedDB.holdNextCommit();
    const pending = outbox.prepare(snapshot());
    const tx = await gate.reached;
    tx.abort(); gate.release();
    await assert.rejects(pending, /aborted/);
    assert.equal(indexedDB.dump('unit-outbox').length, 0);
});

test('old WebViews without durability options retain completion semantics', async () => {
    const { indexedDB, outbox } = fixture();
    indexedDB.strictUnsupported = true;
    const committed = await outbox.prepare(snapshot());
    assert.equal(committed.pending, true);
    assert.equal((await outbox.pending('owner-a')).length, 1);
});

test('missing or failed local storage fails closed and permits a later retry', async () => {
    await assert.rejects(createChatOutbox({ indexedDB: null }).prepare(snapshot()), /unavailable/);
    const { indexedDB, outbox } = fixture();
    indexedDB.openError = true;
    await assert.rejects(outbox.prepare(snapshot()), /open failure/);
    indexedDB.openError = false;
    assert.equal((await outbox.prepare(snapshot())).revision, 1);
});

test('invalid scope, mismatched identity and credential/config top-level fields are rejected before storage', async () => {
    const { indexedDB, outbox } = fixture();
    await assert.rejects(outbox.prepare({ scope: 'bad', body: '{}' }), /scope/);
    await assert.rejects(outbox.prepare({ ...snapshot(), scope: scope('owner-a', 'wrong-card') }), /match/);
    for (const forbidden of ['token', 'launch', 'config', 'headers']) {
        const value = snapshot();
        const body = JSON.parse(value.body); body[forbidden] = 'must never be persisted';
        await assert.rejects(outbox.prepare({ ...value, body: JSON.stringify(body) }), /Unsupported/);
    }
    assert.equal(indexedDB.dump('unit-outbox').length, 0);
});

test('concurrent changed snapshots serialize and stale ACK cannot clear a newer revision', async () => {
    const { outbox } = fixture();
    const [first, newer] = await Promise.all([outbox.prepare(snapshot('first')), outbox.prepare(snapshot('second'))]);
    assert.equal(newer.revision, first.revision + 1);
    assert.deepEqual(await outbox.cloudACK(first, ack('first')), { applied: false, revision: newer.revision });
    assert.equal((await outbox.read(first.scope)).body, newer.body);
    assert.equal((await outbox.pending('owner-a')).length, 1);
    assert.deepEqual(await outbox.cloudACK(newer, ack('second')), { applied: true, revision: newer.revision });
    assert.equal((await outbox.pending('owner-a')).length, 0);
});

test('ACK transaction failure keeps the pending snapshot for replay', async () => {
    const { indexedDB, outbox } = fixture(), committed = await outbox.prepare(snapshot());
    indexedDB.failNextPut = true;
    await assert.rejects(outbox.cloudACK(committed, ack('accepted remotely')), { name: 'QuotaExceededError' });
    assert.equal((await outbox.read(committed.scope)).pending, true);
    assert.equal((await outbox.pending('owner-a')).length, 1);
});

test('reopen retains pending work; account/card/conversation scopes do not mix', async () => {
    const { indexedDB, databaseName, outbox } = fixture();
    for (const id of [scope(), scope('owner-b'), scope('owner-a', 'card-b'), scope('owner-a', 'card-a', 'conversation-b')]) {
        await outbox.prepare(snapshot(id, id));
    }
    await outbox.close();
    const reopened = createChatOutbox({ indexedDB, databaseName });
    assert.equal((await reopened.pending('owner-a')).length, 3);
    assert.equal((await reopened.pending('owner-b')).length, 1);
    assert.equal((await reopened.pending('')).length, 0);
    assert.equal((await reopened.read(scope('owner-c'))), null);
});

test('ACK response stores only allowed messages, never response credentials or launch/config', async () => {
    const { indexedDB, outbox } = fixture(), committed = await outbox.prepare(snapshot());
    await outbox.cloudACK(committed, { token: 'forbidden-test-value', launch: {}, config: {}, messages: [
        { id: '1', role: 'assistant', content: 'safe content', created_at: 'test', swipes: ['safe content'],
            swipe_index: 0, headers: { authorization: 'forbidden-test-value' }, token: 'forbidden-test-value' },
    ] });
    const row = await outbox.read(committed.scope);
    assert.deepEqual(Object.keys(row.ackPayload), ['messages']);
    assert.deepEqual(Object.keys(row.ackPayload.messages[0]), ['id', 'role', 'content', 'created_at', 'swipes', 'swipe_index']);
    assert.equal(JSON.stringify(indexedDB.dump('unit-outbox')).includes('forbidden-test-value'), false);
    const bad = await outbox.prepare(snapshot('next'));
    await assert.rejects(outbox.cloudACK(bad, {}), /acknowledge/);
    assert.equal((await outbox.read(bad.scope)).pending, true);
});

test('fence retains local snapshot when a GET was already in flight before its ACK', async () => {
    const { outbox } = fixture();
    const committed = await outbox.prepare(snapshot('last generated text'));
    const beforeGET = await outbox.fence(committed.scope);
    await outbox.cloudACK(committed, ack('last generated text'));
    const afterGET = await outbox.read(committed.scope, 'chat', beforeGET);
    assert.equal(afterGET.pending, false);
    assert.equal(afterGET.preferred, true);
    assert.equal((await outbox.read(committed.scope, 'chat', await outbox.fence(committed.scope))).preferred, false);
});

test('pending snapshot wins without a fence and changed local version wins old GET', async () => {
    const { outbox } = fixture(), beforeGET = await outbox.fence(scope());
    await outbox.prepare(snapshot());
    assert.equal((await outbox.read(scope())).preferred, true);
    assert.equal((await outbox.read(scope(), 'chat', beforeGET)).preferred, true);
});

test('extension settings have independent revisions and cannot persist arbitrary response fields', async () => {
    const { indexedDB, outbox } = fixture();
    const chat = await outbox.prepare(snapshot());
    const settings = { scope: scope(), body: JSON.stringify({ app_id: 'card-a', conversation_id: 'conversation-a',
        extension_settings: { memory: { enabled: true } } }) };
    const committed = await outbox.prepare(settings, 'extension-settings');
    assert.equal(committed.revision, 1);
    await outbox.cloudACK(committed, { token: 'forbidden-test-value', launch: {} });
    assert.equal((await outbox.read(scope())).body, chat.body);
    assert.equal((await outbox.read(scope(), 'extension-settings')).pending, false);
    assert.equal(JSON.stringify(indexedDB.dump('unit-outbox')).includes('forbidden-test-value'), false);
});

test('ACK row limit evicts only acknowledged snapshots, never pending', async () => {
    const { outbox, indexedDB } = fixture();
    const pending = await outbox.prepare(snapshot('do not evict', scope('owner-b')));
    for (let i = 0; i < OUTBOX_ACK_MAX_ROWS + 2; i++) {
        const committed = await outbox.prepare(snapshot(String(i), scope('owner-a', 'card-a', 'conversation-' + i)));
        await outbox.cloudACK(committed, ack(String(i)));
    }
    assert.equal(indexedDB.dump('unit-outbox').filter(row => row.pending === 0).length, OUTBOX_ACK_MAX_ROWS);
    assert.equal((await outbox.read(pending.scope)).pending, true);
    assert.equal((await outbox.pending('owner-b')).length, 1);
});

test('evicted then recreated identical scope cannot accept a delayed ABA ACK', async () => {
    const { outbox } = fixture(), original = await outbox.prepare(snapshot());
    await outbox.cloudACK(original, ack('original'));
    for (let i = 0; i < OUTBOX_ACK_MAX_ROWS; i++) {
        const committed = await outbox.prepare(snapshot(String(i), scope('owner-a', 'card-a', 'conversation-' + i)));
        await outbox.cloudACK(committed, ack(String(i)));
    }
    assert.equal(await outbox.read(original.scope), null);
    const recreated = await outbox.prepare(snapshot());
    assert.equal(recreated.revision, original.revision);
    assert.notEqual(recreated.commitId, original.commitId);
    assert.equal((await outbox.cloudACK(original, ack('late old response'))).applied, false);
    assert.equal((await outbox.read(original.scope)).pending, true);
});

test('UTF-8 ACK byte budget is enforced without deleting oversized pending data', async () => {
    const { outbox, indexedDB } = fixture();
    const bigText = '汉'.repeat(Math.ceil(OUTBOX_ACK_MAX_BYTES / 3));
    const pending = await outbox.prepare(snapshot(bigText));
    assert.ok(pending.bytes > OUTBOX_ACK_MAX_BYTES);
    assert.equal((await outbox.pending('owner-a')).length, 1);
    await outbox.cloudACK(pending, ack('safe minimal acknowledgement'));
    assert.equal(await outbox.read(pending.scope), null);
    assert.ok(indexedDB.dump('unit-outbox').filter(row => row.pending === 0)
        .reduce((sum, row) => sum + row.bytes + row.ackBytes, 0) <= OUTBOX_ACK_MAX_BYTES);
});
