import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { createLocalSessionStore } from '../../sillytavern-runtime/public/scripts/homer-local-session.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';
const owner = 'delete-test-owner', id = 'delete-test-history';
const scope = (conv = id, user = owner) => JSON.stringify([user, 'card', conv]);
const snap = (conv = id, user = owner) => ({ scope: scope(conv, user), storageVersion: 'a'.repeat(32), body: JSON.stringify({ app_id: 'card', conversation_id: conv, messages: [{ mes: 'synthetic stored message' }] }) });
const ack = { messages: [{ content: 'synthetic stored message' }], storage: { protocol: 2, complete: true, version: 'a'.repeat(32), message_count: 1 } };
const payload = (conv = id, user = owner) => ({ user: { id: user }, launch: { app_id: 'card', conversation_id: conv, card: { name: 'QA' }, messages: ack.messages, storage: ack.storage } });
function fixture() { const indexedDB = transactionIDB(); return { indexedDB, outbox: createChatOutbox({ indexedDB }), sessions: createLocalSessionStore({ indexedDB }) }; }

test('batch deletes exact owned snapshots/settings; persists lightweight markers and retains all unselected data', async () => {
  const { indexedDB, outbox } = fixture();
  for (const [conv, user] of [[id, owner], ['second', owner], ['keep', owner], [id, 'other-owner']]) await outbox.prepare(snap(conv, user));
  await outbox.prepare({ scope: scope(), body: JSON.stringify({ app_id: 'card', conversation_id: id, extension_settings: {} }) }, 'extension-settings');
  await outbox.deleteConversations(owner, [id, 'second', id]);
  assert.equal(await outbox.isDeleted(owner, id), true);
  assert.equal(await outbox.isDeleted('other-owner', id), false);
  assert.equal((await outbox.pending(owner)).length, 1);
  assert.equal((await outbox.pending('other-owner')).length, 1);
  assert.equal((await outbox.read(scope('keep'))).payload.messages.length, 1);
  const rows = indexedDB.dump('homer-chat-outbox-v1').filter(row => row.owner === owner);
  assert.equal(rows.filter(row => row.body).length, 1);
  assert.equal((await outbox.deletions(owner)).length, 2);
  await outbox.close();
  const reopened = createChatOutbox({ indexedDB });
  assert.equal(await reopened.isDeleted(owner, id), true);
  assert.equal((await reopened.deletions(owner))[0].state, 'pending');
});

test('local delete waits for completed transaction; quota failure rolls back markers and original bytes', async () => {
  const { indexedDB, outbox } = fixture(); await outbox.prepare(snap());
  indexedDB.failNextPut = true;
  await assert.rejects(outbox.deleteConversations(owner, [id]), { name: 'QuotaExceededError' });
  assert.equal(await outbox.isDeleted(owner, id), false); assert.equal((await outbox.read(scope())).payload.messages.length, 1);
  const gate = indexedDB.holdNextCommit(); let done = false;
  const work = outbox.deleteConversations(owner, [id]).then(() => { done = true; });
  await gate.reached; assert.equal(done, false); gate.release(); await work; assert.equal(done, true);
});

test('stale owner guard cancels a whole batch and invalid ids never mutate storage', async () => {
  const { outbox } = fixture(); await outbox.prepare(snap());
  await assert.rejects(outbox.deleteConversations(owner, [id], () => false), { code: 'HOMER_OUTBOX_STALE_SCOPE' });
  await assert.rejects(outbox.deleteConversations(owner, [id, '']), /scope/);
  assert.equal((await outbox.deletions(owner)).length, 0);
});

for (const action of ['prepare', 'prepareBatch', 'read', 'fence', 'cloudACK', 'rememberRemote', 'markForked', 'rebasePending']) {
  test(`durable tombstone rejects late ${action}, never resurrects bytes`, async () => {
    const { indexedDB, outbox } = fixture(), snapshot = snap();
    snapshot.committed = await outbox.prepare(snapshot); const fence = await outbox.fence(scope());
    await outbox.deleteConversations(owner, [id]);
    const call = () => action === 'prepareBatch' ? outbox.prepareBatch([{ snapshot, kind: 'chat' }], () => true)
      : ['read', 'fence'].includes(action) ? outbox[action](scope())
      : action === 'cloudACK' ? outbox.cloudACK(snapshot.committed, ack)
      : action === 'rememberRemote' ? outbox.rememberRemote(snapshot, ack, fence)
      : action === 'markForked' ? outbox.markForked(snapshot.committed, 'fork')
      : action === 'rebasePending' ? outbox.rebasePending(snapshot, 'b'.repeat(32)) : outbox.prepare(snapshot);
    await assert.rejects(call(), { code: 'HOMER_CONVERSATION_DELETED' });
    assert.equal(indexedDB.dump('homer-chat-outbox-v1').filter(row => row.body).length, 0);
  });
}

test('cloud success retains marker and a later failed duplicate cannot undo it', async () => {
  const { outbox } = fixture(); await outbox.deleteConversations(owner, [id]);
  await outbox.updateDeletion(owner, id, { state: 'done', attempts: 1 });
  assert.equal(await outbox.updateDeletion(owner, id, { state: 'pending', attempts: 2 }), false);
  assert.equal((await outbox.deletions(owner))[0].state, 'done'); assert.equal(await outbox.isDeleted(owner, id), true);
});

