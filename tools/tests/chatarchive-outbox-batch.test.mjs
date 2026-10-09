import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const scope = JSON.stringify(['synthetic-owner', 'synthetic-card', 'synthetic-story']);
const version = letter => letter.repeat(32);
function snapshot(kind = 'chat', text = 'synthetic checkpoint', id = scope, storageVersion = version('a')) {
  const [, app_id, conversation_id] = JSON.parse(id);
  const body = kind === 'chat' ? { app_id, conversation_id, title: '合成故事',
    messages: [{ name: '合成角色', mes: text, is_user: false, extra: { display_text: text } }] }
    : { app_id, conversation_id, extension_settings: { synthetic: { enabled: true } },
      variables: { checkpoint: text, homer_story_metadata: { chapter: 'synthetic' } } };
  return { scope: id, body: JSON.stringify(body), storageVersion };
}
const entries = text => ['chat', 'extension-settings'].map(kind => ({ kind, snapshot: snapshot(kind, text) }));
const ack = (letter = 'b') => ({ messages: [{ id: 'synthetic-message', role: 'assistant', content: 'synthetic' }],
  storage: { protocol: 2, complete: true, version: version(letter), message_count: 1 } });
const fixture = () => {
  const indexedDB = transactionIDB(), databaseName = 'synthetic-batch-outbox';
  return { indexedDB, databaseName, outbox: createChatOutbox({ indexedDB, databaseName }) };
};
const successfulRequests = factory => factory.trace.filter(event => event === 'request-success').length;

test('chat and settings commit together in exactly one completed strict write transaction', async () => {
  const { indexedDB, databaseName, outbox } = fixture(), gate = indexedDB.holdNextCommit();
  let settled = false;
  const pending = outbox.prepareBatch(entries('checkpoint'), () => true).then(result => { settled = true; return result; });
  try {
    const tx = await gate.reached;
    assert.equal(tx.mode, 'readwrite'); assert.equal(settled, false);
    assert.equal(indexedDB.dump(databaseName).length, 0, 'request success is not durable success');
    gate.release();
    const committed = await pending;
    assert.equal(committed.length, 2); assert.deepEqual(committed.map(row => row.kind), ['chat', 'extension-settings']);
    assert.equal(indexedDB.trace.filter(event => event === 'transaction-complete').length, 1);
    assert.equal(indexedDB.dump(databaseName).length, 2);
    for (const row of committed) {
      assert.equal(row.scope, scope); assert.equal(row.owner, 'synthetic-owner'); assert.equal(row.pending, true);
      assert.equal(row.revision, 1); assert.equal(row.ackRevision, 0); assert.equal(row.baseVersion, version('a'));
      assert.equal(typeof row.commitId, 'string'); assert.equal(row.lineage, row.commitId);
      assert.equal(row.body, snapshot(row.kind, 'checkpoint').body);
      assert.equal(row.bytes, new TextEncoder().encode(row.body).byteLength);
      assert.deepEqual(await outbox.prepare(snapshot(row.kind, 'checkpoint'), row.kind), row);
    }
  } finally { gate.release(); await outbox.close(); }
});

test('batch capture is immutable, preserves caller order and accepts a single existing kind', async () => {
  const { outbox } = fixture(), list = entries('captured').reverse();
  const pending = outbox.prepareBatch(list, () => true);
  for (const item of list) item.snapshot.body = snapshot(item.kind, 'late mutation').body;
  const committed = await pending;
  assert.deepEqual(committed.map(row => row.kind), ['extension-settings', 'chat']);
  assert.equal(JSON.parse(committed[0].body).variables.checkpoint, 'captured');
  assert.equal(JSON.parse(committed[1].body).messages[0].mes, 'captured');
  const [settings] = await outbox.prepareBatch([{ kind: 'extension-settings', snapshot: snapshot('extension-settings', 'settings only') }], () => true);
  assert.equal(settings.revision, 2); assert.equal(settings.kind, 'extension-settings');
  await outbox.close();
});

