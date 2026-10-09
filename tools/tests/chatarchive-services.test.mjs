import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createVisualNovelServices } from '../../frontend/app/assets/js/visual-novel-services.mjs';
import { buildTimeline, anchorFor } from '../../frontend/app/assets/js/visual-novel-core.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const DB = 'homer-vn-media-v1';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const scope = { owner: 'synthetic-owner', appId: 'synthetic-role', conversationId: 'synthetic-story' };
const source = anchorFor(buildTimeline([{ id: 'synthetic-message', name: '角色', mes: '合成测试剧情' }])[0]);
const imageResult = { data: { image_url: 'https://images.example.invalid/generated.png' } };

function harness(options = {}) {
  const indexedDB = options.indexedDB ?? cardTransportIDB();
  let valid = true;
  const calls = [];
  const apiClient = {
    async synthesizeTts(payload, opts) { calls.push({ kind: 'tts', payload, signal: opts.signal }); return { data: { audio_url: '/audio/synthetic.wav' } }; },
    async imageChat(payload, opts) { calls.push({ kind: 'cg', payload, signal: opts.signal }); return imageResult; },
    ...options.apiClient,
  };
  const service = createVisualNovelServices({ scope: options.scope || { ...scope }, isCurrent: () => valid,
    apiClient, indexedDB, fetchImpl: options.fetchImpl || (async () => { throw new Error('Isolated unavailable media download'); }) });
  return { service, indexedDB, calls, invalidate: () => { valid = false; } };
}

test('existing transport methods preserve payload and forward optional cancellation only', async () => {
  const code = await readFile(new URL('../../frontend/app/assets/js/app-core.js', import.meta.url), 'utf8');
  for (const [method, route] of [['imageChat', '/console/api/web/image-chat'], ['synthesizeTts', '/console/api/web/tts/synthesize']]) {
    const line = code.split(/\r?\n/).find(line => line.trimStart().startsWith(`${method}:`));
    const calls = [], context = vm.createContext({ rawRequest: (...args) => { calls.push(args); return args; } });
    const fn = vm.runInContext(`({${line}}).${method}`, context);
    const payload = { text: 'synthetic request' }, controller = new AbortController();
    fn(payload, { signal: controller.signal }); fn(payload);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], route); assert.equal(calls[0][1].method, 'POST');
    assert.equal(calls[0][1].body, payload); assert.equal(calls[0][1].signal, controller.signal);
    assert.equal(calls[1][1].signal, undefined);
  }
});

test('TTS normalizes real service envelopes without storing audio, arbitrary options or response objects', async () => {
  const h = harness();
  try {
    const value = await h.service.speak({ text: ' 合成台词 ', voice_id: 'synthetic-voice', unusedOption: 'ignored' });
    assert.equal(value.url, 'http://localhost/audio/synthetic.wav');
    assert.equal(value.audio_url, value.url);
    assert.deepEqual(h.calls[0].payload, { text: '合成台词', voice_id: 'synthetic-voice' });
    assert.ok(h.calls[0].signal instanceof AbortSignal);
    assert.equal(h.indexedDB.openCount, 0);
  } finally { h.service.destroy(); }
});

test('TTS accepts url shape and rejects empty, script, credential and error-body media without retry', async () => {
  for (const response of [{ data: {} }, { data: { url: ' ' } }, { data: { url: 'javascript:void(0)' } },
    { data: { url: 'https://synthetic-user:synthetic-placeholder@example.invalid/audio' } },
    { result: 'failure', data: { url: '/audio/should-not-play.wav' } }]) {
    let requests = 0;
    const h = harness({ apiClient: { synthesizeTts: async () => { requests++; return response; } } });
    try { await assert.rejects(h.service.speak({ text: 'synthetic' }), { code: 'VN_MEDIA_INVALID' }); assert.equal(requests, 1); }
    finally { h.service.destroy(); }
  }
  const h = harness({ apiClient: { synthesizeTts: async () => ({ url: '/audio/synthetic.wav' }) } });
  try { assert.ok((await h.service.speak({ text: 'synthetic' })).url.endsWith('/audio/synthetic.wav')); }
  finally { h.service.destroy(); }
});

