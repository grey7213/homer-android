import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSessionStore } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-local-session.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const scope = (owner = 'owner-a', app = 'card-a', conversation = 'conversation-a') => JSON.stringify([owner, app, conversation]);
const session = ({ owner = 'owner-a', app = 'card-a', conversation = 'conversation-a', text = 'Complete cloud message', count = 1 } = {}) => ({
    user: { id: owner, name: 'Display user', username: 'display-user' },
    launch: { app_id: app, conversation_id: conversation, title: 'Archived conversation',
        app: { id: app, name: 'Test character', icon: '/character.png' },
        card: { spec: 'chara_card_v2', data: { name: 'Test character', description: '<script>const secret = "auth_token";</script>',
            character_book: { entries: [{ keys: ['character'], content: 'Complete book content' }] },
            extensions: { regex_scripts: [{ id: 'card-regex', findRegex: '(secret|token)', replaceString: '$1' }],
                tavern_helper: { scripts: [{ id: 'card-script', content: 'const bridge_token = "card-authored text";' }] } } } },
        messages: Array.from({ length: count }, (_, index) => ({ id: `message-${index}`, role: 'assistant', content: `${text} ${index}`,
            created_at: index + 1, swipes: ['first swipe', 'second swipe'], swipe_index: 1 })),
        storage: { protocol: 2, complete: true, message_count: count, version: 'a'.repeat(32) } },
});
const fixture = () => {
    const indexedDB = transactionIDB(), databaseName = 'r354-local-session';
    return { indexedDB, databaseName, archive: createLocalSessionStore({ indexedDB, databaseName }) };
};

test('full launch and card remain durable across factory restart without truncation', async () => {
    const { archive, indexedDB, databaseName } = fixture();
    const payload = session({ count: 1101, text: 'Long complete message '.repeat(20) });
    await archive.remember('owner-a', payload);
    await archive.rememberResource(scope(), 'runtime-state', { variables: { model_id: 'model-a', nested: { book: { full: true } } }, extension_settings: { memory: ['all', 'data'] } });
    await archive.close();
    const restarted = createLocalSessionStore({ indexedDB, databaseName });
    assert.deepEqual(await restarted.read('owner-a', 'card-a', 'conversation-a'), payload);
    assert.equal((await restarted.read('owner-a', 'card-a', 'conversation-a')).launch.messages.length, 1101);
    assert.deepEqual(await restarted.resource(scope(), 'runtime-state'), { variables: { model_id: 'model-a', nested: { book: { full: true } } }, extension_settings: { memory: ['all', 'data'] } });
});

test('remember resolves at transaction completion rather than request success', async () => {
    const { archive, indexedDB, databaseName } = fixture(), gate = indexedDB.holdNextCommit();
    let settled = false;
    const remembering = archive.remember('owner-a', session()).then(value => { settled = true; return value; });
    await gate.reached;
    assert.equal(settled, false);
    assert.ok(indexedDB.trace.includes('request-success'));
    assert.equal(indexedDB.dump(databaseName).length, 0);
    gate.release(); await remembering;
    assert.equal(indexedDB.trace.at(-1), 'transaction-complete');
    assert.equal(indexedDB.dump(databaseName).length, 1);
});

test('resource writes also wait for durable completion', async () => {
    const { archive, indexedDB, databaseName } = fixture(), gate = indexedDB.holdNextCommit();
    let settled = false;
    const remembering = archive.rememberResource(scope(), 'models', { list: [{ id: 'model-a' }] }).then(() => { settled = true; });
    await gate.reached;
    assert.equal(settled, false); assert.equal(indexedDB.dump(databaseName).length, 0);
    gate.release(); await remembering;
    assert.equal(indexedDB.dump(databaseName).length, 1);
});

test('sessions capture an immutable clone before opening storage and return independent clones', async () => {
    const { archive } = fixture(), original = session(), expected = session();
    const remembering = archive.remember('owner-a', original);
    original.launch.messages[0].content = 'Mutated before storage';
    original.launch.card.data.character_book.entries[0].content = 'Mutated book';
    original.user.name = 'Mutated user';
    const saved = await remembering;
    assert.deepEqual(saved, expected);
    saved.launch.card.data.name = 'Mutated return';
    const firstRead = await archive.read('owner-a', 'card-a', 'conversation-a');
    firstRead.launch.messages[0].content = 'Mutated read';
    assert.deepEqual(await archive.read('owner-a', 'card-a', 'conversation-a'), expected);
});

