import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createVisualNovelAssetCache } from '../../frontend/app/assets/js/visual-novel-asset-cache.mjs';
import { createStoryStore } from '../../frontend/app/assets/js/visual-novel-story-store.mjs';
import { createPresentationStore } from '../../frontend/app/assets/js/visual-novel-core.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const DB = 'homer-vn-selected-assets', META = 'asset_index', BLOBS = 'asset_blobs';
const scope = { owner: 'fixture-owner', appId: 'fixture-card', conversationId: 'fixture-story' };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const asset = (id = 'background-1', values = {}) => ({ id, kind: 'background', url: `/media-cache/card-assets/ready/${id}.png`,
    mime_type: 'image/png', sha256: digest(png), size_bytes: png.length, status: 'ready', ...values });
const response = (bytes = png, mime = 'image/png', headers = {}) => new Response(bytes, { headers: { 'content-type': mime, ...headers } });

function setup(options = {}) {
    const indexedDB = options.indexedDB || cardTransportIDB(), calls = [], urls = new Map(), revoked = [];
    let next = 0, current = true, online = true;
    const urlAPI = { createObjectURL(blob) { const url = `blob:fixture/${++next}`; urls.set(url, blob); return url; },
        revokeObjectURL(url) { revoked.push(url); urls.delete(url); } };
    const fetcher = options.fetchImpl || (async () => response());
    const cache = createVisualNovelAssetCache({ scope: options.scope || scope, isCurrent: () => current,
        indexedDB, baseURL: 'https://fixture.test/app/story', URL: urlAPI, crypto: webcrypto, online: () => online,
        ...options, fetchImpl: async (...args) => { calls.push(args); return fetcher(...args); } });
    return { cache, indexedDB, calls, urls, revoked, setCurrent: value => { current = value; }, setOnline: value => { online = value; } };
}

test('import/factory are inert; only selected asset GETs and verified durable blobs survive reopen offline', async () => {
    const first = setup();
    assert.equal(first.indexedDB.openCount, 0); assert.equal(first.calls.length, 0); assert.equal(first.urls.size, 0);
    const loaded = await first.cache.resolve(asset());
    assert.deepEqual({ offline: loaded.offline, persisted: loaded.persisted }, { offline: false, persisted: true });
    assert.ok(loaded.url.startsWith('blob:')); assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0][1].method, 'GET'); assert.equal(first.calls[0][1].credentials, 'same-origin');
    assert.equal(first.calls[0][1].redirect, 'error'); assert.equal(first.calls[0][1].referrerPolicy, 'no-referrer');
    assert.equal(first.indexedDB.dump(DB, BLOBS).length, 1);
    assert.equal(first.cache.release(loaded.url), true); assert.equal(first.cache.release(loaded.url), false);
    first.cache.destroy();
    const reopened = setup({ indexedDB: first.indexedDB }); reopened.setOnline(false);
    const offline = await reopened.cache.resolve(asset());
    assert.equal(offline.offline, true); assert.equal(offline.persisted, true); assert.equal(reopened.calls.length, 0);
    assert.deepEqual(new Uint8Array(await reopened.urls.get(offline.url).arrayBuffer()), png);
    reopened.cache.destroy(); assert.deepEqual(reopened.revoked, [offline.url]);
});

test('owner/app/conversation scope isolation; digest hits avoid GET and mutable URLs revalidate before offline fallback', async () => {
    const first = setup(); await first.cache.resolve(asset());
    await first.cache.resolve(asset()); assert.equal(first.calls.length, 1);
    for (const other of [{ ...scope, owner: 'other-owner' }, { ...scope, appId: 'other-card' }, { ...scope, conversationId: 'other-story' }]) {
        const isolated = setup({ indexedDB: first.indexedDB, scope: other }); isolated.setOnline(false);
        assert.equal((await isolated.cache.resolve(asset())).code, 'VN_ASSET_OFFLINE_MISS');
        assert.equal(isolated.urls.size, 0); isolated.cache.destroy();
    }
    const mutable = asset('mutable', { sha256: '', size_bytes: 0 });
    await first.cache.resolve(mutable); await first.cache.resolve(mutable); assert.equal(first.calls.length, 3);
    const failed = setup({ indexedDB: first.indexedDB, fetchImpl: async () => { throw new Error('synthetic network unavailable'); } });
    const fallback = await failed.cache.resolve(mutable);
    assert.equal(fallback.offline, true); assert.equal(fallback.persisted, true); assert.ok(fallback.warning);
    failed.cache.destroy(); first.cache.destroy();
});

