import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../frontend/app/assets/js/visual-novel-library.mjs', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const role = { id: 'authorized-role', name: '实际角色元数据', current_version_id: 'published-version', icon: '/synthetic-role.png', prompt: 'MUST NOT COPY', description: 'MUST NOT READ BODY' };
class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ''; this.disabled = false; this.hidden = false; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, listener) { const set = this.listeners.get(name) || new Set(); set.add(listener); this.listeners.set(name, set); }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatch(name, values = {}) { const event = { prevented: false, currentTarget: this, preventDefault() { this.prevented = true; }, ...values }; for (const fn of this.listeners.get(name) || []) fn(event); return event; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() { this.focused = true; }
}

function harness({ owner: initialOwner = 'owner-a', games = [], api = {}, createStore, getStore, commandStore, cacheRows = [], storageFailure = false, loadFailure = false, pointerCoarse = false } = {}) {
  let owner = initialOwner, nextId = 0; const cache = new Map(cacheRows), navigation = [], posts = [], creates = [], commands = [], reads = [], gets = [], roleCalls = [], guards = [];
  const ui = Object.fromEntries(['new', 'empty-new', 'setup', 'close', 'mode', 'setup-fields', 'role-form', 'role-query', 'role-source', 'role-search', 'role-status', 'roles', 'role-prev', 'role-next', 'role-page', 'selected', 'form', 'title', 'player', 'scene', 'summary', 'create', 'create-status', 'ack', 'recovery', 'recovery-detail', 'recover', 'recovery-link', 'search', 'refresh', 'count', 'status', 'list', 'empty', 'more'].map(key => [key, new Node()]));
  ui['role-source'].value = 'public';
  const root = new Node(), window = new Node('window'); root.querySelector = selector => ui[selector.slice(11, -1)];
  const context = vm.createContext({ URL, URLSearchParams, AbortController, Date, Promise,
    matchMedia: () => ({matches:pointerCoarse}),
    document: { querySelector: () => null, createElement: tag => new Node(tag) }, window,
    location: { origin: 'https://synthetic.invalid', href: 'https://synthetic.invalid/app/visual-novel.html' },
    messagePreview: value => value, api: {}, getCachedUser: () => ({ id: owner }), requireAuth: () => true, injectLayout: () => {}, readPageCache: () => { throw new Error('GAME MUST NOT READ HISTORIES'); }, writePageCache: () => { throw new Error('GAME MUST NOT WRITE HISTORIES'); } });
  vm.runInContext(source.replace(/^import .*;\r?$/gm, '').replaceAll('export ', ''), context);
  const apiClient = {
    conversations() { throw new Error('GAME MUST NOT READ HISTORIES API'); },
    exploreSearch: async (params, options) => { roleCalls.push({ kind: 'public', params, options }); return api.exploreSearch ? api.exploreSearch(params, options) : { data: { apps: [role], total: 1 } }; },
    myApps: async params => { roleCalls.push({ kind: 'mine', params }); return api.myApps ? api.myApps(params) : { data: { list: [role], total: 1 } }; },
    startConversation: async payload => { posts.push(JSON.parse(JSON.stringify(payload))); return api.startConversation ? api.startConversation(payload) : { data: { app_id: role.id, conversation_id: 'confirmed-dedicated-conversation' } }; },
  };
  const storage = { getItem: key => cache.get(key) || null, setItem(key, value) { if (storageFailure) throw new Error('Synthetic quota'); cache.set(key, value); }, removeItem: key => cache.delete(key) };
  const controller = context.createGameLibraryController(root, { readUser: () => owner ? { id: owner } : null, apiClient, storage, navigate: href => navigation.push(href), makeId: () => `synthetic-game-${++nextId}`,
    loadStore: ({ isCurrent }) => {
      guards.push(isCurrent); if (loadFailure) return Promise.reject(new Error('Synthetic missing IDB'));
      return { list: async account => { reads.push(account); return games.filter(game => game.owner === account); }, close() {},
        get: async (account, id) => { gets.push({ account, id }); return getStore ? getStore(account, id, isCurrent) : games.find(game => game.owner === account && game.id === id) || null; },
        command: async (account, id, command, options) => { commands.push(JSON.parse(JSON.stringify({ account, id, command, options })));
          if (commandStore) return commandStore(account, id, command, options, isCurrent);
          const game = games.find(game => game.owner === account && game.id === id); assert.equal(options.expectedRevision, game.revision);
          game.characters.push(command.character); game.revision++; return game; },
        create: async (account, data) => { creates.push(JSON.parse(JSON.stringify({ account, data }))); if (createStore) return createStore(account, data, isCurrent);
          const game = { owner: account, ...data, updatedAt: 1000 }; games.push(game); return game; } };
    } });
  return { controller, ui, cache, posts, creates, commands, navigation, reads, gets, roleCalls, guards, context, window, user: value => { owner = value; },
    async prepare() { await controller.searchRoles(); ui.roles.children[0].dispatch('click'); ui.title.value = '新的专用故事'; ui.player.value = '合成玩家'; ui.scene.value = '海边'; ui.summary.value = '纯合成开场背景'; } };
}

