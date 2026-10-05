import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sessionVM } from './helpers/bridge-session-vm.mjs';
import { createCardPreparationCache } from '../../sillytavern-runtime/public/scripts/homer-stable-template.mjs';

// Actual bridge/session/core functions; controlled HTTP/DOM/storage boundaries.
// Synthetic accounts/cards only. This is neither native timing nor model QA.
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
function section(source, begin, end) {
    const start = source.indexOf(begin), finish = source.indexOf(end, start + begin.length);
    assert.ok(start >= 0 && finish > start, 'Actual shipping section: ' + begin);
    return source.slice(start, finish).replace(/^export /gm, '');
}
const clone = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const targets = [{ app_id: 'synthetic-a', conversation_id: 'synthetic-chat-a' }, { app_id: 'synthetic-b', conversation_id: 'synthetic-chat-b' }];
const avatar = app => `homer-${String(app).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'character'}.png`;

function fixture() {
    let now = 100, sessionHandler = null, mirrorHandler = null, readHandler = null;
    const requests = [], mirrorReads = [], fences = [], effects = [], characters = [], stored = new Map();
    const login = new Map([['ai_xingyue_logged_in', '1'], ['ai_xingyue_user', JSON.stringify({ id: 'owner' })]]);
    const preparationCache = createCardPreparationCache();
    const sourceCard = app => ({ spec: 'chara_card_v2', data: { name: app,
        description: 'Synthetic complete source', character_book: { entries: [{ content: 'synthetic-lore' }] },
        extensions: { unknown: { keep: '完整 source' }, regex_scripts: [{ findRegex: 'a', replaceString: 'b' }] } } });
    const payload = (app, conversation) => ({ user: { id: 'owner' }, launch: {
        app_id: app, conversation_id: conversation, bridge_token: 'synthetic-only', card: sourceCard(app),
        messages: [{ id: 'synthetic-message', content: 'Synthetic authoritative cloud row' }] } });
    const mirror = (app, card = sourceCard(app), marker = {}) => ({ avatar: avatar(app), name: '<b>Synthetic</b>', chat: 'local-chat',
        json_data: JSON.stringify(card), data: { ...clone(card.data), extensions: { ...clone(card.data.extensions),
            homer_bridge: { app_id: app, card_signature: preparationCache.prepare(JSON.stringify(['owner', app]), card).signature, ...marker } } } });
    for (const target of targets) stored.set(avatar(target.app_id), mirror(target.app_id));
    const c = sessionVM(bridge, {
        Date: class extends Date { static now() { return now; } }, performance: { mark() {} },
        prewarmOnly: true, adminPreviewRequested: false, adminBinding: false, bridgeStartScheduled: false,
        requestedAppId: '', requestedConversationId: '', launch: null, session: null,
        hostBootstrapEngineToken: 'engine', hostBootstrapDocumentToken: 'document',
        storageOwner: 'owner', SESSION_CACHE_TTL_MS: 30_000, SESSION_PREFETCH_LIMIT: 2,
        clearCardTransportMemory() {}, AbortController, File: globalThis.File, FormData: globalThis.FormData, setTimeout, clearTimeout,
        localStorage: { getItem: key => login.get(key) || null },
        cardPreparations: preparationCache, characters,
        chatOutbox: { fence: async scope => { fences.push(scope); return { revision: 0, ackRevision: 0, commitId: null }; },
            read: async (...args) => readHandler ? readHandler(...args) : null },
        DOMPurify: { sanitize: value => value.replace(/<[^>]+>/g, '') }, toastr: { error() {} }, t: strings => strings.join(''),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        openLaunchCharacterChat: async index => {
            const item = characters[index], wanted = preparationCache.prepare(JSON.stringify(['owner', c.launch.app_id]), c.launch.card);
            assert.equal(item.data.extensions.homer_bridge.app_id, c.launch.app_id);
            assert.equal(item.data.extensions.homer_bridge.card_signature, wanted.signature);
            effects.push('activate');
        },
        syncLaunchCharacterAvatar: async () => { effects.push('cover'); },
        prepareRuntimeState: (app, conversation) => ({ owner: 'owner', epoch: c.storageAccountEpoch,
            scope: JSON.stringify(['owner', app, conversation]), pending: Promise.resolve({ value: { state: { variables: {} } } }) }),
        prepareRuntimeModels: (app, conversation) => ({ owner: 'owner', epoch: c.storageAccountEpoch,
            scope: JSON.stringify(['owner', app, conversation]), pending: Promise.resolve({ value: { list: [] } }) }),
        payloadList: value => value.list || [], selectRuntimeModelId: () => 'synthetic-model',
        requestJson: async path => {
            if (path.startsWith('/api/homer/regex?')) return { list: [] };
            requests.push(path);
            const query = new URL(path, 'http://fixture.invalid').searchParams;
            return sessionHandler ? sessionHandler(path, query) : payload(query.get('app_id'), query.get('conversation_id'));
        },
        fetch: async (path, options) => {
            if (path === '/api/characters/import') {
                effects.push('import'); const card = JSON.parse(await options.body.get('avatar').text());
                const file = options.body.get('preserved_name') + '.png';
                stored.set(file, { ...card, avatar: file, chat: 'local-chat' });
                return { ok: true, status: 200, json: async () => ({ file_name: file }) };
            }
            assert.equal(path, '/api/characters/get', 'No whole-catalog or private writer is a preparation dependency');
            const name = JSON.parse(options.body).avatar_url;
            mirrorReads.push(name); const index = mirrorReads.length;
            if (mirrorHandler) return mirrorHandler(name, index);
            return { ok: stored.has(name), status: stored.has(name) ? 200 : 404, json: async () => clone(stored.get(name)) };
        },
        requestCachedCharacter: (name, options) => {
            assert.equal(options.owner, 'owner');
            return options.fetcher('/api/characters/get', { headers: options.headers, body: JSON.stringify({ avatar_url: name }) });
        },
    });
    c.getContext = () => ({ characters, getOneCharacter: (...args) => c.getOneCharacter(...args), getRequestHeaders: c.getRequestHeaders });
    vm.runInContext([
        section(bridge, 'function sessionCacheKey(', 'function scheduleSessionPrefetch('),
        section(bridge, 'function prepareConversationResources(', 'async function refreshOfficialRegex('),
        section(core, 'const preparedCharacterReads =', 'export function getCharacterSource('),
        section(bridge, 'function cloneCardWithMarker(', 'async function waitForStableCharacterForm('),
        section(bridge, 'async function importLaunchCardJson(', 'function normalizeOpeningMessage('),
    ].join('\n'), c);
    const message = extra => ({ targets: clone(targets), owner: 'owner', engine_token: 'engine', document_token: 'document', expires_at: now + 30_000, ...extra });
    const prepare = extra => c.prepareColdHistoryConversations(message(extra));
    const entry = (app = targets[0].app_id, conversation = targets[0].conversation_id) => c.sessionPrefetchCache.get(c.sessionCacheKey(app, conversation));
    async function settle() {
        await Promise.allSettled([...c.sessionPrefetchCache.values()].map(row => row.promise)); await turn();
        await Promise.all([...c.sessionPrefetchCache.values()].map(row => row.characterPreparation?.pending));
    }
    async function select(app = targets[0].app_id, conversation = targets[0].conversation_id) {
        c.prepareColdConversation({ owner: 'owner', engine_token: 'engine', document_token: 'document', app_id: app, conversation_id: conversation });
        const resources = entry(app, conversation)?.resources;
        const data = await c.takePrefetchedSession(app, conversation);
        c.requestedAppId = app; c.requestedConversationId = conversation; c.bridgeStartScheduled = true;
        c.session = data; c.launch = data.launch;
        const read = c.prepareInitialCharacterRead(resources?.character);
        return { data, resources, read, consume: () => c.importLaunchCharacter({ reuseActiveCharacter: true, initialRead: read }) };
    }
    return { c, requests, mirrorReads, fences, effects, characters, stored, payload, mirror, message, prepare, entry, settle, select,
        tick(amount) { now += amount; }, setSession(handler) { sessionHandler = handler; },
        setMirror(handler) { mirrorHandler = handler; }, setLocalRead(handler) { readHandler = handler; },
        changeOwner(owner) { login.set('ai_xingyue_logged_in', owner ? '1' : '0'); login.set('ai_xingyue_user', JSON.stringify({ id: owner })); c.reconcileStorageAccount(); } };
}

