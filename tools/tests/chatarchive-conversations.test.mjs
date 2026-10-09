import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createConversationHubAdapter, GROUP_PROTOCOL } from '../../frontend/app/assets/js/visual-novel-conversations.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const owner = 'synthetic-owner';
const group = (gid = 'synthetic-group') => ({ id: gid, name: '合成测试群', members: [
  { app_id: 'role-a', app_name: '角色甲', app_icon: '/synthetic-a.png' }, { app_id: 'role-b', app_name: '角色乙' },
] });
const message = (mid, role = 'assistant', speaker = 'role-a', content = '合成消息', gid = 'synthetic-group') => ({
  id: mid, group_id: gid, role, content, speaker_app_id: role === 'user' ? '' : speaker, speaker_name: role === 'user' ? '合成用户' : '',
});
const envelope = data => ({ result: 'success', data });
function memoryStorage() { const rows = new Map(); return { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), rows }; }

function harness(options = {}) {
  const storage = options.storage || memoryStorage(), calls = [];
  let valid = true;
  const apiClient = {
    async conversations(opts) { calls.push({ kind: 'contacts', signal: opts.signal }); return envelope({ list: [{ id: 'story-a', app_id: 'role-a', app_name: '角色甲', title: '已有剧情', app_icon: '/synthetic-a.png' }] }); },
    async groupChats(opts) { calls.push({ kind: 'groups', signal: opts.signal }); return envelope({ list: [group()] }); },
    async groupChat(gid, opts) { calls.push({ kind: 'detail', gid, signal: opts.signal }); return envelope({ group: group(gid), messages: [message('message-a', 'assistant', 'role-a', '甲的发言', gid), message('message-b', 'assistant', 'role-b', '乙的发言', gid)] }); },
    async exploreSearch(params, opts) { calls.push({ kind: 'roles', params, signal: opts.signal }); return envelope({ apps: [{ id: 'role-a', name: '角色甲' }, { id: 'role-b', name: '角色乙' }], total: 2 }); },
    async createGroupChat(payload, opts) { calls.push({ kind: 'create', payload, signal: opts.signal }); return envelope({ group: group(), messages: [] }); },
    async sendGroupMessage(gid, payload, opts) { calls.push({ kind: 'send', gid, payload, signal: opts.signal }); const created = message('new-user', 'user', '', payload.content, gid); const rows = payload.auto_reply ? [created, message('auto-reply', 'assistant', 'role-a', '自动回复', gid)] : [created]; return envelope({ group: group(gid), messages: rows, new_messages: rows }); },
    async groupReply(gid, payload, opts) { calls.push({ kind: 'reply', gid, payload, signal: opts.signal }); const created = message('new-reply', 'assistant', payload.app_id, '指定回复', gid); return envelope({ group: group(gid), messages: [], message: created }); },
    ...options.apiClient,
  };
  const adapter = createConversationHubAdapter({ owner: options.owner || owner, isCurrent: () => valid, apiClient, storage, now: () => 100000 });
  return { adapter, calls, storage, invalidate: () => { valid = false; } };
}