test('provider failures are explicit and never automatically replay billing or store CG records', async () => {
  let requests = 0;
  const h = harness({ apiClient: { imageChat: async () => { requests++; throw new Error('Isolated provider failure'); } } });
  try {
    await assert.rejects(h.service.generateCG({ prompt: '合成画面', source }), { code: 'VN_CG_FAILED' });
    assert.equal(requests, 1); assert.equal(h.indexedDB.dump(DB, 'records').length, 0);
  } finally { h.service.destroy(); }
});

test('image generation uses exactly the existing prompt/filename payload and one actual request', async () => {
  const h = harness();
  try {
    await h.service.generateCG({ prompt: ' 合成画面 ', source });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].payload, { prompt: '合成画面', filename: '' });
    assert.ok(h.calls[0].signal instanceof AbortSignal);
  } finally { h.service.destroy(); }
});

test('no media URL cannot create a fake successful CG even when an image description is returned', async () => {
  const h = harness({ apiClient: { imageChat: async () => ({ data: { reply: 'synthetic image description' } }) } });
  try {
    await assert.rejects(h.service.generateCG({ prompt: '合成画面', source }), { code: 'VN_MEDIA_INVALID' });
    assert.equal(h.indexedDB.openCount, 0);
  } finally { h.service.destroy(); }
});

test('invalid inputs and scope guards stop calls before a provider request', async () => {
  assert.throws(() => createVisualNovelServices({ scope: {}, isCurrent: () => true }), { code: 'VN_SCOPE_REQUIRED' });
  const h = harness();
  try {
    await assert.rejects(h.service.speak({ text: '' }), { code: 'VN_TTS_INPUT_INVALID' });
    await assert.rejects(h.service.generateCG({ prompt: 'synthetic', source: { messageId: 'unverified' } }), { code: 'VN_SOURCE_INVALID' });
    h.invalidate();
    await assert.rejects(h.service.generateCG({ prompt: 'synthetic', source }), { code: 'VN_SERVICE_CANCELLED' });
    assert.equal(h.calls.length, 0);
  } finally { h.service.destroy(); }
});

test('late replies after scope invalidation never reach download or persistence', async () => {
  const reply = deferred(); let downloads = 0;
  const h = harness({ apiClient: { imageChat: () => reply.promise }, fetchImpl: async () => { downloads++; } });
  const pending = h.service.generateCG({ prompt: 'synthetic', source });
  try {
    await tick(); h.invalidate(); reply.resolve(imageResult);
    await assert.rejects(pending, { code: 'VN_SERVICE_CANCELLED' });
    assert.equal(downloads, 0); assert.equal(h.indexedDB.openCount, 0);
  } finally { h.service.destroy(); }
});

test('scope mutation is fenced even if the caller current callback has not changed', async () => {
  const selected = { ...scope }, reply = deferred();
  const h = harness({ scope: selected, apiClient: { synthesizeTts: () => reply.promise } });
  const pending = h.service.speak({ text: 'synthetic' });
  try {
    await tick(); selected.conversationId = 'different-story'; reply.resolve({ data: { url: '/audio/synthetic.wav' } });
    await assert.rejects(pending, { code: 'VN_SERVICE_CANCELLED' });
  } finally { h.service.destroy(); }
});

test('cancelled requests settle when a provider ignores abort and cannot store late media', async () => {
  const reply = deferred(), abort = new AbortController();
  const h = harness({ apiClient: { imageChat: () => reply.promise } });
  const pending = h.service.generateCG({ prompt: 'synthetic', source, signal: abort.signal });
  try {
    await tick(); abort.abort();
    await assert.rejects(pending, { code: 'VN_SERVICE_CANCELLED' });
    reply.resolve(imageResult); await tick();
    assert.equal(h.indexedDB.openCount, 0);
  } finally { h.service.destroy(); }
});

