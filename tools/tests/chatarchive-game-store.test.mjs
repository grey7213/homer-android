import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createGame, applyGameCommand, buildGameContext, createGameStore } from '../../frontend/app/assets/js/visual-novel-game-store.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const DB = 'homer-vn-games-v1', BODY = 'games', INDEX = 'game_index', CP = 'game_checkpoints', CPI = 'game_checkpoint_index';
const owner = 'synthetic-game-owner';
const role = (id = 'role-a') => ({ id, appId: 'app-' + id, versionId: 'version-' + id, name: id === 'role-a' ? '合成向导' : '合成同伴',
    avatar: '/synthetic/' + id + '.png', conversationId: 'conversation-' + id });
const setup = (id = 'game-1') => ({ id, owner, title: '合成独立游戏', player: { name: '合成玩家' },
    world: { scene: '用户指定的书店', summary: '用户指定的世界背景。' }, characters: [role(), role('role-b')] });
const game = () => createGame(setup(), { now: 100 });
const reduce = (g, type, values = {}, now = 101) => applyGameCommand(g, { type, ...values }, { now });
const begin = (g, requestId = 'request-1', values = {}) => reduce(g, 'begin-turn', { requestId, ...g.active, userText: '玩家真实输入。', ...values });
const complete = (g, requestId = 'request-1', reply = '已确认的合成模型回复。') => reduce(begin(g, requestId), 'finish-turn', { requestId, reply, canonicalMessageId: 'canonical-' + requestId });
function harness(options = {}) {
    const indexedDB = options.indexedDB ?? cardTransportIDB(); let next = 0;
    const store = createGameStore({ indexedDB, now: () => 1000, makeId: () => 'generated-' + (++next), ...options });
    return { indexedDB, store };
}

test('version-1 creation is pure, inert and contains only explicit game state, not historical conversation text', () => {
    const input = setup(), saved = structuredClone(input), g = createGame(input, { now: () => 100 });
    assert.deepEqual(input, saved); assert.equal(g.version, 1); assert.equal(g.revision, 0);
    assert.deepEqual(g.active, { characterId: 'role-a', channel: 'stage', eventId: '' });
    assert.deepEqual(g.turns, []); assert.deepEqual(g.events, []); assert.deepEqual(g.memories, []);
    input.characters[0].name = '调用者修改'; assert.equal(g.characters[0].name, '合成向导');
    assert.equal(g.player.name, '合成玩家'); assert.equal(g.world.scene, '用户指定的书店');
    for (const key of ['messages', 'relationLevel', 'affection', 'map', 'credentials', 'cardBody']) assert.equal(g[key], undefined);
    const h = harness(); assert.equal(h.indexedDB.openCount, 0); h.store.close();
});

test('completed turns preserve full replies and canonical IDs; archived memories are original excerpts, not synthetic summaries', () => {
    const initial = game(), reply = '原文😀'.repeat(5000), original = structuredClone(initial);
    let g = complete(initial, 'long-turn', reply);
    assert.deepEqual(initial, original); assert.equal(g.turns[0].reply, reply); assert.equal(g.turns[0].canonicalMessageId, 'canonical-long-turn');
    assert.equal(g.revision, 2); assert.equal(g.turns[0].status, 'completed');
    g = reduce(g, 'archive-turn', { requestId: 'long-turn' });
    assert.deepEqual(Object.keys(g.memories[0]).sort(), ['characterId', 'createdAt', 'requestId', 'text']);
    assert.equal(g.memories[0].text, '玩家：玩家真实输入。\n合成向导：' + reply);
    assert.throws(() => reduce(g, 'archive-turn', { requestId: 'long-turn' }), { code: 'VN_GAME_MEMORY_DUPLICATE' });
    const context = buildGameContext(g, 'role-a', 'talk'); assert.ok(context.includes('已归档原文记忆')); assert.ok(context.length <= 12000);
    assert.equal(buildGameContext(g, 'role-b', 'talk').includes('原文😀'), false);
});