test('two authenticated empty-host peers read exact mirrors without characters publication or side effects', async () => {
    const h = fixture(); h.prepare(); await h.settle();
    assert.deepEqual(h.mirrorReads, targets.map(t => avatar(t.app_id))); assert.equal(h.requests.length, 2);
    assert.deepEqual(h.fences.map(JSON.parse), targets.map(t => ['owner', t.app_id, t.conversation_id]));
    assert.equal(h.c.sessionPrefetchCache.size, 2); assert.deepEqual(h.characters, []); assert.deepEqual(h.effects, []);
    assert.equal(h.c.launch, null); assert.equal(h.c.session, null);
    for (const target of targets) {
        const row = h.entry(target.app_id, target.conversation_id), payload = await row.promise;
        assert.equal(h.c.sessionReadFences.get(payload).raw, true, 'Optional mirror read does not consume the local/cloud fence');
        assert.equal(row.resources.character, row.characterPreparation);
    }
});

test('read-only mirror starts beside session, but original authenticated session and save fence must settle before handoff', async () => {
    const h = fixture(), gate = deferred(); h.setSession(async (_path, q) => { await gate.promise; return h.payload(q.get('app_id'), q.get('conversation_id')); });
    h.prepare(); await turn(); assert.equal(h.fences.length, 2); assert.equal(h.mirrorReads.length, 2);
    assert.equal(h.entry().characterPreparation.payload, null); assert.deepEqual(h.characters, []); assert.deepEqual(h.effects, []);
    gate.resolve(); await h.settle(); assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.effects, []);
});