test('singleflight refuses repeated CG POSTs while original request is active', async () => {
  const reply = deferred(); let requests = 0;
  const h = harness({ apiClient: { imageChat: () => { requests++; return reply.promise; } } });
  const first = h.service.generateCG({ prompt: 'synthetic', source });
  try {
    await tick(); await assert.rejects(h.service.generateCG({ prompt: 'synthetic', source }), { code: 'VN_SERVICE_BUSY' });
    assert.equal(requests, 1); reply.resolve(imageResult); await first;
  } finally { h.service.destroy(); }
});

test('cancelling a stalled media stream settles without awaiting unresponsive stream cleanup', async () => {
  const reading = deferred(), never = deferred(), started = deferred(), abort = new AbortController();
  let released = false;
  const h = harness({ fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }),
    body: { getReader: () => ({ read: () => { started.resolve(); return reading.promise; }, cancel: () => never.promise,
      releaseLock: () => { released = true; } }) } }) });
  const pending = h.service.generateCG({ prompt: 'synthetic', source, signal: abort.signal });
  try {
    await started.promise; abort.abort(); await assert.rejects(pending, { code: 'VN_SERVICE_CANCELLED' });
    assert.equal(released, true); assert.equal(h.indexedDB.openCount, 0);
    reading.resolve({ done: true }); never.resolve();
  } finally { h.service.destroy(); }
});

test('platform piping enforces actual 64 MiB cap without trusting a small Content-Length', async () => {
  const chunk = new Uint8Array(1024 * 1024); let reads = 0, cancelled = false, pipeCalls = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(chunk); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const pipeTo = body.pipeTo.bind(body); body.pipeTo = (...args) => { pipeCalls++; return pipeTo(...args); };
  body.getReader = () => { throw new Error('Platform path must not acquire a manual reader'); };
  const h = harness({ fetchImpl: async () => ({ ok: true,
    headers: new Headers({ 'content-type': 'image/png', 'content-length': '1' }), body }) });
  try {
    const result = await h.service.generateCG({ prompt: 'synthetic', source });
    assert.equal(result.offline, false); assert.equal(result.persisted, true); assert.equal(result.url, imageResult.data.image_url);
    assert.equal(h.calls.length, 1); assert.equal(pipeCalls, 1); assert.equal(cancelled, true); assert.ok(reads <= 66);
    assert.equal(h.indexedDB.dump(DB, 'blobs').length, 0);
  } finally { h.service.destroy(); }
});

test('platform byte-cap failure cannot hang on source cancellation or replay a CG request', async () => {
  const cleanup = deferred(), abort = new AbortController(), chunk = new Uint8Array(1024 * 1024);
  let reads = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(chunk); },
    cancel() { cancelled = true; return cleanup.promise; } }, { highWaterMark: 0 });
  const h = harness({ fetchImpl: async () => ({ ok: true,
    headers: new Headers({ 'content-type': 'image/png', 'content-length': '1' }), body }) });
  // Failure watchdog only: an implementation that awaits cancel must fail, not hang the suite.
  const watchdog = setTimeout(() => abort.abort(), 1000);
  try {
    const result = await h.service.generateCG({ prompt: 'synthetic', source, signal: abort.signal });
    assert.equal(result.offline, false); assert.equal(result.persisted, true); assert.equal(result.url, imageResult.data.image_url);
    assert.equal(abort.signal.aborted, false); assert.equal(cancelled, true); assert.ok(reads <= 66);
    assert.equal(h.calls.length, 1); assert.equal(h.indexedDB.dump(DB, 'blobs').length, 0);
    assert.equal(h.indexedDB.dump(DB, 'records').length, 1);
  } finally { clearTimeout(watchdog); cleanup.resolve(); h.service.destroy(); }
});