test('role metadata projection never copies prompt/body or signed avatar and pins the available version', () => {
  const h = harness(); const projected = h.context.normalizePlayableRole(role);
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), { id: role.id, appId: role.id, name: role.name, versionId: 'published-version', avatar: 'https://synthetic.invalid/synthetic-role.png' });
  assert.equal(h.context.normalizePlayableRole({ ...role, icon: 'https://synthetic.invalid/image?token=SECRET' }).avatar, ''); h.controller.destroy();
});

test('touch chooser focuses a non-input control instead of covering portraits with the keyboard', async () => {
  for (const pointerCoarse of [true, false]) {
    const h = harness({pointerCoarse}); h.ui.new.dispatch('click'); await tick();
    assert.equal(h.ui.close.focused === true,pointerCoarse);
    assert.equal(h.ui['role-query'].focused === true,!pointerCoarse);
    h.controller.destroy();
  }
});

test('directory reads only game-store list, uses game identities, and never promotes ordinary histories', async () => {
  const h = harness({ games: [{ id: 'game-only', owner: 'owner-a', title: '真实游戏目录', characters: [{ id: role.id, appId: role.id, name: role.name, conversationId: 'dedicated' }], world: { scene: '办公室' }, updatedAt: 1000 }] });
  await h.controller.refresh(); assert.equal(h.ui.list.children.length, 1); assert.equal(h.posts.length, 0); assert.equal(h.roleCalls.length, 0);
  const links = h.ui.list.children[0].children[1].children.at(-1).children;
  assert.match(links[0].href, /conversation_id=dedicated.*vn_game=game-only&vn_view=stage/); assert.match(links[1].href, /vn_view=talk/); h.controller.destroy();
});

test('empty directory starts a new story directly and role search uses the real public/owned schemas', async () => {
  const h = harness(); await h.controller.refresh(); assert.equal(h.ui.empty.hidden, false); h.ui.new.dispatch('click'); await tick();
  assert.equal(h.ui.setup.hidden, false); assert.equal(h.roleCalls[0].params.zone, 'clean'); assert.ok(h.roleCalls[0].options.signal instanceof AbortSignal);
  h.ui['role-source'].value = 'mine'; await h.controller.searchRoles(); assert.equal(h.roleCalls.at(-1).kind, 'mine'); assert.equal(h.ui.roles.children.length, 1); h.controller.destroy();
});

