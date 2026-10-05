import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCardTransport } from '../../sillytavern-runtime/public/scripts/homer-card-transport.mjs';
import { createCardTransportCache } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const REV = 'a'.repeat(64), NEW_REV = 'b'.repeat(64);
const card = { name: 'Synthetic fixture', data: { name: 'Synthetic fixture', character_book: {
    entries: [{ keys: ['synthetic'], content: 'complete synthetic world' }] }, extensions: { scripts: ['synthetic-only'] } } };
const mirror = { ...card, avatar: 'synthetic.png', json_data: JSON.stringify(card), unknown: { keep: true }, chat: 'synthetic' };
const stats = { chat_size: 10, date_last_chat: 20 };
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = body => ({ ok: true, status: 200, json: async () => copy(body) });
function body(kind, hit, revision = REV) {
    if (kind === 'session-card') return { user: { id: 'fixture-owner' }, launch: { app_id: 'fixture-card',
        conversation_id: 'fixture-chat', bridge_token: 'synthetic-nonsecret-token', messages: [{ content: 'fresh synthetic cloud' }],
        card_transport: { version: 1, sha256: revision }, ...(hit ? {} : { card: copy(card) }) } };
    return { homer_character_transport: { version: 2, sha256: revision, ...(hit ? { not_modified: true } : {}) },
        fresh_stats: stats, ...(hit ? {} : { character: copy(mirror) }) };
}
function harness(kind = 'session-card', { timeout = 1000, initiallyCurrent = true } = {}) {
    const gate = deferred(), calls = [], writes = []; let clock = 100, epoch = initiallyCurrent ? 0 : 1;
    const snapshotEpoch = 0, id = kind === 'session-card' ? 'fixture-card' : 'synthetic.png';
    let onRevision;
    const storage = { read(_owner, _kind, _id, options) { onRevision = options.onRevision; onRevision(hint()); return gate.promise; },
        write: async (...args) => { writes.push(args); } };
    function hint() { return { owner: 'fixture-owner', kind, id, entryId: 'synthetic-entry', revision: REV, expiresAt: 500 }; }
    const replies = [body(kind, true)];
    const online = async (path, config) => {
        calls.push({ path, json: config ? JSON.parse(config.body) : null });
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        const value = typeof reply === 'function' ? await reply() : reply;
        return kind === 'session-card' ? copy(value) : value?.ok === false ? value : response(value);
    };
    const api = createCardTransport({ storage, now: () => clock, readTimeoutMs: timeout });
    const common = { owner: 'fixture-owner', isCurrent: () => epoch === snapshotEpoch };
    const run = () => kind === 'session-card' ? api.session('/api/homer/session?app_id=fixture-card&conversation_id=fixture-chat', {
        ...common, appId: id, conversationId: 'fixture-chat', request: online, validate: payload => assert.equal(payload.user.id, 'fixture-owner'),
    }) : api.character(id, { ...common, headers: {}, fetcher: online });
    return { kind, calls, writes, replies, gate, storage, run, hint, emit: value => onRevision(value),
        row: () => ({ payload: copy(kind === 'session-card' ? card : mirror), revision: REV, expiresAt: 500 }),
        stale: () => { epoch++; }, aba: () => { epoch += 2; }, expire: () => { clock = 1000; } };
}
function knownRevision(h, index = 0) { return h.kind === 'session-card' ? new URL(h.calls[index].path, 'http://fixture.invalid').searchParams.get('card_sha256') : h.calls[index].json.card_sha256 || null; }
async function sourceOf(h, value) { return h.kind === 'session-card' ? value.launch.card : (await value.json()); }