test('platform pipe abort settles despite stalled cleanup; missing bounded stream never calls unbounded blob', async () => {
  const began = deferred(), cleanup = deferred(), controller = new AbortController();
  const body = new ReadableStream({ pull() { began.resolve(); return new Promise(() => {}); }, cancel() { return cleanup.promise; } }, { highWaterMark: 0 });
  const h = harness({ fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), body }) });
  try {
    const pending = h.service.generateCG({ prompt: 'synthetic', source, signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'VN_SERVICE_CANCELLED' });
    await began.promise; controller.abort(); await rejected; assert.equal(h.indexedDB.openCount, 0);
  } finally { cleanup.resolve(); h.service.destroy(); }
  let blobCalls = 0;
  const absent = harness({ fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png', 'content-length': '1' }),
    blob: async () => { blobCalls++; return new Blob(['synthetic'], { type: 'image/png' }); } }) });
  try {
    const result = await absent.service.generateCG({ prompt: 'synthetic', source });
    assert.equal(result.offline, false); assert.equal(result.persisted, true); assert.equal(blobCalls, 0);
    assert.equal(absent.indexedDB.dump(DB, 'blobs').length, 0);
  } finally { absent.service.destroy(); }
});

test('CG keeps its validated source and accepted image array URL across factory restart and isolates accounts', async () => {
  const indexedDB = cardTransportIDB();
  const h = harness({ indexedDB, apiClient: { imageChat: async () => ({ data: { images: [{ url: '/media-cache/generated/synthetic.png' }] } }) } });
  const result = await h.service.generateCG({ prompt: 'synthetic', source });
  assert.equal(result.persisted, true); assert.equal(result.offline, false); assert.deepEqual(result.source, source);
  assert.deepEqual(h.calls, []);
  h.service.destroy();
  const reopened = harness({ indexedDB }), other = harness({ indexedDB, scope: { ...scope, owner: 'other-synthetic-owner' } });
  try {
    const list = await reopened.service.listCG(); assert.equal(list.length, 1); assert.equal(list[0].id, result.id);
    assert.deepEqual(list[0].source, source); assert.equal((await other.service.listCG()).length, 0);
    assert.equal(await other.service.deleteCG(result.id), false);
    assert.equal((await reopened.service.listCG()).length, 1);
    assert.equal(await reopened.service.deleteCG(result.id), true); assert.equal((await reopened.service.listCG()).length, 0);
  } finally { reopened.service.destroy(); other.service.destroy(); }
});

test('a successful CORS image download is durable, uses no cross-origin cookies, and releases object URLs', async () => {
  const fetches = [], blob = new Blob(['synthetic PNG bytes'], { type: 'image/png' });
  const h = harness({ fetchImpl: async (url, options) => {
    fetches.push({ url, options }); return new Response(blob, { headers: { 'content-type': 'image/png' } });
  } });
  const value = await h.service.generateCG({ prompt: 'synthetic', source });
  assert.equal(value.offline, true); assert.ok(value.url.startsWith('blob:'));
  assert.equal(fetches[0].options.credentials, 'omit'); assert.equal(fetches[0].options.mode, 'cors');
  assert.equal(fetches[0].options.referrerPolicy, 'no-referrer'); assert.equal(fetches[0].options.redirect, 'error');
  assert.equal(h.indexedDB.dump(DB, 'blobs')[0].blob.size, blob.size);
  assert.equal((await h.service.listCG())[0].offline, true);
  const objectURL = value.url; h.service.destroy();
  await assert.rejects(fetch(objectURL));
});