test('published API wrappers preserve their route/body and forward optional cancellation', async () => {
  const source = await readFile(new URL('../../frontend/app/assets/js/app-core.js', import.meta.url), 'utf8');
  for (const [name, route, args, post] of [
    ['conversations', '/console/api/web/conversations', [], false], ['groupChats', '/console/api/web/group-chats', [], false],
    ['groupChat', '/console/api/web/group-chats/group%2Fa', ['group/a'], false],
    ['createGroupChat', '/console/api/web/group-chats', [{ app_ids: ['role-a', 'role-b'] }], true],
    ['sendGroupMessage', '/console/api/web/group-chats/group%2Fa/message', ['group/a', { content: '合成消息', auto_reply: false }], true],
    ['groupReply', '/console/api/web/group-chats/group%2Fa/reply', ['group/a', { app_id: 'role-a' }], true],
  ]) {
    const line = source.split(/\r?\n/).find(line => line.trimStart().startsWith(`${name}:`));
    const calls = [], context = vm.createContext({ rawRequest: (...values) => { calls.push(values); }, encodeURIComponent });
    const fn = vm.runInContext(`({${line}}).${name}`, context), controller = new AbortController();
    fn(...args, { signal: controller.signal }); fn(...args);
    assert.equal(calls[0][0], route); assert.equal(calls[1][0], route);
    assert.equal(calls[0][1].signal, controller.signal); assert.equal(calls[1][1].signal, undefined);
    if (post) { assert.equal(calls[0][1].method, 'POST'); assert.equal(calls[0][1].body, args.at(-1)); }
  }
  const block = source.match(/exploreSearch: \(params = \{\}, \{ signal \} = \{\}\) => \{[\s\S]*?\n  \},/)[0];
  const calls = [], context = vm.createContext({ rawRequest: (...values) => calls.push(values), URLSearchParams });
  const fn = vm.runInContext(`({${block}}).exploreSearch`, context), controller = new AbortController();
  fn({ q: '合成', page: 2 }, { signal: controller.signal }); fn({ q: '合成', page: 2 });
  assert.equal(calls[0][0], '/go/api/explore/search?q=%E5%90%88%E6%88%90&page=2');
  assert.equal(calls[0][1].signal, controller.signal); assert.equal(calls[0][1].auth, false); assert.equal(calls[1][1].signal, undefined);
});

test('contacts reuse the current owner history cache and existing conversation URLs', async () => {
  const storage = memoryStorage();
  storage.setItem(`homer.page-cache.v1.histories.${owner}`, JSON.stringify({ savedAt: 99999, value: { list: [
    { id: 'existing-story', app_id: 'actual-role', app_name: '现有角色', secret: 'not-a-real-secret' },
  ] } }));
  const before = storage.getItem(`homer.page-cache.v1.histories.${owner}`), h = harness({ storage });
  assert.equal(h.adapter.snapshot().cached.contacts, true); assert.equal(h.adapter.snapshot().contacts[0].id, 'existing-story');
  assert.equal(h.adapter.snapshot().contacts[0].secret, undefined);
  assert.match(h.adapter.contactHref('existing-story'), /app_id=actual-role&conversation_id=existing-story&presentation=archive_vn&vn_view=talk/);
  assert.equal(h.adapter.contactHref('not-real'), '');
  await h.adapter.loadContacts(); assert.equal(storage.getItem(`homer.page-cache.v1.histories.${owner}`), before);
  assert.ok(h.calls[0].signal instanceof AbortSignal); h.adapter.destroy();
});

test('group cache is an owner-scoped read snapshot only and strips unrecognized fields', async () => {
  const storage = memoryStorage(), h = harness({ storage });
  await h.adapter.loadGroups(); await h.adapter.openGroup('synthetic-group');
  const keys = [...storage.rows.keys()]; assert.equal(keys.length, 1); assert.match(keys[0], /homer\.vn-group-view\.v1/);
  h.adapter.destroy();
  const reopened = harness({ storage }); assert.equal(reopened.adapter.snapshot().cached.groups, true);
  await reopened.adapter.openGroup('synthetic-group'); assert.equal(reopened.adapter.snapshot().messages.length, 2);
  const other = harness({ storage, owner: 'other-synthetic-owner' }); assert.equal(other.adapter.snapshot().groups.length, 0);
  reopened.adapter.destroy(); other.adapter.destroy();
});

test('independent per-message speakers preserve actual group member identity', async () => {
  const h = harness(); await h.adapter.openGroup('synthetic-group');
  const messages = h.adapter.snapshot().messages;
  assert.equal(messages[0].speaker_app_id, 'role-a'); assert.equal(messages[0].speaker_name, '角色甲');
  assert.equal(messages[1].speaker_app_id, 'role-b'); assert.equal(messages[1].speaker_name, '角色乙');
  assert.ok(messages[0].speaker_avatar.endsWith('/synthetic-a.png')); assert.equal(messages[1].speaker_avatar, ''); h.adapter.destroy();
});

