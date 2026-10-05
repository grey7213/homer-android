import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  historyPreparationOwner, selectFreshHistoryTargets, normalizeHistoryPreparation,
  createHistoryPreparationMailbox,
} from '../../frontend/assets/js/history-dialogue-preparation.mjs';

const target = (app = 'app-a', conversation = 'conv-a') => ({ app_id: app, conversation_id: conversation });
const batch = (overrides = {}) => ({ owner: 'owner-a', targets: [target()], expires_at: 31_000, ...overrides });

test('strict preparation owner never uses email or anonymous namespaces', () => {
  assert.equal(historyPreparationOwner({ email: 'fixture@example.invalid' }), '');
  assert.equal(historyPreparationOwner({ user_id: 42 }), '42');
  assert.equal(historyPreparationOwner(null), '');
});

test('fresh target selection strips all data except at most two unique IDs', () => {
  const rows = [{ id: '', app_id: 'x' }, { id: 'c', app_id: 'a', body: 'private' },
    { id: 'c', app_id: 'a' }, { id: 'd', app_id: 'b' }, { id: 'e', app_id: 'c' }];
  assert.deepEqual(selectFreshHistoryTargets(rows), [target('a', 'c'), target('b', 'd')]);
  assert.deepEqual(selectFreshHistoryTargets([{ id: 'c', app_id: 'x'.repeat(161) }]), []);
});

test('entire malformed batch is rejected, rather than partially read', () => {
  for (const value of [null, batch({ owner: 'owner-b' }), batch({ targets: [] }),
    batch({ targets: [target(), target('b', 'd'), target('c', 'e')] }),
    batch({ targets: [target(), target('', 'b')] }),
    batch({ targets: [target(123, 'b')] }), batch({ expires_at: NaN }),
    batch({ expires_at: 1000 }), batch({ expires_at: 31001 })]) {
    assert.equal(normalizeHistoryPreparation(value, 'owner-a', 1000), null);
  }
  assert.equal(normalizeHistoryPreparation(batch(), '', 1000), null);
});

test('normalization copies/freeze IDs and retains original expiry', () => {
  const input = batch({ targets: [target(' a ', ' c '), target('a', 'c')] });
  const result = normalizeHistoryPreparation(input, 'owner-a', 1000);
  input.targets[0].app_id = 'changed';
  assert.deepEqual(result.targets, [target('a', 'c')]);
  assert.equal(result.expires_at, 31000);
  assert.ok(Object.isFrozen(result.targets[0]));
});

function mailboxFixture() {
  const state = { owner: 'owner-a', eligible: true, available: false, now: 1000, sent: [] };
  const mailbox = createHistoryPreparationMailbox({
    getOwner: () => state.owner, eligible: () => state.eligible, now: () => state.now,
    send: value => { if (!state.available) return false; state.sent.push(value); return true; },
  });
  return { state, mailbox };
}

test('late handshake flushes one latest batch only once, without extending expiry', () => {
  const { state, mailbox } = mailboxFixture();
  mailbox.offer(batch());
  mailbox.offer(batch({ targets: [target('b', 'd')], expires_at: 9000 }));
  state.now = 3000; state.available = true;
  assert.equal(mailbox.flush(), true);
  assert.equal(mailbox.flush(), false);
  assert.deepEqual(state.sent[0].targets, [target('b', 'd')]);
  assert.equal(state.sent[0].expires_at, 9000);
});

test('account change, actual selection, expiry and reset each discard queued preparation', () => {
  for (const invalidate of [state => { state.owner = 'owner-b'; },
    state => { state.eligible = false; }, state => { state.now = 31000; }]) {
    const { state, mailbox } = mailboxFixture();
    mailbox.offer(batch()); invalidate(state); state.available = true;
    assert.equal(mailbox.flush(), false); assert.equal(state.sent.length, 0);
    state.owner = 'owner-a'; state.eligible = true; state.now = 1000;
    assert.equal(mailbox.flush(), false);
  }
  const { state, mailbox } = mailboxFixture();
  mailbox.offer(batch()); mailbox.clear(); state.available = true;
  assert.equal(mailbox.flush(), false);
});

