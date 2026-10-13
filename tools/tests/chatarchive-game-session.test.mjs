import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameCommand, buildGameContext } from '../../frontend/app/assets/js/visual-novel-game-store.mjs';
import { createGameSession, projectGameMessages } from '../../frontend/app/assets/js/visual-novel-game-session.mjs';

const setup = () => createGame({ id: 'game-one', owner: 'test-owner', title: '合成游玩', player: { name: '玩家' },
  world: { scene: '海边', summary: '只使用合成剧情' }, characters: [{ id: 'role-a', appId: 'role-a', name: '合成人物',
    versionId: 'version-a', avatar: '', conversationId: 'conv-a' }] }, { now: 1 });
function memoryStore(initial = setup()) {
  let value = initial; const commands = [], snapshots = new Map();
  return { commands, get value() { return value; }, close() {},
    async get(owner, id) { return owner === value.owner && id === value.id ? structuredClone(value) : null; },
    async command(owner, id, input, { expectedRevision }) {
      assert.equal(owner, value.owner); assert.equal(id, value.id); assert.equal(expectedRevision, value.revision);
      commands.push(input); value = applyGameCommand(value, input, { now: 2 + commands.length }); return structuredClone(value);
    },
    async checkpoint(_owner, _id, label) { const id = `save-${snapshots.size}`; snapshots.set(id, structuredClone(value)); return { id, label }; },
    async listCheckpoints() { return [...snapshots.keys()].map(id => ({ id })); },
    async deleteCheckpoint(_owner, _game, id) { return snapshots.delete(id); },
    async restore(_owner, _game, id) { const previousRevision = value.revision; value = structuredClone(snapshots.get(id)); value.revision = previousRevision + 1; return structuredClone(value); },
  };
}
function session(store, extra = {}) { let id = 0; return createGameSession({ owner: 'test-owner', gameId: 'game-one',
  appId: 'role-a', conversationId: 'conv-a', store, makeId: () => `req-${++id}`, ...extra }); }
const defer = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

test('channel transition locks immediately, cannot race a model request or another disk mutation', async () => {
  const store = memoryStore(), gate = defer(); let held = false, generated = 0;
  const command = store.command.bind(store); store.command = async (...args) => { if (held) await gate.promise; return command(...args); };
  const flow = session(store, { host: { generate: () => { generated++; } } }); await flow.open(); held = true;
  const switching = flow.selectChannel('talk'); assert.equal(flow.busy,true);
  await assert.rejects(flow.send('切换未落盘的输入'),{code:'GAME_TURN_BUSY'});
  await assert.rejects(flow.selectChannel('stage'),{code:'GAME_TURN_BUSY'});
  gate.resolve(); await switching; assert.equal(flow.busy,false); assert.equal(flow.state.active.channel,'talk');
  assert.equal(generated,0); assert.equal(flow.state.turns.length,0); await flow.destroy();
});

test('fresh game opens without existing historical messages or automatic generation', async () => {
  const store = memoryStore(); let calls = 0;
  const flow = session(store, { host: { generate: () => { calls++; } } });
  const game = await flow.open(); assert.equal(calls, 0); assert.deepEqual(projectGameMessages(game), []);
  assert.equal(game.active.channel, 'stage'); await flow.destroy();
});

test('private chat, date, stage and explicit memory form one durable game loop', async () => {
  const store = memoryStore(), prompts = [];
  const flow = session(store, { host: { async generate(request) { prompts.push(buildGameContext(store.value,
    store.value.active.characterId, request.channel, request.eventId));
    return { requestId: request.requestId, text: `[角色:合成人物]\n合成回复 ${request.userText}`, messageId: `m-${request.requestId}` }; } } });
  await flow.open(); await flow.selectChannel('talk'); await flow.send('一起去海边吗？');
  const privateTurn = flow.state.turns[0]; await flow.archive(privateTurn.requestId);
  await flow.planDate({ title: '海边散步', scene: '傍晚海岸' }); const dateId = flow.state.events[0].id;
  await flow.startDate(dateId); await flow.send('沿海岸慢慢走');
  assert.equal(flow.state.active.eventId, dateId); assert.equal(flow.state.events[0].status, 'active');
  assert.deepEqual(projectGameMessages(flow.state).map(m => m.id), ['req-3:user', 'req-3:reply']);
  await flow.finishDate(dateId); assert.equal(flow.state.active.channel, 'talk');
  assert.equal(flow.state.events[0].status, 'completed'); assert.equal(flow.state.memories.length, 1);
  assert.equal(projectGameMessages(flow.state).length, 2); // The date is not duplicated into private chat.
  await flow.selectChannel('stage'); await flow.send('回到舞台');
  assert.match(prompts.at(-1), /一起去海边/); assert.match(prompts.at(-1), /海边散步/);
  assert.equal(flow.state.turns.length, 3); await flow.destroy();
  const reopened = session(store); await reopened.open(); assert.equal(reopened.state.turns.length, 3);
  assert.equal(projectGameMessages(reopened.state).length, 2); await reopened.destroy();
});

