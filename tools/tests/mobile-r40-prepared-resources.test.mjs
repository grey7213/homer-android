import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';
import { emptyLocalSessions } from './helpers/bridge-session-vm.mjs';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a > 0 && b > a); return source.slice(a, b);
}
const clone = value => JSON.parse(JSON.stringify(value));
const scope = (app = 'target', conv = 'target-chat') => JSON.stringify(['fixture-owner', app, conv]);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness(t) {
    const calls = [], events = [], applied = [], rules = [];
    let now = Date.now();
    const outbox = createChatOutbox({ indexedDB: transactionIDB(), databaseName: 'r40-resources' });
    t.after(() => outbox.close());
    const c = {
        owner: 'fixture-owner', storageAccountEpoch: 1, launch: { app_id: 'old', conversation_id: 'old-chat' },
        sessionPrefetchCache: new Map(), Date: { now: () => now }, URLSearchParams,
        reconcileStorageAccount: () => c.owner, cloudSyncScope: () => JSON.stringify([c.owner, c.launch.app_id, c.launch.conversation_id]),
        sessionCacheKey: (app, conv) => `${app}::${conv}`,
        queryString: (app, conv) => new URLSearchParams({ app_id: app, conversation_id: conv }).toString(),
        requestJson: async path => {
            calls.push(path);
            if (path.includes('/runtime-state?')) return { variables: { homer_model_settings: { model_id: 'chosen' } }, extension_settings: { memory: { enabled: true } } };
            if (path === '/api/homer/models') return { list: [{ id: 'off', enabled: false }, { id: 'chosen', name: 'visible' }], default_id: 'chosen' };
            return { scripts: [{ id: 'rule', findRegex: 'x', replaceString: 'y' }] };
        },
        chatOutbox: outbox, localSessions: emptyLocalSessions(), cloneJsonObject: clone, synchronizeJsonContainer: (a, b) => Object.assign(a, clone(b)),
        extensionSettingsBaseline: { memory: { enabled: false } }, extension_settings: {}, runtimeVariables: {},
        runtimeUiData: { models: [], modelDefaultId: '' }, payloadList: data => Array.isArray(data) ? data : data?.list || [],
        replaceExtensionSettings: value => { c.extension_settings = clone(value); applied.push(clone(value)); },
        extensionSettingsSnapshot: () => ({ signature: JSON.stringify(c.extension_settings) }), extensionSettingsScope: () => c.cloudSyncScope(),
        lastExtensionSettingsScope: '', lastExtensionSettingsSignature: '', conversationExtensionSettings: null,
        applicationReady: true, reaffirmExtensionSettingsAfterReady: false,
        eventSource: { emit: async event => { events.push(event); } }, event_types: { SETTINGS_LOADED: 'settings' },
        conversationModelSettings: () => ({ model_id: c.selectRuntimeModelId(c.runtimeVariables, c.runtimeUiData.models, c.runtimeUiData.modelDefaultId) }),
        setOfficialDisplayRules: payload => { rules.push(clone(payload)); return { count: payload.scripts?.length || 0, errors: [] }; },
        officialRegexState: {}, showHostNotice() {}, loadConversationMods() {}, refreshAdminConfiguration() { throw Error('no admin fixture'); },
    };
    vm.createContext(c);
    vm.runInContext([
        section('function selectRuntimeModelId(', 'function selectedModel('),
        section('async function loadRuntimeState(', 'async function persistRuntimeVariables('),
        section('function prepareRuntimeModels(', 'let modLoadController;'),
    ].join('\n'), c);
    const entry = { expiresAt: Date.now() + 30_000, promise: Promise.resolve({}) };
    c.sessionPrefetchCache.set('target::target-chat', entry);
    const bind = () => { c.launch = { app_id: 'target', conversation_id: 'target-chat' }; };
    const apply = async resources => {
        bind(); const models = c.loadRuntimeUiData(resources.models);
        await Promise.all([models, c.loadRuntimeState(resources.state, models, resources.regex)]);
    };
    return { c, calls, events, applied, rules, entry, outbox, bind, apply, advance: () => { now += 31_000; }, prepare: () => c.prepareConversationResources('target', 'target-chat') };
}

test('bounded peer prepares state/models/matching rules without activation and consumption makes no duplicate reads', async t => {
    const h = harness(t), prepared = h.prepare(); await prepared.regex.pending;
    assert.equal(h.c.launch.app_id, 'old'); assert.equal(h.events.length, 0); assert.equal(h.applied.length, 0); assert.equal(h.rules.length, 0);
    assert.equal(h.calls.length, 3); assert.equal(h.prepare(), prepared);
    await h.apply(prepared);
    assert.equal(h.calls.length, 3); assert.equal(h.events.length, 1);
    assert.equal(h.c.runtimeUiData.models.length, 1); assert.equal(h.c.extension_settings.memory.enabled, true);
    assert.equal(h.rules.at(-1).scripts[0].id, 'rule');
});

test('local edits after the prefetched state fence still win when the target is consumed', async t => {
    const h = harness(t), prepared = h.prepare(); await prepared.regex.pending;
    await h.outbox.prepare({ scope: scope(), body: JSON.stringify({ app_id: 'target', conversation_id: 'target-chat', extension_settings: { memory: { enabled: true, newest: 'local' } } }) }, 'extension-settings');
    await h.apply(prepared);
    assert.equal(h.c.extension_settings.memory.newest, 'local');
});