test('credential/data/executable URLs and unsafe MIME never fetch or persist; Spine directories are delegated', async () => {
    const fixture = setup();
    for (const url of ['https://user:password@fixture.test/a.png', 'http://elsewhere.test/a.png', 'data:image/png;base64,AAAA',
        'blob:private', 'javascript:alert(1)', '/a.png?access_token=synthetic', '/a.png?X-Amz-Signature=synthetic',
        '/a.png?api_key=synthetic', '/a.png?x-auth=synthetic', '/a.png#access_token=synthetic', '/token/synthetic/a.png']) {
        const result = await fixture.cache.resolve(asset('bad-url', { url }));
        assert.equal(result.url, ''); assert.equal(result.persisted, false); assert.equal(result.reason, 'not-offline-cached');
    }
    for (const mime_type of ['image/svg+xml', 'text/html', 'application/javascript', 'application/zip']) {
        assert.equal((await fixture.cache.resolve(asset('bad-type', { mime_type }))).code, 'VN_ASSET_TYPE_UNSUPPORTED');
    }
    assert.equal((await fixture.cache.resolve({ kind: 'spine', metadata: { spine: { skeleton_url: '/skeleton.skel' } } })).delegated, true);
    assert.equal((await fixture.cache.resolve(asset('spine-preview', { kind: 'portrait', metadata: { spine: { manifest_url: '/manifest.json' } } }))).reason, 'spine-delegated');
    assert.equal(fixture.indexedDB.openCount, 0); assert.equal(fixture.calls.length, 0);
    const external = setup(); await external.cache.resolve(asset('public-external', { url: 'https://public.fixture.test/a.png' }));
    assert.equal(external.calls[0][1].credentials, 'omit'); external.cache.destroy(); fixture.cache.destroy();
});

test('stream byte cap handles missing/lying lengths, cancels reads, validates complete size/hash/type, never loads archives', async () => {
    let cancelled = false;
    const large = setup({ maxAssetBytes: 20, fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png', 'content-length': '1' }),
        body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(21) }), cancel() { cancelled = true; } }) } }) });
    assert.equal((await large.cache.resolve(asset('large', { sha256: '', size_bytes: 0 }))).code, 'VN_ASSET_TOO_LARGE');
    assert.equal(cancelled, true); assert.equal(large.indexedDB.dump(DB, BLOBS).length, 0); large.cache.destroy();
    const scenarios = [
        { fetchImpl: async () => response(png, 'text/html'), code: 'VN_ASSET_TYPE_UNSUPPORTED' },
        { fetchImpl: async () => response(png, 'image/png', { 'content-length': '999' }), maxAssetBytes: 20, code: 'VN_ASSET_TOO_LARGE' },
        { fetchImpl: async () => response(new Uint8Array(3)), code: 'VN_ASSET_SIZE_MISMATCH' },
        { fetchImpl: async () => response(new Uint8Array(png.length)), code: 'VN_ASSET_INTEGRITY_MISMATCH' },
        { fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), blob: async () => new Blob([png]) }), code: 'VN_ASSET_BOUNDED_STREAM_UNAVAILABLE' },
        { crypto: null, code: 'VN_ASSET_INTEGRITY_UNAVAILABLE' },
    ];
    for (const scenario of scenarios) {
        const fixture = setup(scenario);
        const result = await fixture.cache.resolve(asset());
        assert.equal(result.code, scenario.code); assert.equal(result.url, ''); assert.equal(fixture.urls.size, 0);
        assert.equal(fixture.indexedDB.dump(DB, BLOBS).length, 0); fixture.cache.destroy();
    }
});

