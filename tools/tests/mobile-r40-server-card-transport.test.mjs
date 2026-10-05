import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
    isCardCacheRequested,
    jsonContentSha256,
    withSessionCardTransport,
    withCharacterCardTransport,
} from '../../sillytavern-runtime/src/homer-card-transport.js';

// All content and identifiers below are synthetic fixtures; no account data.
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const options = (clientSha = '') => ({ enabled: '1', clientSha, status: 200 });
const card = () => ({ spec: 'chara_card_v2', data: { name: 'Fixture',
    description: 'Synthetic description', character_book: { entries: [{ content: 'Fixture world' }] },
    extensions: { regex_scripts: [{ findRegex: 'fixture', replaceString: 'example' }], arbitrary: 'preserve' } } });
const session = () => ({ user: { id: 'fixture-owner' }, launch: { app_id: 'fixture-card',
    conversation_id: 'fixture-conversation', bridge_token: 'synthetic-nonsecret-token', card: card(),
    runtime_config: { preset: 'fixture-preset' } }, messages: [{ mes: 'Fixture message' }],
    runtime: { extensions: ['fixture-extension'] }, arbitrary: { field: 'preserve' } });
const character = () => ({ name: 'Fixture', avatar: 'fixture-avatar.png', data: card().data,
    json_data: JSON.stringify(card()), create_date: 'fixture-date', date_added: 1000,
    date_last_chat: 2000, chat_size: 1234, data_size: 4321, arbitrary: { field: 'preserve' } });

test('SHA is over the exact complete JSON representation, including order and unknown fields', () => {
    assert.equal(jsonContentSha256({ a: '你好', b: 2 }), digest({ a: '你好', b: 2 }));
    assert.notEqual(jsonContentSha256({ a: 1, b: 2 }), jsonContentSha256({ b: 2, a: 1 }));
    assert.notEqual(jsonContentSha256(card()), jsonContentSha256({ ...card(), extra: 'new' }));
});

test('cache opt-in is explicit, not truthy or query-array coercion', () => {
    assert.equal(isCardCacheRequested(1), true);
    assert.equal(isCardCacheRequested('1'), true);
    for (const invalid of [true, false, 'true', 0, '01', ['1'], { value: 1 }, null, undefined]) {
        assert.equal(isCardCacheRequested(invalid), false);
    }
});

test('session first/mismatched/invalid revision returns the complete card without mutating input', () => {
    const original = session();
    const before = clone(original);
    for (const clientSha of ['', 'f'.repeat(64), 'bad', [digest(original.launch.card)], {}, null]) {
        const result = withSessionCardTransport(original, options(clientSha));
        assert.equal(result.launch.card, original.launch.card);
        assert.deepEqual(result.launch.card_transport, { version: 1, sha256: digest(original.launch.card) });
        assert.deepEqual(result.messages, original.messages);
        assert.deepEqual(result.arbitrary, original.arbitrary);
    }
    assert.deepEqual(original, before);
});

test('matching session SHA omits only card and retains fresh user/token/config/messages/runtime', () => {
    const original = session();
    const result = withSessionCardTransport(original, options(digest(original.launch.card).toUpperCase()));
    assert.equal(Object.hasOwn(result.launch, 'card'), false);
    assert.equal(result.launch.bridge_token, original.launch.bridge_token);
    assert.equal(result.user, original.user);
    assert.equal(result.launch.runtime_config, original.launch.runtime_config);
    assert.equal(result.messages, original.messages);
    assert.equal(result.runtime, original.runtime);
    assert.ok(original.launch.card);
});

test('wrapped session preserves the upstream envelope and supports V1 nonempty card', () => {
    const original = { code: 0, arbitrary: 'outer', data: session() };
    original.data.launch.card = { name: 'Fixture V1', description: 'Synthetic' };
    const result = withSessionCardTransport(original, options(digest(original.data.launch.card)));
    assert.equal(result.code, 0);
    assert.equal(result.arbitrary, 'outer');
    assert.equal(result.data.launch.card, undefined);
    assert.equal(original.data.launch.card.name, 'Fixture V1');
});