test('resource capture and reads are independent JSON clones', async () => {
    const { archive } = fixture(), original = { variables: { model_id: 'model-a', nested: { values: [1, 2, 3] } } };
    const remembering = archive.rememberResource(scope(), 'runtime-state', original);
    original.variables.nested.values.push(4);
    const returned = await remembering; returned.variables.nested.values.push(5);
    const read = await archive.resource(scope(), 'runtime-state'); read.variables.model_id = 'mutated';
    assert.deepEqual(await archive.resource(scope(), 'runtime-state'), { variables: { model_id: 'model-a', nested: { values: [1, 2, 3] } } });
});

test('later remote history cannot replace an established phone-owned archive', async () => {
    const { archive, indexedDB, databaseName } = fixture(), first = session({ text: 'First archive' });
    await archive.remember('owner-a', first);
    const remote = session({ text: 'Newer remote', count: 3 }); remote.launch.storage.version = 'b'.repeat(32);
    assert.deepEqual(await archive.remember('owner-a', remote), first);
    assert.deepEqual(await archive.read('owner-a', 'card-a', 'conversation-a'), first);
    assert.equal(indexedDB.dump(databaseName).length, 1);
});

test('concurrent remote completions retain the first archive atomically', async () => {
    const { archive } = fixture(), first = session({ text: 'First full launch' }), second = session({ text: 'Delayed full launch' });
    await Promise.all([archive.remember('owner-a', first), archive.remember('owner-a', second)]);
    assert.deepEqual(await archive.read('owner-a', 'card-a', 'conversation-a'), first);
});

test('account, app and conversation are separate exact storage identities', async () => {
    const { archive } = fixture();
    const variants = [session(), session({ owner: 'owner-b', text: 'Other account' }), session({ app: 'card-b', text: 'Other card' }), session({ conversation: 'conversation-b', text: 'Other conversation' })];
    for (const payload of variants) await archive.remember(payload.user.id, payload);
    for (const payload of variants) assert.deepEqual(await archive.read(payload.user.id, payload.launch.app_id, payload.launch.conversation_id), payload);
    assert.equal(await archive.read('missing-owner', 'card-a', 'conversation-a'), null);
    assert.equal(await archive.read('owner-a', 'missing-card', 'conversation-a'), null);
    assert.equal(await archive.read('owner-a', 'card-a', 'missing-conversation'), null);
    assert.equal((await archive.list('owner-a')).length, 3);
    assert.equal((await archive.list('owner-b')).length, 1);
});

test('invalid or conflicting account and launch identities cannot be archived', async () => {
    const { archive, indexedDB, databaseName } = fixture();
    await assert.rejects(archive.remember('owner-b', session()), /account/);
    const conflicting = session(); conflicting.user.user_id = 'owner-b';
    await assert.rejects(archive.remember('owner-a', conflicting), /account/);
    const invalidOwnerType = session(); invalidOwnerType.user.id = ['owner-a'];
    await assert.rejects(archive.remember('owner-a', invalidOwnerType), /account/);
    for (const field of ['app_id', 'conversation_id']) {
        const invalid = session(); invalid.launch[field] = '';
        await assert.rejects(archive.remember('owner-a', invalid), /Invalid/);
    }
    for (const owner of ['', null, ' '.repeat(4), 'a'.repeat(161)]) await assert.rejects(archive.remember(owner, session()), /Invalid/);
    assert.equal(indexedDB.dump(databaseName).length, 0);
});

test('empty complete conversations are valid but partial, conditional and preview launches are rejected', async () => {
    const { archive } = fixture(), empty = session({ count: 0 });
    assert.deepEqual(await archive.remember('owner-a', empty), empty);
    const mutations = [payload => { payload.launch.storage.message_count = 2; }, payload => { payload.launch.storage.complete = false; },
        payload => { payload.launch.storage.unchanged = true; }, payload => { payload.launch.storage.version = 'invalid'; },
        payload => { payload.launch.storage.protocol = 1; }, payload => { payload.launch.messages = null; },
        payload => { payload.launch.messages = ['invalid']; }, payload => { delete payload.launch.card; },
        payload => { payload.launch.admin_preview = true; }];
    for (const mutate of mutations) { const payload = session(); mutate(payload); await assert.rejects(archive.remember('owner-a', payload), /full|complete/); }
    assert.deepEqual(await archive.read('owner-a', 'card-a', 'conversation-a'), empty);
});