test('commands reject duplicate generation, cross-character/channel/date requests and unfinished context switches', () => {
    let g = game();
    assert.throws(() => begin(g, 'bad', { characterId: 'role-b' }), { code: 'VN_GAME_ACTIVE_MISMATCH' });
    assert.throws(() => begin(g, 'bad', { channel: 'talk' }), { code: 'VN_GAME_ACTIVE_MISMATCH' });
    assert.throws(() => begin(g, 'bad', { eventId: 'not-active' }), { code: 'VN_GAME_ACTIVE_MISMATCH' });
    g = begin(g); assert.throws(() => begin(g), { code: 'VN_GAME_REQUEST_DUPLICATE' });
    assert.throws(() => begin(g, 'second'), { code: 'VN_GAME_TURN_PENDING' });
    assert.throws(() => reduce(g, 'select', { characterId: 'role-b', channel: 'talk' }), { code: 'VN_GAME_TURN_PENDING' });
    assert.throws(() => reduce(g, 'finish-turn', { requestId: 'unknown', reply: '不能绑定别的请求', canonicalMessageId: 'other' }), { code: 'VN_GAME_REQUEST_INVALID' });
    g = reduce(g, 'finish-turn', { requestId: 'request-1', reply: '确认完成', canonicalMessageId: 'canonical-1' });
    assert.throws(() => begin(g), { code: 'VN_GAME_REQUEST_DUPLICATE' });
    assert.throws(() => reduce(g, 'finish-turn', { requestId: 'request-1', reply: '晚到重复回复', canonicalMessageId: 'canonical-late' }), { code: 'VN_GAME_REQUEST_INVALID' });
    assert.throws(() => reduce(g, 'select', { characterId: 'unknown', channel: 'talk' }), { code: 'VN_GAME_CHARACTER_MISSING' });
    assert.throws(() => reduce(g, 'select', { characterId: 'role-a', channel: 'director' }), { code: 'VN_GAME_INVALID' });
});

test('interrupted/uncertain turns and recovered pending work never enter context or retry automatically', () => {
    let g = begin(game(), 'uncertain-request', { userText: '尚未确认的输入' });
    assert.equal(buildGameContext(g, 'role-a', 'stage').includes('尚未确认'), false);
    g = reduce(g, 'recover-pending'); assert.equal(g.turns[0].status, 'uncertain'); assert.equal(g.revision, 2);
    assert.equal(g.turns[0].reply, ''); assert.equal(g.turns[0].canonicalMessageId, '');
    assert.equal(reduce(g, 'recover-pending').revision, 2);
    assert.throws(() => begin(g, 'uncertain-request'), { code: 'VN_GAME_REQUEST_DUPLICATE' });
    g = begin(g, 'next'); g = reduce(g, 'fail-turn', { requestId: 'next', status: 'interrupted', error: '合成取消' });
    assert.equal(g.turns[1].status, 'interrupted'); assert.equal(buildGameContext(g, 'role-a', 'stage').includes('玩家真实输入'), false);
    assert.throws(() => reduce(g, 'archive-turn', { requestId: 'next' }), { code: 'VN_GAME_REQUEST_INVALID' });
});