test('platform pipeTo is preferred and counts actual bytes; getReader-only environments retain bounded fallback', async () => {
    let pipeCalls = 0;
    const body = new ReadableStream({ start(controller) { controller.enqueue(png); controller.close(); } });
    const pipeTo = body.pipeTo.bind(body);
    body.pipeTo = (...args) => { pipeCalls++; return pipeTo(...args); };
    body.getReader = () => { throw new Error('Platform path must not acquire a manual reader'); };
    const platform = setup({ fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), body }) });
    assert.equal((await platform.cache.resolve(asset())).persisted, true); assert.equal(pipeCalls, 1); platform.cache.destroy();
    let cancelled = false;
    const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(21)); }, cancel() { cancelled = true; } });
    const capped = setup({ maxAssetBytes: 20, fetchImpl: async () => ({ ok: true,
        headers: new Headers({ 'content-type': 'image/png', 'content-length': '1' }), body: oversized }) });
    assert.equal((await capped.cache.resolve(asset('cap', { sha256: '', size_bytes: 0 }))).code, 'VN_ASSET_TOO_LARGE');
    assert.equal(cancelled, true); assert.equal(capped.indexedDB.dump(DB, BLOBS).length, 0); capped.cache.destroy();
    let reads = 0, released = false;
    const fallback = setup({ fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }),
        body: { getReader: () => ({ read: async () => ++reads === 1 ? { done: false, value: png } : { done: true },
            cancel() { throw new Error('Completed fallback must not be cancelled'); }, releaseLock() { released = true; } }) } }) });
    assert.equal((await fallback.cache.resolve(asset())).persisted, true); assert.equal(reads, 2); assert.equal(released, true);
    fallback.cache.destroy();
});

test('aborting platform piping settles even when underlying stream cancellation never responds', async () => {
    let started, cleanup;
    const began = new Promise(resolve => { started = resolve; }), never = new Promise(resolve => { cleanup = resolve; });
    const body = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { return never; } }, { highWaterMark: 0 });
    const fixture = setup({ fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), body }) });
    const controller = new AbortController(), pending = fixture.cache.resolve(asset(), { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await began; controller.abort(); await rejected;
    assert.equal(fixture.indexedDB.dump(DB, BLOBS).length, 0); assert.equal(fixture.urls.size, 0);
    cleanup(); fixture.cache.destroy();
});

test('platform byte-cap failure stays explicit when underlying cancellation never settles', async () => {
    let cleanup, cancelled = false;
    const never = new Promise(resolve => { cleanup = resolve; });
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(21)); },
        cancel() { cancelled = true; return never; } }, { highWaterMark: 0 });
    const fixture = setup({ maxAssetBytes: 20, requestTimeoutMs: 20, fetchImpl: async () => ({ ok: true,
        headers: new Headers({ 'content-type': 'image/png', 'content-length': '1' }), body }) });
    try {
        const result = await fixture.cache.resolve(asset('stalled-cap', { sha256: '', size_bytes: 0 }));
        assert.equal(result.code, 'VN_ASSET_TOO_LARGE'); assert.equal(cancelled, true);
        assert.equal(result.persisted, false); assert.equal(result.url, ''); assert.equal(fixture.calls.length, 1);
        assert.equal(fixture.indexedDB.dump(DB, BLOBS).length, 0); assert.equal(fixture.urls.size, 0);
    } finally { cleanup(); fixture.cache.destroy(); }
});