function historyFixture() {
  const calls = [], state = { owner: { id: 'owner-a' }, list: [], cache: null, response: null };
  const context = {
    window: { HomerNative: { prepareHistoryConversations: (...args) => calls.push(args) },
      addEventListener() {}, removeEventListener() {} },
    location: { href: 'http://owned.invalid/app/histories.html' },
    requireAuth: () => true, getCachedUser: () => state.owner,
    readPageCache: () => state.cache, writePageCache() {}, injectLayout() {},
    loadPublicSiteSettings: async () => null,
    api: { conversations: async () => state.response ?? { data: { list: state.list } },
      profile: async () => ({ data: state.owner }), points: async () => ({ points: 0 }) },
    setCachedUser() {}, ApiError: class extends Error {}, messagePreview: value => value,
    historyPreparationOwner, selectFreshHistoryTargets,
  };
  const source = readFileSync(new URL('../../frontend/app/assets/js/hub-pages.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  vm.createContext(context); vm.runInContext(source, context);
  return { calls, state, context, page: context.window.historiesPage() };
}

test('actual history load sends only fresh, search-matching first two IDs', async () => {
  const { state, calls, page } = historyFixture();
  state.list = [{ id: 'c', app_id: 'a', app_name: 'Match' },
    { id: 'd', app_id: 'b', app_name: 'Other' }, { id: 'e', app_id: 'c', app_name: 'Match' }];
  page.search = 'match';
  await page.loadList();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'owner-a');
  assert.deepEqual(JSON.parse(calls[0][2]), [target('a', 'c'), target('c', 'e')]);
});

test('actual history cached paint does not send preparation on rejected fresh read', async () => {
  const { state, calls, context, page } = historyFixture();
  state.cache = { list: [{ id: 'cached', app_id: 'a' }] };
  context.api.conversations = async () => { throw Error('offline'); };
  await page.init();
  assert.equal(page.conversations[0].id, 'cached');
  assert.equal(calls.length, 0);
});

test('actual history stale epoch, changed owner and destroy reject late fresh results', async () => {
  for (const invalidate of [(page, state) => { ++page._listEpoch; },
    (page, state) => { state.owner = { id: 'owner-b' }; }, page => page.destroy()]) {
    const { calls, context, state, page } = historyFixture();
    let resolve; context.api.conversations = () => new Promise(done => { resolve = done; });
    const work = page.loadList(); invalidate(page, state);
    resolve({ data: { list: [{ id: 'c', app_id: 'a' }] } }); await work;
    assert.equal(calls.length, 0); assert.equal(page.conversations.length, 0);
  }
});

test('no strict owner and unavailable/throwing native bridge leave real list functional', async () => {
  const { state, context, page, calls } = historyFixture();
  state.list = [{ id: 'c', app_id: 'a' }]; state.owner = { email: 'fixture@example.invalid' };
  await page.loadList(); assert.equal(calls.length, 0); assert.equal(page.conversations.length, 1);
  state.owner = { id: 'owner-a' }; delete context.window.HomerNative;
  await page.loadList(); assert.equal(page.conversations.length, 1);
  context.window.HomerNative = { prepareHistoryConversations() { throw Error('unsupported'); } };
  await page.loadList(); assert.equal(page.conversations.length, 1);
});

test('actual host mailbox posts only with current child document and empty eligible state', () => {
  const source = readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
  const fragment = source.slice(source.indexOf('const historyReadPreparation ='), source.indexOf('let composerUi ='));
  const sent = [], listeners = new Map(), child = { documentElement: { dataset: { homerBootstrapDocument: 'doc-a' } } };
  const context = {
    createHistoryPreparationMailbox, historyPreparationOwner, getCachedUser: () => ({ id: 'owner-a' }),
    prewarming: true, runtimeAccountBlocked: false, adminPreview: false, adminBindPending: false,
    pendingAdminCard: '', preparedAdminCard: '', activeAppId: '', activeConversationId: '',
    runtimeColdFlight: null, runtimeReady: false, runtimeBound: false, navigationPending: false,
    bridgeAvailable: false, runtimeEngineToken: 'engine-a', runtimeLaunchOwner: 'owner-a', runtimePriorDocument: null,
    coldRuntimeOwnerMatches: () => true, HOST_CHANNEL: 'homer:dialogue-host:v1', location: { origin: 'http://owned.invalid' },
    frame: { contentDocument: child, contentWindow: { postMessage: (...args) => sent.push(args) } },
    window: { addEventListener: (name, fn) => listeners.set(name, fn) },
  };
  vm.createContext(context); vm.runInContext(fragment, context);
  const offer = () => listeners.get('homer:prepare-history-conversations')({ detail: batch({ expires_at: Date.now() + 30000 }) });
  offer(); assert.equal(sent.length, 0);
  context.bridgeAvailable = true;
  vm.runInContext('historyReadPreparation.flush()', context);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].document_token, 'doc-a'); assert.equal(sent[0][0].engine_token, 'engine-a');
  assert.equal(sent[0][0].type, 'prepare-history-conversations');
  assert.equal(sent[0][1], 'http://owned.invalid');
  context.runtimePriorDocument = child; offer(); assert.equal(sent.length, 1);
  context.activeAppId = 'selected'; vm.runInContext('historyReadPreparation.flush()', context);
  context.activeAppId = ''; context.runtimePriorDocument = null;
  vm.runInContext('historyReadPreparation.flush()', context); assert.equal(sent.length, 1);
  for (const flag of ['adminPreview', 'runtimeBound', 'runtimeReady', 'runtimeAccountBlocked', 'navigationPending']) {
    context[flag] = true; offer(); context[flag] = false;
    assert.equal(sent.length, 1);
  }
  const adminFragment = source.slice(source.indexOf('function prepareAdminCard()'),
    source.indexOf('function bindPreparedAdminPreview()'));
  vm.runInContext(adminFragment, context);
  context.bridgeAvailable = false;
  offer();
  listeners.get('homer:prepare-admin-preview')({ detail: { app_id: 'admin-card' } });
  context.bridgeAvailable = true;
  vm.runInContext('prepareAdminCard(); historyReadPreparation.flush()', context);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0].type, 'prepare-admin-preview');
  assert.equal(sent.filter(([message]) => message.type === 'prepare-history-conversations').length, 1);
});
