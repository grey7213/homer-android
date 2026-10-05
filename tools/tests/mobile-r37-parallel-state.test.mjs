import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createChatOutbox } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';

const source = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
    assert.ok(begin >= 0 && finish > begin, 'Actual bridge section not found: ' + start);
    return source.slice(begin, finish);
}
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const scope = (owner = 'test-owner', app = 'test-target', conv = 'test-conversation') => JSON.stringify([owner, app, conv]);

function harness() {
    const indexedDB = transactionIDB(), outbox = createChatOutbox({ indexedDB, databaseName: 'r37-state' });
    const requests = [], applied = [], events = [], rules = [];
    const context = {
        launch: { app_id: 'old-card', conversation_id: 'old-conversation' },
        session: { user: { id: 'test-owner' } }, owner: 'test-owner', storageAccountEpoch: 0,
        reconcileStorageAccount: () => context.owner,
        cloudSyncScope: () => scope(context.session.user.id, context.launch.app_id, context.launch.conversation_id),
        queryString: (app, conv) => new URLSearchParams({ app_id: app, conversation_id: conv }).toString(),
        chatOutbox: outbox, cloneJsonObject: clone, synchronizeJsonContainer: (target, values) => Object.assign(target, clone(values)),
        extensionSettingsBaseline: { memory: { enabled: false } }, extension_settings: {},
        replaceExtensionSettings: value => { context.extension_settings = clone(value); applied.push(clone(value)); },
        extensionSettingsSnapshot: () => ({ signature: JSON.stringify(context.extension_settings) }),
        extensionSettingsScope: () => context.cloudSyncScope(), lastExtensionSettingsScope: '', lastExtensionSettingsSignature: '',
        runtimeVariables: {}, applicationReady: true, conversationExtensionSettings: null, reaffirmExtensionSettingsAfterReady: false,
        event_types: { SETTINGS_LOADED: 'settings-loaded' }, eventSource: { emit: async event => events.push(event) },
        conversationModelSettings: () => ({ model_id: context.runtimeVariables.homer_model_settings?.model_id || 'model-a' }),
        setOfficialDisplayRules: payload => { rules.push(payload); return { count: payload.scripts?.length || 0, errors: [] }; },
        officialRegexState: {}, URLSearchParams, showHostNotice() {},
        refreshAdminConfiguration: async () => { throw new Error('Not an administrator preview'); },
        requestJson: async path => {
            requests.push(path);
            return path.startsWith('/api/homer/regex') ? { scripts: [{ id: 'test-rule' }] }
                : { variables: { homer_model_settings: { model_id: 'model-a' }, test: 'cloud' }, extension_settings: { memory: { enabled: true } } };
        },
    };
    vm.createContext(context);
    vm.runInContext(section('async function loadRuntimeState(', 'async function persistRuntimeVariables('), context);
    const bind = (app = 'test-target', conv = 'test-conversation') => { context.launch = { app_id: app, conversation_id: conv }; };
    return { context, outbox, requests, applied, events, rules, bind };
}

test('target runtime read begins under immutable target scope before old launch leaves, without applying it', async () => {
    const h = harness(), network = deferred(), reached = deferred();
    h.context.requestJson = async path => { h.requests.push(path); reached.resolve(); return network.promise; };
    const ticket = h.context.prepareRuntimeState('test-target', 'test-conversation');
    await reached.promise;
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0], /app_id=test-target&conversation_id=test-conversation/);
    assert.equal(h.context.launch.app_id, 'old-card');
    assert.equal(h.applied.length, 0);
    network.resolve({ variables: {}, extension_settings: {} });
    assert.equal((await ticket.pending).error, undefined);
});

test('runtime state consumes the exact prestarted response and keeps real local fence semantics', async () => {
    const h = harness();
    const ticket = h.context.prepareRuntimeState('test-target', 'test-conversation');
    await ticket.pending;
    await h.outbox.prepare({ scope: scope(), body: JSON.stringify({ app_id: 'test-target', conversation_id: 'test-conversation',
        extension_settings: { memory: { enabled: true, savedLocally: 'newer edit' } } }) }, 'extension-settings');
    h.bind();
    await h.context.loadRuntimeState(ticket);
    assert.equal(h.requests.filter(path => path.includes('/runtime-state?')).length, 1);
    assert.equal(h.context.extension_settings.memory.savedLocally, 'newer edit');
    assert.equal(h.context.runtimeVariables.test, 'cloud');
    assert.equal(h.events.length, 1);
});

test('unused target read rejection is handled even when leave or session activation fails', async () => {
    const h = harness();
    h.context.requestJson = async () => { throw new Error('synthetic target fetch failure'); };
    const ticket = h.context.prepareRuntimeState('test-target', 'test-conversation');
    await turn();
    const outcome = await ticket.pending;
    assert.match(outcome.error.message, /synthetic target fetch failure/);
    assert.equal(h.applied.length, 0);
    h.bind();
    await assert.rejects(h.context.loadRuntimeState(ticket), /synthetic target fetch failure/);
});