test('legacy and non-success sessions are unchanged, even with a matching SHA', () => {
    const original = session();
    for (const enabled of [undefined, false, true, 0, ['1']]) {
        assert.equal(withSessionCardTransport(original, { ...options(digest(original.launch.card)), enabled }), original);
    }
    for (const status of [0, 199, 300, 401, 403, 404, 500, 502]) {
        assert.equal(withSessionCardTransport(original, { ...options(digest(original.launch.card)), status }), original);
    }
});

test('malformed, unauthenticated or admin session bodies cannot gain transport omission', () => {
    const mutations = [
        value => delete value.user,
        value => { value.user = {}; },
        value => { value.user = []; },
        value => { value.user.id = ''; },
        value => delete value.launch,
        value => { value.launch = []; },
        value => delete value.launch.bridge_token,
        value => { value.launch.bridge_token = ' '; },
        value => { value.launch.bridge_token = {}; },
        value => delete value.launch.app_id,
        value => delete value.launch.conversation_id,
        value => { value.launch.card = null; },
        value => { value.launch.card = []; },
        value => { value.launch.card = {}; },
        value => { value.launch.admin_preview = true; },
        value => { value.admin_preview = true; },
        value => { value.success = false; },
        value => { value.error = 'Synthetic denial'; },
    ];
    for (const mutate of mutations) {
        const value = session();
        mutate(value);
        assert.equal(withSessionCardTransport(value, options(digest(card()))), value);
    }
    for (const value of [null, undefined, [], {}, 'string']) {
        assert.equal(withSessionCardTransport(value, options()), value);
    }
});

test('edits to scripts/worldbooks or an unknown session card field invalidate the former SHA', () => {
    const original = session();
    const revision = digest(original.launch.card);
    for (const mutate of [
        value => { value.data.character_book.entries[0].content = 'Edited world'; },
        value => { value.data.extensions.regex_scripts[0].replaceString = 'Edited regex'; },
        value => { value.arbitrary_server_field = 'Edited'; },
    ]) {
        const edited = clone(original);
        mutate(edited.launch.card);
        const result = withSessionCardTransport(edited, options(revision));
        assert.equal(result.launch.card, edited.launch.card);
        assert.notEqual(result.launch.card_transport.sha256, revision);
    }
});

test('mirror first read preserves all complete fields, then matching SHA returns not-modified envelope', () => {
    const original = character();
    const before = clone(original);
    const result = withCharacterCardTransport(original, options());
    assert.equal(result.character, original);
    assert.equal(result.character.json_data, before.json_data);
    assert.deepEqual(result.homer_character_transport, { version: 1, sha256: digest(original) });
    const matched = withCharacterCardTransport(original, options(digest(original)));
    assert.equal(Object.hasOwn(matched, 'character'), false);
    assert.deepEqual(matched.homer_character_transport, { version: 1, sha256: digest(original), not_modified: true });
    assert.deepEqual(original, before);
});

test('mirror SHA includes persisted json_data, statistics, complete data and unknown fields', () => {
    const original = character();
    const revision = digest(original);
    for (const mutate of [
        value => { value.json_data += ' '; },
        value => { value.date_last_chat++; },
        value => { value.chat_size++; },
        value => { value.data.character_book.entries[0].content = 'Edited'; },
        value => { value.arbitrary.field = 'Edited'; },
    ]) {
        const edited = clone(original);
        mutate(edited);
        const result = withCharacterCardTransport(edited, options(revision));
        assert.equal(result.character, edited);
        assert.notEqual(result.homer_character_transport.sha256, revision);
    }
});