test('dates can pause for private chat, resume the same event, finish in talk, and cannot fabricate relationships', () => {
    let g = reduce(game(), 'plan-date', { eventId: 'date-a', characterId: 'role-a', title: '去公园走走', scene: '用户指定的公园' });
    g = reduce(g, 'plan-date', { eventId: 'date-b', characterId: 'role-b', title: '另一场约会', scene: '用户指定的咖啡店' });
    assert.throws(() => begin(g, 'date-pending', { eventId: 'date-a' }), { code: 'VN_GAME_ACTIVE_MISMATCH' });
    g = reduce(g, 'start-date', { eventId: 'date-a' });
    assert.deepEqual(g.active, { characterId: 'role-a', channel: 'stage', eventId: 'date-a' });
    assert.ok(buildGameContext(g, 'role-a', 'stage', 'date-a').includes('用户指定的公园'));
    assert.throws(() => buildGameContext(g, 'role-b', 'stage', 'date-a'), { code: 'VN_GAME_ACTIVE_MISMATCH' });
    g = complete(g, 'date-turn', '约会中确认的回复');
    g = reduce(g, 'select', { characterId: 'role-a', channel: 'talk' });
    assert.equal(g.active.eventId, ''); assert.equal(g.events[0].status, 'active');
    assert.equal(buildGameContext(g, 'role-a', 'talk').includes('约会中确认的回复'), true);
    assert.match(buildGameContext(g, 'role-a', 'talk'), /已发生事件，非当前频道发言/);
    assert.throws(() => reduce(g, 'start-date', { eventId: 'date-b' }), { code: 'VN_GAME_EVENT_INVALID' });
    g = reduce(g, 'start-date', { eventId: 'date-a' }); assert.equal(g.active.eventId, 'date-a');
    g = reduce(g, 'finish-date', { eventId: 'date-a' });
    assert.deepEqual(g.active, { characterId: 'role-a', channel: 'talk', eventId: '' }); assert.equal(g.events[0].status, 'completed');
    const nextContext = buildGameContext(g, 'role-a', 'stage');
    assert.match(nextContext, /已结束约会：去公园走走/); assert.match(nextContext, /约会中确认的回复/);
    assert.match(nextContext, /非当前频道发言/); assert.match(nextContext, /更早事件仍保留/);
    assert.equal(nextContext.includes('另一场约会'), false); // Planned, never occurred.
    assert.equal(buildGameContext(g, 'role-b', 'stage').includes('约会中确认的回复'), false);
    assert.equal(g.relationship, undefined); assert.equal(g.characters[0].affection, undefined);
    assert.throws(() => reduce(g, 'start-date', { eventId: 'date-a' }), { code: 'VN_GAME_EVENT_INVALID' });
});

test('context is bounded Unicode text, includes only current-domain completed turns and explicit memories, and stage format is separate from talk', () => {
    let g = complete(game(), 'role-a-stage', '甲角色阶段事实');
    g = reduce(g, 'select', { characterId: 'role-a', channel: 'talk' }); g = complete(g, 'role-a-talk', '甲角色私聊事实');
    g = reduce(g, 'select', { characterId: 'role-b', channel: 'talk' }); g = complete(g, 'role-b-talk', '乙角色秘密事实');
    const stage = buildGameContext(g, 'role-a', 'stage'), talk = buildGameContext(g, 'role-a', 'talk');
    assert.ok(stage.includes('甲角色阶段事实')); assert.equal(stage.includes('甲角色私聊事实'), false);
    assert.ok(talk.includes('甲角色私聊事实')); assert.equal(talk.includes('甲角色阶段事实'), false);
    assert.equal(stage.includes('乙角色秘密事实'), false); assert.equal(talk.includes('乙角色秘密事实'), false);
    assert.ok(stage.includes('[旁白]')); assert.ok(stage.includes('最多12项')); assert.equal(talk.includes('舞台输出格式'), false);
    g = reduce(g, 'update-world', { summary: '😀'.repeat(40000) });
    const limited = buildGameContext(g, 'role-a', 'stage'); assert.ok(limited.length <= 12000);
    assert.equal(/\ud800$|\ud83d$/.test(limited), false); assert.equal(g.world.summary.length, 80000);
});

test('unsafe prototypes, getters, unknown card fields and credential URLs fail closed before any storage', async () => {
    const h = harness(); let getterRan = false;
    const accessor = setup(); Object.defineProperty(accessor.player, 'name', { enumerable: true, get() { getterRan = true; return '不能执行'; } });
    const variants = [accessor, { ...setup(), player: Object.create({ name: '继承属性' }) }, { ...setup(), cardBody: '受保护卡正文不接收' },
        { ...setup(), world: { scene: '正常文本', summary: () => '脚本' } }, { ...setup(), credentials: { access_token: 'synthetic-not-a-secret' } }];
    for (const input of variants) await assert.rejects(h.store.create(owner, input));
    for (const avatar of ['javascript:alert(1)', 'https://user:synthetic@fixture.invalid/avatar.png', '/a.png?access_token=synthetic', '/a.png?auth=synthetic', '/token/synthetic/a.png']) {
        const input = setup(); input.characters[0].avatar = avatar; await assert.rejects(h.store.create(owner, input));
    }
    assert.equal(getterRan, false); assert.equal(h.indexedDB.openCount, 0);
    const ordinary = setup(); ordinary.world.summary = '故事中出现 password、token 和 API key 是普通文字。';
    await h.store.create(owner, ordinary); assert.equal((await h.store.get(owner, ordinary.id)).world.summary, ordinary.world.summary);
    h.store.close();
});