test('recursive credentials and offline account authority are removed while authored content remains intact', async () => {
    const { archive, indexedDB, databaseName } = fixture(), payload = session();
    const credential = 'credential-sentinel';
    payload.user.is_admin = true; payload.user.isAdmin = true; payload.user.role = 'administrator'; payload.user.permissions = ['manage-accounts'];
    payload.user.password = credential; payload.user.email = 'private-fixture@example.invalid';
    payload.launch.bridge_token = credential; payload.auth_token = credential; payload.csrf_token = credential;
    payload.launch.config = { model_id: 'preserved-model', max_tokens: 4096, token_count: 9, modelId: 'preserved-model',
        headers: { Authorization: credential, 'X-CSRF-Token': credential, Accept: 'application/json' },
        nested: [{ apiKey: credential, openai_api_key: credential, secret_access_key: credential, refreshToken: credential,
            access_key_id: credential, client_secret: credential, jwt: credential, cookies: credential, public_text: 'All public text' }] };
    const originalCard = structuredClone(payload.launch.card);
    await archive.remember('owner-a', payload);
    const saved = await archive.read('owner-a', 'card-a', 'conversation-a');
    assert.deepEqual(saved.user, { id: 'owner-a', name: 'Display user', username: 'display-user' });
    assert.deepEqual(saved.launch.card, originalCard);
    assert.deepEqual(saved.launch.config, { model_id: 'preserved-model', max_tokens: 4096, token_count: 9, modelId: 'preserved-model',
        nested: [{ public_text: 'All public text' }] });
    assert.equal('headers' in saved.launch.config, false);
    assert.equal(JSON.stringify(indexedDB.dump(databaseName)).includes(credential), false);
    assert.equal(JSON.stringify(saved).includes('is_admin'), false);
});

test('models and per-model regex resources remain separate and runtime variables retain full safe values', async () => {
    const { archive, indexedDB, databaseName } = fixture(), values = { variables: { model_id: 'one', budget: 123, nested: { items: ['all', 'values'], api_key: 'resource-sentinel' } },
        extension_settings: { memory: { book: 'Full runtime state' } }, app_id: 'card-a', conversation_id: 'conversation-a' };
    await archive.rememberResource(scope(), 'runtime-state', values);
    await archive.rememberResource(scope(), 'models', { list: [{ id: 'one', model_id: 'provider-one', max_tokens: 8192 }] });
    await archive.rememberResource(scope(), 'regex:one', { modelId: 'one', payload: { rules: [{ findRegex: 'token', replaceString: 'secret' }] } });
    await archive.rememberResource(scope(), 'regex:two', { modelId: 'two', payload: { rules: [{ findRegex: 'different' }] } });
    assert.equal((await archive.resource(scope(), 'runtime-state')).variables.nested.api_key, undefined);
    assert.deepEqual((await archive.resource(scope(), 'runtime-state')).variables.nested.items, ['all', 'values']);
    assert.equal((await archive.resource(scope(), 'models')).list[0].model_id, 'provider-one');
    assert.equal((await archive.resource(scope(), 'regex:one')).payload.rules[0].findRegex, 'token');
    assert.equal((await archive.resource(scope(), 'regex:two')).payload.rules[0].findRegex, 'different');
    assert.equal(await archive.resource(scope('owner-b'), 'models'), null);
    assert.equal(await archive.resource(scope('owner-a', 'card-b'), 'models'), null);
    assert.equal(await archive.resource(scope('owner-a', 'card-a', 'conversation-b'), 'models'), null);
    assert.equal(JSON.stringify(indexedDB.dump(databaseName)).includes('resource-sentinel'), false);
    assert.deepEqual(await archive.list('owner-a'), []);
});

test('resource refresh updates only its exact scoped kind', async () => {
    const { archive } = fixture();
    await archive.rememberResource(scope(), 'regex', { text: 'first' });
    await archive.rememberResource(scope(), 'regex', { text: 'new' });
    await archive.rememberResource(scope('owner-b'), 'regex', { text: 'other-account' });
    assert.deepEqual(await archive.resource(scope(), 'regex'), { text: 'new' });
    assert.deepEqual(await archive.resource(scope('owner-b'), 'regex'), { text: 'other-account' });
});

test('resource scope and identity mismatches fail before writing', async () => {
    const { archive, indexedDB, databaseName } = fixture();
    for (const invalid of ['invalid', '{}', '[]', '["owner-a","card-a"]', '["owner-a","card-a",""]']) await assert.rejects(archive.rememberResource(invalid, 'models', {}), /Invalid/);
    for (const kind of ['wrong', '', 'regex:', 'regex: ', null]) await assert.rejects(archive.rememberResource(scope(), kind, {}), /kind/);
    for (const data of [{ owner: 'owner-b' }, { user_id: 'owner-b' }, { app_id: 'card-b' }, { conversation_id: 'conversation-b' }, { user: { id: 'owner-b' } }, { owner: ['owner-a'] }]) {
        await assert.rejects(archive.rememberResource(scope(), 'runtime-state', data), /scope|account/);
    }
    assert.equal(indexedDB.dump(databaseName).length, 0);
});