test('v2 first mirror read separates only known fresh statistics without losing any character fields', () => {
    const original = character();
    original.chat = 'Persisted fixture conversation';
    original.extra_unknown = { nested: ['keep', 42] };
    original.fresh_stats = { creator_field: 'Keep this unknown character field too' };
    const before = clone(original);
    for (const enabled of [2, '2']) {
        const result = withCharacterCardTransport(original, { enabled });
        assert.equal(result.homer_character_transport.version, 2);
        assert.equal(result.homer_character_transport.sha256, digest(result.character));
        assert.equal(Object.hasOwn(result.character, 'chat_size'), false);
        assert.equal(Object.hasOwn(result.character, 'date_last_chat'), false);
        assert.equal(result.character.chat, original.chat);
        assert.equal(result.character.json_data, original.json_data);
        assert.deepEqual(result.character.data, original.data);
        assert.deepEqual(result.character.fresh_stats, original.fresh_stats);
        assert.deepEqual({ ...result.character, ...result.fresh_stats }, original);
        assert.deepEqual(result.fresh_stats, { chat_size: original.chat_size, date_last_chat: original.date_last_chat });
    }
    assert.deepEqual(original, before);
});

test('v2 stats-only changes keep the content SHA and always return this read fresh statistics', () => {
    const original = character();
    const first = withCharacterCardTransport(original, { enabled: 2 });
    const changed = { ...clone(original), chat_size: 5678, date_last_chat: 9876.125 };
    const matched = withCharacterCardTransport(changed, { enabled: 2, clientSha: first.homer_character_transport.sha256 });
    assert.equal(matched.character, undefined);
    assert.equal(matched.homer_character_transport.version, 2);
    assert.equal(matched.homer_character_transport.not_modified, true);
    assert.equal(matched.homer_character_transport.sha256, first.homer_character_transport.sha256);
    assert.deepEqual(matched.fresh_stats, { chat_size: 5678, date_last_chat: 9876.125 });
    assert.deepEqual({ ...first.character, ...matched.fresh_stats }, changed);
});

test('v2 chat, dates, json_data, worldbook, script and unknown content edits all invalidate the old content SHA', () => {
    const original = character(); original.chat = 'Fixture chat';
    const previous = withCharacterCardTransport(original, { enabled: 2 }).homer_character_transport.sha256;
    for (const mutate of [
        value => { value.chat = 'Edited persisted chat'; },
        value => { value.date_added++; },
        value => { value.create_date = 'Edited author date'; },
        value => { value.data_size++; },
        value => { value.json_data += ' '; },
        value => { value.data.character_book.entries[0].content = 'Edited world'; },
        value => { value.data.extensions.regex_scripts[0].replaceString = 'Edited script'; },
        value => { value.arbitrary.field = 'Edited unknown'; },
    ]) {
        const changed = clone(original); mutate(changed);
        const result = withCharacterCardTransport(changed, { enabled: 2, clientSha: previous });
        assert.ok(result.character);
        assert.notEqual(result.homer_character_transport.sha256, previous);
        assert.deepEqual({ ...result.character, ...result.fresh_stats }, changed);
    }
});

test('v2 requires both own finite nonnegative numeric statistics; invalid data falls back unchanged', () => {
    for (const key of ['chat_size', 'date_last_chat']) {
        for (const value of [undefined, null, '123', -1, NaN, Infinity, -Infinity, [], {}]) {
            const invalid = character(); invalid[key] = value;
            assert.equal(withCharacterCardTransport(invalid, { enabled: 2 }), invalid);
        }
        const missing = character(); delete missing[key];
        assert.equal(withCharacterCardTransport(missing, { enabled: 2 }), missing);
        const inherited = character(); const stat = inherited[key]; delete inherited[key];
        Object.setPrototypeOf(inherited, { [key]: stat });
        assert.equal(withCharacterCardTransport(inherited, { enabled: 2 }), inherited);
    }
    const zero = { ...character(), chat_size: 0, date_last_chat: 0 };
    const result = withCharacterCardTransport(zero, { enabled: 2 });
    assert.deepEqual(result.fresh_stats, { chat_size: 0, date_last_chat: 0 });
    assert.deepEqual({ ...result.character, ...result.fresh_stats }, zero);
});