test('single flight begins before disk read and waits for actual host completion', async () => {
  const store = memoryStore(), host = defer(); let calls = 0;
  const flow = session(store, { host: { generate: () => { calls++; return host.promise; } } }); await flow.open();
  const sending = flow.send('等待真实完成'); await assert.rejects(flow.send('重复点击'), { code: 'GAME_TURN_BUSY' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  assert.equal(flow.state.turns[0].status, 'pending'); assert.equal(flow.busy, true);
  host.resolve({ requestId: 'req-1', text: '真实宿主完成的测试文本', messageId: 'assistant-1' });
  await sending; assert.equal(flow.busy, false); assert.equal(flow.state.turns[0].status, 'completed'); await flow.destroy();
});

test('stop persists interrupted before provider ends and rejects late replies', async () => {
  const store = memoryStore(), host = defer(); let stopped = 0;
  const flow = session(store, { host: { generate: () => host.promise, stop: async () => { stopped++; } } }); await flow.open();
  const sending = flow.send('中途停止'); const rejected = assert.rejects(sending, { code: 'GAME_INTERRUPTED' });
  await new Promise(resolve => setImmediate(resolve)); await flow.stop();
  assert.equal(store.value.turns[0].status, 'interrupted'); assert.equal(stopped, 1);
  host.resolve({ requestId: 'req-1', text: '迟到结果不可写入', messageId: 'late' }); await rejected;
  assert.equal(store.value.turns[0].reply, ''); await flow.destroy();
});

test('pending is recovered as uncertain on reopen without reissuing provider POST', async () => {
  const initial = applyGameCommand(setup(), { type: 'begin-turn', requestId: 'old-request', characterId: 'role-a',
    channel: 'stage', eventId: '', userText: '旧请求' }, { now: 2 });
  const store = memoryStore(initial); let calls = 0;
  const flow = session(store, { host: { generate: () => { calls++; } } }); await flow.open();
  assert.equal(flow.state.turns[0].status, 'uncertain'); assert.equal(calls, 0); await flow.destroy();
});

test('account invalidation does not publish late reply or write to new account', async () => {
  const store = memoryStore(), host = defer(); let valid = true, published = 0;
  const flow = session(store, { host: { generate: () => host.promise }, isCurrent: () => valid, onChange: () => { published++; } });
  await flow.open(); const sending = flow.send('原账号的行动'); const rejected = assert.rejects(sending, { code: 'GAME_SCOPE_CHANGED' });
  await new Promise(resolve => setImmediate(resolve)); const before = published; valid = false;
  host.resolve({ requestId: 'req-1', text: '迟到结果', messageId: 'late' }); await rejected;
  assert.equal(published, before); assert.equal(store.value.owner, 'test-owner'); assert.equal(store.value.turns[0].status, 'uncertain'); await flow.destroy();
});

test('local begin failure prevents any generation and cannot fabricate success', async () => {
  const store = memoryStore(); store.command = async () => { throw new Error('disk failure'); }; let calls = 0;
  const flow = session(store, { host: { generate: () => { calls++; } } }); await flow.open();
  await assert.rejects(flow.send('无法保存'), /disk failure/); assert.equal(calls, 0); assert.equal(flow.busy, false); await flow.destroy();
});

test('failed or malformed result is uncertain, not a fake completed reply', async () => {
  for (const result of [{ text: 'no request id', messageId: 'm' }, { requestId: 'req-1', text: '', messageId: 'm' }]) {
    const store = memoryStore(), flow = session(store, { host: { generate: async () => result } }); await flow.open();
    await assert.rejects(flow.send('测试'), { code: 'GAME_REPLY_UNCONFIRMED' });
    assert.equal(store.value.turns[0].status, 'uncertain'); assert.equal(store.value.turns[0].reply, ''); await flow.destroy();
  }
});

test('bindings reject other character or conversation instead of showing wrong history', async () => {
  const store = memoryStore();
  const flow = createGameSession({ owner: 'test-owner', gameId: 'game-one', appId: 'another-role', conversationId: 'conv-a', store });
  await assert.rejects(flow.open(), { code: 'GAME_BINDING_MISMATCH' }); await flow.destroy();
});

test('game branch restores channels and memories without deleting canonical history', async () => {
  const store = memoryStore(), flow = session(store, { host: { generate: async r => ({ requestId: r.requestId,
    text: `合成${r.userText}`, messageId: `canonical-${r.requestId}` }) } }); await flow.open();
  await flow.send('过去'); const save = await flow.checkpoint('过去时间点');
  await flow.send('未来'); await flow.archive('req-2');
  await flow.restore(save.id); assert.equal(flow.state.turns.length, 1); assert.equal(flow.state.memories.length, 0);
  assert.equal(flow.state.turns[0].canonicalMessageId, 'canonical-req-1');
  assert.equal(store.commands.some(c => /delete/.test(c.type)), false); await flow.destroy();
});