test('actual role search pagination and 2–8 validated member selection create one real group', async () => {
  const h = harness({ apiClient: { exploreSearch: async (params, opts) => { h.calls.push({ kind: 'roles', params, signal: opts.signal }); return envelope({ apps: Array.from({ length: 9 }, (_, index) => ({ id: `role-${index}`, name: `角色${index}` })), total: 18 }); },
    createGroupChat: async (payload, opts) => { h.calls.push({ kind: 'create', payload, signal: opts.signal }); return envelope({ group: { ...group(), members: payload.app_ids.map(app_id => ({ app_id, app_name: app_id })) }, messages: [] }); } } });
  await h.adapter.searchRoles({ q: '实际', page: 2, pageSize: 9 });
  assert.deepEqual(h.calls[0].params, { q: '实际', page: 2, page_size: 9 }); assert.equal(h.adapter.snapshot().rolesPage.hasMore, false);
  assert.throws(() => h.adapter.selectRole('invented-role'), { code: 'VN_HUB_ROLE' });
  h.adapter.selectRole('role-0'); await assert.rejects(h.adapter.createGroup(), { code: 'VN_HUB_ROLE' });
  for (let index = 1; index < 8; index++) h.adapter.selectRole(`role-${index}`);
  assert.throws(() => h.adapter.selectRole('role-8'), { code: 'VN_HUB_ROLE' });
  const created = await h.adapter.createGroup({ name: '我的群' }); assert.equal(created.members.length, 8);
  assert.equal(h.calls.filter(call => call.kind === 'create').length, 1); assert.equal(h.adapter.snapshot().mutation.outcome, 'confirmed'); h.adapter.destroy();
});

test('lists/messages paginate only available rows and expose the known backend window limits', async () => {
  const h = harness({ apiClient: {
    groupChats: async () => envelope({ list: Array.from({ length: 50 }, (_, index) => group(`group-${index}`)) }),
    groupChat: async gid => envelope({ group: group(gid), messages: Array.from({ length: 300 }, (_, index) => message(`message-${index}`, 'assistant', 'role-a', String(index), gid)) }),
  } });
  await h.adapter.loadGroups(); const groups = h.adapter.groupPage({ page: 2, pageSize: 24 });
  assert.equal(groups.list.length, 24); assert.equal(groups.list[0].id, 'group-24'); assert.equal(groups.serverPagination, false); assert.equal(groups.mayBeTruncated, true);
  await h.adapter.openGroup('group-0'); const messages = h.adapter.messagePage({ page: 8, pageSize: 40 });
  assert.equal(messages.list.length, 20); assert.equal(messages.list[0].id, 'message-280'); assert.equal(messages.hasMore, false); assert.equal(messages.mayBeTruncated, true);
  assert.equal(GROUP_PROTOCOL.serverPagination, false); h.adapter.destroy();
});

test('sending is explicit, defaults to no auto reply, and is not optimistically confirmed', async () => {
  const pending = deferred(), h = harness({ apiClient: { sendGroupMessage: (...args) => { h.calls.push({ kind: 'send', args }); return pending.promise; } } });
  await h.adapter.openGroup('synthetic-group'); const original = h.adapter.snapshot().messages;
  const request = h.adapter.sendMessage({ content: ' 新消息 ' }); await tick();
  assert.deepEqual(h.adapter.snapshot().messages, original); assert.equal(h.calls[1].args[1].auto_reply, false);
  await assert.rejects(h.adapter.sendMessage({ content: '第二条' }), { code: 'VN_HUB_BUSY' });
  const row = message('new-confirmed', 'user', '', '新消息'); pending.resolve(envelope({ group: group(), messages: original, new_messages: [row] }));
  await request; assert.equal(h.adapter.snapshot().messages.at(-1).id, 'new-confirmed'); assert.equal(h.adapter.snapshot().mutation.outcome, 'confirmed');
  assert.equal(h.calls.filter(call => call.kind === 'send').length, 1); h.adapter.destroy();
});

