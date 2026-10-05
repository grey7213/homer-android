import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = relative => readFileSync(new URL(`../../sillytavern-runtime/src/${relative}`, import.meta.url), 'utf8');
const chatsSource = read('endpoints/chats.js');
const settingsSource = read('endpoints/settings.js');
const utilSource = read('util.js');
const usersSource = read('users.js');
const validatorSource = read('middleware/validateFileName.js');
const startupSource = read('server-startup.js');
const serverSource = read('server-main.js');

function section(source, start, end) {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin + start.length);
    assert.ok(begin >= 0 && finish > begin, `Actual source boundary exists: ${start}`);
    return source.slice(begin, finish).replace(/^export /gm, '');
}

const loginMiddleware = section(usersSource, 'export function requireLoginMiddleware(', '\n/**');
const pathGuard = section(utilSource, 'export function isPathUnderParent(', '\n/**');
const readFile = section(utilSource, 'export function tryReadFileSync(', '\n/**');
const writeFile = section(utilSource, 'export function tryWriteFileSync(', '\n/**');
const integrityError = section(chatsSource, 'class IntegrityMismatchError extends Error', '\n/**');
const saveChat = section(chatsSource, 'export async function trySaveChat(', "router.post('/save'");
const chatRoutes = section(chatsSource, "router.post('/save'", "router.post('/rename'");
const settingsRoute = section(settingsSource, "router.post('/get',", "router.post('/get-snapshots'");
const validAvatar = validatorSource
    .replace(/^import .+;\r?\n/gm, '')
    .replace(/^export default (.+);\r?\n?/gm, 'const validateAvatarUrlMiddleware = $1;\n')
    .replace(/^export /gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const silent = { error() {}, warn() {}, debug() {} };

function response() {
    return {
        code: 200, body: undefined,
        send(body) { this.body = body; return this; },
        sendStatus(code) { this.code = code; return this; },
        status(code) { this.code = code; return this; },
    };
}

// Only filesystem I/O is substituted. Login, filename/path checks, routes,
// full JSONL parser and recursive first-save utility are shipping functions.
function fixture({ directoryExists = true, content, ioError, settings = '{}' } = {}) {
    const root = path.resolve('C:/synthetic-homer-route');
    const chats = path.join(root, 'chats');
    const directory = path.join(chats, 'fixture-card');
    const file = path.join(directory, 'Homer-fixture.jsonl');
    const existing = new Set(directoryExists ? [directory] : []);
    const files = new Map(content === undefined ? [] : [[file, content]]);
    const calls = [];
    const routes = new Map();
    const scope = {
        path, console: silent, checkIntegrity: false,
        fs: {
            existsSync(target) {
                calls.push(['exists', target]);
                if (ioError === 'exists') throw new Error('Synthetic filesystem failure');
                return existing.has(target) || files.has(target);
            },
            mkdirSync(target, options) { calls.push(['mkdir', target, options]); existing.add(target); },
            readFileSync(target) {
                calls.push(['read', target]);
                if (ioError === 'read') throw new Error('Synthetic file read failure');
                if (target === path.join(root, 'settings.json')) return settings;
                if (!files.has(target)) throw new Error('Synthetic missing file');
                return files.get(target);
            },
            readdirSync(target) { calls.push(['list', target]); return []; },
        },
        writeFileAtomicSync(target, data, encoding) {
            calls.push(['write', target, encoding]); files.set(target, data);
        },
        readFirstLine: async target => {
            calls.push(['first-line', target]);
            if (ioError === 'header') throw new Error('Synthetic header failure');
            return files.get(target).split('\n')[0];
        },
        tryParse: text => { try { return JSON.parse(text); } catch { return null; } },
        sanitize: value => value,
        getBackupFunction: () => (...args) => calls.push(['backup', ...args]),
        router: { post(route, ...chain) { routes.set(route, chain); } },
    };
    vm.createContext(scope);
    vm.runInContext(`${validAvatar}\n${loginMiddleware}\n${pathGuard}\n${readFile}\n${writeFile}\n${integrityError}\n${saveChat}\n${chatRoutes}`, scope);
    const user = { profile: { handle: 'synthetic-user' }, directories: { root, chats, backups: path.join(root, 'backups') } };
    async function invoke(route = '/get', body = {}, requestUser = user) {
        const req = { body: { avatar_url: 'fixture-card.png', file_name: 'Homer-fixture', ...body }, user: requestUser, originalUrl: `/api/chats${route}` };
        const res = response();
        const chain = [scope.requireLoginMiddleware, ...routes.get(route)];
        for (const middleware of chain) {
            let continued = false;
            await middleware(req, res, () => { continued = true; });
            if (!continued) break;
        }
        return res;
    }
    return { scope, routes, user, calls, files, directory, file, invoke };
}

function writes(f) { return f.calls.filter(([kind]) => kind === 'mkdir' || kind === 'write' || kind === 'backup'); }
const header = { user_name: 'Synthetic', chat_metadata: { integrity: 'synthetic-integrity', unknown: { enabled: true }, greeting: 2 } };
const jsonl = `${JSON.stringify(header)}\n${JSON.stringify({ mes: 'Synthetic message' })}\ninvalid\n`;

test('private mounts keep login before both shipping API routers', () => {
    assert.ok(serverSource.indexOf('app.use(requireLoginMiddleware);') < serverSource.indexOf('setupPrivateEndpoints(app);'));
    assert.ok(startupSource.includes("app.use('/api/chats', chatsRouter);"));
    assert.ok(startupSource.includes("app.use('/api/settings', settingsRouter);"));
});

test('actual login middleware rejects unauthenticated chat without any filesystem work', async () => {
    const f = fixture({ directoryExists: false });
    const result = await f.invoke('/get', { metadata_only: true }, null);
    assert.equal(result.code, 403);
    assert.equal(f.calls.length, 0);
});

for (const avatar of ['../other.png', 'other/fixture.png', 'fixture\u0000.png']) {
    test('actual filename middleware rejects unsafe avatar before any filesystem work', async () => {
        const f = fixture();
        const result = await f.invoke('/get', { avatar_url: avatar, metadata_only: true });
        assert.equal(result.code, 400);
        assert.equal(f.calls.length, 0);
    });
}

test('actual parent path guard rejects a parent-directory avatar even without separators', async () => {
    const f = fixture();
    const result = await f.invoke('/get', { avatar_url: '..', metadata_only: true });
    assert.equal(result.code, 400);
    assert.equal(f.calls.length, 0);
});

test('strict metadata-only missing directory returns empty without mkdir or any write', async () => {
    const f = fixture({ directoryExists: false });
    const result = await f.invoke('/get', { metadata_only: true });
    assert.equal(result.code, 200);
    assert.deepEqual(plain(result.body), {});
    assert.deepEqual(writes(f), []);
    assert.deepEqual(f.calls.map(([kind]) => kind), ['exists']);
});

for (const flag of [undefined, false, 'true', 1, []]) {
    test(`non-strict metadata flag ${JSON.stringify(flag)} retains normal missing-directory creation`, async () => {
        const f = fixture({ directoryExists: false });
        const result = await f.invoke('/get', { metadata_only: flag });
        assert.equal(result.code, 200);
        assert.deepEqual(plain(result.body), {});
        assert.deepEqual(writes(f), [['mkdir', f.directory, undefined]]);
    });
}

test('metadata-only missing file returns empty with no read or write', async () => {
    const f = fixture();
    const result = await f.invoke('/get', { metadata_only: true });
    assert.deepEqual(plain(result.body), {});
    assert.deepEqual(f.calls.map(([kind]) => kind), ['exists', 'exists']);
});

test('metadata-only uses original first line preserving integrity and all unknown metadata', async () => {
    const f = fixture({ content: jsonl });
    const result = await f.invoke('/get', { metadata_only: true });
    assert.deepEqual(plain(result.body), { chat_metadata: header.chat_metadata });
    assert.equal(f.calls.filter(([kind]) => kind === 'first-line').length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === 'read').length, 0);
    assert.deepEqual(writes(f), []);
});