test('media-only global 64 MiB LRU evicts binary data without deleting any CG record', async () => {
  const blob = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: 'image/png' });
  const h = harness({ fetchImpl: async () => new Response(blob, { headers: { 'content-type': 'image/png' } }) });
  try {
    await h.service.generateCG({ prompt: 'synthetic first', source });
    await h.service.generateCG({ prompt: 'synthetic second', source });
    const records = h.indexedDB.dump(DB, 'records'), images = h.indexedDB.dump(DB, 'blobs');
    assert.equal(records.length, 2); assert.equal(images.length, 1);
    assert.ok(images.reduce((sum, item) => sum + item.bytes, 0) <= 64 * 1024 * 1024);
    assert.equal(images[0].key, records[1].id);
    assert.equal((await h.service.listCG()).filter(item => item.offline).length, 1);
    assert.ok(h.indexedDB.trace.every(item => !item.store || ['records', 'blobs'].includes(item.store)));
  } finally { h.service.destroy(); }
});

test('oversized and non-image downloads retain real generation URL with offline false', async () => {
  for (const headers of [{ 'content-type': 'image/png', 'content-length': String(65 * 1024 * 1024) }, { 'content-type': 'text/html' }]) {
    let bodyReads = 0;
    const h = harness({ fetchImpl: async () => ({ ok: true, headers: new Headers(headers), blob: async () => { bodyReads++; return new Blob(['x']); } }) });
    try {
      const value = await h.service.generateCG({ prompt: 'synthetic', source });
      assert.equal(value.url, imageResult.data.image_url); assert.equal(value.offline, false); assert.equal(value.persisted, true);
      assert.equal(bodyReads, 0); assert.equal(h.indexedDB.dump(DB, 'blobs').length, 0);
    } finally { h.service.destroy(); }
  }
});

test('binary quota failure falls back to metadata without another image POST', async () => {
  const indexedDB = cardTransportIDB(); indexedDB.failNextPut = true;
  const h = harness({ indexedDB, fetchImpl: async () => new Response(new Blob(['synthetic'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }) });
  try {
    const value = await h.service.generateCG({ prompt: 'synthetic', source });
    assert.equal(value.offline, false); assert.equal(value.persisted, true); assert.equal(h.calls.length, 1);
    assert.equal(indexedDB.dump(DB, 'records').length, 1); assert.equal(indexedDB.dump(DB, 'blobs').length, 0);
  } finally { h.service.destroy(); }
});

test('storage-unavailable generation is honest about persistence while keeping the valid real result', async () => {
  const h = harness({ indexedDB: {} });
  try {
    const value = await h.service.generateCG({ prompt: 'synthetic', source });
    assert.equal(value.url, imageResult.data.image_url); assert.equal(value.persisted, false); assert.equal(value.offline, false);
    await assert.rejects(h.service.listCG(), { code: 'VN_MEDIA_STORE_UNAVAILABLE' });
  } finally { h.service.destroy(); }
});

test('aborting an unfinished durable write never reports success or leaves a CG row', async () => {
  const indexedDB = cardTransportIDB(), gate = indexedDB.holdNextCommit('readwrite'), abort = new AbortController();
  const h = harness({ indexedDB });
  const pending = h.service.generateCG({ prompt: 'synthetic', source, signal: abort.signal });
  try {
    await gate.reached; abort.abort(); await assert.rejects(pending, { code: 'VN_SERVICE_CANCELLED' });
    gate.release(); await tick(); assert.equal(indexedDB.dump(DB, 'records').length, 0);
  } finally { gate.release(); h.service.destroy(); }
});

test('destroy aborts active provider operations and prevents all subsequent work', async () => {
  const reply = deferred(), h = harness({ apiClient: { synthesizeTts: () => reply.promise } });
  const pending = h.service.speak({ text: 'synthetic' });
  await tick(); h.service.destroy(); await assert.rejects(pending, { code: 'VN_SERVICE_CANCELLED' });
  reply.resolve({ data: { url: '/audio/synthetic.wav' } });
  await assert.rejects(h.service.listCG(), { code: 'VN_SERVICE_CANCELLED' });
  await assert.rejects(h.service.speak({ text: 'synthetic' }), { code: 'VN_SERVICE_CANCELLED' });
});