test('character/turn/UTF-8 body limits reject rather than truncating or recycling old story', () => {
    const many = setup(); many.characters = Array.from({ length: 13 }, (_, i) => role('role-' + i));
    assert.throws(() => createGame(many, { now: 1 }), { code: 'VN_GAME_CHARACTER_LIMIT' });
    const duplicate = setup(); duplicate.characters[1].conversationId = duplicate.characters[0].conversationId;
    assert.throws(() => createGame(duplicate), { code: 'VN_GAME_CHARACTER_DUPLICATE' });
    const oversized = setup(); oversized.world.summary = '汉'.repeat(1500000);
    assert.throws(() => createGame(oversized, { now: 1 }), { code: 'VN_GAME_TOO_LARGE' }); assert.equal(oversized.world.summary.length, 1500000);
    const maximum = game(), template = complete(game()).turns[0];
    maximum.turns = Array.from({ length: 5000 }, (_, i) => ({ ...template, id: 't-' + i, requestId: 'r-' + i, canonicalMessageId: 'canonical-' + i }));
    assert.throws(() => begin(maximum, 'one-too-many'), { code: 'VN_GAME_TURN_LIMIT' });
    assert.equal(maximum.turns.length, 5000);
});

test('owner identity remains complete; read/reopen and metadata-only listings are owner/game isolated', async () => {
    const h = harness(), longOwner = 'shared-prefix'.repeat(100) + '-first', otherOwner = 'shared-prefix'.repeat(100) + '-second';
    const input = setup('same-game-id'); delete input.owner;
    const creating = h.store.create(longOwner, input); input.characters[0].name = '晚到修改'; await creating;
    assert.equal((await h.store.get(longOwner, input.id)).owner, longOwner); assert.equal(await h.store.get(otherOwner, input.id), null);
    await h.store.create(otherOwner, { ...setup('same-game-id'), owner: otherOwner });
    h.indexedDB.trace.length = 0;
    const listed = await h.store.list(longOwner); assert.equal(listed.length, 1); assert.equal(listed[0].owner, longOwner);
    assert.equal(listed[0].characters[0].name, '合成向导'); assert.equal(listed[0].world.scene, '用户指定的书店'); assert.equal(listed[0].turnCount, 0);
    assert.equal(listed[0].turns, undefined); assert.equal(listed[0].memories, undefined); assert.equal(h.indexedDB.trace.some(r => r.store === BODY), false);
    h.store.close(); const reopened = harness({ indexedDB: h.indexedDB });
    const g = await reopened.store.get(longOwner, input.id); g.world.scene = '调用者修改';
    assert.equal((await reopened.store.get(longOwner, input.id)).world.scene, '用户指定的书店'); reopened.store.close();
});