for (const kind of ['session-card', 'character-content-v2']) {
    test(`${kind}: conditional authorization starts before held body verification, which still gates restoration`, async () => {
        const h = harness(kind); let settled = false;
        const pending = h.run().then(value => { settled = true; return value; });
        assert.equal(h.calls.length, 1); assert.equal(knownRevision(h), REV);
        await turn(); assert.equal(settled, false, 'A metadata hint is not a usable cached body');
        h.gate.resolve(h.row());
        const value = await sourceOf(h, await pending);
        assert.deepEqual(value, kind === 'session-card' ? card : { ...mirror, ...stats });
        assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
    });
    test(`${kind}: full online response does not wait for optional held cache verification`, async () => {
        const h = harness(kind); h.replies[0] = body(kind, false, NEW_REV);
        const value = await sourceOf(h, await h.run());
        assert.deepEqual(value, kind === 'session-card' ? card : { ...mirror, ...stats });
        assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 1);
        h.emit(h.hint()); h.gate.resolve(h.row()); await turn(); assert.equal(h.calls.length, 1);
    });
    for (const failure of ['null', 'rejected', 'expired']) test(`${kind}: ${failure} complete validation retries one full read, never restores hint`, async () => {
        const h = harness(kind); h.replies.push(body(kind, false)); const pending = h.run();
        await turn(); assert.equal(h.calls.length, 1);
        if (failure === 'rejected') h.gate.reject(Error('Synthetic cache digest failure'));
        else { if (failure === 'expired') h.expire(); h.gate.resolve(failure === 'null' ? null : h.row()); }
        await sourceOf(h, await pending);
        assert.equal(h.calls.length, 2); assert.equal(knownRevision(h, 1), null);
        h.emit(h.hint()); await turn(); assert.equal(h.calls.length, 2);
    });
    test(`${kind}: owner ABA after early request prevents cache restoration and retry`, async () => {
        const h = harness(kind); const pending = h.run(); await turn();
        h.aba(); h.gate.resolve(h.row());
        await assert.rejects(pending, /账号或会话已变化/); assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
    });
    test(`${kind}: hint/body/server revision mismatch never substitutes a different verified row`, async () => {
        const h = harness(kind); h.replies.push(body(kind, false, NEW_REV));
        const pending = h.run(); h.gate.resolve({ ...h.row(), revision: NEW_REV });
        await sourceOf(h, await pending); assert.equal(h.calls.length, 2); assert.equal(knownRevision(h, 1), null);
    });
    test(`${kind}: storage timeout and later hint cannot dispatch a second first request`, async () => {
        const h = harness(kind, { timeout: 10 });
        h.storage.read = (_owner, _kind, _id, options) => { h.delayedHint = options.onRevision; return h.gate.promise; };
        h.replies[0] = body(kind, false);
        const pending = h.run(); assert.equal(h.calls.length, 0);
        await pending; assert.equal(h.calls.length, 1); assert.equal(knownRevision(h), null);
        h.delayedHint(h.hint()); h.gate.resolve(h.row()); await turn(); assert.equal(h.calls.length, 1);
    });
    test(`${kind}: early conditional hit followed by body timeout uses only one full fallback`, async () => {
        const h = harness(kind, { timeout: 10 }); h.replies.push(body(kind, false));
        await h.run(); assert.equal(h.calls.length, 2); assert.equal(knownRevision(h), REV); assert.equal(knownRevision(h, 1), null);
        h.emit(h.hint()); h.gate.resolve(h.row()); await turn(); assert.equal(h.calls.length, 2);
    });
    test(`${kind}: validation after startup deadline but before slow authorized reply reuses complete cache`, async () => {
        const h = harness(kind, { timeout: 10 }), network = deferred(); h.replies[0] = () => network.promise;
        const pending = h.run(); assert.equal(h.calls.length, 1); assert.equal(knownRevision(h), REV);
        await wait(25); h.gate.resolve(h.row()); await turn();
        network.resolve(body(kind, true));
        assert.deepEqual(await sourceOf(h, await pending), kind === 'session-card' ? card : { ...mirror, ...stats });
        assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
    });
    test(`${kind}: not-modified reply starts a separate bounded wait for unfinished complete validation`, async () => {
        const h = harness(kind, { timeout: 30 }), network = deferred(); h.replies[0] = () => network.promise;
        let settled = false;
        const pending = h.run().then(value => { settled = true; return value; });
        await wait(45); network.resolve(body(kind, true)); await turn();
        assert.equal(settled, false); assert.equal(h.calls.length, 1);
        h.gate.resolve(h.row());
        assert.deepEqual(await sourceOf(h, await pending), kind === 'session-card' ? card : { ...mirror, ...stats });
        assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
    });
    test(`${kind}: late validation cannot outlive the response-relative wait or dispatch a third request`, async () => {
        const h = harness(kind, { timeout: 10 }), network = deferred(); h.replies[0] = () => network.promise;
        h.replies.push(body(kind, false));
        const pending = h.run(); await wait(25); assert.equal(h.calls.length, 1);
        network.resolve(body(kind, true));
        await pending; assert.equal(h.calls.length, 2); assert.equal(knownRevision(h, 1), null);
        h.gate.reject(Error('Late complete validation failure')); h.emit(h.hint()); await turn();
        assert.equal(h.calls.length, 2); assert.equal(h.writes.length, 1);
    });
    test(`${kind}: late owner ABA cannot restore cache or issue a fallback after a slow authorized reply`, async () => {
        const h = harness(kind, { timeout: 10 }), network = deferred(); h.replies[0] = () => network.promise;
        const pending = h.run(); await wait(25); network.resolve(body(kind, true)); await turn();
        h.aba(); h.gate.resolve(h.row());
        await assert.rejects(pending, /账号或会话已变化/); assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
    });
    test(`${kind}: TTL expiring during the response-relative wait still forces one fresh full read`, async () => {
        const h = harness(kind, { timeout: 10 }), network = deferred(); h.replies[0] = () => network.promise;
        h.replies.push(body(kind, false));
        const pending = h.run(); await wait(25); network.resolve(body(kind, true)); await turn();
        h.expire(); h.gate.resolve(h.row()); await pending;
        assert.equal(h.calls.length, 2); assert.equal(knownRevision(h, 1), null);
    });
}

