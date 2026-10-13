import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStore } from '../../frontend/app/assets/js/visual-novel-story-store.mjs';
import { buildTimeline, anchorFor, scopeKey } from '../../frontend/app/assets/js/visual-novel-core.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const DB_NAME = 'homer-vn-story-checkpoints', BODY = 'story_checkpoints', INDEX = 'story_checkpoint_index';
const scope = { owner: 'story-test-owner', appId: 'story-test-card', conversationId: 'story-test-conversation' };
const messages = () => [{ name: '向导', is_user: false, mes: '一段完整剧情', swipes: ['一段完整剧情', '另一个候选'], swipe_id: 0,
    swipe_info: [{ extra: { emotion: 'happy' } }, { extra: { emotion: 'sad' } }],
    extra: { homer_sync_id: 'local-1', homer_message_id: 'cloud-1', token_count: 12, custom: { inventory: ['钥匙'], reasoning: '普通思考文本' } } },
    { name: '玩家', is_user: true, mes: '我选择继续。', extra: { homer_sync_id: 'local-2' } }];
const checkpoint = (id = 'slot-1') => { const full = messages(); return { id, name: '完整剧情测试', messages: full,
    metadata: { scenario: '合成场景', homer_model_settings: { temperature: 0.8 } }, variables: { affection: 7, inventory: ['钥匙'] },
    extensionSettings: { story: { enabled: true, description: '剧情里可以说 password、Bearer 和 API key。这是普通正文。' } },
    cursor: anchorFor(buildTimeline(full)[0]), createdAt: 100 }; };

test('complete ST messages, swipes, aliases and story state survive defensive copy and reopen', async () => {
    const indexedDB = cardTransportIDB(), store = createStoryStore({ indexedDB });
    const input = checkpoint(); input.messages[0].mes += '长'.repeat(12000);
    input.messages[0].swipes[0] = input.messages[0].mes;
    const expected = structuredClone(input);
    const saving = store.save(scope, input);
    input.messages[0].mes = '调用者随后修改'; input.variables.affection = 999;
    const summary = await saving;
    assert.equal(summary.messageCount, 2);
    assert.ok(summary.sizeBytes > 12000);
    assert.equal(summary.messages, undefined);
    store.close();
    const reopened = createStoryStore({ indexedDB });
    const result = await reopened.get(scope, expected.id);
    for (const key of ['messages', 'metadata', 'variables', 'extensionSettings', 'cursor']) assert.deepEqual(result[key], expected[key]);
    assert.equal(result.messages[0].extra.token_count, 12);
    result.messages[0].swipes[1] = '不能污染持久化候选'; result.variables.affection = -1;
    assert.deepEqual((await reopened.get(scope, expected.id)).messages, expected.messages);
    assert.deepEqual((await reopened.get(scope, expected.id)).variables, expected.variables);
    reopened.close();
});

test('listing returns scoped summaries and never reads complete message bodies', async () => {
    const indexedDB = cardTransportIDB(), store = createStoryStore({ indexedDB });
    await store.save(scope, checkpoint('older'));
    await store.save(scope, { ...checkpoint('newer'), createdAt: 200 });
    indexedDB.trace.length = 0;
    const listed = await store.list(scope);
    assert.deepEqual(listed.map(row => row.id), ['newer', 'older']);
    assert.ok(listed.every(row => Object.keys(row).sort().join(',') === 'createdAt,id,messageCount,name,sizeBytes,version'));
    assert.ok(!indexedDB.trace.some(row => row.store === BODY));
    for (const other of [{ ...scope, owner: 'other-owner' }, { ...scope, appId: 'other-card' }, { ...scope, conversationId: 'other-conversation' }]) {
        assert.deepEqual(await store.list(other), []);
        assert.equal(await store.get(other, 'older'), null);
        assert.equal(await store.delete(other, 'older'), false);
    }
    store.close();
});

test('nested credentials/internal scope fields are rejected without inspecting ordinary story words', async () => {
    const indexedDB = cardTransportIDB(), store = createStoryStore({ indexedDB });
    for (const field of ['api_key', 'AccessToken', 'refresh-token', 'sessionToken', 'authorization', 'Cookie', 'private_key', 'password', 'headers', 'additional_headers', 'homer_bridge', 'homer_bridge_backup', '密码']) {
        const input = checkpoint(); input.variables.nested = { [field]: 'synthetic-forbidden-value' };
        await assert.rejects(store.save(scope, input), error => error.code === 'VN_STORY_FORBIDDEN_FIELD' && !error.message.includes('synthetic-forbidden-value'));
    }
    const input = checkpoint(); input.messages[0].mes = '她说：密码 password、token 和 bearer 都只是这段剧情的词语。';
    await store.save(scope, input);
    assert.equal((await store.get(scope, input.id)).messages[0].mes, input.messages[0].mes);
    const tokenString = checkpoint('bad-counter'); tokenString.messages[0].extra.token_count = 'synthetic-not-a-counter';
    await assert.rejects(store.save(scope, tokenString), { code: 'VN_STORY_FORBIDDEN_FIELD' });
    const settings = checkpoint('ordinary-token-settings');
    settings.extensionSettings.STMemoryBooks = { moduleSettings: { maxTokens: 0, tokenWarningThreshold: 50000 } };
    settings.extensionSettings.ordinary = { max_tokens: 2048, max_completion_tokens: 1024,
        show_token_count: true, message_token_count_enabled: false };
    await store.save(scope, settings);
    assert.deepEqual((await store.get(scope, settings.id)).extensionSettings, settings.extensionSettings);
    for (const value of ['synthetic-not-budget', { access_token: 'synthetic' }, -1, Infinity, true]) {
        const invalid = checkpoint('bad-token-setting'); invalid.extensionSettings.maxTokens = value;
        await assert.rejects(store.save(scope, invalid), { code: 'VN_STORY_FORBIDDEN_FIELD' });
    }
    store.close();
});