test('global LRU budget evicts only asset blobs/index, preserves story checkpoints and reading bookmarks', async () => {
    const indexedDB = cardTransportIDB(), story = createStoryStore({ indexedDB }), reading = createPresentationStore({ indexedDB });
    await story.save(scope, { id: 'story-slot', name: '合成剧情哨兵', messages: [{ mes: '保留正文' }], createdAt: 1 });
    await reading.save(scope, { settings: { fontSize: 20 } });
    const fixture = setup({ indexedDB, maxCacheBytes: png.length * 2, maxAssetBytes: png.length });
    await fixture.cache.resolve(asset('a')); await fixture.cache.resolve(asset('b'));
    await fixture.cache.resolve(asset('a')); await fixture.cache.resolve(asset('c'));
    const rows = indexedDB.dump(DB, META);
    assert.equal(rows.length, 2); assert.equal(indexedDB.dump(DB, BLOBS).length, 2);
    assert.ok(rows.some(row => row.sourceURL.endsWith('/a.png'))); assert.ok(rows.some(row => row.sourceURL.endsWith('/c.png')));
    const other = setup({ indexedDB, scope: { ...scope, owner: 'another-owner' }, maxCacheBytes: png.length * 2, maxAssetBytes: png.length });
    await other.cache.resolve(asset('other-owner-asset'));
    assert.equal(indexedDB.dump(DB, META).reduce((sum, row) => sum + row.sizeBytes, 0), png.length * 2);
    assert.equal((await story.get(scope, 'story-slot')).messages[0].mes, '保留正文');
    assert.equal((await reading.load(scope)).settings.fontSize, 20);
    assert.ok(indexedDB.trace.filter(row => row.event === 'transaction' && row.stores.some(name => [META, BLOBS].includes(name)))
        .every(row => row.stores.every(name => [META, BLOBS].includes(name))));
    fixture.cache.destroy(); other.cache.destroy(); story.close(); reading.close();
});

test('same-millisecond LRU touches remain strict across concurrent factories, legacy ties, restart and backward wall clock', async () => {
    const actualNow = Date.now, fixedTime = 1770000000000, caches = [];
    Date.now = () => fixedTime;
    try {
        const indexedDB = cardTransportIDB(), options = { indexedDB, maxCacheBytes: png.length * 2, maxAssetBytes: png.length };
        const first = setup(options), second = setup(options); caches.push(first.cache, second.cache);
        // Separate factory transactions contend on the same durable index.
        await Promise.all([first.cache.resolve(asset('same-a')), second.cache.resolve(asset('same-b'))]);
        const original = indexedDB.dump(DB, META);
        assert.equal(new Set(original.map(row => row.lastUsed)).size, 2);
        // Existing v1 rows may already have equal wall-clock timestamps.
        for (const row of original) indexedDB.seed(DB, META, row.key, { ...row, lastUsed: fixedTime });
        const beforeTouch = fixedTime;
        await first.cache.resolve(asset('same-a'));
        const touched = indexedDB.dump(DB, META).find(row => row.sourceURL.endsWith('/same-a.png'));
        assert.ok(touched.lastUsed > beforeTouch);
        await second.cache.resolve(asset('same-c'));
        let rows = indexedDB.dump(DB, META);
        assert.deepEqual(rows.map(row => row.sourceURL.split('/').at(-1)).sort(), ['same-a.png', 'same-c.png']);
        assert.ok(rows.find(row => row.sourceURL.endsWith('/same-c.png')).lastUsed > touched.lastUsed);
        first.cache.destroy(); second.cache.destroy();
        const reopened = setup(options); caches.push(reopened.cache);
        const beforeReopenTouch = Math.max(...rows.map(row => row.lastUsed));
        Date.now = () => fixedTime - 5000;
        await reopened.cache.resolve(asset('same-a'));
        assert.ok(indexedDB.dump(DB, META).find(row => row.sourceURL.endsWith('/same-a.png')).lastUsed > beforeReopenTouch);
        await reopened.cache.resolve(asset('same-d'));
        rows = indexedDB.dump(DB, META);
        assert.deepEqual(rows.map(row => row.sourceURL.split('/').at(-1)).sort(), ['same-a.png', 'same-d.png']);
        assert.equal(indexedDB.dump(DB, BLOBS).length, 2);
        assert.equal(new Set(rows.map(row => row.lastUsed)).size, 2);
    } finally { Date.now = actualNow; caches.forEach(cache => cache.destroy()); }
});

