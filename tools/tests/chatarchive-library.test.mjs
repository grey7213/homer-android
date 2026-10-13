import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../frontend/app/assets/js/visual-novel-library.mjs', import.meta.url), 'utf8');
const preview = await readFile(new URL('../../frontend/assets/js/message-preview.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const rows = (owner = 'synthetic-a', count = 40) => Array.from({ length: count }, (_, index) => ({ id: `${owner}-story-${index}`, app_id: `${owner}-role-${index}`, app_name: `${owner}角色${index}`, title: `剧情${index}`, last_message: '<script>notExecutable()</script><b>安全摘要</b>' }));
const plain = value => JSON.parse(JSON.stringify(value));

class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.value = ''; this.disabled = false; this.hidden = false; this.textContent = ''; }
  append(...nodes) { for (const node of nodes) { if (node.tag === 'fragment') this.append(...node.children); else { node.parent = this; this.children.push(node); } } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(name, fn) { const handlers = this.listeners.get(name) || new Set(); handlers.add(fn); this.listeners.set(name, handlers); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  dispatch(name, values = {}) { const event = { currentTarget: this, prevented: false, preventDefault() { this.prevented = true; }, ...values }; for (const fn of [...(this.listeners.get(name) || [])]) fn(event); return event; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
}

function harness({ initialUser = { id: 'synthetic-a' }, cached = rows(), getConversations, readCache } = {}) {
  let user = initialUser; const writes = [], calls = [], nav = [], cacheReads = [];
  const root = new Node(), ui = Object.fromEntries(['search', 'refresh', 'count', 'status', 'list', 'empty', 'empty-title', 'empty-detail', 'more', 'hub'].map(key => [key, new Node()]));
  const modes = ['stage', 'talk'].map(value => Object.assign(new Node('button'), { dataset: { vnView: value } }));
  root.querySelector = selector => ui[selector.slice(9, -1)];
  root.querySelectorAll = () => modes;
  const window = new Node('window'), document = { body: new Node('body'), querySelector: () => null, createElement: tag => new Node(tag), createDocumentFragment: () => new Node('fragment') };
  const context = vm.createContext({ document, window, URL, URLSearchParams, AbortController, Date,
    location: { origin: 'https://synthetic.invalid', assign: value => nav.push(value) },
    api: { conversations: options => { calls.push(options); return getConversations?.(options) || Promise.resolve({ data: { list: rows() } }); } },
    requireAuth: () => true, getCachedUser: () => user, injectLayout: () => {},
    readPageCache: (scope, owner) => { cacheReads.push({ scope, owner: plain(owner) }); return readCache ? readCache(scope, owner) : owner?.id === 'synthetic-a' ? { list: cached } : null; },
    writePageCache: (scope, owner, value) => writes.push({ scope, owner: plain(owner), value: plain(value) }),
  });
  vm.runInContext(preview.replaceAll('export ', '') + '\n' + source.replace(/^import .*;\r?$/gm, '').replaceAll('export ', ''), context);
  const controller = context.createLibraryController(root);
  return { controller, ui, modes, calls, writes, cacheReads, window, document, context, nav, user: next => { user = next; } };
}

test('local-first paints actual cached stories, safe previews and paginated existing links', () => {
  const h = harness();
  assert.equal(h.ui.list.children.length, 36); assert.equal(h.ui.count.textContent, '40 段故事'); assert.equal(h.calls.length, 0);
  const first = h.ui.list.children[0]; assert.match(first.href, /app_id=synthetic-a-role-0&conversation_id=synthetic-a-story-0&presentation=archive_vn&vn_view=stage/);
  assert.equal(first.children[1].children.find(node => node.tag === 'p').textContent, '安全摘要');
  h.ui.more.dispatch('click'); assert.equal(h.ui.list.children.length, 40); assert.equal(h.ui.more.hidden, true); h.controller.destroy();
});

test('search and read-mode switching keep real conversation ids and never create conversations', () => {
  const h = harness(); h.ui.search.value = '角色38'; h.ui.search.dispatch('input');
  assert.equal(h.ui.list.children.length, 1); h.modes[1].dispatch('click'); assert.match(h.ui.list.children[0].href, /conversation_id=synthetic-a-story-38.*vn_view=talk/);
  assert.equal(h.calls.length, 0); h.controller.destroy();
});

test('refresh forwards an AbortSignal and writes only the accepted current-owner metadata cache', async () => {
  const h = harness(); await h.controller.refresh();
  assert.ok(h.calls[0].signal instanceof AbortSignal); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].scope, 'histories');
  assert.equal(h.writes[0].owner.id, 'synthetic-a'); assert.equal(h.writes[0].value.list.length, 40); assert.equal(h.ui.refresh.disabled, false); h.controller.destroy();
});

test('explicit refresh supersedes and cancels the previous GET without accepting its late result', async () => {
  const first = deferred(), second = deferred(); let call = 0;
  const h = harness({ getConversations: () => ++call === 1 ? first.promise : second.promise });
  const old = h.controller.refresh(), fresh = h.controller.refresh(); assert.equal(h.calls[0].signal.aborted, true);
  second.resolve({ data: { list: rows('new-list', 2) } }); await fresh;
  first.resolve({ data: { list: rows('stale-list', 1) } }); await old;
  assert.equal(h.writes.length, 1); assert.equal(h.ui.count.textContent, '2 段故事'); assert.match(h.ui.list.children[0].href, /new-list-story/); h.controller.destroy();
});

test('cross-window account changes immediately clear old stories/search and cancel the old request', async () => {
  const old = deferred(), fresh = deferred(); let call = 0;
  const h = harness({ getConversations: () => ++call === 1 ? old.promise : fresh.promise }); h.ui.search.value = '私有搜索条件';
  const pending = h.controller.refresh(); h.user({ id: 'synthetic-b' }); h.window.dispatch('storage', { key: 'ai_xingyue_user' });
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.ui.list.children.length, 0); assert.equal(h.ui.search.value, '');
  old.resolve({ data: { list: rows('synthetic-a', 1) } }); await pending; assert.equal(h.writes.length, 0);
  fresh.resolve({ data: { list: rows('synthetic-b', 2) } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.writes[0].owner.id, 'synthetic-b'); assert.equal(h.ui.list.children.length, 2); h.controller.destroy();
});

test('retained card click and auxiliary navigation are fenced even without a delivered account event', () => {
  for (const kind of ['click', 'auxclick']) {
    const h = harness(), old = h.ui.list.children[0]; h.user({ id: 'synthetic-b' });
    assert.equal(old.dispatch(kind).prevented, true); assert.equal(h.ui.list.children.length, 0); assert.equal(h.nav.length, 0); h.controller.destroy();
  }
});

test('sign-out closes the modal, clears old content, cancels GET and rejects all late cache writes', async () => {
  const pending = deferred(), h = harness({ getConversations: () => pending.promise });
  const request = h.controller.refresh(); h.ui.hub.dispatch('click'); assert.equal(h.document.body.children[0].open, true);
  h.user(null); h.window.dispatch('homer-account-cleared'); assert.equal(h.document.body.children.length, 0);
  assert.equal(h.ui.list.children.length, 0); assert.match(h.ui.status.textContent, /请登录/); assert.equal(h.calls[0].signal.aborted, true);
  pending.resolve({ data: { list: rows() } }); await request; assert.equal(h.writes.length, 0); h.controller.destroy();
});

test('malformed or unavailable list reads keep local stories with an explicit status', async () => {
  for (const response of [{ data: {} }, null]) {
    const h = harness({ getConversations: () => response === null ? Promise.reject(new Error('Synthetic offline')) : Promise.resolve(response) });
    await h.controller.refresh(); assert.equal(h.ui.list.children.length, 36); assert.match(h.ui.status.textContent, /暂时无法更新/); assert.equal(h.writes.length, 0); h.controller.destroy();
  }
});

test('destroy aborts a pending read, removes listeners and prevents late writes or navigation', async () => {
  const pending = deferred(), h = harness({ getConversations: () => pending.promise }), card = h.ui.list.children[0];
  const request = h.controller.refresh(); h.controller.destroy(); assert.equal(h.calls[0].signal.aborted, true);
  pending.resolve({ data: { list: rows('late-account', 3) } }); await request;
  assert.equal(h.writes.length, 0); assert.equal(h.window.listeners.get('storage').size, 0); assert.equal(card.dispatch('click').prevented, true);
});

test('two complete long owners sharing the legacy first 160 characters never read or overwrite that cache alias', async () => {
  const prefix = 'synthetic-owner-'.padEnd(160, 'x');
  const firstOwner = { id: prefix + '-first' }, secondOwner = { id: prefix + '-second' };
  const legacyValue = { list: rows('other-account-private-cache', 1) };
  const second = deferred(); let calls = 0;
  const h = harness({ initialUser: firstOwner,
    readCache: (_scope, owner) => owner.id.slice(0, 160) === prefix ? legacyValue : null,
    getConversations: () => ++calls === 1 ? Promise.resolve({ data: { list: rows('first-network', 1) } }) : second.promise });
  assert.equal(h.cacheReads.length, 0); assert.equal(h.ui.list.children.length, 0);
  assert.match(h.ui.status.textContent, /本机会话索引不可用.*离线.*联网刷新/);
  await h.controller.refresh(); assert.match(h.ui.list.children[0].href, /first-network-story/);
  assert.equal(h.writes.length, 0);
  h.user(secondOwner); h.window.dispatch('storage', { key: 'ai_xingyue_user' });
  assert.equal(h.ui.list.children.length, 0); assert.equal(h.cacheReads.length, 0);
  second.resolve({ data: { list: rows('second-network', 2) } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.ui.list.children.length, 2); assert.match(h.ui.list.children[0].href, /second-network-story/);
  assert.equal(h.cacheReads.length, 0); assert.equal(h.writes.length, 0);
  assert.equal(legacyValue.list[0].id, 'other-account-private-cache-story-0'); h.controller.destroy();
});

test('offline long-owner cache rejection stays explicit while exactly 160 characters retain the existing cache contract', async () => {
  const owner = { id: 'synthetic-owner-'.padEnd(160, 'y') };
  const h = harness({ initialUser: owner, readCache: () => ({ list: rows('accepted-boundary-cache', 1) }) });
  assert.equal(h.cacheReads.length, 1); assert.equal(h.ui.list.children.length, 1);
  await h.controller.refresh(); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].owner.id, owner.id); h.controller.destroy();
  const long = harness({ initialUser: { id: owner.id + '-long' }, readCache: () => ({ list: rows('unsafe-cache', 1) }),
    getConversations: () => Promise.reject(new Error('Synthetic offline')) });
  await long.controller.refresh(); assert.equal(long.ui.list.children.length, 0);
  assert.match(long.ui.status.textContent, /本机会话索引不可用.*离线.*联网刷新/);
  assert.equal(long.cacheReads.length, 0); assert.equal(long.writes.length, 0); long.controller.destroy();
});
