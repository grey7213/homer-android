import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntimeAdapter, createLocalRuntimeStore, installLocalRuntime, sanitizeRuntimeValue } from '../../sillytavern-runtime/public/scripts/homer-local-runtime.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const ORIGIN = 'https://owned.invalid';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const card = () => ({ spec: 'chara_card_v2', data: { name: 'Synthetic card', first_mes: 'Hello',
    character_book: { entries: [{ content: 'Synthetic world' }] }, extensions: { homer_bridge: { app_id: 'card-1', card_signature: 'synthetic' } } } });
const make = (fetcher = async () => { throw new Error('offline'); }, indexedDB = transactionIDB()) => {
    let owner = 'owner-a';
    const storage = createLocalRuntimeStore({ indexedDB });
    const adapter = createLocalRuntimeAdapter({ owner: () => owner, origin: ORIGIN, storage, fetcher });
    return { adapter, indexedDB, storage, account: value => { owner = value; } };
};

test('standalone documents do not install an offline adapter', () => {
    const original = async () => json({});
    const target = { fetch: original, location: { origin: ORIGIN } };
    assert.equal(installLocalRuntime({ target, isEmbedded: false, owner: () => 'owner-a' }), null);
    assert.equal(target.fetch, original);
});

test('embedded installation is idempotent', () => {
    const target = { fetch: async () => json({}), location: { origin: ORIGIN } };
    const storage = createLocalRuntimeStore({ indexedDB: transactionIDB() });
    const first = installLocalRuntime({ target, isEmbedded: true, owner: () => 'owner-a', storage });
    assert.equal(installLocalRuntime({ target, isEmbedded: true, owner: () => 'owner-a', storage }), first);
});

test('settings nested JSON and credential fields are not persisted', async () => {
    const fixture = { settings: JSON.stringify({ username: 'Synthetic', api_key_openai: 'synthetic-private',
        oai_settings: { proxy_password: 'synthetic-private', api_key: 'synthetic-private', temperature: 0.8 },
        extension_settings: { some_module: { access_token: 'synthetic-private', enabled: true } } }),
        bridge_token: 'synthetic-private', is_admin: true, enable_accounts: true, request_compression: { enabled: true } };
    const { adapter, indexedDB } = make(async request => new URL(typeof request === 'string' ? request : request.url).pathname === '/csrf-token'
        ? json({ token: 'synthetic-live-only' }) : json(fixture));
    const response = await adapter.fetch('/api/settings/get', post({}));
    const data = await response.json(), settings = JSON.parse(data.settings);
    assert.equal(settings.username, 'Synthetic');
    assert.deepEqual(settings.oai_settings, { temperature: 0.8 });
    assert.deepEqual(data.request_compression, { enabled: false });
    assert.equal(data.enable_accounts, true);
    const serialized = JSON.stringify(indexedDB.dump('homer-local-runtime-v1'));
    assert.ok(!serialized.includes('synthetic-private'));
    assert.ok(!serialized.includes('synthetic-live-only'));
    assert.ok(!serialized.includes('is_admin'));
});

test('secret initialization does not fetch provider keys or cache a CSRF token', async () => {
    let calls = 0;
    const { adapter, indexedDB } = make(async () => { calls++; throw new Error('offline'); });
    assert.deepEqual(await (await adapter.fetch('/csrf-token')).json(), { token: '' });
    assert.deepEqual(await (await adapter.fetch('/api/secrets/settings', post({}))).json(), { allowKeysExposure: false });
    assert.deepEqual(await (await adapter.fetch('/api/secrets/read', post({}))).json(), {});
    assert.equal((await adapter.fetch('/api/secrets/view', post({}))).status, 403);
    assert.equal(calls, 0); assert.deepEqual(indexedDB.dump('homer-local-runtime-v1'), []);
});

test('local runtime account projection never revives administrator access', async () => {
    const { adapter } = make();
    const user = await (await adapter.fetch('/api/users/me')).json();
    assert.equal(user.admin, false);
    assert.equal(user.handle, 'default-user');
    assert.equal(sanitizeRuntimeValue({ enable_accounts: false }).enable_accounts, true);
});

test('cached initialization does not await a fresh network response', async () => {
    const { adapter, storage } = make(async () => new Promise(() => {}));
    await storage.update('owner-a', 'boot', 'POST:/api/settings/get', () => ({ data: { settings: '{}', world_names: [] }, localMutation: false }));
    const response = await Promise.race([adapter.fetch('/api/settings/get', post({})),
        new Promise((_, reject) => setTimeout(() => reject(new Error('local read waited for network')), 100))]);
    assert.equal(response.status, 200);
});