test('v1 keeps full-object hashes and session transport never opts into mirror v2', () => {
    const original = character();
    const result = withCharacterCardTransport(original, options());
    assert.equal(result.homer_character_transport.version, 1);
    assert.equal(result.character, original);
    assert.equal(result.fresh_stats, undefined);
    assert.equal(result.homer_character_transport.sha256, digest(original));
    const changed = { ...original, date_last_chat: original.date_last_chat + 1 };
    const mismatch = withCharacterCardTransport(changed, options(result.homer_character_transport.sha256));
    assert.equal(mismatch.character, changed);
    assert.equal(mismatch.homer_character_transport.not_modified, undefined);
    for (const enabled of [2, '2', ['2'], true]) {
        const launch = session();
        assert.equal(withSessionCardTransport(launch, { ...options(), enabled }), launch);
    }
    for (const enabled of [['2'], true, '02', 3]) assert.equal(withCharacterCardTransport(original, { enabled }), original);
});

test('invalid/incomplete/shallow mirrors and legacy requests retain their original response', () => {
    const original = character();
    for (const enabled of [undefined, false, true, ['1']]) {
        assert.equal(withCharacterCardTransport(original, { enabled, clientSha: digest(original) }), original);
    }
    for (const value of [undefined, null, [], {}, { data: {} }, { avatar: 'fixture.png' }, { avatar: 'fixture.png', data: {} },
        { avatar: ' ', data: {} }, { avatar: 'fixture.png', data: [] }, { ...original, shallow: true }]) {
        assert.equal(withCharacterCardTransport(value, options(digest(original))), value);
    }
});

test('an unserializable card cannot turn a successful legacy result into a transport error', () => {
    const launch = session();
    launch.launch.card.circular = launch.launch.card;
    assert.equal(withSessionCardTransport(launch, options()), launch);
    const mirror = character();
    mirror.circular = mirror;
    assert.equal(withCharacterCardTransport(mirror, options()), mirror);
});

function responseRecorder() {
    return { statusCode: 200, headers: {}, body: undefined,
        status(code) { this.statusCode = code; return this; },
        setHeader(key, value) { this.headers[key] = value; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; },
        sendStatus(code) { this.statusCode = code; return this; } };
}

const homerSource = readFileSync(new URL('../../sillytavern-runtime/src/endpoints/homer.js', import.meta.url), 'utf8');
function loadSessionForward(fetcher) {
    const start = homerSource.indexOf('function readCookie(');
    const end = homerSource.indexOf("router.get('/session'");
    assert.ok(start >= 0 && end > start, 'Shipping forward function exists');
    const context = vm.createContext({ Buffer, URL, AbortController, withSessionCardTransport,
        BACKEND_BASE_URL: 'https://fixture.invalid', AUTH_COOKIE_NAME: 'fixture-cookie', REQUEST_TIMEOUT_MS: 3000,
        fetch: fetcher, setTimeout: () => 1, clearTimeout: () => {}, console: { warn() {} } });
    vm.runInContext(`${homerSource.slice(start, end)}\nglobalThis.forward = forwardToHomer;`, context);
    return context.forward;
}
const request = (query = {}) => ({ method: 'GET', headers: { cookie: 'fixture-cookie=synthetic-nonsecret' }, query });
const upstream = (body, status = 200, contentType = 'application/json') => ({ status,
    headers: { get: () => contentType }, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });

test('shipping session forward requires cookie even when caller already has a matching SHA', async () => {
    let calls = 0;
    const forward = loadSessionForward(async () => { calls++; return upstream(session()); });
    const req = request({ card_cache: '1', card_sha256: digest(card()) });
    req.headers = {};
    const res = responseRecorder();
    await forward(req, res, '/console/api/web/dialogue/session', { decorateSession: true, conditionalCardTransport: true });
    assert.equal(calls, 0);
    assert.equal(res.statusCode, 401);
});