test('invalid, empty, duplicate-kind and mixed-scope batches reject before opening storage', async () => {
  const { indexedDB, outbox } = fixture();
  const alternate = JSON.stringify(['synthetic-owner', 'synthetic-card', 'other-synthetic-story']);
  const unsupported = snapshot(); unsupported.body = JSON.stringify({ ...JSON.parse(unsupported.body), unsupported: true });
  const invalid = [null, [], {}, [null], [{ kind: 'unknown', snapshot: snapshot() }],
    [{ snapshot: snapshot() }], [{ kind: 'chat', snapshot: snapshot() }, { kind: 'chat', snapshot: snapshot() }],
    [{ kind: 'chat', snapshot: snapshot() }, { kind: 'extension-settings', snapshot: snapshot('extension-settings', 'other', alternate) }],
    [{ kind: 'chat', snapshot: snapshot() }, { kind: 'extension-settings', snapshot: { scope, body: 'not-json' } }],
    [{ kind: 'chat', snapshot: unsupported }]];
  for (const list of invalid) await assert.rejects(outbox.prepareBatch(list, () => true), TypeError);
  await assert.rejects(outbox.prepareBatch(entries('valid'), undefined), TypeError);
  assert.equal(indexedDB.trace.length, 0);
  await outbox.close();
});

test('a false or thrown scope guard never starts an outbox transaction', async () => {
  const { indexedDB, outbox } = fixture();
  await assert.rejects(outbox.prepareBatch(entries('stale'), () => false), { code: 'HOMER_OUTBOX_STALE_SCOPE' });
  const expected = new Error('Synthetic host epoch changed');
  await assert.rejects(outbox.prepareBatch(entries('stale'), () => { throw expected; }), failure => failure === expected);
  assert.equal(indexedDB.trace.length, 0);
  await outbox.close();
});

test('scope changes while IndexedDB opens reject before any read or put', async () => {
  const { indexedDB, databaseName, outbox } = fixture(); let current = true;
  const pending = outbox.prepareBatch(entries('stale'), () => current); current = false;
  await assert.rejects(pending, { code: 'HOMER_OUTBOX_STALE_SCOPE' });
  assert.equal(indexedDB.trace.length, 0); assert.equal(indexedDB.dump(databaseName).length, 0);
  await outbox.close();
});

test('the guard is rechecked immediately before a put even when its read callback was current', async () => {
  const { indexedDB, databaseName, outbox } = fixture(); let readCallbackSeen = false;
  await assert.rejects(outbox.prepareBatch(entries('stale'), () => {
    if (successfulRequests(indexedDB) !== 1) return true;
    if (readCallbackSeen) return false;
    readCallbackSeen = true; return true;
  }), { code: 'HOMER_OUTBOX_STALE_SCOPE' });
  assert.equal(readCallbackSeen, true); assert.equal(successfulRequests(indexedDB), 1);
  assert.equal(indexedDB.dump(databaseName).length, 0);
  await outbox.close();
});

test('guard invalidation after a successful put rolls back both existing rows', async () => {
  const { indexedDB, databaseName, outbox } = fixture();
  await outbox.prepareBatch(entries('later progress'), () => true);
  const before = indexedDB.dump(databaseName), start = successfulRequests(indexedDB);
  await assert.rejects(outbox.prepareBatch(entries('restore checkpoint'), () => successfulRequests(indexedDB) - start < 3),
    { code: 'HOMER_OUTBOX_STALE_SCOPE' });
  assert.deepEqual(indexedDB.dump(databaseName), before, 'a staged first put cannot become half a restore');
  assert.equal(indexedDB.trace.at(-1), 'transaction-abort');
  await outbox.close();
});

test('quota failure on the second put retains every byte and revision of both rows', async () => {
  const { indexedDB, databaseName, outbox } = fixture();
  await outbox.prepareBatch(entries('later progress'), () => true);
  const before = indexedDB.dump(databaseName), start = successfulRequests(indexedDB); let armed = false;
  await assert.rejects(outbox.prepareBatch(entries('restore checkpoint'), () => {
    if (!armed && successfulRequests(indexedDB) - start === 3) { indexedDB.failNextPut = true; armed = true; }
    return true;
  }), { name: 'QuotaExceededError' });
  assert.equal(armed, true, 'quota rejection occurs after both reads and the first successful put');
  assert.deepEqual(indexedDB.dump(databaseName), before);
  await outbox.close();
});