test('mirrors survive adapter restart offline, with full messages and extension metadata', async () => {
    const { adapter, indexedDB } = make();
    await adapter.seedCharacter('homer-card-1.png', card());
    const request = { avatar_url: 'homer-card-1.png', file_name: 'Homer-conversation-1', metadata_only: true };
    const header = await (await adapter.fetch('/api/chats/get', post(request))).json();
    const messages = Array.from({ length: 1101 }, (_, index) => ({ mes: `Synthetic-${index}`, is_user: index % 2 === 0,
        extra: { homer_sync_id: `synthetic-${index}`, homer_prompt_state: { source: index } }, swipes: ['Synthetic A', 'Synthetic B'] }));
    assert.equal((await adapter.fetch('/api/chats/save', post({ ...request, chat: [header, ...messages] }))).status, 200);
    const reopened = make(undefined, indexedDB).adapter;
    const value = await (await reopened.fetch('/api/chats/get', post({ ...request, metadata_only: false }))).json();
    assert.equal(value.length, 1102);
    assert.deepEqual(value.at(-1), messages.at(-1));
    assert.equal((await (await reopened.fetch('/api/characters/get', post({ avatar_url: request.avatar_url }))).json()).data.name, 'Synthetic card');
});

test('read-only metadata and full mirror share one original integrity header', async () => {
    const { adapter } = make();
    const request = { avatar_url: 'homer-card-1.png', file_name: 'Homer-conversation-1' };
    const [a, b] = await Promise.all([adapter.fetch('/api/chats/get', post({ ...request, metadata_only: true })).then(r => r.json()),
        adapter.fetch('/api/chats/get', post({ ...request, metadata_only: false })).then(r => r.json())]);
    assert.equal(a.chat_metadata.integrity, b[0].chat_metadata.integrity);
    const rejected = await adapter.fetch('/api/chats/save', post({ ...request, force: true,
        chat: [{ chat_metadata: { integrity: 'different-synthetic-header' } }, { mes: 'Old data' }] }));
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { error: 'integrity' });
});

test('local mirror writes never POST cloud histories, even when online', async () => {
    const calls = [];
    const { adapter } = make(async request => { calls.push(typeof request === 'string' ? request : request.url); return json({}); });
    const character = card(), form = new FormData();
    form.append('avatar', new Blob([JSON.stringify(character)], { type: 'application/json' }), 'homer-card-1.json');
    form.append('file_type', 'json'); form.append('preserved_name', 'homer-card-1');
    assert.deepEqual(await (await adapter.fetch('/api/characters/import', { method: 'POST', body: form })).json(), { file_name: 'homer-card-1.png' });
    assert.equal((await adapter.fetch('/api/worldinfo/edit', post({ name: 'Synthetic world', data: { entries: { 1: { content: 'Synthetic' } } } }))).status, 200);
    assert.equal((await adapter.fetch('/api/settings/save', post({ username: 'Synthetic' }))).status, 200);
    assert.deepEqual(calls, []);
});

test('local write resolves only after strict transaction completion', async () => {
    const { adapter, indexedDB } = make();
    await adapter.fetch('/api/settings/save', post({ username: 'Synthetic' }));
    const gate = indexedDB.holdNextCommit();
    let done = false;
    const save = adapter.fetch('/api/settings/save', post({ username: 'Synthetic changed' })).then(() => { done = true; });
    await gate.reached;
    assert.equal(done, false);
    gate.release(); await save; assert.equal(done, true);
});

test('quota failures do not falsely acknowledge a local save', async () => {
    const { adapter, indexedDB } = make();
    indexedDB.failNextPut = true;
    await assert.rejects(adapter.fetch('/api/settings/save', post({ username: 'Synthetic' })), /quota/i);
    assert.deepEqual(indexedDB.dump('homer-local-runtime-v1'), []);
});

test('new account cannot read the previous account mirror', async () => {
    let network = 0;
    const { adapter, account } = make(async request => {
        network++;
        return typeof request === 'string' ? json({ token: 'synthetic-memory-only' }) : json({ error: 'not-found' }, 404);
    });
    await adapter.seedCharacter('homer-card-1.png', card());
    account('owner-b'); adapter.clearAuthorization();
    assert.equal((await adapter.fetch('/api/characters/get', post({ avatar_url: 'homer-card-1.png' }))).status, 404);
    assert.ok(network > 0);
    account('owner-a'); adapter.clearAuthorization();
    assert.equal((await adapter.fetch('/api/characters/get', post({ avatar_url: 'homer-card-1.png' }))).status, 200);
});