test('shipping session forward reads complete upstream before omitting, not conditional upstream auth', async () => {
    let signalRead;
    let finishRead;
    const readStarted = new Promise(resolve => { signalRead = resolve; });
    const bodyRead = new Promise(resolve => { finishRead = resolve; });
    let calls = 0;
    const forward = loadSessionForward(async (url, init) => {
        calls++;
        assert.equal(url.searchParams.get('app_id'), 'fixture-card');
        assert.equal(url.searchParams.has('card_cache'), false);
        assert.equal(url.searchParams.has('card_sha256'), false);
        assert.equal(init.headers.Cookie, 'fixture-cookie=synthetic-nonsecret');
        return { status: 200, headers: { get: () => 'application/json' },
            arrayBuffer() { signalRead(); return bodyRead; } };
    });
    const res = responseRecorder();
    const pending = forward(request({ app_id: 'fixture-card', card_cache: '1', card_sha256: digest(card()) }), res,
        '/console/api/web/dialogue/session', { decorateSession: true, conditionalCardTransport: true });
    await readStarted;
    assert.equal(res.body, undefined);
    finishRead(Buffer.from(JSON.stringify(session())));
    await pending;
    assert.equal(calls, 1);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.launch.card, undefined);
    assert.equal(body.launch.bridge_token, 'synthetic-nonsecret-token');
    assert.equal(body.runtime.bridge_base_url, 'https://fixture.invalid');
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('shipping session legacy bytes, non-JSON and error responses do not gain transport metadata', async () => {
    const raw = '{ "user": { "id": "fixture-owner" }, "launch": {"card":{"name":"Fixture"}} }';
    const forwardLegacy = loadSessionForward(async () => ({ status: 200,
        headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(raw) }));
    const legacy = responseRecorder();
    await forwardLegacy(request(), legacy, '/console/api/web/dialogue/session', { decorateSession: true, conditionalCardTransport: true });
    assert.equal(legacy.body.toString(), raw);
    for (const status of [401, 403, 404, 500]) {
        const res = responseRecorder();
        const forward = loadSessionForward(async () => upstream(session(), status));
        await forward(request({ card_cache: '1', card_sha256: digest(card()) }), res,
            '/console/api/web/dialogue/session', { decorateSession: true, conditionalCardTransport: true });
        const body = JSON.parse(res.body.toString());
        assert.equal(res.statusCode, status);
        assert.ok(body.launch.card);
        assert.equal(body.launch.card_transport, undefined);
    }
    const res = responseRecorder();
    const forward = loadSessionForward(async () => ({ status: 200,
        headers: { get: () => 'text/plain' }, arrayBuffer: async () => Buffer.from('synthetic plain text') }));
    await forward(request({ card_cache: '1' }), res, '/console/api/web/dialogue/session',
        { decorateSession: true, conditionalCardTransport: true });
    assert.equal(res.body.toString(), 'synthetic plain text');
});

test('only the shipping normal session route opts into conditional card transport', async () => {
    const routes = new Map();
    const observed = [];
    const start = homerSource.indexOf("router.get('/session'");
    const end = homerSource.indexOf("router.post('/admin-configuration'");
    const context = vm.createContext({ router: { get(route, handler) { routes.set(route, handler); } },
        forwardToHomer(req, res, route, opts) { observed.push({ route, opts }); } });
    vm.runInContext(homerSource.slice(start, end), context);
    await routes.get('/session')({}, {});
    await routes.get('/admin-preview')({}, {});
    assert.equal(observed[0].opts.conditionalCardTransport, true);
    assert.equal(observed[1].opts.conditionalCardTransport, undefined);
});

const characterSource = readFileSync(new URL('../../sillytavern-runtime/src/endpoints/characters.js', import.meta.url), 'utf8');
function loadCharacterGet({ exists = true, value = character(), process = async () => value } = {}) {
    const start = characterSource.indexOf("router.post('/get',");
    const end = characterSource.indexOf("router.post('/chats',", start);
    assert.ok(start >= 0 && end > start, 'Shipping get route exists');
    const validator = () => {};
    const reads = [];
    let handler;
    const context = vm.createContext({ path, fs: { existsSync: () => exists }, validateAvatarUrlMiddleware: validator,
        withCharacterCardTransport, console: { error() {} },
        processCharacter: async (...args) => { reads.push(args); return process(...args); },
        router: { post(route, middleware, fn) {
            assert.equal(route, '/get'); assert.equal(middleware, validator); handler = fn;
        } } });
    vm.runInContext(characterSource.slice(start, end), context);
    return { handler, reads };
}
const characterRequest = body => ({ body, user: { directories: { characters: 'C:/fixture/characters', chats: 'C:/fixture/chats' } } });

test('shipping mirror route always processes the authenticated user complete character before matching', async () => {
    const full = character();
    const { handler, reads } = loadCharacterGet({ value: full });
    const req = characterRequest({ avatar_url: full.avatar, card_cache: 1, card_sha256: digest(full) });
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(reads.length, 1);
    assert.equal(reads[0][0], full.avatar);
    assert.equal(reads[0][1], req.user.directories);
    assert.equal(reads[0][2].shallow, false);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.homer_character_transport.not_modified, true);
    assert.equal(res.body.character, undefined);
});