test('model generation requires an explicit cost acknowledgement and actual member', async () => {
  const h = harness(); await h.adapter.openGroup('synthetic-group');
  await assert.rejects(h.adapter.sendMessage({ content: '消息', autoReply: true }), { code: 'VN_HUB_COST' });
  await assert.rejects(h.adapter.requestReply({ appId: 'role-a' }), { code: 'VN_HUB_COST' });
  await assert.rejects(h.adapter.requestReply({ appId: 'invented', acknowledgeCost: true }), { code: 'VN_HUB_ROLE' });
  assert.equal(h.calls.filter(call => ['send', 'reply'].includes(call.kind)).length, 0);
  await h.adapter.sendMessage({ content: '消息', autoReply: true, acknowledgeCost: true }); assert.equal(h.calls.at(-1).payload.auto_reply, true);
  await h.adapter.requestReply({ appId: 'role-b', acknowledgeCost: true }); assert.equal(h.calls.at(-1).payload.app_id, 'role-b');
  assert.equal(h.adapter.snapshot().messages.at(-1).speaker_name, '角色乙'); h.adapter.destroy();
});

test('a failed/partial group POST stays unconfirmed, blocks replay, and requires a successful read', async () => {
  const h = harness({ apiClient: { sendGroupMessage: async () => { h.calls.push({ kind: 'send' }); throw new Error('Synthetic provider failure after saving user message'); } } });
  await h.adapter.openGroup('synthetic-group'); const original = h.adapter.snapshot().messages;
  await assert.rejects(h.adapter.sendMessage({ content: '可能已保存', autoReply: true, acknowledgeCost: true }), { code: 'VN_HUB_REQUEST' });
  assert.equal(h.adapter.snapshot().mutation.outcome, 'unconfirmed'); assert.deepEqual(h.adapter.snapshot().messages, original);
  assert.throws(() => h.adapter.sendMessage({ content: '不要重试' }), { code: 'VN_HUB_REFRESH_REQUIRED' });
  await h.adapter.loadGroups(); assert.equal(h.adapter.snapshot().mutation.outcome, 'unconfirmed');
  await h.adapter.openGroup('synthetic-group'); assert.equal(h.adapter.snapshot().mutation.outcome, 'reconciled');
  assert.equal(h.calls.filter(call => call.kind === 'send').length, 1); h.adapter.destroy();
});

test('malformed/error-body mutation responses never masquerade as successful sends', async () => {
  for (const response of [envelope({ group: group(), messages: [] }), { result: 'failure', data: { group: group(), messages: [], new_messages: [] } },
    envelope({ group: group('wrong-group'), messages: [], new_messages: [message('new-user', 'user', '', '消息')] })]) {
    let requests = 0;
    const h = harness({ apiClient: { sendGroupMessage: async () => { requests++; return response; } } });
    await h.adapter.openGroup('synthetic-group');
    await assert.rejects(h.adapter.sendMessage({ content: '消息' }), { code: 'VN_HUB_RESPONSE' });
    assert.equal(h.adapter.snapshot().mutation.outcome, 'unconfirmed'); assert.equal(requests, 1); h.adapter.destroy();
  }
});