test('generation, billing, sync, authentication and extension installation never fake offline success', async () => {
    const called = [];
    const { adapter } = make(async request => {
        const path = new URL(typeof request === 'string' ? request : request.url).pathname;
        called.push(path);
        if (path === '/csrf-token') return json({ token: 'synthetic-memory-only' });
        throw new Error('offline');
    });
    for (const path of ['/api/backends/chat-completions/generate', '/api/homer/sync', '/api/homer/runtime-state',
        '/console/api/web/auth/login', '/api/extensions/install', '/api/homer/admin-preview']) {
        await assert.rejects(adapter.fetch(path, post({})), /offline/);
        assert.equal(called.filter(item => item === path).length, 1);
    }
});

test('fresh CSRF is injected only on the actual network request, never stored', async () => {
    const calls = [];
    const { adapter, indexedDB } = make(async request => {
        if (typeof request === 'string') { calls.push('/csrf-token'); return json({ token: 'synthetic-memory-only' }); }
        calls.push(new URL(request.url).pathname);
        assert.equal(request.headers.get('X-CSRF-Token'), 'synthetic-memory-only');
        return json({ ok: true });
    });
    assert.equal((await adapter.fetch('/api/homer/sync', { ...post({ messages: [] }), headers: { 'X-CSRF-Token': 'old-placeholder', 'Content-Type': 'application/json' } })).status, 200);
    assert.deepEqual(calls, ['/csrf-token', '/api/homer/sync']);
    assert.deepEqual(indexedDB.dump('homer-local-runtime-v1'), []);
});

test('401 is preserved and unsafe requests are not retried', async () => {
    let calls = 0;
    const { adapter } = make(async request => typeof request === 'string' ? json({ token: 'synthetic-memory-only' })
        : (calls++, json({ error: 'unauthorized' }, 401)));
    assert.equal((await adapter.fetch('/api/homer/sync', post({}))).status, 401);
    assert.equal(calls, 1);
});

test('same-owner logout/relogin rejects late initialization response and cannot cache it', async () => {
    let release;
    const { adapter, indexedDB } = make(async request => typeof request === 'string' ? json({ token: 'synthetic-memory-only' })
        : new Promise(resolve => { release = () => resolve(json({ settings: '{}', username: 'Old account session' })); }));
    const read = adapter.fetch('/api/settings/get', post({}));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    adapter.clearAuthorization(); release();
    await assert.rejects(read, /账号已切换/);
    assert.deepEqual(indexedDB.dump('homer-local-runtime-v1'), []);
});

test('missing boot cache does not masquerade as ready on a first offline install', async () => {
    const { adapter } = make();
    await assert.rejects(adapter.fetch('/api/settings/get', post({})), /offline/);
});

test('static and cross-origin requests are not used as local authorization or cached', async () => {
    const called = [];
    const { adapter, indexedDB } = make(async request => { called.push(request.url); return json({ ok: true }); });
    await adapter.fetch('/scripts/owned-template.html');
    await adapter.fetch('https://third-party.invalid/owned-script.js');
    assert.equal(called.length, 2);
    assert.deepEqual(indexedDB.dump('homer-local-runtime-v1'), []);
});

test('a stale background settings read cannot replace a newer local change', async () => {
    let release;
    const { adapter, storage } = make(async request => typeof request === 'string' ? json({ token: 'synthetic-memory-only' })
        : new Promise(resolve => { release = () => resolve(json({ settings: JSON.stringify({ username: 'Remote old' }) })); }));
    await storage.update('owner-a', 'boot', 'POST:/api/settings/get', () => ({ data: { settings: JSON.stringify({ username: 'Local old' }) }, localMutation: false }));
    await adapter.fetch('/api/settings/get', post({}));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await adapter.fetch('/api/settings/save', post({ username: 'Local new' }));
    release(); await adapter.pendingRefreshes();
    const current = await (await adapter.fetch('/api/settings/get', post({}))).json();
    assert.equal(JSON.parse(current.settings).username, 'Local new');
});

test('older WebViews without strict durability options still wait for transaction completion', async () => {
    const { adapter, indexedDB } = make();
    indexedDB.strictUnsupported = true;
    assert.equal((await adapter.fetch('/api/settings/save', post({ username: 'Synthetic' }))).status, 200);
    assert.equal(indexedDB.dump('homer-local-runtime-v1').length, 1);
});

test('unexpected methods on a read URL still use the real network', async () => {
    const { adapter } = make();
    await assert.rejects(adapter.fetch('/api/settings/get', { method: 'DELETE' }), /offline/);
});

test('sanitizer preserves normal prompt text instead of regexp-editing contents', () => {
    const text = 'A story mentions token and password but is not an account credential.';
    assert.equal(sanitizeRuntimeValue({ mes: text }).mes, text);
});