test('logical-clock ceiling rebases only metadata while retaining strict LRU order', async () => {
    const fixture = setup({ maxCacheBytes: png.length * 2, maxAssetBytes: png.length });
    try {
        await fixture.cache.resolve(asset('ceiling-a')); await fixture.cache.resolve(asset('ceiling-b'));
        const newest = fixture.indexedDB.dump(DB, META).find(row => row.sourceURL.endsWith('/ceiling-b.png'));
        fixture.indexedDB.seed(DB, META, newest.key, { ...newest, lastUsed: Number.MAX_SAFE_INTEGER });
        await fixture.cache.resolve(asset('ceiling-a'));
        const touched = fixture.indexedDB.dump(DB, META);
        assert.ok(touched.every(row => Number.isSafeInteger(row.lastUsed)));
        assert.ok(touched.find(row => row.sourceURL.endsWith('/ceiling-a.png')).lastUsed > touched.find(row => row.sourceURL.endsWith('/ceiling-b.png')).lastUsed);
        await fixture.cache.resolve(asset('ceiling-c'));
        assert.deepEqual(fixture.indexedDB.dump(DB, META).map(row => row.sourceURL.split('/').at(-1)).sort(), ['ceiling-a.png', 'ceiling-c.png']);
        assert.equal(fixture.indexedDB.dump(DB, BLOBS).length, 2);
    } finally { fixture.cache.destroy(); }
});

test('commit acknowledgment and quota failure are honest; failed replacement cannot partially evict cache', async () => {
    const fixture = setup({ maxCacheBytes: png.length, maxAssetBytes: png.length });
    await fixture.cache.resolve(asset('old'));
    const gate = fixture.indexedDB.holdNextCommit('readwrite'); let settled = false;
    const replacing = fixture.cache.resolve(asset('new')).then(value => { settled = true; return value; });
    await gate.reached; assert.equal(settled, false); assert.ok(fixture.indexedDB.dump(DB, META)[0].sourceURL.endsWith('/old.png'));
    gate.release(); assert.equal((await replacing).persisted, true);
    fixture.indexedDB.failNextPut = true;
    const failed = await fixture.cache.resolve(asset('quota'));
    assert.equal(failed.persisted, false); assert.equal(failed.offline, false); assert.equal(failed.reason, 'not-offline-cached');
    assert.ok(failed.url.startsWith('blob:')); assert.ok(fixture.indexedDB.dump(DB, META)[0].sourceURL.endsWith('/new.png'));
    assert.equal(fixture.indexedDB.dump(DB, BLOBS).length, 1); fixture.cache.destroy();
});

