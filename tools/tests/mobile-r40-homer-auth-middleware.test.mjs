import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the shipping middleware with isolated, non-network peripherals.
// Every cookie, user and token value below is a synthetic non-secret fixture.
const source = readFileSync(new URL('../../sillytavern-runtime/src/middleware/homerBridge.js', import.meta.url), 'utf8');
const usersSource = readFileSync(new URL('../../sillytavern-runtime/src/users.js', import.meta.url), 'utf8');
const clock = 2_000_000;
const loginUrl = 'https://fixture.invalid/app/login.html';
const backendUrl = 'https://fixture.invalid';
const session = (verifiedAt = clock - 10) => ({ handle: 'old-fixture-user', version: 'old-fixture-version',
    homerHandle: 'old-fixture-user', homerVerifiedAt: verifiedAt, csrfToken: 'synthetic-old-csrf',
    bootstrapFlag: 'preserve-unrelated-state' });
const request = ({ cookie = '', pathname = '/api/characters/get', state = session(), method = 'POST', internal = false } = {}) => ({
    method, path: pathname, session: state,
    headers: { ...(cookie ? { cookie } : {}), ...(internal ? { 'x-forwarded-prefix': '/module/dialogue/' } : {}) },
});
function responseRecorder() {
    return { statusCode: 200, body: undefined, location: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        sendStatus(code) { this.statusCode = code; return this; },
        redirect(location) { this.statusCode = 302; this.location = location; return this; } };
}

function harness({ enabled = true, status = 200, identity = { handle: 'new-fixture-user', name: 'Fixture user', is_admin: false },
    fetchError = null, userError = null } = {}) {
    const requests = [], provisioned = [], warnings = [], userReads = [];
    const config = { 'homerBridge.enabled': enabled, 'homerBridge.backendBaseUrl': backendUrl,
        'homerBridge.authCookieName': 'fixture-cookie', 'homerBridge.loginUrl': loginUrl,
        'homerBridge.verificationTtlSeconds': 60, 'homerBridge.requestTimeoutMs': 3000 };
    const context = vm.createContext({ URL, AbortController, process: { env: {} }, Date: { now: () => clock },
        getConfigValue: (name, fallback) => Object.hasOwn(config, name) ? config[name] : fallback,
        setTimeout: () => 1, clearTimeout: () => {},
        console: { warn: (...args) => warnings.push(args), error: () => {} },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (fetchError) throw fetchError;
            return { status, ok: status >= 200 && status < 300, json: async () => ({ data: { user: identity } }) };
        },
        ensureExternalUser: async (...args) => {
            provisioned.push(args);
            if (userError) throw userError;
            return { handle: args[0], name: args[1], is_admin: args[2] };
        },
        getAccountVersion: () => 'new-fixture-version',
        ENABLE_ACCOUNTS: true,
        storage: { getItem: async key => { userReads.push(key); return null; } },
        toKey: value => value, getUserDirectories: () => { throw Error('Unexpected private directory read'); },
    });
    const code = source.replace(/^import .*;\r?\n/gm, '')
        .replace('export default async function homerBridgeMiddleware', 'async function homerBridgeMiddleware');
    vm.runInContext(`${code}\nglobalThis.middleware = homerBridgeMiddleware;`, context);
    const start = usersSource.indexOf('export async function setUserDataMiddleware(');
    const end = usersSource.indexOf('\n/**', start);
    assert.ok(start >= 0 && end > start, 'Shipping downstream setUserDataMiddleware exists');
    vm.runInContext(usersSource.slice(start, end).replace('export async function', 'async function'), context);
    return { middleware: context.middleware, setUserData: context.setUserDataMiddleware,
        requests, provisioned, warnings, userReads };
}

function assertAnonymous(req) {
    assert.ok(req.session && typeof req.session === 'object');
    for (const key of ['handle', 'version', 'homerHandle', 'homerVerifiedAt', 'csrfToken']) {
        assert.equal(Object.hasOwn(req.session, key), false, `${key} must not survive authentication loss`);
    }
    assert.equal(req.user, undefined);
}