test('shipping mirror route notices fresh edits and never skips processCharacter using the supplied hash', async () => {
    const full = character();
    const previous = digest(full);
    full.json_data += ' ';
    const { handler, reads } = loadCharacterGet({ value: full });
    const res = responseRecorder();
    await handler(characterRequest({ avatar_url: full.avatar, card_cache: 1, card_sha256: previous }), res);
    assert.equal(reads.length, 1);
    assert.equal(res.body.character, full);
    assert.notEqual(res.body.homer_character_transport.sha256, previous);
});

test('shipping mirror v2 still reads the current user complete character on a statistics-only hit', async () => {
    const full = character();
    const initial = withCharacterCardTransport(full, { enabled: 2 });
    full.date_last_chat += 111; full.chat_size += 222;
    const { handler, reads } = loadCharacterGet({ value: full });
    const res = responseRecorder();
    const req = characterRequest({ avatar_url: full.avatar, card_cache: 2, card_sha256: initial.homer_character_transport.sha256 });
    await handler(req, res);
    assert.equal(reads.length, 1);
    assert.equal(reads[0][1], req.user.directories);
    assert.equal(reads[0][2].shallow, false);
    assert.equal(res.body.homer_character_transport.not_modified, true);
    assert.equal(res.body.character, undefined);
    assert.deepEqual({ ...initial.character, ...res.body.fresh_stats }, full);
});

test('shipping mirror v2 deletion, processing failure and invalid stats cannot become a cached success', async () => {
    for (const row of [
        { config: { exists: false }, status: 404, reads: 0 },
        { config: { process: async () => { throw new Error('Synthetic parse failure'); } }, status: 500, reads: 1 },
    ]) {
        const harness = loadCharacterGet(row.config), res = responseRecorder();
        await harness.handler(characterRequest({ avatar_url: 'fixture.png', card_cache: 2, card_sha256: 'a'.repeat(64) }), res);
        assert.equal(res.statusCode, row.status);
        assert.equal(harness.reads.length, row.reads);
        assert.equal(res.body, undefined);
    }
    const invalid = character(); invalid.date_last_chat = -1;
    const harness = loadCharacterGet({ value: invalid }), res = responseRecorder();
    await harness.handler(characterRequest({ avatar_url: invalid.avatar, card_cache: 2 }), res);
    assert.equal(res.body, invalid);
});

test('shipping mirror missing body/file and processing failures remain authoritative without metadata', async () => {
    for (const row of [
        { config: {}, body: undefined, status: 400, reads: 0 },
        { config: { exists: false }, body: { avatar_url: 'fixture.png', card_cache: 1 }, status: 404, reads: 0 },
        { config: { process: async () => { throw new Error('Synthetic parse failure'); } },
            body: { avatar_url: 'fixture.png', card_cache: 1 }, status: 500, reads: 1 },
    ]) {
        const harness = loadCharacterGet(row.config);
        const res = responseRecorder();
        await harness.handler(characterRequest(row.body), res);
        assert.equal(res.statusCode, row.status);
        assert.equal(harness.reads.length, row.reads);
        assert.equal(res.body, undefined);
    }
});

test('shipping mirror legacy/incomplete responses retain their original format', async () => {
    for (const row of [{ value: character(), optin: undefined }, { value: undefined, optin: 1 },
        { value: { ...character(), shallow: true }, optin: 1 }]) {
        const harness = loadCharacterGet({ process: async () => row.value });
        const res = responseRecorder();
        await harness.handler(characterRequest({ avatar_url: 'fixture.png', card_cache: row.optin }), res);
        assert.equal(res.body, row.value);
    }
});