test('cancelled POST remains singleflight until ignored-abort transport settles and cannot apply late data', async () => {
  const pending = deferred(), h = harness({ apiClient: { sendGroupMessage: (...args) => { h.calls.push({ kind: 'send', args }); return pending.promise; } } });
  await h.adapter.openGroup('synthetic-group'); const original = h.adapter.snapshot().messages;
  const request = h.adapter.sendMessage({ content: '待确认' }); await tick(); h.adapter.cancel('mutation');
  await assert.rejects(request, { name: 'AbortError' }); assert.equal(h.adapter.snapshot().busy.mutation, true);
  await assert.rejects(h.adapter.openGroup('synthetic-group'), { code: 'VN_HUB_BUSY' });
  assert.throws(() => h.adapter.sendMessage({ content: '禁止重试' }), { code: 'VN_HUB_REFRESH_REQUIRED' });
  const row = message('late-user', 'user', '', '待确认'); pending.resolve(envelope({ group: group(), messages: [row], new_messages: [row] })); await tick();
  assert.deepEqual(h.adapter.snapshot().messages, original); assert.equal(h.adapter.snapshot().busy.mutation, undefined);
  await h.adapter.openGroup('synthetic-group'); assert.equal(h.adapter.snapshot().mutation.outcome, 'reconciled'); h.adapter.destroy();
});

test('account/epoch changes fence async responses and all cached writes', async () => {
  for (const kind of ['groups', 'detail', 'contacts', 'roles']) {
    const pending = deferred(), ownerObject = { id: owner }, storage = memoryStorage();
    const name = { groups: 'groupChats', detail: 'groupChat', contacts: 'conversations', roles: 'exploreSearch' }[kind];
    const h = harness({ owner: ownerObject, storage, apiClient: { [name]: () => pending.promise } });
    const request = { groups: () => h.adapter.loadGroups(), detail: () => h.adapter.openGroup('synthetic-group'), contacts: () => h.adapter.loadContacts(), roles: () => h.adapter.searchRoles() }[kind]();
    await tick(); ownerObject.id = 'other-owner';
    pending.resolve(envelope(kind === 'detail' ? { group: group(), messages: [] } : { list: [], apps: [] }));
    await assert.rejects(request, { name: 'AbortError' }); assert.equal(storage.rows.size, 0);
    assert.throws(() => h.adapter.snapshot(), { name: 'AbortError' }); h.adapter.destroy();
  }
});

test('switching groups cancels and fences the previous in-flight read without a stale paint', async () => {
  const first = deferred(), second = deferred();
  const h = harness({ apiClient: { groupChat: (gid, opts) => { h.calls.push({ gid, signal: opts.signal }); return gid === 'first' ? first.promise : second.promise; } } });
  const initial = h.adapter.openGroup('first'); await tick();
  const next = h.adapter.openGroup('second'); await assert.rejects(initial, { name: 'AbortError' }); await tick();
  assert.equal(h.calls[0].signal.aborted, true);
  second.resolve(envelope({ group: group('second'), messages: [message('second-message', 'assistant', 'role-b', '第二群', 'second')] })); await next;
  first.resolve(envelope({ group: group('first'), messages: [message('first-message', 'assistant', 'role-a', '旧群', 'first')] })); await tick();
  assert.equal(h.adapter.snapshot().current.id, 'second'); assert.equal(h.adapter.snapshot().messages[0].id, 'second-message'); h.adapter.destroy();
});

test('read errors retain prior real rows, expired/malformed snapshots never create local groups', async () => {
  const storage = memoryStorage(); storage.setItem(`homer.vn-group-view.v1.${JSON.stringify([owner])}`, JSON.stringify({ savedAt: 100000 - 86400001, value: { groups: [group()], details: [] } }));
  let failRead = false;
  const h = harness({ storage, apiClient: { groupChats: async () => { if (failRead) throw new Error('Synthetic offline'); return envelope({ list: [group()] }); } } });
  assert.equal(h.adapter.snapshot().groups.length, 0); await h.adapter.loadGroups(); failRead = true;
  await assert.rejects(h.adapter.loadGroups(), { code: 'VN_HUB_REQUEST' }); assert.equal(h.adapter.snapshot().groups.length, 1); assert.equal(h.adapter.snapshot().status.groups.phase, 'error');
  h.adapter.destroy();
});