test('explicit transaction abort cannot acknowledge either new row', async () => {
  const { indexedDB, databaseName, outbox } = fixture(), gate = indexedDB.holdNextCommit();
  const pending = outbox.prepareBatch(entries('aborted checkpoint'), () => true);
  const tx = await gate.reached; tx.abort(); gate.release();
  await assert.rejects(pending, /aborted/); assert.equal(indexedDB.dump(databaseName).length, 0);
  await outbox.close();
});

test('identical acknowledged bodies preserve revision, ACK, lineage and update time without a rewrite', async () => {
  const { indexedDB, databaseName, outbox } = fixture();
  const initial = await outbox.prepareBatch(entries('unchanged'), () => true);
  await outbox.cloudACK(initial[0], ack()); await outbox.cloudACK(initial[1], {});
  const expected = await Promise.all(initial.map(row => outbox.prepare(snapshot(row.kind, 'unchanged', scope, version('c')), row.kind)));
  const before = indexedDB.dump(databaseName);
  const result = await outbox.prepareBatch(['chat', 'extension-settings'].map(kind => ({ kind, snapshot: snapshot(kind, 'unchanged', scope, version('c')) })), () => true);
  assert.deepEqual(result, expected); assert.deepEqual(indexedDB.dump(databaseName), before);
  assert.ok(result.every(row => !row.pending && row.revision === 1 && row.ackRevision === 1));
  assert.equal(result[0].baseVersion, version('b')); assert.equal(result[0].cloudVersion, version('b'));
  await outbox.close();
});

test('changed bodies match prepare pending authority and delayed ACK rebasing semantics', async () => {
  const { outbox } = fixture();
  const previous = await outbox.prepareBatch(entries('later progress'), () => true);
  const restored = await outbox.prepareBatch(['chat', 'extension-settings'].map(kind => ({ kind, snapshot: snapshot(kind, 'checkpoint', scope, version('c')) })), () => true);
  for (let index = 0; index < restored.length; index++) {
    assert.equal(restored[index].revision, previous[index].revision + 1); assert.equal(restored[index].ackRevision, 0);
    assert.equal(restored[index].baseVersion, version('a'), 'an existing pending base cannot be replaced by captured version');
    assert.equal(restored[index].lineage, previous[index].lineage); assert.equal(restored[index].pending, true);
    assert.notEqual(restored[index].commitId, previous[index].commitId);
  }
  assert.equal((await outbox.cloudACK(previous[0], ack())).applied, false);
  const latest = await outbox.read(scope);
  assert.equal(latest.payload.messages[0].mes, 'checkpoint'); assert.equal(latest.pending, true);
  assert.equal(latest.baseVersion, version('b')); assert.equal(latest.commitId, restored[0].commitId);
  await outbox.close();
});

test('concurrent ordinary prepare cannot lose a batched restore revision or overwrite its settings', async () => {
  const { outbox } = fixture();
  const batch = outbox.prepareBatch(entries('checkpoint'), () => true);
  const normal = outbox.prepare(snapshot('chat', 'newer live edit'));
  const [restored, later] = await Promise.all([batch, normal]);
  assert.equal(later.revision, restored[0].revision + 1);
  assert.equal((await outbox.read(scope)).payload.messages[0].mes, 'newer live edit');
  assert.equal((await outbox.read(scope, 'extension-settings')).payload.variables.checkpoint, 'checkpoint');
  await outbox.close();
});

test('old WebViews keep atomic completion when strict durability is unsupported', async () => {
  const { indexedDB, databaseName, outbox } = fixture(); indexedDB.strictUnsupported = true;
  const committed = await outbox.prepareBatch(entries('checkpoint'), () => true);
  assert.equal(committed.length, 2); assert.equal(indexedDB.dump(databaseName).length, 2);
  assert.equal(indexedDB.trace.filter(event => event === 'transaction-complete').length, 1);
  await outbox.close();
});