test('list supplies history references and metadata without copying large cards or message arrays', async () => {
    const { archive } = fixture(), payload = session({ count: 1101 });
    payload.launch.app.card = payload.launch.card;
    payload.launch.created_at = 100; payload.launch.updated_at = 200;
    await archive.remember('owner-a', payload);
    const [item] = await archive.list('owner-a');
    assert.deepEqual(item, { app_id: 'card-a', id: 'conversation-a', conversation_id: 'conversation-a', title: 'Archived conversation',
        app: { id: 'card-a', name: 'Test character', icon: '/character.png' }, app_name: 'Test character', app_icon: '/character.png',
        last_message: 'Complete cloud message 1100', message_count: 1101, created_at: 100, updated_at: 200 });
    item.app.name = 'Mutated metadata';
    assert.equal((await archive.list('owner-a'))[0].app.name, 'Test character');
    assert.equal('card' in item, false); assert.equal('messages' in item, false);
});

test('history archives are retained beyond old outbox and preview cache limits', async () => {
    const { archive, indexedDB, databaseName } = fixture();
    for (let index = 0; index < 125; index++) await archive.remember('owner-a', session({ conversation: `conversation-${index}` }));
    assert.equal((await archive.list('owner-a')).length, 125);
    assert.equal(indexedDB.dump(databaseName).length, 125);
    assert.ok(await archive.read('owner-a', 'card-a', 'conversation-0'));
});

test('quota errors reject and retain previously committed session and resource bytes', async () => {
    const { archive, indexedDB } = fixture();
    await archive.remember('owner-a', session());
    await archive.rememberResource(scope(), 'models', { list: [{ id: 'before' }] });
    indexedDB.failNextPut = true;
    await assert.rejects(archive.remember('owner-a', session({ conversation: 'new' })), { name: 'QuotaExceededError' });
    indexedDB.failNextPut = true;
    await assert.rejects(archive.rememberResource(scope(), 'models', { list: [{ id: 'uncommitted' }] }), { name: 'QuotaExceededError' });
    assert.equal(await archive.read('owner-a', 'card-a', 'new'), null);
    assert.deepEqual(await archive.resource(scope(), 'models'), { list: [{ id: 'before' }] });
    assert.equal((await archive.read('owner-a', 'card-a', 'conversation-a')).launch.messages.length, 1);
});

test('transaction abort after request success rejects without a memory-only success', async () => {
    const { archive, indexedDB, databaseName } = fixture(), gate = indexedDB.holdNextCommit();
    const remembering = archive.remember('owner-a', session());
    const tx = await gate.reached; tx.abort(); gate.release();
    await assert.rejects(remembering, /aborted/);
    assert.equal(indexedDB.dump(databaseName).length, 0);
});

test('missing or unavailable IndexedDB fails closed and a failed open can later retry', async () => {
    const unavailable = createLocalSessionStore({ indexedDB: null });
    await assert.rejects(unavailable.remember('owner-a', session()), /unavailable/);
    await assert.rejects(unavailable.rememberResource(scope(), 'models', {}), /unavailable/);
    const { archive, indexedDB } = fixture();
    indexedDB.openError = true;
    await assert.rejects(archive.remember('owner-a', session()), /open failure/);
    indexedDB.openError = false;
    assert.deepEqual(await archive.remember('owner-a', session()), session());
});

test('older WebViews without strict durability options retain transaction completion semantics', async () => {
    const { archive, indexedDB } = fixture(); indexedDB.strictUnsupported = true;
    await archive.remember('owner-a', session());
    assert.deepEqual(await archive.read('owner-a', 'card-a', 'conversation-a'), session());
});

test('cyclic and non-JSON data fail before storage', async () => {
    const { archive, indexedDB, databaseName } = fixture(), payload = session(); payload.launch.card.data.circular = payload;
    await assert.rejects(archive.remember('owner-a', payload), /JSON/);
    await assert.rejects(archive.rememberResource(scope(), 'runtime-state', { value: Infinity }), /JSON/);
    for (const value of [new Date(), new Map([['key', 'value']]), new Set(['value']), new (class CustomValue { field = 'value'; })()]) {
        await assert.rejects(archive.rememberResource(scope(), 'runtime-state', { value }), /JSON/);
    }
    assert.equal(indexedDB.dump(databaseName).length, 0);
});
