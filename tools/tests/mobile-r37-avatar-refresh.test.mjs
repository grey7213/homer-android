import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bridge = await readFile(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const begin = bridge.indexOf('async function syncLaunchCharacterAvatar(');
const end = bridge.indexOf('\nasync function importLaunchCardJson(', begin);
assert(begin > 0 && end > begin);
let helper;
try { helper = await import('../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-avatar-refresh.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

class ImageFixture extends EventTarget {
    constructor(src, complete = false) {
        super(); this.original = src; this.value = src; this.complete = complete; this.isConnected = true; this.writes = [];
    }
    getAttribute(name) { return name === 'src' ? this.value : null; }
    get src() { return this.value; }
    set src(value) { this.value = value; this.complete = false; this.writes.push(value); }
    finish(event = 'load') { this.complete = true; this.dispatchEvent(new Event(event)); }
}
function harness({ complete = false, coverHold, uploadHold } = {}) {
    const image = new ImageFixture('/thumbnail?type=avatar&file=homer-fixture.png&homer_cover=old&homer_cover=older#fragment', complete);
    const character = { avatar: 'homer-fixture.png', data: { extensions: { homer_bridge: { app_id: 'fixture-card', card_signature: 'revision-one' } } } };
    const markers = new Map(), requests = [];
    const scope = {
        launch: { app_id: 'fixture-card', card: { data: { extensions: { homer_cover_url: '/cover-fixture.png' } } } },
        owner: 'fixture-owner', storageAccountEpoch: 1,
        reconcileStorageAccount: () => scope.owner,
        getContext: () => ({ characters: [character] }),
        getManagedCoverUrl: () => scope.launch.card.data.extensions.homer_cover_url,
        accountStorage: { getItem: key => markers.get(key), setItem: (key, value) => markers.set(key, value) },
        getRequestHeaders: () => ({ fixture: 'no-credentials' }),
        FormData, File, Date, URL, HTMLImageElement: ImageFixture,
        document: { querySelectorAll: () => [image] }, window: { location: { href: 'https://fixture.invalid/module/dialogue/' } },
        location: { href: 'https://fixture.invalid/module/dialogue/' },
        MODULE_ID: 'avatar-unit', console: { warn() {} },
        refreshSettledAvatarImages: (...args) => {
            assert.equal(typeof helper?.refreshSettledAvatarImages, 'function');
            return helper.refreshSettledAvatarImages(...args);
        },
        fetch: async (url, options) => {
            requests.push({ url, method: options?.method, avatar: options?.body?.get('avatar_url') });
            if (options?.method === 'POST') return uploadHold ? uploadHold.promise : { ok: true };
            if (coverHold) return coverHold.promise;
            return { ok: true, blob: async () => new Blob(['synthetic image'], { type: 'image/png' }) };
        },
    };
    vm.createContext(scope); vm.runInContext(bridge.slice(begin, end), scope);
    return { scope, character, image, requests, markers };
}

test('successful upload does not cancel a pending old thumbnail; refresh follows its one load completion', async () => {
    const h = harness();
    assert.equal(await h.scope.syncLaunchCharacterAvatar(h.character, true), true);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(h.image.writes.length, 0, 'do not assign src while old thumbnail is still loading');
    h.image.finish(); assert.equal(h.image.writes.length, 1);
    const url = new URL(h.image.src, 'https://fixture.invalid/');
    assert.equal(url.searchParams.getAll('homer_cover').length, 1);
    assert.equal(url.searchParams.get('file'), 'homer-fixture.png');
    assert.equal(url.hash, '#fragment');
    h.image.finish('error'); h.image.finish();
    assert.equal(h.image.writes.length, 1, 'load/error listeners are jointly one-shot');
});

test('already complete image refreshes immediately and force does not skip revision upload because a marker exists', async () => {
    const h = harness({ complete: true }); h.markers.set('homer-avatar-sync:fixture-card', '/cover-fixture.png');
    h.character.data.extensions.homer_bridge.card_signature = 'revision-two';
    assert.equal(await h.scope.syncLaunchCharacterAvatar(h.character, true), true);
    assert.equal(h.requests.length, 2); assert.equal(h.image.writes.length, 1);
    assert.equal(new URL(h.image.src, 'https://fixture.invalid/').searchParams.getAll('homer_cover').length, 1);
    assert.equal(h.character.data.extensions.homer_bridge.card_signature, 'revision-two');
});

test('a completed old-thumbnail error also refreshes after upload without retrying upload', async () => {
    const h = harness(); await h.scope.syncLaunchCharacterAvatar(h.character, true);
    assert.equal(h.image.writes.length, 0); h.image.finish('error');
    assert.equal(h.image.writes.length, 1); assert.equal(h.requests.length, 2);
});

for (const phase of ['disconnected', 'source-changed', 'account-changed', 'epoch-changed', 'card-changed', 'revision-changed']) {
    test(`late old-thumbnail completion cannot refresh ${phase} state`, async () => {
        const h = harness(); await h.scope.syncLaunchCharacterAvatar(h.character, true);
        assert.equal(h.image.writes.length, 0);
        if (phase === 'disconnected') h.image.isConnected = false;
        if (phase === 'source-changed') h.image.value = '/another-image.png';
        if (phase === 'account-changed') h.scope.owner = 'other-owner';
        if (phase === 'epoch-changed') h.scope.storageAccountEpoch++;
        if (phase === 'card-changed') h.scope.launch = { ...h.scope.launch, app_id: 'other-card' };
        if (phase === 'revision-changed') h.character.data.extensions.homer_bridge.card_signature = 'revision-two';
        h.image.finish(); assert.equal(h.image.writes.length, 0);
    });
}

for (const phase of ['account', 'epoch', 'revision']) {
    test(`cover fetch completed after ${phase} switch cannot post a late avatar or mark a new scope`, async () => {
        const hold = deferred(), h = harness({ coverHold: hold });
        const work = h.scope.syncLaunchCharacterAvatar(h.character, true);
        if (phase === 'account') h.scope.owner = 'other-owner';
        if (phase === 'epoch') h.scope.storageAccountEpoch++;
        if (phase === 'revision') h.character.data.extensions.homer_bridge.card_signature = 'revision-two';
        hold.resolve({ ok: true, blob: async () => new Blob(['fixture'], { type: 'image/png' }) });
        assert.equal(await work, false);
        assert.equal(h.requests.length, 1); assert.equal(h.markers.size, 0); assert.equal(h.image.writes.length, 0);
    });
}

test('late upload response retains captured file/marker and does not refresh a newly selected card', async () => {
    const hold = deferred(), h = harness({ uploadHold: hold });
    const work = h.scope.syncLaunchCharacterAvatar(h.character, true);
    while (h.requests.length < 2) await Promise.resolve();
    h.scope.launch = { app_id: 'other-card', card: { data: { extensions: { homer_cover_url: '/other-cover.png' } } } };
    hold.resolve({ ok: true }); assert.equal(await work, true);
    assert.equal(h.requests[0].url, '/cover-fixture.png');
    assert.equal(h.requests[1].avatar, 'homer-fixture.png');
    assert.equal(h.markers.get('homer-avatar-sync:fixture-card'), '/cover-fixture.png');
    assert.equal(h.markers.has('homer-avatar-sync:other-card'), false);
    assert.equal(h.image.writes.length, 0);
});

test('leave before cover GET finishes still uploads exact retained revision and returning does not repeat the large upload', async () => {
    const hold = deferred(), h = harness({ coverHold: hold });
    const originalLaunch = h.scope.launch;
    const work = h.scope.syncLaunchCharacterAvatar(h.character, true);
    h.scope.launch = { app_id: 'other-card', card: { data: { extensions: { homer_cover_url: '/other-cover.png' } } } };
    hold.resolve({ ok: true, blob: async () => new Blob(['revised cover pixels'], { type: 'image/png' }) });
    assert.equal(await work, true);
    assert.equal(h.requests[0].url, '/cover-fixture.png');
    assert.equal(h.requests[1].avatar, 'homer-fixture.png');
    assert.equal(h.markers.get('homer-avatar-sync:fixture-card'), '/cover-fixture.png');
    assert.equal(h.markers.has('homer-avatar-sync:other-card'), false);
    assert.equal(h.image.writes.length, 0, 'the away-state must not cancel or refresh another card');
    h.scope.launch = { ...originalLaunch };
    h.image.finish();
    assert.equal(h.image.writes.length, 1, 'returning to the same revision permits the exact old thumbnail completion refresh');
    assert.equal(new URL(h.image.src, 'https://fixture.invalid/').searchParams.get('file'), 'homer-fixture.png');
    assert.equal(await h.scope.syncLaunchCharacterAvatar(h.character), false);
    assert.equal(h.requests.length, 2, 'returning does not repeat cover GET or upload');
});

for (const phase of ['account', 'same-owner-epoch', 'revision']) {
    test(`pending upload ${phase} change cannot refresh pixels or mark current account`, async () => {
        const hold = deferred(), h = harness({ uploadHold: hold });
        const work = h.scope.syncLaunchCharacterAvatar(h.character, true);
        while (h.requests.length < 2) await Promise.resolve();
        if (phase === 'account') h.scope.owner = 'other-owner';
        if (phase === 'same-owner-epoch') h.scope.storageAccountEpoch++;
        if (phase === 'revision') h.character.data.extensions.homer_bridge.card_signature = 'revision-two';
        hold.resolve({ ok: true }); assert.equal(await work, false);
        assert.equal(h.markers.size, 0); assert.equal(h.image.writes.length, 0);
    });
}

test('nonmatching and already disconnected complete images are not refreshed', async () => {
    assert.equal(typeof helper?.refreshSettledAvatarImages, 'function');
    const unrelated = new ImageFixture('/cover-other.png', true);
    const detached = new ImageFixture('/thumbnail?file=homer-fixture.png', true); detached.isConnected = false;
    helper.refreshSettledAvatarImages([unrelated, detached], { avatar: 'homer-fixture.png', stamp: 123,
        baseUrl: 'https://fixture.invalid/', isCurrent: () => true });
    assert.equal(unrelated.writes.length, 0); assert.equal(detached.writes.length, 0);
});

test('unchanged settled scope may reuse an existing non-force marker; absent/new marker still uploads', async () => {
    const h = harness({ complete: true });
    assert.equal(await h.scope.syncLaunchCharacterAvatar(h.character), true);
    assert.equal(h.requests.length, 2);
    assert.equal(await h.scope.syncLaunchCharacterAvatar(h.character), false);
    assert.equal(h.requests.length, 2);
});