test('required setup validation makes no POST and explicit confirmation makes one dedicated binding', async () => {
  const h = harness(); await h.prepare(); h.ui.player.value = ''; await h.controller.create(); assert.equal(h.posts.length, 0);
  h.ui.player.value = '合成玩家'; await h.controller.create();
  assert.deepEqual(h.posts, [{ app_id: role.id, app_name: role.name, app_icon: 'https://synthetic.invalid/synthetic-role.png', version_id: 'published-version' }]);
  assert.equal(h.creates[0].data.characters[0].conversationId, 'confirmed-dedicated-conversation'); assert.equal(h.creates[0].data.world.scene, '海边');
  assert.match(h.navigation[0], /vn_game=.+&vn_view=stage/); assert.equal(h.cache.size, 0); h.controller.destroy();
  assert.equal(h.ui.setup.hidden,true); // Returning to a retained hall must not restore its creation overlay.
});

test('double submission stays singleflight and cannot navigate before the actual POST and durable create resolve', async () => {
  const post = deferred(), saved = deferred(); const h = harness({ api: { startConversation: () => post.promise }, createStore: () => saved.promise });
  await h.prepare(); const creating = h.controller.create(); await tick(); await h.controller.create(); assert.equal(h.posts.length, 1); assert.equal(h.navigation.length, 0);
  post.resolve({ data: { conversation_id: 'confirmed' } }); await tick(); assert.equal(h.navigation.length, 0); assert.equal(h.creates.length, 1);
  saved.resolve({ id: h.creates[0].data.id, owner: 'owner-a', characters: [{ appId: role.id, conversationId: 'confirmed' }] }); await creating; assert.equal(h.navigation.length, 1); h.controller.destroy();
});

test('quota failure preserves confirmed conversation metadata and retries only local create, never POST', async () => {
  let attempts = 0; const h = harness({ createStore: async (account, data) => { if (++attempts === 1) throw new Error('Synthetic IDB quota'); return { owner: account, ...data }; } });
  await h.prepare(); await h.controller.create(); assert.equal(h.posts.length, 1); assert.equal(h.navigation.length, 0); assert.equal(h.ui.recovery.hidden, false);
  assert.match(h.ui['recovery-detail'].textContent, /confirmed-dedicated-conversation/); assert.equal(h.cache.size, 1);
  assert.doesNotMatch([...h.cache.values()][0], /MUST NOT COPY|MUST NOT READ BODY|token/);
  await h.controller.create(); assert.equal(h.posts.length, 1); await h.controller.recover(); assert.equal(h.posts.length, 1); assert.equal(h.creates.length, 2); assert.equal(h.cache.size, 0); h.controller.destroy();
});

test('total local storage failure still shows exact confirmed conversation instead of claiming success', async () => {
  const h = harness({ storageFailure: true, createStore: () => Promise.reject(new Error('Synthetic IDB quota')) }); await h.prepare(); await h.controller.create();
  assert.equal(h.navigation.length, 0); assert.match(h.ui['create-status'].textContent, /confirmed-dedicated-conversation.*本机故事未保存/);
  assert.equal(h.cache.size, 0); assert.equal(h.ui.recovery.hidden, false); h.controller.destroy();
});

test('malformed/failed POST is unconfirmed and blocked until the user explicitly acknowledges checking history', async () => {
  const h = harness({ api: { startConversation: async () => ({ data: {} }) } }); await h.prepare(); await h.controller.create();
  assert.equal(h.ui.create.disabled, true); assert.equal(h.ui.ack.hidden, false); assert.match(h.ui['create-status'].textContent, /未确认/);
  await h.controller.create(); assert.equal(h.posts.length, 1); h.ui.ack.dispatch('click'); await h.controller.create(); assert.equal(h.posts.length, 2); assert.equal(h.creates.length, 0); h.controller.destroy();
});

test('late POST after an account switch only retains the original full-owner recovery metadata', async () => {
  const post = deferred(); const prefix = 'owner-'.padEnd(160, 'x'), first = prefix + '-a', second = prefix + '-b';
  const h = harness({ owner: first, api: { startConversation: () => post.promise } }); await h.prepare(); const creating = h.controller.create(); await tick();
  h.user(second); h.window.dispatch('storage', { key: 'ai_xingyue_user' }); post.resolve({ data: { conversation_id: 'late-confirmed' } }); await creating;
  assert.equal(h.creates.length, 0); assert.equal(h.navigation.length, 0); assert.equal(h.ui.recovery.hidden, true);
  assert.equal(h.cache.has(`homer.vn-game-recovery.v1.${JSON.stringify(first)}`), true); assert.equal(h.cache.has(`homer.vn-game-recovery.v1.${JSON.stringify(second)}`), false); h.controller.destroy();
});

