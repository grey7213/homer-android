import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const begin = source.indexOf('function prepareRuntimeModels(');
const end = source.indexOf('\nlet modLoadController;', begin);
assert.ok(begin > 0 && end > begin);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const catalog = { list: [{ id: 'disabled', enabled: false }, { id: 'actual-model', name: 'Visible name' }], default_id: 'actual-model' };

function harness() {
    const calls = [];
    const context = {
        owner: 'verified-owner', storageAccountEpoch: 0,
        reconcileStorageAccount: () => context.owner,
        launch: { app_id: 'old-card', conversation_id: 'old-chat' },
        runtimeUiData: { conversations: [{ id: 'preserved-history' }] },
        requestJson: async path => { calls.push(path); return catalog; },
        loadConversationMods: () => calls.push('mods'),
        payloadList: value => value?.list || [],
    };
    vm.createContext(context); vm.runInContext(source.slice(begin, end), context);
    return { context, calls, bind: () => { context.launch = { app_id: 'target-card', conversation_id: 'target-chat' }; } };
}

test('fresh actual model catalog starts beside old-session leave without changing any model UI', async () => {
    const h = harness(), network = deferred();
    h.context.requestJson = async path => { h.calls.push(path); return network.promise; };
    const ticket = h.context.prepareRuntimeModels('target-card', 'target-chat');
    assert.deepEqual(h.calls, ['/api/homer/models']);
    assert.equal(h.context.launch.app_id, 'old-card');
    assert.equal(h.context.runtimeUiData.models, undefined);
    assert.ok(Object.isFrozen(ticket));
    h.bind(); const work = h.context.loadRuntimeUiData(ticket);
    network.resolve(catalog); await work;
    assert.equal(h.calls.filter(path => path === '/api/homer/models').length, 1);
    assert.equal(h.context.runtimeUiData.models.length, 1);
    assert.equal(h.context.runtimeUiData.models[0].name, 'Visible name');
    assert.equal(h.context.runtimeUiData.modelDefaultId, 'actual-model');
    assert.equal(h.context.runtimeUiData.conversations[0].id, 'preserved-history');
});

for (const change of ['owner', 'epoch', 'target']) {
    test(`prepared catalog rejects ${change} change before starting optional Mod work or applying IDs`, async () => {
        const h = harness(), ticket = h.context.prepareRuntimeModels('target-card', 'target-chat');
        await ticket.pending; h.bind();
        if (change === 'owner') h.context.owner = 'different-owner';
        if (change === 'epoch') h.context.storageAccountEpoch++;
        if (change === 'target') h.context.launch.conversation_id = 'different-chat';
        await assert.rejects(h.context.loadRuntimeUiData(ticket), /会话/);
        assert.equal(h.context.runtimeUiData.models, undefined);
        assert.equal(h.calls.includes('mods'), false);
    });
}

for (const change of ['owner', 'epoch', 'launch']) {
    test(`late catalog cannot replace current IDs after ${change} changes during response`, async () => {
        const h = harness(), network = deferred(); h.context.requestJson = async () => network.promise;
        h.bind(); const ticket = h.context.prepareRuntimeModels('target-card', 'target-chat');
        const work = h.context.loadRuntimeUiData(ticket);
        if (change === 'owner') h.context.owner = 'different-owner';
        if (change === 'epoch') h.context.storageAccountEpoch++;
        if (change === 'launch') h.context.launch = { ...h.context.launch };
        network.resolve(catalog); await work;
        assert.equal(h.context.runtimeUiData.models, undefined);
    });
}

test('discarded rejected prestarted catalog is handled, and ordinary failure retains old empty-catalog behavior', async () => {
    const h = harness(); h.context.requestJson = async () => { throw new Error('isolated unavailable catalog'); };
    const unused = h.context.prepareRuntimeModels('target-card', 'target-chat');
    assert.match((await unused.pending).error.message, /isolated/);
    h.bind(); await h.context.loadRuntimeUiData();
    assert.equal(h.context.runtimeUiData.models.length, 0);
    assert.equal(h.context.runtimeUiData.modelDefaultId, '');
    assert.equal(h.context.runtimeUiData.conversations[0].id, 'preserved-history');
});

test('unverified account cannot send a fresh catalog request', async () => {
    const h = harness(); h.context.owner = '';
    const ticket = h.context.prepareRuntimeModels('target-card', 'target-chat');
    assert.ok((await ticket.pending).error);
    assert.equal(h.calls.length, 0);
});

test('ordinary startup and admin-shaped scope keep the same one-read flow without leaving optional Mods blocking', async () => {
    const h = harness(); h.context.launch = { app_id: 'preview-card', conversation_id: '', admin_preview: true };
    await h.context.loadRuntimeUiData();
    assert.equal(h.calls.filter(path => path === '/api/homer/models').length, 1);
    assert.equal(h.calls.filter(path => path === 'mods').length, 1);
    assert.equal(h.context.runtimeUiData.models[0].id, 'actual-model');
});