for (const reason of ['expiry', 'owner', 'epoch', 'evicted']) {
    test(`peer resources are not reusable after ${reason}`, async t => {
        const h = harness(t), old = h.prepare(); await old.regex.pending;
        if (reason === 'expiry') h.entry.expiresAt = 0;
        if (reason === 'owner') h.c.owner = 'other-fixture-owner';
        if (reason === 'epoch') h.c.storageAccountEpoch++;
        if (reason === 'evicted') h.c.sessionPrefetchCache.clear();
        const next = h.prepare(); assert.notEqual(next, old); await next.regex.pending;
        if (reason === 'owner' || reason === 'epoch') await assert.rejects(h.apply(old), /会话/);
    });
}

test('failed speculative preparation is discarded and a user click can retry immediately', async t => {
    const h = harness(t), request = h.c.requestJson;
    h.c.requestJson = async path => { if (path.includes('/runtime-state?')) throw Error('offline'); return request(path); };
    const first = h.prepare(); assert.ok((await first.regex.pending).error);
    await Promise.resolve(); assert.equal(h.entry.resources, undefined);
    h.c.requestJson = request;
    const next = h.prepare(); assert.notEqual(first, next); await h.apply(next);
    assert.equal(h.rules.at(-1).scripts[0].id, 'rule');
});

test('logout while state is in flight prevents even the speculative regex request', async t => {
    const h = harness(t), gate = deferred(), request = h.c.requestJson;
    h.c.requestJson = async path => path.includes('/runtime-state?') ? gate.promise : request(path);
    const prepared = h.prepare(); await new Promise(resolve => setImmediate(resolve));
    h.c.storageAccountEpoch++; gate.resolve({ variables: {}, extension_settings: {} });
    assert.ok((await prepared.regex.pending).error);
    assert.equal(h.calls.filter(path => path.includes('/regex?')).length, 0);
    assert.equal(h.applied.length, 0);
});

test('a settings listener selecting another model forces a fresh matching regex read', async t => {
    const h = harness(t), prepared = h.prepare(); await prepared.regex.pending;
    h.c.eventSource.emit = async () => { h.c.runtimeUiData.models.push({ id: 'changed' }); h.c.runtimeVariables.homer_model_settings.model_id = 'changed'; };
    await h.apply(prepared);
    assert.ok(h.calls.some(path => path.includes('/regex?') && path.includes('model=changed')));
});

test('the generation path still requests current official rules instead of retaining the prepared snapshot', async t => {
    const h = harness(t), prepared = h.prepare(); await h.apply(prepared);
    const before = h.calls.filter(path => path.includes('/regex?')).length;
    await h.c.refreshOfficialRegex();
    assert.equal(h.calls.filter(path => path.includes('/regex?')).length, before + 1);
});

test('unverified empty owner performs no speculative server reads', async t => {
    const h = harness(t); h.c.owner = '';
    const prepared = h.prepare(); assert.ok((await prepared.regex.pending).error);
    assert.equal(h.calls.length, 0);
});

test('resources expiring during the leave barrier are all fetched again at consumption', async t => {
    const h = harness(t), old = h.prepare(); await old.regex.pending;
    assert.equal(h.calls.length, 3); h.advance();
    await h.apply(old);
    assert.equal(h.calls.filter(path => path.includes('/runtime-state?')).length, 2);
    assert.equal(h.calls.filter(path => path === '/api/homer/models').length, 2);
    assert.equal(h.calls.filter(path => path.includes('/regex?')).length, 2);
});

for (const pendingKind of ['state', 'models', 'regex']) {
    test(`expiry while awaiting prepared ${pendingKind} triggers a fresh read before application`, async t => {
        const h = harness(t), resources = h.prepare(); await resources.regex.pending; h.bind();
        const ticket = resources[pendingKind], held = deferred();
        const old = { ...ticket, pending: held.promise };
        h.c.runtimeUiData.models = [{ id: 'chosen' }]; h.c.runtimeVariables = { homer_model_settings: { model_id: 'chosen' } };
        let work;
        if (pendingKind === 'state') work = h.c.loadRuntimeState(old);
        if (pendingKind === 'models') work = h.c.loadRuntimeUiData(old);
        if (pendingKind === 'regex') work = h.c.refreshOfficialRegex('chosen', old);
        await Promise.resolve(); h.advance(); held.resolve(await ticket.pending); await work;
        const matches = path => pendingKind === 'state' ? path.includes('/runtime-state?') : pendingKind === 'models' ? path === '/api/homer/models' : path.includes('/regex?');
        assert.equal(h.calls.filter(matches).length, 2);
    });
}

test('expiry during the local settings-fence read also reloads before replacing extension settings', async t => {
    const h = harness(t), resources = h.prepare(); await resources.regex.pending; h.bind();
    h.c.runtimeUiData.models = [{ id: 'chosen' }];
    const reached = deferred(), held = deferred(), original = h.outbox.read.bind(h.outbox);
    let once = true;
    h.outbox.read = async (...args) => {
        if (once) { once = false; reached.resolve(); await held.promise; }
        return original(...args);
    };
    const work = h.c.loadRuntimeState(resources.state, Promise.resolve(), resources.regex);
    await reached.promise; assert.equal(h.applied.length, 0); h.advance(); held.resolve(); await work;
    assert.equal(h.calls.filter(path => path.includes('/runtime-state?')).length, 2);
    assert.equal(h.applied.length, 1);
});