test('same-owner new-login epoch invalidates the store guard and old list/card navigation', async () => {
  const h = harness({ games: [{ id: 'old-game', owner: 'owner-a', characters: [{ appId: role.id, conversationId: 'old-conversation' }] }] }); await h.controller.refresh();
  const guard = h.guards[0], card = h.ui.list.children[0].children[1].children.at(-1).children[0];
  h.window.dispatch('storage', { key: 'ai_xingyue_token' }); assert.equal(guard(), false); assert.equal(card.dispatch('click').prevented, true); h.controller.destroy();
});

test('store startup failure is explicit and never posts a server mutation', async () => {
  const h = harness({ loadFailure: true }); await h.prepare(); await h.controller.create(); assert.equal(h.posts.length, 0); assert.equal(h.ui.ack.hidden, true);
  assert.match(h.ui['create-status'].textContent, /没有发送创建会话/); h.controller.destroy();
});

test('scope changes cancel GETs; ignored-abort role results cannot repaint another account', async () => {
  const found = deferred(); const h = harness({ api: { exploreSearch: () => found.promise } }); const reading = h.controller.searchRoles();
  h.user('owner-b'); h.window.dispatch('storage', { key: 'ai_xingyue_user' }); assert.equal(h.roleCalls[0].options.signal.aborted, true);
  found.resolve({ data: { apps: [role] } }); await reading; assert.equal(h.ui.roles.children.length, 0); assert.equal(h.posts.length, 0); h.controller.destroy();
});

const secondRole = { id: 'second-authorized-role', name: '第二位实际人物', version_id: 'second-version' };
const existingGame = () => ({ id: 'existing-game', owner: 'owner-a', title: '已有独立故事', revision: 7, world: { scene: '图书馆' },
  characters: [{ id: role.id, appId: role.id, name: role.name, conversationId: 'original-thread' }], active: { characterId: role.id, channel: 'stage' }, turns: [] });
const secondApi = { exploreSearch: async () => ({ data: { apps: [role, secondRole], total: 2 } }), startConversation: async () => ({ data: { conversation_id: 'second-confirmed-thread' } }) };
async function selectSecond(h) { await h.controller.manageCharacters('existing-game'); await h.controller.searchRoles(); h.ui.roles.children[1].dispatch('click'); }

test('manage characters is a real add mode: duplicate app disabled, one POST and revision-checked local command', async () => {
  const h = harness({ games: [existingGame()], api: secondApi }); await h.controller.refresh();
  const manage = h.ui.list.children[0].children[1].children.at(-1).children[2]; assert.equal(manage.textContent, '管理人物'); assert.equal(manage.attributes.get('data-game-id'), 'existing-game');
  await selectSecond(h); assert.equal(h.ui['setup-fields'].hidden, true); assert.equal(h.ui.title.disabled, true); assert.equal(h.ui.roles.children[0].disabled, true);
  assert.match(h.ui.mode.textContent, /管理人物.*已有独立故事/); await h.controller.create();
  assert.deepEqual(h.posts, [{ app_id: secondRole.id, app_name: secondRole.name, app_icon: '', version_id: 'second-version' }]); assert.equal(h.creates.length, 0);
  assert.equal(h.commands.length, 1); assert.equal(h.commands[0].options.expectedRevision, 7); assert.equal(h.commands[0].command.type, 'add-character');
  assert.equal(h.commands[0].command.character.conversationId, 'second-confirmed-thread'); assert.match(h.navigation[0], /vn_game=existing-game/); h.controller.destroy();
});