test('size accounting matches UTF-8 JSON, including controls, emoji and undefined ordinary fields', async () => {
    const indexedDB = cardTransportIDB(), store = createStoryStore({ indexedDB });
    const input = checkpoint();
    input.messages[0].mes = '汉字😀\n\t\b\f\r\u0000"\\\ud800\udc00\ud800';
    input.messages[0].extra.ordinary_missing = undefined;
    input.variables.sparse = new Array(2); input.variables.sparse[1] = '保留形状';
    await store.save(scope, input);
    const { sizeBytes, messageCount, ...body } = await store.get(scope, input.id);
    assert.equal(sizeBytes, Buffer.byteLength(JSON.stringify(body, (_key, value) => value === undefined ? null : value), 'utf8'));
    assert.equal(messageCount, 2);
    assert.ok(Object.hasOwn(body.messages[0].extra, 'ordinary_missing'));
    assert.equal(body.variables.sparse.length, 2); assert.equal(Object.hasOwn(body.variables.sparse, 0), false);
    const missingMessage = checkpoint('invalid-hole'); missingMessage.messages = new Array(1);
    await assert.rejects(store.save(scope, missingMessage), { code: 'VN_STORY_INVALID' });
    store.close();
});

test('prototypes, accessors, executable values, cycles and pollution keys fail before database work', async () => {
    const indexedDB = cardTransportIDB(), store = createStoryStore({ indexedDB });
    let getterRan = false;
    const inputs = [];
    const accessor = checkpoint(); Object.defineProperty(accessor.variables, 'ordinary', { enumerable: true, get() { getterRan = true; return 'bad'; } }); inputs.push(accessor);
    const fn = checkpoint(); fn.extensionSettings.callback = () => {}; inputs.push(fn);
    const cycle = checkpoint(); cycle.variables.self = cycle.variables; inputs.push(cycle);
    const custom = checkpoint(); custom.variables = Object.create({ inherited: true }); inputs.push(custom);
    const date = checkpoint(); date.metadata.timestamp = new Date(); inputs.push(date);
    const symbol = checkpoint(); symbol.variables[Symbol('private')] = 'bad'; inputs.push(symbol);
    for (const value of inputs) await assert.rejects(store.save(scope, value), { code: 'VN_STORY_UNSAFE_VALUE' });
    const pollution = checkpoint(); pollution.variables = JSON.parse('{"__proto__":{"polluted":true}}');
    await assert.rejects(store.save(scope, pollution), { code: 'VN_STORY_FORBIDDEN_FIELD' });
    assert.equal(getterRan, false);
    assert.equal(indexedDB.openCount, 0);
    assert.equal({}.polluted, undefined);
});

test('save acknowledges only transaction commit; index failure rolls back a previously staged full body', async () => {
    const indexedDB = cardTransportIDB(), store = createStoryStore({ indexedDB });
    await store.list(scope);
    const gate = indexedDB.holdNextCommit('readwrite'); let completed = false;
    const saving = store.save(scope, checkpoint()).then(value => { completed = true; return value; });
    await gate.reached;
    assert.equal(completed, false); assert.equal(indexedDB.dump(DB_NAME, BODY).length, 0); assert.equal(indexedDB.dump(DB_NAME, INDEX).length, 0);
    gate.release(); await saving;
    const original = await store.get(scope, 'slot-1');
    const database = indexedDB.database(DB_NAME), transaction = database.transaction.bind(database);
    database.transaction = (...args) => {
        const tx = transaction(...args), objectStore = tx.objectStore.bind(tx);
        tx.objectStore = name => {
            const result = objectStore(name);
            if (name === BODY) {
                const put = result.put.bind(result);
                result.put = row => { const request = put(row); request.onsuccess = () => { indexedDB.failNextPut = true; }; return request; };
            }
            return result;
        };
        return tx;
    };
    const replacement = checkpoint(); replacement.messages[0].mes = '这个替换不能在半写入后留下';
    await assert.rejects(store.save(scope, replacement), { code: 'VN_STORY_WRITE_FAILED' });
    database.transaction = transaction;
    assert.deepEqual(await store.get(scope, 'slot-1'), original);
    assert.equal(indexedDB.dump(DB_NAME, BODY).length, 1); assert.equal(indexedDB.dump(DB_NAME, INDEX).length, 1);
    store.close();
});