for (const content of ['invalid\n', '{}\n', 'null\n']) {
    test('empty or malformed first header retains existing empty-metadata response', async () => {
        const f = fixture({ content });
        const result = await f.invoke('/get', { metadata_only: true });
        assert.deepEqual(plain(result.body), { chat_metadata: {} });
        assert.deepEqual(writes(f), []);
    });
}

for (const ioError of ['exists', 'header']) {
    test(`metadata-only ${ioError} failure remains HTTP 500, never an empty cached success`, async () => {
        const f = fixture({ content: jsonl, ioError });
        const result = await f.invoke('/get', { metadata_only: true });
        assert.equal(result.code, 500);
        assert.equal(result.body, undefined);
        assert.deepEqual(writes(f), []);
    });
}

test('normal read preserves full JSONL messages and parser behavior', async () => {
    const f = fixture({ content: jsonl });
    const result = await f.invoke();
    assert.deepEqual(plain(result.body), [header, { mes: 'Synthetic message' }]);
    assert.equal(f.calls.filter(([kind]) => kind === 'first-line').length, 0);
    assert.equal(f.calls.filter(([kind]) => kind === 'read').length, 1);
    assert.deepEqual(writes(f), []);
});

test('normal read failure retains original empty-array utility fallback', async () => {
    const f = fixture({ content: jsonl, ioError: 'read' });
    const result = await f.invoke();
    assert.equal(result.code, 200);
    assert.deepEqual(plain(result.body), []);
    assert.deepEqual(writes(f), []);
});