test('person limit and pending turns refuse management without any POST', async () => {
  for (const kind of ['limit', 'pending']) {
    const game = existingGame(); if (kind === 'pending') game.turns.push({ status: 'pending' });
    else game.characters = Array.from({ length: 12 }, (_, index) => ({ id: `role-${index}`, appId: `role-${index}`, conversationId: `thread-${index}` }));
    const h = harness({ games: [game], api: secondApi }); await h.controller.manageCharacters(game.id);
    assert.match(h.ui.status.textContent, kind === 'pending' ? /待确认/ : /12/); assert.equal(h.posts.length, 0); h.controller.destroy();
  }
});

test('add mode rechecks actual full game immediately before POST, including a newly pending turn', async () => {
  const game = existingGame(), h = harness({ games: [game], api: secondApi }); await selectSecond(h); game.turns.push({ status: 'pending' });
  await h.controller.create(); assert.equal(h.posts.length, 0); assert.equal(h.commands.length, 0); assert.match(h.ui['create-status'].textContent, /待确认.*没有发送创建会话/); h.controller.destroy();
});

test('add command quota recovery records gameId and only retries local CAS, never server POST', async () => {
  const game = existingGame(); let attempts = 0;
  const h = harness({ games: [game], api: secondApi, commandStore: async (account, id, command, options) => {
    assert.equal(options.expectedRevision, game.revision); if (++attempts === 1) throw new Error('Synthetic command quota'); game.characters.push(command.character); game.revision++; return game;
  } });
  await selectSecond(h); await h.controller.create(); assert.equal(h.posts.length, 1); assert.equal(h.navigation.length, 0);
  const row = JSON.parse([...h.cache.values()][0]); assert.equal(row.mode, 'add'); assert.equal(row.gameId, game.id); assert.equal(row.setup, undefined);
  await h.controller.recover(); assert.equal(h.posts.length, 1); assert.equal(h.commands.length, 2); assert.equal(h.cache.size, 0); assert.equal(h.navigation.length, 1); h.controller.destroy();
});

test('committed add with lost response is recovered by exact binding without another command or POST', async () => {
  const game = existingGame(), h = harness({ games: [game], api: secondApi, commandStore: async (_account, _id, command) => {
    game.characters.push(command.character); game.revision++; throw new Error('Synthetic response lost after commit');
  } });
  await selectSecond(h); await h.controller.create(); assert.equal(h.cache.size, 1); assert.equal(h.commands.length, 1);
  await h.controller.recover(); assert.equal(h.commands.length, 1); assert.equal(h.posts.length, 1); assert.equal(game.characters.length, 2); assert.equal(h.cache.size, 0); h.controller.destroy();
});

test('stable game identity recovers a committed create with lost response without duplicating a game', async () => {
  let committed;
  const h = harness({ getStore: (_account, id) => committed?.id === id ? committed : null,
    createStore: async (account, data) => { committed = { owner: account, ...data }; throw new Error('Synthetic response lost after commit'); } });
  await h.prepare(); await h.controller.create(); const id = committed.id; await h.controller.recover();
  assert.equal(h.creates.length, 1); assert.equal(h.posts.length, 1); assert.match(h.navigation[0], new RegExp(`vn_game=${id}`)); assert.equal(h.cache.size, 0); h.controller.destroy();
});

test('confirmed add arriving after an account switch keeps only old-owner binding, never modifies either game', async () => {
  const post = deferred(), h = harness({ games: [existingGame()], api: { ...secondApi, startConversation: () => post.promise } });
  await selectSecond(h); const creating = h.controller.create(); await tick(); h.user('owner-b'); h.window.dispatch('storage', { key: 'ai_xingyue_user' });
  post.resolve({ data: { conversation_id: 'late-add-thread' } }); await creating; assert.equal(h.commands.length, 0); assert.equal(h.navigation.length, 0);
  const row = JSON.parse(h.cache.get('homer.vn-game-recovery.v1."owner-a"')); assert.equal(row.gameId, 'existing-game'); assert.equal(row.character.conversationId, 'late-add-thread');
  assert.equal(h.ui.recovery.hidden, true); h.controller.destroy();
});