test('full session/resource removal fences delayed card reads and retains another account', async () => {
  const { sessions, indexedDB } = fixture();
  await sessions.remember(owner, payload()); await sessions.remember(owner, payload('keep'));
  await sessions.remember('other-owner', payload(id, 'other-owner'));
  await sessions.rememberResource(scope(), 'runtime-state', { extension_settings: {} });
  await sessions.deleteConversations(owner, [id]); await sessions.close();
  const reopened = createLocalSessionStore({ indexedDB });
  for (const call of [() => reopened.read(owner, 'card', id), () => reopened.remember(owner, payload()), () => reopened.resource(scope(), 'runtime-state'), () => reopened.rememberResource(scope(), 'models', {})]) await assert.rejects(call(), { code: 'HOMER_CONVERSATION_DELETED' });
  assert.equal((await reopened.list(owner))[0].id, 'keep'); assert.equal((await reopened.list('other-owner')).length, 1);
});

function serviceFixture() {
  const { outbox, sessions } = fixture(); const values = new Map();
  let currentOwner = owner, online = true; const listeners = new Map(), requests = [];
  const context = {
    createChatOutbox: () => outbox, createLocalSessionStore: () => sessions,
    isLoggedIn: () => Boolean(currentOwner), getCachedUser: () => ({ id: currentOwner }), getToken: () => '',
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    navigator: { get onLine() { return online; } }, document: { hidden: false }, setInterval: () => {}, AbortController,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    window: { addEventListener(name, fn) { listeners.set(name, fn); }, dispatchEvent(event) { listeners.get(event.type)?.(event); } },
    apiText: async (url, init, options) => { requests.push({ url, init, options }); return context.response(url, init); },
    response: async () => ({ response: { ok: true, status: 200 }, text: JSON.stringify({ result: 'success', data: { deleted: true } }) }),
  };
  vm.createContext(context);
  const source = fs.readFileSync(new URL('../../frontend/assets/js/conversation-deletion.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  context.startConversationDeletionSync();
  return { context, outbox, sessions, requests, setOwner: value => { currentOwner = value; context.window.dispatchEvent({ type: 'homer-account-cleared' }); }, setOnline: value => { online = value; } };
}

test('offline local deletion succeeds immediately; later replay deletes cloud only, including already-absent ACK', async () => {
  const f = serviceFixture(); await f.context.flushConversationDeletions(); f.setOnline(false);
  await f.outbox.prepare(snap()); await f.sessions.remember(owner, payload());
  await f.context.deleteLocalConversations(owner, [id]);
  assert.equal(f.requests.length, 0); assert.equal(f.context.deletionStatus(owner).pending, 1);
  assert.equal(f.context.filterDeletedConversations(owner, [{ id }, { id: 'keep' }]).length, 1);
  assert.equal((await f.sessions.list(owner)).length, 0);
  f.context.response = async () => ({ response: { ok: true, status: 200 }, text: '{"data":{"deleted":false}}' });
  f.setOnline(true); await f.context.flushConversationDeletions();
  assert.equal((await f.outbox.deletions(owner))[0].state, 'done'); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.timeoutMs, 8000); assert.equal(f.requests[0].init.method, 'POST');
});

test('idle replay with no deletions emits no invalidation into an active chat', async () => {
  const f = serviceFixture();
  let invalidations = 0;
  f.context.window.addEventListener('homer:conversation-deletions', () => { invalidations += 1; });
  await f.context.flushConversationDeletions();
  await f.context.flushConversationDeletions();
  assert.equal(invalidations, 0);
  assert.equal(f.requests.length, 0);
});

for (const kind of ['timeout', 'unauthorized', 'invalid-ack', 'missing-route']) {
  test(`${kind} keeps local deletion; explicit retry never replays unrelated writes`, async () => {
    const f = serviceFixture(); await f.context.flushConversationDeletions(); f.setOnline(false);
    await f.context.deleteLocalConversations(owner, [id]);
    f.context.response = async () => {
      if (kind === 'timeout') throw Object.assign(new Error('fixture timeout'), { reason: 'timeout' });
      if (kind === 'invalid-ack') return { response: { ok: true, status: 200 }, text: '{}' };
      return { response: { ok: false, status: kind === 'unauthorized' ? 401 : 404 }, text: '{}' };
    };
    f.setOnline(true); await f.context.flushConversationDeletions();
    assert.equal(f.context.isConversationDeleted(owner, id), true);
    assert.equal((await f.outbox.deletions(owner))[0].state, ['unauthorized', 'missing-route'].includes(kind) ? 'blocked' : 'pending');
    await f.context.flushConversationDeletions(); assert.equal(f.requests.length, 1);
    f.context.response = async () => ({ response: { ok: true, status: 200 }, text: '{"deleted":true}' });
    await f.context.flushConversationDeletions({ retryBlocked: true });
    assert.equal((await f.outbox.deletions(owner))[0].state, 'done'); assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(request => request.url.endsWith('/delete')));
  });
}

test('account switch aborts pending delete and fences its late ACK; another account cannot replay it', async () => {
  const f = serviceFixture(); await f.context.flushConversationDeletions(); f.setOnline(false);
  await f.context.deleteLocalConversations(owner, [id]);
  let resolve, started; const gate = new Promise(r => { started = r; });
  f.context.response = async () => { started(); return new Promise(r => { resolve = r; }); };
  f.setOnline(true); const work = f.context.flushConversationDeletions(); await gate;
  f.setOwner('other-owner'); assert.equal(f.requests[0].init.signal.aborted, true);
  resolve({ response: { ok: true, status: 200 }, text: '{"deleted":true}' }); await work;
  assert.equal((await f.outbox.deletions(owner))[0].state, 'pending');
  await f.context.flushConversationDeletions(); assert.equal(f.requests.length, 1);
});