test('destroy cancels transports, suppresses listeners and never writes a late group snapshot', async () => {
  const pending = deferred(), h = harness({ apiClient: { groupChats: () => pending.promise } }); let updates = 0;
  h.adapter.subscribe(() => updates++); const request = h.adapter.loadGroups(); await tick(); h.adapter.destroy(); const before = updates;
  await assert.rejects(request, { name: 'AbortError' }); pending.resolve(envelope({ list: [group()] })); await tick();
  assert.equal(updates, before); assert.equal(h.storage.rows.size, 0);
});

test('cached or failed detail reads cannot be used to send while offline', async () => {
  const storage = memoryStorage(), first = harness({ storage }); await first.adapter.openGroup('synthetic-group'); first.adapter.destroy();
  const h = harness({ storage, apiClient: { groupChat: async () => { throw new Error('Synthetic offline'); } } });
  await assert.rejects(h.adapter.openGroup('synthetic-group'), { code: 'VN_HUB_REQUEST' });
  assert.equal(h.adapter.snapshot().cached.detail, true); assert.equal(h.adapter.snapshot().messages.length, 2);
  assert.throws(() => h.adapter.sendMessage({ content: '不能假装离线发送成功' }), { code: 'VN_HUB_REFRESH_REQUIRED' });
  assert.equal(h.calls.length, 0); h.adapter.destroy();
});

test('real returned long messages remain complete; long sends reject instead of silently truncating', async () => {
  const content = '合'.repeat(22000), h = harness({ apiClient: { groupChat: async gid => envelope({ group: group(gid), messages: [message('long-message', 'assistant', 'role-a', content, gid)] }) } });
  await h.adapter.openGroup('synthetic-group'); assert.equal(h.adapter.snapshot().messages[0].content, content);
  await assert.rejects(h.adapter.sendMessage({ content }), { code: 'VN_HUB_INPUT' }); assert.equal(h.calls.length, 0); h.adapter.destroy();
});

test('auto-reply with only a user acknowledgement cannot claim generation succeeded', async () => {
  const row = message('partial-user', 'user', '', '消息');
  const h = harness({ apiClient: { sendGroupMessage: async () => envelope({ group: group(), messages: [row], new_messages: [row] }) } });
  await h.adapter.openGroup('synthetic-group');
  await assert.rejects(h.adapter.sendMessage({ content: '消息', autoReply: true, acknowledgeCost: true }), { code: 'VN_HUB_RESPONSE' });
  assert.equal(h.adapter.snapshot().mutation.outcome, 'unconfirmed'); h.adapter.destroy();
});

test('long account identities do not collide with the legacy truncated history-cache owner', () => {
  const storage = memoryStorage(), prefix = 'a'.repeat(160);
  storage.setItem(`homer.page-cache.v1.histories.${prefix}`, JSON.stringify({ savedAt: 100000, value: { list: [{ id: 'other-story', app_id: 'other-role' }] } }));
  const h = harness({ storage, owner: prefix + '-distinct-owner' }); assert.equal(h.adapter.snapshot().contacts.length, 0); h.adapter.destroy();
});

test('scope epoch invalidation and an already-aborted request make no API calls or cache writes', async () => {
  const pending = deferred(), h = harness({ apiClient: { groupChats: () => pending.promise } });
  const request = h.adapter.loadGroups(); await tick(); h.invalidate(); pending.resolve(envelope({ list: [group()] }));
  await assert.rejects(request, { name: 'AbortError' }); assert.equal(h.storage.rows.size, 0); h.adapter.destroy();
  const second = harness(), controller = new AbortController(); controller.abort();
  await assert.rejects(second.adapter.loadGroups({ signal: controller.signal }), { name: 'AbortError' }); assert.equal(second.calls.length, 0); second.adapter.destroy();
});