test('missing website cookie rejects a private API before even a fresh runtime verification TTL', async () => {
    const h = harness(), req = request(); req.user = { profile: { handle: 'old-fixture-user' } };
    const res = responseRecorder(); let next = 0;
    await h.middleware(req, res, () => { next++; });
    assert.equal(res.statusCode, 401);
    assert.equal(next, 0); assert.equal(h.requests.length, 0); assert.equal(h.provisioned.length, 0);
    assertAnonymous(req);
    assert.equal(req.session.bootstrapFlag, 'preserve-unrelated-state');
});

test('expired runtime identity with no website cookie returns 401, never next(null) into user middleware', async () => {
    const h = harness(), req = request({ state: session(clock - 60_000) }), res = responseRecorder(); let next = 0;
    await h.middleware(req, res, async () => { next++; await h.setUserData(req, res, () => {}); });
    assert.equal(res.statusCode, 401); assert.equal(next, 0);
    assertAnonymous(req); assert.equal(h.userReads.length, 0);
});

test('missing/empty/unrelated cookies reject all private API methods and the old runtime login endpoint', async () => {
    for (const cookie of ['', 'unrelated=synthetic', 'fixture-cookie=', 'fixture-cookie=   ']) {
        for (const pathname of ['/api', '/api/homer/session', '/api/characters/get', '/api/users/login', '/api/settings/get']) {
            for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
                const h = harness(), req = request({ cookie, pathname, method }), res = responseRecorder();
                await h.middleware(req, res, () => assert.fail('Private request must terminate'));
                assert.equal(res.statusCode, 401); assertAnonymous(req);
                assert.equal(h.requests.length, 0);
            }
        }
    }
});

test('null or missing runtime sessions cannot turn unauthenticated private requests into 500', async () => {
    for (const state of [null, undefined]) {
        const h = harness(), req = request(), res = responseRecorder(); req.session = state;
        await h.middleware(req, res, () => assert.fail('Must return 401'));
        assert.equal(res.statusCode, 401); assertAnonymous(req);
    }
});

test('anonymous CSRF bootstrap keeps a session but discards stale private identity before downstream user middleware', async () => {
    for (const state of [session(), session(clock - 60_000), {}, null]) {
        const h = harness(), req = request({ pathname: '/csrf-token', method: 'GET', state }), res = responseRecorder(); let next = 0;
        await h.middleware(req, res, async () => {
            next++;
            await h.setUserData(req, res, () => { res.json({ token: 'synthetic-new-anonymous-csrf' }); });
        });
        assert.equal(next, 1); assert.equal(res.statusCode, 200);
        assert.equal(res.body.token, 'synthetic-new-anonymous-csrf');
        assertAnonymous(req); assert.equal(h.requests.length, 0); assert.equal(h.userReads.length, 0);
    }
});

test('anonymous static/bootstrap assets still continue without a null session or old user directories', async () => {
    for (const pathname of ['/scripts/templates.js', '/lib/sha256.browser.mjs', '/style.css', '/favicon.ico']) {
        const h = harness(), req = request({ pathname, method: 'GET' }), res = responseRecorder(); let next = 0;
        await h.middleware(req, res, async () => { next++; await h.setUserData(req, res, () => {}); });
        assert.equal(next, 1); assert.equal(res.statusCode, 200); assertAnonymous(req);
        assert.equal(h.userReads.length, 0); assert.equal(h.requests.length, 0);
    }
});

test('external runtime document navigation preserves the original website-owned redirect', async () => {
    for (const pathname of ['/', '/index.html', '/login']) {
        for (const method of ['GET', 'HEAD']) {
            const h = harness(), req = request({ pathname, method }), res = responseRecorder();
            await h.middleware(req, res, () => assert.fail('External document should redirect'));
            assert.equal(res.statusCode, 302);
            assert.equal(res.location, pathname === '/login' ? loginUrl : `${backendUrl}/app/chat.html`);
            assert.equal(h.requests.length, 0); assertAnonymous(req);
        }
    }
});