test('foreign owner, logout epoch and wrong target reject prepared state before extension application', async () => {
    for (const mode of ['owner', 'epoch', 'target']) {
        const h = harness(), ticket = h.context.prepareRuntimeState('test-target', 'test-conversation');
        await ticket.pending;
        h.bind();
        if (mode === 'owner') { h.context.owner = 'other-owner'; h.context.session.user.id = 'other-owner'; }
        if (mode === 'epoch') h.context.storageAccountEpoch++;
        if (mode === 'target') h.bind('different-card', 'different-conversation');
        await assert.rejects(h.context.loadRuntimeState(ticket), /会话|账号/);
        assert.equal(h.applied.length, 0);
    }
});

test('account change during local preflight cannot send target read under a different cookie account', async () => {
    const h = harness(), gate = deferred(), reached = deferred();
    const fence = h.outbox.fence.bind(h.outbox);
    h.outbox.fence = async (...args) => { const value = await fence(...args); reached.resolve(); await gate.promise; return value; };
    const ticket = h.context.prepareRuntimeState('test-target', 'test-conversation');
    await reached.promise; h.context.owner = 'other-owner'; h.context.storageAccountEpoch++; gate.resolve();
    assert.ok((await ticket.pending).error);
    assert.equal(h.requests.length, 0);
});

test('official regex starts while SETTINGS_LOADED is held, after effective variables are installed', async () => {
    const h = harness(), eventGate = deferred(), eventReached = deferred();
    h.bind();
    h.context.eventSource.emit = async event => {
        assert.equal(h.context.runtimeVariables.homer_model_settings.model_id, 'model-a');
        h.events.push(event); eventReached.resolve(); await eventGate.promise;
    };
    const work = h.context.loadRuntimeState();
    await eventReached.promise; await turn();
    assert.ok(h.requests.some(path => path.includes('/regex?') && path.includes('model=model-a')));
    eventGate.resolve(); await work;
});

test('first-use catalog can settle beside SETTINGS_LOADED but regex never reads an empty old catalog', async () => {
    const h = harness(), catalog = deferred(), eventGate = deferred(), eventReached = deferred();
    h.bind(); let catalogReady = false;
    h.context.conversationModelSettings = () => ({ model_id: catalogReady ? 'model-a' : '' });
    h.context.eventSource.emit = async () => { eventReached.resolve(); await eventGate.promise; };
    const work = h.context.loadRuntimeState(null, catalog.promise);
    await eventReached.promise; await turn();
    assert.equal(h.requests.filter(path => path.includes('/regex?')).length, 0);
    catalogReady = true; catalog.resolve(); await turn();
    assert.ok(h.requests.some(path => path.includes('/regex?') && path.includes('model=model-a')));
    eventGate.resolve(); await work;
});

test('SETTINGS_LOADED changing effective model forces fresh matching regex, not old model output', async () => {
    const h = harness(), firstRegex = deferred(), firstReached = deferred();
    h.bind();
    h.context.requestJson = async path => {
        h.requests.push(path);
        if (!path.includes('/regex?')) return { variables: { homer_model_settings: { model_id: 'model-a' } }, extension_settings: {} };
        if (path.includes('model=model-a')) { firstReached.resolve(); return firstRegex.promise; }
        return { scripts: [{ id: 'model-b-rule' }] };
    };
    h.context.eventSource.emit = async () => { await firstReached.promise; h.context.runtimeVariables.homer_model_settings.model_id = 'model-b'; };
    const work = h.context.loadRuntimeState();
    await firstReached.promise; await turn(); firstRegex.resolve({ scripts: [{ id: 'old-model-a-rule' }] });
    await work;
    assert.ok(h.requests.some(path => path.includes('model=model-b')));
    assert.equal(h.rules.some(payload => payload.scripts?.some(rule => rule.id === 'old-model-a-rule')), false);
    assert.equal(h.rules.at(-1).scripts[0].id, 'model-b-rule');
});

test('late regex from the old launch cannot overwrite an activated different conversation', async () => {
    const h = harness(), gate = deferred(), reached = deferred();
    h.bind();
    h.context.requestJson = async path => { h.requests.push(path); reached.resolve(); return gate.promise; };
    const work = h.context.refreshOfficialRegex('model-a');
    await reached.promise; h.bind('new-card', 'new-conversation');
    gate.resolve({ scripts: [{ id: 'stale-rule' }] }); await work;
    assert.equal(h.rules.some(payload => payload.scripts?.some(rule => rule.id === 'stale-rule')), false);
});