test('malformed or foreign metadata hints do not start a request or provide a cached body', async () => {
    const mutations = [hint => { hint.owner = 'other'; }, hint => { hint.kind = 'character-content-v2'; },
        hint => { hint.id = 'other'; }, hint => { hint.entryId = ''; }, hint => { hint.revision = 'INVALID'; },
        hint => { hint.expiresAt = 100; }, hint => { hint.expiresAt = Infinity; }];
    for (const mutate of mutations) {
        const h = harness(); h.storage.read = (_owner, _kind, _id, options) => {
            const hint = h.hint(); mutate(hint); options.onRevision(hint); return h.gate.promise;
        };
        h.replies[0] = body('session-card', false);
        const pending = h.run(); assert.equal(h.calls.length, 0);
        h.gate.resolve(null); await pending; assert.equal(h.calls.length, 1); assert.equal(knownRevision(h), null);
    }
});

for (const status of [401, 403, 404, 500]) {
    test(`mirror HTTP ${status} stays authoritative while body validation is still held`, async () => {
        const h = harness('character-content-v2'); h.replies[0] = { ok: false, status };
        assert.equal((await h.run()).status, status); assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
        h.gate.reject(Error('Late optional cache failure')); await turn(); assert.equal(h.calls.length, 1);
    });
    test(`session HTTP ${status} rejection cannot be turned into a cached success or retry`, async () => {
        const h = harness(); h.replies[0] = Error(`HTTP ${status} synthetic`);
        await assert.rejects(h.run(), new RegExp(String(status))); assert.equal(h.calls.length, 1);
        h.gate.reject(Error('Late optional cache failure')); await turn(); assert.equal(h.calls.length, 1);
    });
}

test('an initially invalid owner guard neither reads online nor produces an unhandled flight rejection', async () => {
    const h = harness('session-card', { initiallyCurrent: false });
    await assert.rejects(h.run(), /账号或会话已变化/); assert.equal(h.calls.length, 0);
    h.gate.resolve(h.row()); await turn(); assert.equal(h.calls.length, 0);
});