test('valid selected target reuses original core ticket through take deletion and publishes only during real binding', async () => {
    const h = fixture(); h.prepare(); await h.settle();
    const original = h.entry().characterPreparation, selected = await h.select();
    assert.equal(h.c.sessionPrefetchCache.size, 0); assert.equal(selected.read.optionalPreparation, original);
    assert.deepEqual(h.characters, []); await selected.consume();
    assert.equal(h.mirrorReads.filter(n => n === avatar(targets[0].app_id)).length, 1);
    assert.deepEqual(h.effects, ['activate']); assert.equal(original.claimed, true);
    assert.equal(h.characters[0].json_data, JSON.stringify(selected.data.launch.card));
    await assert.rejects(h.c.getOneCharacter(original.avatar, { cacheOwner: 'owner', preparedRead: original.read }), /票据/);
});

test('pending core ticket is awaited once rather than starting a duplicate selected request', async () => {
    const h = fixture(), gate = deferred(); h.setMirror(async name => { await gate.promise; return { ok: true, status: 200, json: async () => clone(h.stored.get(name)) }; });
    h.prepare({ targets: [targets[0]] }); await turn(); assert.equal(h.mirrorReads.length, 1);
    const selected = await h.select(), work = selected.consume(); await turn();
    assert.equal(h.mirrorReads.length, 1); assert.deepEqual(h.characters, []);
    gate.resolve(); await work; assert.equal(h.mirrorReads.length, 1); assert.deepEqual(h.effects, ['activate']);
});

test('history deadline is the original smaller expiry and repeated messages cannot renew it', async () => {
    const h = fixture(); h.prepare({ expires_at: 200 }); await h.settle(); const first = h.entry().characterPreparation;
    assert.equal(first.expiresAt, 200); h.tick(20); h.prepare(); await h.settle();
    assert.equal(h.entry().characterPreparation, first); assert.equal(first.expiresAt, 200); assert.equal(h.mirrorReads.length, 2);
});

test('a later selected target cancels an evicted peer before its late session can authorize a handoff', async () => {
    const h = fixture(), gate = deferred(); h.setSession(async (_path, q) => { await gate.promise; return h.payload(q.get('app_id'), q.get('conversation_id')); });
    h.prepare(); const peer = h.entry(targets[1].app_id, targets[1].conversation_id).characterPreparation;
    h.c.prepareColdConversation({ owner: 'owner', engine_token: 'engine', document_token: 'document', ...targets[0] });
    assert.equal(peer.cancelled, true); gate.resolve(); await h.settle(); await peer.pending;
    assert.deepEqual(h.mirrorReads, targets.map(t => avatar(t.app_id))); assert.equal(peer.payload, null);
    assert.equal(peer.isCurrent(), false); assert.deepEqual(h.characters, []); assert.deepEqual(h.effects, []);
});