test('only two selected GETs run at once; queued and active requests cancel on destroy without leaked URLs', async () => {
    let active = 0, peak = 0, started;
    const releases = [], twoStarted = new Promise(resolve => { started = resolve; });
    const fixture = setup({ fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
        active++; peak = Math.max(peak, active); if (active === 2) started();
        let finished = false;
        const finish = fn => { if (finished) return; finished = true; active--; signal.removeEventListener('abort', abort); fn(); };
        const abort = () => finish(() => reject(Object.assign(new Error('synthetic cancellation'), { name: 'AbortError' })));
        signal.addEventListener('abort', abort, { once: true }); releases.push(() => finish(() => resolve(response())));
    }) });
    const loads = Array.from({ length: 6 }, (_, index) => fixture.cache.resolve(asset(`queued-${index}`)));
    const settled = Promise.allSettled(loads);
    await twoStarted;
    assert.equal(peak, 2); assert.equal(fixture.calls.length, 2);
    releases.splice(0).forEach(release => release());
    for (let step = 0; step < 10 && fixture.calls.length < 4; step++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(peak <= 2);
    fixture.cache.destroy();
    const results = await settled;
    assert.ok(results.some(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
    assert.equal(active, 0); assert.equal(fixture.urls.size, 0); assert.equal(peak, 2);
});

test('scope/epoch and external abort fences prevent stale results and cache writes, including held commit', async () => {
    const fixture = setup(); await fixture.cache.resolve(asset('ready'));
    const gate = fixture.indexedDB.holdNextCommit('readwrite'), controller = new AbortController();
    const loading = fixture.cache.resolve(asset('held'), { signal: controller.signal });
    const rejection = assert.rejects(loading, { name: 'AbortError' });
    await gate.reached; controller.abort(); gate.release(); await rejection;
    assert.equal(fixture.indexedDB.dump(DB, META).length, 1);
    fixture.setCurrent(false); await assert.rejects(fixture.cache.resolve(asset('stale')), { name: 'AbortError' });
    fixture.cache.destroy();
    const mutableScope = { ...scope }, changed = setup({ scope: mutableScope });
    mutableScope.conversationId = 'changed-story';
    await assert.rejects(changed.cache.resolve(asset()), { name: 'AbortError' });
    assert.equal(changed.indexedDB.openCount, 0); changed.cache.destroy();
});

test('no durable store, blocked/open errors, corruption and offline misses report not-offline-cached honestly', async () => {
    for (const options of [{ indexedDB: null }, { indexedDB: { open() { throw new Error('synthetic unavailable'); } } }]) {
        const fixture = setup(options); const result = await fixture.cache.resolve(asset());
        assert.equal(result.persisted, false); assert.equal(result.offline, false); assert.equal(result.reason, 'not-offline-cached');
        assert.ok(result.url.startsWith('blob:')); fixture.cache.destroy();
    }
    const blockedIDB = cardTransportIDB(); blockedIDB.blockNextOpen = true;
    const blocked = setup({ indexedDB: blockedIDB }); const blockedResult = await blocked.cache.resolve(asset());
    assert.equal(blockedResult.persisted, true); // A fresh second open can safely recover after the blocked request closes.
    blocked.cache.destroy();
    const fixture = setup(); const loaded = await fixture.cache.resolve(asset()); fixture.cache.release(loaded.url);
    const row = fixture.indexedDB.dump(DB, META)[0]; fixture.indexedDB.seed(DB, BLOBS, row.key, { key: row.key, blob: new Blob(['corrupt'], { type: row.mime }) });
    fixture.setOnline(false); const corrupt = await fixture.cache.resolve(asset());
    assert.equal(corrupt.code, 'VN_ASSET_OFFLINE_MISS'); assert.equal(corrupt.url, ''); fixture.cache.destroy();
    assert.throws(() => createVisualNovelAssetCache({ scope: {}, isCurrent: () => true }), { code: 'VN_SCOPE_REQUIRED' });
});

test('timeout stops bounded work without waiting for an uncooperative fetch; BGM whitelist supports ordinary audio', async () => {
    const fixture = setup({ requestTimeoutMs: 20, fetchImpl: async () => new Promise(() => {}) });
    const result = await fixture.cache.resolve(asset());
    assert.equal(result.code, 'VN_ASSET_TIMEOUT'); assert.equal(result.persisted, false); assert.equal(result.url, ''); fixture.cache.destroy();
    const bgm = setup({ fetchImpl: async () => response(png, 'audio/mpeg') });
    const audio = await bgm.cache.resolve(asset('bgm', { kind: 'bgm', mime_type: 'audio/*', url: '/bgm.mp3' }));
    assert.equal(audio.persisted, true); assert.equal(bgm.urls.get(audio.url).type, 'audio/mpeg'); bgm.cache.destroy();
});