test('missing filename remains empty without reading a header', async () => {
    const f = fixture({ content: jsonl });
    const result = await f.invoke('/get', { metadata_only: true, file_name: '' });
    assert.deepEqual(plain(result.body), {});
    assert.deepEqual(f.calls.map(([kind]) => kind), ['exists']);
});

test('chat reads remain bound to the authenticated user directory', async () => {
    const f = fixture({ directoryExists: false });
    const other = { ...f.user, directories: { ...f.user.directories, chats: path.resolve('C:/synthetic-other/chats') } };
    await f.invoke('/get', { metadata_only: true }, other);
    assert.deepEqual(f.calls, [['exists', path.join(other.directories.chats, 'fixture-card')]]);
    assert.deepEqual(writes(f), []);
});

test('first normal save still creates parents recursively without preceding get', async () => {
    const f = fixture({ directoryExists: false });
    const chat = [header, { mes: 'Synthetic first reply' }];
    const result = await f.invoke('/save', { chat });
    assert.equal(result.code, 200);
    assert.deepEqual(plain(result.body), { ok: true });
    assert.deepEqual(plain(writes(f)[0]), ['mkdir', f.directory, { recursive: true }]);
    assert.deepEqual(JSON.parse(f.files.get(f.file).split('\n')[0]), header);
    assert.equal(f.files.get(f.file).split('\n').length, 2);
    assert.equal(writes(f).filter(([kind]) => kind === 'write').length, 1);
});

function settingsFixture(settings = '{}', { readError = false } = {}) {
    const calls = [];
    let handler;
    const scope = {
        path, console: silent, SETTINGS_FILE: 'settings.json',
        fs: {
            readFileSync(target) { calls.push(['read', target]); if (readError) throw new Error('Synthetic settings failure'); return settings; },
            readdirSync(target) { calls.push(['list', target]); return ['synthetic.json']; },
        },
        sortByName: () => undefined,
        readPresetsFromDirectory: () => ({ fileContents: ['{}'], fileNames: ['synthetic'] }),
        readAndParseFromDirectory: () => [{ synthetic: true }],
        ENABLE_EXTENSIONS: true, ENABLE_EXTENSIONS_AUTO_UPDATE: false, ENABLE_ACCOUNTS: true,
        ENABLE_REQUEST_COMPRESSION: false, REQUEST_COMPRESSION_MIN: 1, REQUEST_COMPRESSION_MAX: 2, REQUEST_COMPRESSION_TIMEOUT: 3,
        router: { post(route, fn) { assert.equal(route, '/get'); handler = fn; } },
    };
    vm.createContext(scope);
    vm.runInContext(`${loginMiddleware}\n${settingsRoute}`, scope);
    const root = path.resolve('C:/synthetic-settings');
    const request = { body: {}, user: { directories: { root, worlds: path.join(root, 'worlds') } } };
    function invoke(user = request.user, body = {}) {
        const res = response();
        scope.requireLoginMiddleware({ ...request, body, user }, res, () => handler({ ...request, body, user }, res));
        return res;
    }
    return { calls, invoke };
}

test('settings actual get advertises a fixed server capability alongside unchanged settings', () => {
    const original = JSON.stringify({ theme: 'synthetic' });
    const f = settingsFixture(original);
    const result = f.invoke();
    assert.equal(result.code, 200);
    assert.deepEqual(plain(result.body.homer_capabilities), { readonly_chat_header: true });
    assert.equal(result.body.settings, original);
    assert.equal(result.body.enable_extensions, true);
    assert.deepEqual(plain(result.body.world_names), ['synthetic']);
});

test('user settings and request body cannot override the server capability', () => {
    const original = JSON.stringify({ homer_capabilities: { readonly_chat_header: false, other: true } });
    const f = settingsFixture(original);
    const result = f.invoke(undefined, { homer_capabilities: { readonly_chat_header: false } });
    assert.deepEqual(plain(result.body.homer_capabilities), { readonly_chat_header: true });
    assert.equal(result.body.settings, original);
});

test('settings capability remains private and is not returned on a failed settings read', () => {
    const f = settingsFixture();
    assert.equal(f.invoke(null).code, 403);
    assert.deepEqual(f.calls, []);
    const broken = settingsFixture('{}', { readError: true }).invoke();
    assert.equal(broken.code, 500);
    assert.equal(broken.body, undefined);
});