for (const mode of ['owner', 'epoch']) test(`late ${mode} changes prevent optional read publication and admission`, async () => {
    const h = fixture(), gate = deferred(); h.setMirror(async name => { await gate.promise; return { ok: true, status: 200, json: async () => clone(h.stored.get(name)) }; });
    h.prepare({ targets: [targets[0]] }); await turn(); const ticket = h.entry().characterPreparation;
    if (mode === 'owner') h.changeOwner('other'); else h.c.invalidateStorageAccount();
    gate.resolve(); await ticket.pending; assert.equal(ticket.isCurrent(), false);
    assert.deepEqual(h.characters, []); assert.deepEqual(h.effects, []);
});

test('expired optional response during selected await falls back to one normal fresh read', async () => {
    const h = fixture(), gate = deferred(); h.prepare({ targets: [targets[0]], expires_at: 150 });
    h.setMirror(async (name, index) => { if (index === 1) await gate.promise; return { ok: true, status: 200, json: async () => clone(h.stored.get(name)) }; });
    await turn(); const selected = await h.select(), work = selected.consume(); h.tick(100); gate.resolve(); await work;
    assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.effects, ['activate']);
});

test('an optional read that never settles is bounded by its original deadline and cannot wedge selection', async () => {
    const h = fixture(), gate = deferred();
    h.setMirror(async (name, index) => { if (index === 1) await gate.promise; return { ok: true, status: 200, json: async () => clone(h.stored.get(name)) }; });
    h.prepare({ targets: [targets[0]], expires_at: 110 }); await turn();
    const optional = h.entry().characterPreparation, selected = await h.select(); await selected.consume();
    assert.equal(optional.cancelled, true); assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.effects, ['activate']);
    gate.resolve(); await optional.pending; assert.equal(h.mirrorReads.length, 2); assert.equal(h.characters.length, 1);
});

for (const field of ['owner', 'app', 'conversation']) test(`mirror bytes cannot acquire a handoff if parallel session fails ${field} authorization`, async () => {
    const h = fixture(); h.setSession((_path, q) => {
        const row = h.payload(q.get('app_id'), q.get('conversation_id'));
        if (field === 'owner') row.user.id = 'foreign';
        if (field === 'app') row.launch.app_id = 'foreign';
        if (field === 'conversation') row.launch.conversation_id = 'foreign';
        return row;
    });
    h.prepare({ targets: [targets[0]] }); const optional = h.entry().characterPreparation;
    await optional.pending; assert.equal(optional.payload, null); assert.deepEqual(h.characters, []); assert.deepEqual(h.effects, []);
});

for (const status of [401, 403, 404, 500]) test(`optional HTTP ${status} is discarded; successful selected fresh read recovers`, async () => {
    const h = fixture(); h.setMirror(async (name, index) => index === 1 ? { ok: false, status } : { ok: true, status: 200, json: async () => clone(h.stored.get(name)) });
    h.prepare({ targets: [targets[0]] }); await h.settle(); const selected = await h.select(); await selected.consume();
    assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.effects, ['activate']);
});

for (const status of [401, 403, 500]) test(`genuine selected HTTP ${status} remains failure and never becomes import`, async () => {
    const h = fixture(); h.setMirror(async () => ({ ok: false, status })); h.prepare({ targets: [targets[0]] }); await h.settle();
    const selected = await h.select(); await assert.rejects(selected.consume(), new RegExp(`HTTP ${status}`));
    assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.characters, []); assert.deepEqual(h.effects, []);
});

test('failed optional transport settles and normal selected read recovers without importing', async () => {
    const h = fixture(); h.setMirror(async (name, index) => { if (index === 1) throw Error('Synthetic optional read failed'); return { ok: true, status: 200, json: async () => clone(h.stored.get(name)) }; });
    h.prepare({ targets: [targets[0]] }); await h.settle(); const selected = await h.select(); await selected.consume();
    assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.effects, ['activate']);
});

test('only a genuine selected 404 follows the unchanged import then exact fresh read path', async () => {
    const h = fixture(); h.stored.delete(avatar(targets[0].app_id));
    h.prepare({ targets: [targets[0]] }); await h.settle(); const selected = await h.select(); await selected.consume();
    assert.equal(h.mirrorReads.length, 3); assert.deepEqual(h.effects, ['import', 'cover', 'activate']);
    assert.equal(h.characters[0].data.extensions.unknown.keep, '完整 source');
});

