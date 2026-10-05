import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(begin, end) {
    const from = source.indexOf(begin), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
}
const message = () => ({ type: 'prepare-conversation', owner: 'owner', app_id: 'card', conversation_id: 'chat',
    engine_token: 'engine', document_token: 'document' });
function harness() {
    const reads = [], resources = [], marks = [];
    const c = vm.createContext({
        prewarmOnly: true, adminPreviewRequested: false, bridgeStartScheduled: false, requestedAppId: '', launch: null,
        hostBootstrapEngineToken: 'engine', hostBootstrapDocumentToken: 'document', owner: 'owner',
        storageAccountEpoch: 0,
        sessionPrefetchCache: new Map(), performance: { mark: name => marks.push(name) },
        prefetchSession: async (app, chat) => { reads.push([app, chat]); c.sessionPrefetchCache.set(app + '::' + chat, {}); },
        prepareConversationResources: (app, chat) => resources.push([app, chat]),
        canNotifyHost: () => true, HOST_CHANNEL: 'channel',
        window: { location: { origin: 'http://fixture.invalid' }, parent: {} },
    });
    c.reconcileStorageAccount = () => c.owner;
    vm.runInContext(section('function sessionCacheKey(', 'function invalidateCachedSession('), c);
    vm.runInContext(section('async function receiveHostCommand(', "window.addEventListener('message'"), c);
    return { c, reads, resources, marks };
}

test('actual cold preparation starts read-only work and retains only the selected existing target', () => {
    const h = harness(); h.c.sessionPrefetchCache.set('previous::chat', {});
    h.c.prepareColdConversation(message());
    assert.deepEqual(h.reads, [['card', 'chat']]); assert.deepEqual(h.resources, h.reads);
    assert.deepEqual([...h.c.sessionPrefetchCache.keys()], ['card::chat']);
    assert.equal(h.c.requestedAppId, ''); assert.equal(h.c.launch, null); assert.equal(h.c.bridgeStartScheduled, false);
});

for (const [property, value] of Object.entries({ prewarmOnly: false, adminPreviewRequested: true, bridgeStartScheduled: true,
    requestedAppId: 'bound', launch: {}, hostBootstrapEngineToken: '', owner: '' })) {
    test(`cold read rejects invalid state ${property}`, () => {
        const h = harness(); h.c[property] = value; h.c.prepareColdConversation(message());
        assert.equal(h.reads.length, 0); assert.equal(h.resources.length, 0);
    });
}
for (const [property, value] of Object.entries({ engine_token: 'old', document_token: 'old', owner: 'other',
    app_id: '', conversation_id: 'x'.repeat(161) })) {
    test(`cold read rejects invalid correlation ${property}`, () => {
        const h = harness(); h.c.prepareColdConversation({ ...message(), [property]: value });
        assert.equal(h.reads.length, 0);
    });
}

test('host command retains both origin and WindowProxy checks before speculative reads', async () => {
    const h = harness();
    const event = { origin: 'http://fixture.invalid', source: h.c.window.parent,
        data: { ...message(), channel: 'channel', version: 1 } };
    await h.c.receiveHostCommand({ ...event, origin: 'https://foreign.invalid' });
    await h.c.receiveHostCommand({ ...event, source: {} });
    assert.equal(h.reads.length, 0);
    await h.c.receiveHostCommand(event); assert.equal(h.reads.length, 1);
});

test('speculative read rejection is handled without applying a role or raising unhandled errors', async () => {
    const h = harness(); h.c.prefetchSession = async () => { throw Error('offline'); };
    h.c.prepareColdConversation(message()); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.c.launch, null); assert.equal(h.c.requestedAppId, '');
});

test('actual start consumes a prepared session once with its read fences and prepares config before eviction', async () => {
    const h = harness(), order = [], payload = { user: { id: 'owner' } }, prepared = {};
    Object.assign(h.c, { requestedAppId: 'card', requestedConversationId: 'chat', launchSessionPreloadPromise: null,
        boundBootstrapToken: 'bind', prewarmBootstrapPromise: Promise.resolve(),
        installKeywordInjector() {}, saveConversationExtensionSettings() {}, logDialogueEvent() {},
        runtimeGate: () => null, setRuntimeGate() {}, notifyHostLoading() {},
        prepareConversationResources: () => { order.push('configuration'); return prepared; },
        takePrefetchedSession: async () => { order.push('consume'); h.c.sessionPrefetchCache.clear(); return payload; },
        fetchSession: async () => { order.push('fresh'); return payload; },
        setAccessClasses() {}, captureExtensionSettingsBaseline() {}, installPresentationModeBridge() {},
        installRoleplayHubCompatibility() {}, installCardStageRuntime() {},
        bootstrapLaunch: async (got, _extensions, token, resources) => {
            assert.equal(got, payload); assert.equal(token, 'bind'); assert.equal(resources, prepared); order.push('bootstrap');
        },
    });
    h.c.sessionPrefetchCache.set('card::chat', {});
    vm.runInContext(section('async function startHomerBridge(', 'export async function init('), h.c);
    await h.c.startHomerBridge();
    assert.deepEqual(order, ['configuration', 'consume', 'bootstrap']);
    assert.equal(h.c.session, payload);
});