test('explicit account-cleared latches empty UI even if cached identity and retained card are stale', async () => {
  const h = harness({ games: [existingGame()] }); await h.controller.refresh(); const link = h.ui.list.children[0].children[1].children.at(-1).children[0];
  h.window.dispatch('homer-account-cleared'); assert.equal(h.ui.list.children.length, 0); assert.equal(link.dispatch('click').prevented, true);
  h.window.dispatch('pageshow'); await tick(); assert.equal(h.ui.list.children.length, 0); assert.equal(h.ui.new.disabled, true); assert.match(h.ui.status.textContent, /请登录/);
  h.window.dispatch('storage', { key: 'ai_xingyue_user', newValue: '{"id":"owner-a"}' }); await tick(); assert.equal(h.ui.list.children.length, 1); h.controller.destroy();
});

test('malformed durable create result retains its confirmed conversation and cannot claim saved success', async () => {
  const h = harness({ createStore: async () => ({ owner: 'wrong-owner', id: 'wrong-game', characters: [] }) }); await h.prepare(); await h.controller.create();
  assert.equal(h.navigation.length, 0); assert.equal(h.cache.size, 1); assert.equal(h.ui.recovery.hidden, false); assert.match(h.ui['create-status'].textContent, /confirmed-dedicated-conversation.*未保存/); h.controller.destroy();
});

test('while confirmed create is still saving its local transaction, recovery cannot race a second save', async () => {
  const saving = deferred(), h = harness({ createStore: () => saving.promise }); await h.prepare(); const creating = h.controller.create(); await tick();
  assert.equal(h.ui.recover.disabled, true); await h.controller.recover(); assert.equal(h.creates.length, 1);
  saving.resolve({ owner: 'owner-a', ...h.creates[0].data }); await creating; assert.equal(h.posts.length, 1); h.controller.destroy();
});

test('reload recovery metadata recreates only the stable local game and never repeats POST', async () => {
  const row = { version: 1, mode: 'new', owner: 'owner-a', setup: { id: 'confirmed-game-id', title: '已确认新游戏', player: { name: '玩家' }, world: { scene: '海边', summary: '合成背景' }, prompt: 'NOT ALLOWED' },
    character: { id: role.id, appId: role.id, name: role.name, versionId: 'published-version', avatar: '', conversationId: 'confirmed-before-reload', prompt: 'NOT ALLOWED' } };
  const h = harness({ cacheRows: [['homer.vn-game-recovery.v1."owner-a"', JSON.stringify(row)]] }); assert.equal(h.ui.recovery.hidden, false); await h.controller.recover();
  assert.equal(h.posts.length, 0); assert.equal(h.creates.length, 1); assert.equal(h.creates[0].data.id, 'confirmed-game-id'); assert.doesNotMatch(JSON.stringify(h.creates), /NOT ALLOWED/); assert.equal(h.cache.size, 0); h.controller.destroy();
});

test('reload add recovery recognizes an already committed exact character and fences its retained link after account change', async () => {
  const game = existingGame(), character = { id: secondRole.id, appId: secondRole.id, name: secondRole.name, versionId: '', avatar: '', conversationId: 'confirmed-before-reload' }; game.characters.push(character);
  const row = { version: 1, mode: 'add', owner: 'owner-a', gameId: game.id, character };
  const h = harness({ games: [game], cacheRows: [['homer.vn-game-recovery.v1."owner-a"', JSON.stringify(row)]] }); assert.equal(h.ui.recovery.hidden, false); await h.controller.recover();
  assert.equal(h.posts.length, 0); assert.equal(h.commands.length, 0); assert.equal(h.cache.size, 0); h.user('owner-b'); assert.equal(h.ui['recovery-link'].dispatch('auxclick').prevented, true); h.controller.destroy();
});