test('wrong optional avatar cannot be published and normal selected exact-avatar read recovers', async () => {
    const h = fixture(); h.setMirror(async (name, index) => ({ ok: true, status: 200, json: async () => ({ ...clone(h.stored.get(name)), avatar: index === 1 ? 'wrong.png' : name }) }));
    h.prepare({ targets: [targets[0]] }); await h.settle(); const selected = await h.select(); await selected.consume();
    assert.equal(h.mirrorReads.length, 2); assert.equal(h.characters[0].avatar, avatar(targets[0].app_id)); assert.deepEqual(h.effects, ['activate']);
});

test('same avatar filename with another app marker still follows original full-source reimport before activation', async () => {
    const h = fixture(); h.stored.set(avatar(targets[0].app_id), h.mirror('synthetic-a!', h.payload(targets[0].app_id, targets[0].conversation_id).launch.card));
    h.prepare({ targets: [targets[0]] }); await h.settle(); const selected = await h.select(); await selected.consume();
    assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.effects, ['import', 'cover', 'activate']);
    assert.equal(h.characters[0].data.extensions.homer_bridge.app_id, targets[0].app_id);
});

test('fresh source change after optional mirror read is reimported using the complete changed card', async () => {
    const h = fixture(); h.setSession((_path, q) => { const value = h.payload(q.get('app_id'), q.get('conversation_id')); value.launch.card.data.extensions.unknown.new = 'fresh revision'; return value; });
    h.prepare({ targets: [targets[0]] }); await h.settle(); const selected = await h.select(); await selected.consume();
    assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.effects, ['import', 'cover', 'activate']);
    assert.equal(h.characters[0].data.extensions.unknown.new, 'fresh revision');
    assert.equal(h.characters[0].data.character_book.entries[0].content, 'synthetic-lore');
});

test('a new payload from local projection or fresh refetch never claims an old payload ticket', async () => {
    const h = fixture(); h.prepare({ targets: [targets[0]] }); await h.settle(); const row = h.entry(), original = row.characterPreparation;
    const prefer = h.c.preferLocalSession; h.c.preferLocalSession = async (...args) => clone(await prefer(...args));
    const selected = await h.select(); assert.notEqual(selected.data, original.payload); assert.equal(selected.read.optionalPreparation, undefined);
    await selected.consume(); assert.equal(original.claimed, false); assert.equal(h.mirrorReads.length, 2); assert.deepEqual(h.effects, ['activate']);
});

test('legacy separator-colliding batch is rejected atomically without even session or mirror reads', async () => {
    const h = fixture(); h.prepare({ targets: [{ app_id: 'a::b', conversation_id: 'c' }, { app_id: 'a', conversation_id: 'b::c' }] });
    await h.settle(); assert.deepEqual(h.requests, []); assert.deepEqual(h.mirrorReads, []); assert.equal(h.c.sessionPrefetchCache.size, 0);
});

test('unchanged original save/ACK consumption refetch rejects the stale optional ticket', async () => {
    const h = fixture(); h.prepare({ targets: [targets[0]] }); await h.settle(); const original = h.entry().characterPreparation;
    let used = false; const prefer = h.c.preferLocalSession;
    h.c.preferLocalSession = async (...args) => { if (!used) { used = true; const error = Error('Synthetic pending newer save'); error.code = 'HOMER_STALE_STORAGE_READ'; throw error; } return prefer(...args); };
    const selected = await h.select(); assert.notEqual(selected.data, original.payload); await selected.consume();
    assert.equal(h.requests.length, 2); assert.equal(h.fences.length, 2); assert.equal(h.mirrorReads.length, 2);
    assert.equal(original.claimed, false); assert.deepEqual(h.effects, ['activate']);
});

test('source wiring keeps mirror preparation in cold helpers and actual publication after extensions', () => {
    const bootstrap = section(bridge, 'async function bootstrapLaunch(', 'async function startHomerBridge(');
    assert.ok(bootstrap.indexOf('prepareInitialCharacterRead(preparedResources?.character)') > bootstrap.indexOf('launch = session.launch'));
    assert.ok(bootstrap.indexOf('await administratorExtensionsPromise') < bootstrap.indexOf('await importLaunchCharacter'));
    const warm = section(bridge, 'function scheduleSessionPrefetch(', 'function setAccessClasses(');
    assert.ok(!warm.includes('prepareColdCharacterRead'), 'Normal warm peer preparation is unchanged');
});