test('internal runtime documents without identity retain the existing login redirect', async () => {
    for (const pathname of ['/', '/login']) {
        const h = harness(), req = request({ pathname, method: 'GET', internal: true }), res = responseRecorder();
        await h.middleware(req, res, () => assert.fail('Should redirect to the website login'));
        assert.equal(res.location, loginUrl); assertAnonymous(req);
    }
});

for (const status of [401, 403]) {
    test(`authoritative identity HTTP ${status} clears expired identity and terminates the private API with 401`, async () => {
        const h = harness({ status }), req = request({ cookie: 'fixture-cookie=synthetic-website-cookie', state: session(clock - 60_000) });
        const res = responseRecorder(); req.user = { profile: { handle: 'old-fixture-user' } };
        await h.middleware(req, res, () => assert.fail('Rejected identity must not continue'));
        assert.equal(res.statusCode, 401); assertAnonymous(req);
        assert.equal(h.requests.length, 1); assert.equal(h.provisioned.length, 0);
        assert.equal(h.requests[0].options.headers.Cookie, 'fixture-cookie=synthetic-website-cookie');
    });
    test(`identity HTTP ${status} still permits anonymous CSRF without any old runtime user`, async () => {
        const h = harness({ status }), req = request({ pathname: '/csrf-token', method: 'GET',
            cookie: 'fixture-cookie=synthetic-website-cookie', state: session(clock - 60_000) });
        const res = responseRecorder(); let next = 0;
        await h.middleware(req, res, async () => { next++; await h.setUserData(req, res, () => {}); });
        assert.equal(next, 1); assert.equal(res.statusCode, 200); assertAnonymous(req);
        assert.equal(h.userReads.length, 0);
    });
}

test('a present website cookie and a still-fresh identity retain the existing TTL fast path', async () => {
    const h = harness(), req = request({ cookie: 'unrelated=synthetic; fixture-cookie=synthetic-value=with-padding' });
    const res = responseRecorder(), original = req.session; let next = 0;
    await h.middleware(req, res, () => { next++; });
    assert.equal(next, 1); assert.equal(h.requests.length, 0); assert.equal(req.session, original);
    assert.equal(req.session.handle, 'old-fixture-user'); assert.equal(res.statusCode, 200);
});

test('expired or anonymous session with a valid website cookie still provisions the verified current user', async () => {
    for (const state of [session(clock - 60_000), {}, null]) {
        const h = harness(), req = request({ cookie: 'fixture-cookie=synthetic-value=with-padding', state }), res = responseRecorder(); let next = 0;
        await h.middleware(req, res, () => { next++; });
        assert.equal(next, 1); assert.equal(h.requests.length, 1);
        assert.deepEqual(h.provisioned[0], ['new-fixture-user', 'Fixture user', false]);
        assert.equal(req.session.handle, 'new-fixture-user'); assert.equal(req.session.version, 'new-fixture-version');
        assert.equal(req.session.homerHandle, 'new-fixture-user'); assert.equal(req.session.homerVerifiedAt, clock);
        assert.equal(h.requests[0].options.headers.Cookie, 'fixture-cookie=synthetic-value=with-padding');
    }
});

test('backend transport/non-auth errors retain the prior fallback policy rather than becoming authoritative logout', async () => {
    for (const config of [{ fetchError: Error('Synthetic unavailable') }, { status: 500 },
        { identity: {} }, { userError: Error('Synthetic provisioning unavailable') }]) {
        const h = harness(config), req = request({ cookie: 'fixture-cookie=synthetic', state: session(clock - 60_000) });
        const before = { ...req.session }, res = responseRecorder(); let next = 0;
        await h.middleware(req, res, () => { next++; });
        assert.equal(next, 1); assert.equal(res.statusCode, 200); assert.deepEqual(req.session, before);
    }
});

test('bridge disabled leaves regular runtime authentication and public routes unchanged', async () => {
    const h = harness({ enabled: false }), req = request(), original = req.session, res = responseRecorder(); let next = 0;
    await h.middleware(req, res, () => { next++; });
    assert.equal(next, 1); assert.equal(req.session, original); assert.equal(h.requests.length, 0);
    assert.equal(res.statusCode, 200);
});