test('scope capacity is 24 with overwrite allowed; deletion removes body and index atomically', async () => {
    const indexedDB = cardTransportIDB(), store = createStoryStore({ indexedDB });
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => store.save(scope, checkpoint(`slot-${index}`))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 24);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VN_STORY_LIMIT');
    await store.save(scope, { ...checkpoint('slot-0'), name: '覆盖同一快照' });
    assert.equal((await store.get(scope, 'slot-0')).name, '覆盖同一快照');
    assert.equal(await store.delete(scope, 'slot-0'), true); assert.equal(await store.delete(scope, 'slot-0'), false);
    assert.equal(await store.get(scope, 'slot-0'), null);
    assert.equal((await store.list(scope)).length, 23);
    assert.equal(indexedDB.dump(DB_NAME, BODY).length, 23); assert.equal(indexedDB.dump(DB_NAME, INDEX).length, 23);
    store.close();
});

test('32 MiB checkpoint limit rejects before open; owner budget includes other conversations but not other owners', async () => {
    const oversizedFactory = cardTransportIDB(), oversizedStore = createStoryStore({ indexedDB: oversizedFactory });
    const oversized = checkpoint(); oversized.messages[0].mes = 'x'.repeat(32 * 1024 * 1024);
    await assert.rejects(oversizedStore.save(scope, oversized), { code: 'VN_STORY_TOO_LARGE' });
    assert.equal(oversizedFactory.openCount, 0); oversizedStore.close();
    const indexedDB = cardTransportIDB(), store = createStoryStore({ indexedDB }); await store.list(scope);
    for (let index = 0; index < 8; index++) {
        const other = { ...scope, conversationId: `budget-conversation-${index}` }, scopedKey = `story:${scopeKey(other)}`;
        const key = `${scopedKey}:checkpoint:${JSON.stringify(`budget-${index}`)}`;
        // Inject metadata-only size counters; avoid allocating 256 MiB fixtures.
        indexedDB.seed(DB_NAME, INDEX, key, { key, version: 1, owner: scope.owner, scopeKey: scopedKey,
            id: `budget-${index}`, name: '合成容量计数', createdAt: index, messageCount: 1, sizeBytes: 32 * 1024 * 1024 });
    }
    await assert.rejects(store.save(scope, checkpoint()), { code: 'VN_STORY_OWNER_BUDGET' });
    assert.equal(indexedDB.dump(DB_NAME, BODY).length, 0);
    await store.save({ ...scope, owner: 'different-owner' }, checkpoint());
    assert.equal(indexedDB.dump(DB_NAME, BODY).length, 1);
    await store.save({ ...scope, conversationId: 'budget-conversation-0' }, checkpoint('budget-0'));
    await store.save(scope, checkpoint());
    assert.equal((await store.list(scope)).length, 1);
    await store.delete({ ...scope, conversationId: 'budget-conversation-0' }, 'budget-0');
    await store.save(scope, checkpoint());
    assert.equal((await store.list(scope)).length, 1);
    store.close();
});

test('missing/blocked/closed/corrupt storage fails closed and older durability options still commit to IDB', async () => {
    const absent = createStoryStore({ indexedDB: null });
    await assert.rejects(absent.save(scope, checkpoint()), { code: 'VN_STORY_STORE_UNAVAILABLE' });
    const blocked = cardTransportIDB(); blocked.blockNextOpen = true;
    await assert.rejects(createStoryStore({ indexedDB: blocked }).list(scope), { code: 'VN_STORY_STORE_BLOCKED' });
    const indexedDB = cardTransportIDB(); indexedDB.strictUnsupported = true;
    const store = createStoryStore({ indexedDB });
    await assert.rejects(store.list({}), { code: 'VN_SCOPE_REQUIRED' }); assert.equal(indexedDB.openCount, 0);
    await store.save(scope, checkpoint());
    const row = indexedDB.dump(DB_NAME, BODY)[0];
    indexedDB.seed(DB_NAME, BODY, row.key, { ...row, owner: 'wrong-owner' });
    await assert.rejects(store.get(scope, 'slot-1'), { code: 'VN_STORY_CORRUPT' });
    const summary = indexedDB.dump(DB_NAME, INDEX)[0];
    indexedDB.seed(DB_NAME, INDEX, summary.key, { ...summary, sizeBytes: -1 });
    await assert.rejects(store.list(scope), { code: 'VN_STORY_CORRUPT' });
    indexedDB.database(DB_NAME).stores.delete(BODY);
    await assert.rejects(store.get(scope, 'slot-1'), { code: 'VN_STORY_STORE_UNAVAILABLE' });
    store.close();
    await assert.rejects(store.list(scope), { code: 'VN_STORY_STORE_CLOSED' });
});