test('commands resolve only at actual transaction commit and revision CAS serializes concurrent factories', async () => {
    const h = harness(); let g = await h.store.create(owner, setup());
    const gate = h.indexedDB.holdNextCommit('readwrite'); let completed = false;
    const pending = h.store.command(owner, g.id, { type: 'update-world', scene: '事务提交后地点' }, { expectedRevision: 0 }).then(value => { completed = true; return value; });
    await gate.reached; assert.equal(completed, false); assert.equal(h.indexedDB.dump(DB, BODY)[0].game.world.scene, '用户指定的书店'); gate.release(); g = await pending;
    const other = harness({ indexedDB: h.indexedDB });
    const results = await Promise.allSettled([h.store.command(owner, g.id, { type: 'update-world', scene: '并发甲' }, { expectedRevision: 1 }),
        other.store.command(owner, g.id, { type: 'update-world', scene: '并发乙' }, { expectedRevision: 1 })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'VN_GAME_REVISION_CONFLICT');
    assert.equal((await h.store.get(owner, g.id)).revision, 2);
    await assert.rejects(h.store.command(owner, g.id, { type: 'update-world', scene: '无版本' }), { code: 'VN_GAME_REVISION_REQUIRED' });
    h.store.close(); other.store.close();
});

test('checkpoint restore backs up current local branch atomically, preserves canonical IDs, increases revision and excludes later context', async () => {
    const h = harness(); let g = await h.store.create(owner, setup());
    const cmd = async c => { g = await h.store.command(owner, g.id, c, { expectedRevision: g.revision }); return g; };
    await cmd({ type: 'begin-turn', requestId: 'past', ...g.active, userText: '已存档输入' });
    await cmd({ type: 'finish-turn', requestId: 'past', reply: '已存档正文', canonicalMessageId: 'canonical-past' });
    const slot = await h.store.checkpoint(owner, g.id, '分支起点');
    await cmd({ type: 'begin-turn', requestId: 'future', ...g.active, userText: '之后输入' });
    await cmd({ type: 'finish-turn', requestId: 'future', reply: '不能污染恢复分支的后续正文', canonicalMessageId: 'canonical-future' });
    const before = structuredClone(g), restoringRevision = g.revision;
    g = await h.store.restore(owner, g.id, slot.id, { expectedRevision: restoringRevision });
    assert.equal(g.revision, restoringRevision + 1); assert.equal(g.turns.length, 1); assert.equal(g.turns[0].canonicalMessageId, 'canonical-past');
    assert.equal(buildGameContext(g, 'role-a', 'stage').includes('不能污染恢复'), false);
    const checkpoints = await h.store.listCheckpoints(owner, g.id), backup = checkpoints.find(r => r.automatic);
    assert.equal(checkpoints.length, 2); assert.equal(backup.label, '恢复前自动备份');
    assert.deepEqual(h.indexedDB.dump(DB, CP).find(r => r.id === backup.id).game, before);
    assert.equal(h.indexedDB.dump(DB, CP).find(r => r.id === backup.id).game.turns[1].canonicalMessageId, 'canonical-future');
    assert.equal(checkpoints.every(r => !r.game && !r.turns), true);
    assert.equal((await h.store.listCheckpoints('other-owner', g.id)).length, 0);
    await assert.rejects(h.store.restore('other-owner', g.id, slot.id, { expectedRevision: 0 }), { code: 'VN_GAME_MISSING' });
    assert.ok(h.indexedDB.trace.filter(r => r.event === 'transaction').every(r => r.stores.every(s => [BODY, INDEX, CP, CPI].includes(s))));
    h.store.close();
});

test('restoring a pending checkpoint marks it uncertain and never restarts or binds a late reply', async () => {
    const h = harness(); let g = await h.store.create(owner, setup());
    g = await h.store.command(owner, g.id, { type: 'begin-turn', requestId: 'pending-save', ...g.active, userText: '曾请求但未确认' }, { expectedRevision: g.revision });
    const checkpoint = await h.store.checkpoint(owner, g.id, '未完成分支');
    g = await h.store.command(owner, g.id, { type: 'fail-turn', requestId: 'pending-save', status: 'interrupted', error: '停止' }, { expectedRevision: g.revision });
    g = await h.store.restore(owner, g.id, checkpoint.id, { expectedRevision: g.revision });
    assert.equal(g.turns[0].status, 'uncertain'); assert.equal(g.turns[0].canonicalMessageId, '');
    await assert.rejects(h.store.command(owner, g.id, { type: 'finish-turn', requestId: 'pending-save', reply: '晚到回复', canonicalMessageId: 'canonical-late' },
        { expectedRevision: g.revision }), { code: 'VN_GAME_REQUEST_INVALID' });
    h.store.close();
});

test('checkpoint limits require explicit deletion; full-capacity restore does not silently discard a backup or mutate game', async () => {
    const h = harness(), g = await h.store.create(owner, setup());
    for (let i = 0; i < 12; i++) await h.store.checkpoint(owner, g.id, '存档-' + i);
    const slots = await h.store.listCheckpoints(owner, g.id);
    await assert.rejects(h.store.checkpoint(owner, g.id, '不能覆盖'), { code: 'VN_GAME_CHECKPOINT_LIMIT' });
    await assert.rejects(h.store.restore(owner, g.id, slots[0].id, { expectedRevision: 0 }), { code: 'VN_GAME_CHECKPOINT_LIMIT' });
    assert.deepEqual(await h.store.get(owner, g.id), g); assert.equal(h.indexedDB.dump(DB, CP).length, 12);
    assert.equal(await h.store.deleteCheckpoint('different-owner', g.id, slots[0].id), false);
    assert.equal(await h.store.deleteCheckpoint(owner, g.id, slots[1].id), true); assert.equal(await h.store.deleteCheckpoint(owner, g.id, slots[1].id), false);
    assert.equal((await h.store.restore(owner, g.id, slots[0].id, { expectedRevision: 0 })).revision, 1);
    assert.equal(h.indexedDB.dump(DB, CP).length, 12); assert.equal(h.indexedDB.dump(DB, CPI).length, 12); h.store.close();
});

test('quota/partial restore failures roll back current game and both checkpoint stores; unavailable storage cannot succeed in memory', async () => {
    for (const options of [{ indexedDB: null }, { indexedDB: { open() { throw new Error('synthetic failure'); } } }]) {
        const h = harness(options); await assert.rejects(h.store.create(owner, setup()), { code: 'VN_GAME_STORE_UNAVAILABLE' }); h.store.close();
    }
    const h = harness(); const g = await h.store.create(owner, setup()); const slot = await h.store.checkpoint(owner, g.id, '原存档');
    const database = h.indexedDB.database(DB), nativeTx = database.transaction.bind(database);
    database.transaction = (...args) => {
        const tx = nativeTx(...args), nativeStore = tx.objectStore.bind(tx);
        tx.objectStore = name => { const store = nativeStore(name); if (name === CP) {
            const put = store.put.bind(store); store.put = row => { const request = put(row); request.onsuccess = () => { h.indexedDB.failNextPut = true; }; return request; };
        } return store; }; return tx;
    };
    await assert.rejects(h.store.restore(owner, g.id, slot.id, { expectedRevision: 0 }), { code: 'VN_GAME_WRITE_FAILED' });
    database.transaction = nativeTx;
    assert.deepEqual(await h.store.get(owner, g.id), g); assert.equal(h.indexedDB.dump(DB, CP).length, 1); assert.equal(h.indexedDB.dump(DB, CPI).length, 1);
    h.indexedDB.failNextPut = true; await assert.rejects(h.store.command(owner, g.id, { type: 'update-world', scene: '不能半保存' }, { expectedRevision: 0 }), { code: 'VN_GAME_WRITE_FAILED' });
    assert.deepEqual(await h.store.get(owner, g.id), g); h.store.close();
});

test('current-owner/epoch guards and close fence late results and abort pending transactions', async () => {
    let current = true; const h = harness({ isCurrent: supplied => current && supplied === owner });
    current = false; await assert.rejects(h.store.create(owner, setup()), { code: 'VN_GAME_CANCELLED' }); assert.equal(h.indexedDB.openCount, 0);
    current = true; await h.store.create(owner, setup());
    const gate = h.indexedDB.holdNextCommit('readwrite');
    const pending = h.store.command(owner, 'game-1', { type: 'update-world', scene: '退出后的迟到写入' }, { expectedRevision: 0 });
    const rejected = assert.rejects(pending); await gate.reached; current = false; h.store.close(); gate.release(); await rejected;
    assert.equal(h.indexedDB.dump(DB, BODY)[0].game.world.scene, '用户指定的书店');
    await assert.rejects(h.store.get(owner, 'game-1')); assert.equal(h.indexedDB.dump(DB, BODY).length, 1);
});

test('actual Chromium IndexedDB verifies durable reopen, cross-owner isolation, native concurrent CAS and atomic restore', async t => {
    const runtime = 'C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1007-641-0_26.1007.641.0_x64__3k8sg7r9htsxt/dependencies/node/node_modules/playwright';
    const executablePath = 'C:/Users/ROG/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
    const python = 'C:/Program Files/python/python.exe';
    let chromium; try { ({ chromium } = createRequire(import.meta.url)(runtime)); } catch { t.skip('Bundled Playwright unavailable; transaction-double tests are not real IDB evidence'); return; }
    if (!existsSync(executablePath) || !existsSync(python)) { t.skip('Local browser/server unavailable; no real IDB claim'); return; }
    const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(python, ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', fileURLToPath(new URL('../../frontend', import.meta.url))],
        { windowsHide: true, stdio: 'ignore' });
    let browser;
    try {
        for (let attempt = 0; ; attempt++) {
            try { if ((await fetch(base + '/app/assets/js/visual-novel-game-store.mjs')).ok) break; } catch {}
            if (attempt >= 30) throw new Error('Own synthetic server did not start'); await new Promise(resolve => setTimeout(resolve, 100));
        }
        browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage();
        const failures = []; page.on('pageerror', e => failures.push(e.message)); page.on('requestfailed', r => failures.push(r.failure()?.errorText));
        page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
        await page.route(base + '/store-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic game store only</title>' }));
        await page.route(base + '/favicon.ico', route => route.fulfill({ status: 204, body: '' })); await page.goto(base + '/store-fixture');
        const result = await page.evaluate(async input => {
            const { createGameStore, buildGameContext } = await import('/app/assets/js/visual-novel-game-store.mjs');
            let serial = 0; const options = { now: () => 100, makeId: () => 'native-slot-' + (++serial) };
            const first = createGameStore(options); let g = await first.create(input.owner, input);
            g = await first.command(input.owner, g.id, { type: 'begin-turn', requestId: 'native-before', ...g.active, userText: '原输入' }, { expectedRevision: g.revision });
            g = await first.command(input.owner, g.id, { type: 'finish-turn', requestId: 'native-before', reply: '恢复前保留的正文', canonicalMessageId: 'native-canonical-before' }, { expectedRevision: g.revision });
            const cp = await first.checkpoint(input.owner, g.id, '原生存档'); first.close();
            const second = createGameStore(options), concurrent = createGameStore(options); g = await second.get(input.owner, input.id);
            const attempts = await Promise.allSettled([second.command(input.owner, input.id, { type: 'update-world', scene: 'native-A' }, { expectedRevision: g.revision }),
                concurrent.command(input.owner, input.id, { type: 'update-world', scene: 'native-B' }, { expectedRevision: g.revision })]);
            g = await second.get(input.owner, input.id);
            g = await second.command(input.owner, g.id, { type: 'begin-turn', requestId: 'native-later', ...g.active, userText: '未来输入' }, { expectedRevision: g.revision });
            g = await second.command(input.owner, g.id, { type: 'finish-turn', requestId: 'native-later', reply: '恢复后不可出现的未来剧情', canonicalMessageId: 'native-canonical-future' }, { expectedRevision: g.revision });
            const beforeRevision = g.revision; g = await second.restore(input.owner, input.id, cp.id, { expectedRevision: g.revision });
            const rows = await second.list(input.owner), checkpoints = await second.listCheckpoints(input.owner, input.id);
            const other = await second.get(input.owner + '-different', input.id);
            const context = buildGameContext(g, g.active.characterId, 'stage'); second.close(); concurrent.close();
            const reopened = createGameStore(options); const persisted = await reopened.get(input.owner, input.id); reopened.close();
            return { failures: attempts.filter(v => v.status === 'rejected').map(v => v.reason.code), successes: attempts.filter(v => v.status === 'fulfilled').length,
                beforeRevision, revision: persisted.revision, canonical: persisted.turns[0].canonicalMessageId, turnCount: persisted.turns.length,
                futureInContext: context.includes('恢复后不可出现'), backups: checkpoints.filter(c => c.automatic).length, checkpointCount: checkpoints.length,
                other, summary: { characters: rows[0].characters.length, world: rows[0].world.scene, turnCount: rows[0].turnCount, body: rows[0].turns } };
        }, setup());
        assert.deepEqual(result.failures, ['VN_GAME_REVISION_CONFLICT']); assert.equal(result.successes, 1);
        assert.equal(result.revision, result.beforeRevision + 1); assert.equal(result.canonical, 'native-canonical-before'); assert.equal(result.turnCount, 1);
        assert.equal(result.futureInContext, false); assert.equal(result.backups, 1); assert.equal(result.checkpointCount, 2); assert.equal(result.other, null);
        assert.equal(result.summary.characters, 2); assert.equal(result.summary.turnCount, 1); assert.equal(result.summary.body, undefined); assert.deepEqual(failures, []);
    } finally { await browser?.close(); server.kill(); }
});