test('actual cache transaction emits early metadata, but corrupt complete bytes force fresh online body', async () => {
    const indexedDB = cardTransportIDB(), databaseName = 'synthetic-overlap';
    const storage = createCardTransportCache({ indexedDB, databaseName, now: () => 100 });
    const revision = createHash('sha256').update(JSON.stringify(card)).digest('hex');
    await storage.write('fixture-owner', 'session-card', 'fixture-card', revision, card);
    storage.clearMemory(); // Exercise cold IDB metadata/body overlap, not the opt-in verified L1.
    const row = indexedDB.dump(databaseName, 'entries')[0]; row.payload.data.name = 'Altered synthetic fixture';
    indexedDB.seed(databaseName, 'entries', row.key, row);
    const gate = indexedDB.holdNextCommit('readonly'), calls = [];
    const api = createCardTransport({ storage, now: () => 100, readTimeoutMs: 1000 });
    const pending = api.session('/api/homer/session', { owner: 'fixture-owner', appId: 'fixture-card', conversationId: 'fixture-chat',
        isCurrent: () => true, validate() {}, request: async path => {
            calls.push(path); return body('session-card', calls.length === 1, revision);
        } });
    await gate.reached; assert.equal(calls.length, 1); assert.match(calls[0], new RegExp(`card_sha256=${revision}`));
    gate.release(); const result = await pending;
    assert.deepEqual(result.launch.card, card); assert.equal(calls.length, 2); assert.doesNotMatch(calls[1], /card_sha256/);
});

for (const kind of ['session-card', 'character-content-v2']) for (const mode of ['native', 'missing', 'throws']) {
    test(`${kind}: ${mode} structured clone retains complete JSON source and isolates live mutations`, async () => {
        const payload = { spec: 'chara_card_v3', data: { name: 'Synthetic complete source',
            description: '字😀\\\"\n'.repeat(65536), first_mes: 'Synthetic opening',
            character_book: { entries: [{ keys: ['synthetic'], content: 'Complete world source',
                extensions: { unknown: { keep: [1, true, null, '字'] } } }] },
            extensions: { regex_scripts: [{ findRegex: '/synthetic/g', replaceString: '```html\n<!doctype html><html><body><script>window.SYNTHETIC=true;<\/script></body></html>\n```' }],
                scripts: [{ source: 'Synthetic-only full script', enabled: true }] } }, unknown: { values: [1, null, 'retain'] } };
        if (kind !== 'session-card') Object.assign(payload, { avatar: 'synthetic.png', chat: 'synthetic', json_data: JSON.stringify(payload) });
        const expected = JSON.parse(JSON.stringify(payload));
        const storage = { read: async () => ({ payload, revision: REV, expiresAt: 500 }), write: async () => assert.fail('A hit must not write cache') };
        const api = createCardTransport({ storage, now: () => 100, readTimeoutMs: 20 });
        const originalClone = globalThis.structuredClone, originalStringify = JSON.stringify;
        let cloneCalls = 0, sourceSerializations = 0, restored;
        try {
            globalThis.structuredClone = mode === 'missing' ? undefined : value => {
                if (value === payload) cloneCalls++;
                if (mode === 'throws') throw Error('Synthetic old-WebView clone failure');
                return originalClone(value);
            };
            JSON.stringify = function (value, ...args) {
                if (value === payload) sourceSerializations++;
                return Reflect.apply(originalStringify, JSON, [value, ...args]);
            };
            const common = { owner: 'fixture-owner', isCurrent: () => true };
            if (kind === 'session-card') {
                const value = await api.session('/api/homer/session', { ...common, appId: 'fixture-card', conversationId: 'fixture-chat',
                    validate() {}, request: async () => body(kind, true) });
                restored = value.launch.card;
            } else {
                const value = await api.character('synthetic.png', { ...common, headers: {},
                    fetcher: async () => ({ ok: true, status: 200, json: async () => body(kind, true) }) });
                restored = await value.json();
            }
        } finally { globalThis.structuredClone = originalClone; JSON.stringify = originalStringify; }
        assert.deepEqual(restored, kind === 'session-card' ? expected : { ...expected, ...stats });
        assert.equal(cloneCalls, mode === 'missing' ? 0 : 1);
        assert.equal(sourceSerializations, mode === 'native' ? 0 : 1);
        assert.notEqual(restored, payload); assert.notEqual(restored.data, payload.data);
        restored.data.description = 'Live change';
        restored.data.character_book.entries[0].content = 'Live world change';
        restored.data.extensions.regex_scripts[0].replaceString = 'Live frontend change';
        restored.unknown.values.push('Live unknown change');
        assert.deepEqual(payload, expected, 'Full cached source is not mutable through the live character');
    });
}
