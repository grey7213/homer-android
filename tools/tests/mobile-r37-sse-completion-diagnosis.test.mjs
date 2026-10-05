import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const diagnosticSource = fs.readFileSync(new URL('./mobile_r37_sse_completion_diagnosis.py', import.meta.url), 'utf8');
const probe = diagnosticSource.match(/SSE_PROBE = r"""([\s\S]*?)"""/)[1];
const nativeParts = diagnosticSource.match(/NATIVE_INIT_PROBE = r"""([\s\S]*?)""" \+ SSE_PROBE \+ r"""([\s\S]*?)"""/);
assert.ok(nativeParts, 'Native reload bootstrap must include the same actual reader observer');
const nativeProbe = nativeParts[1] + probe + nativeParts[2];
const nativeCleanup = diagnosticSource.match(/NATIVE_CLEANUP_PROBE = r"""([\s\S]*?)"""/)[1];
const openai = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = openai.indexOf('    if (stream) {', openai.indexOf('async function sendOpenAIRequest('));
const end = openai.indexOf('    } else {\n        let data;', start);
assert.ok(start > 0 && end > start, 'Actual streaming function boundary must remain precise');
const actualStreamingBranch = `${openai.slice(start, end)}\n    }`;
const openaiFilename = 'http://127.0.0.1/module/dialogue/scripts/openai.js';
const parsed = (content = 'fixture response', finish = null) => ({ done: false, value: { data: JSON.stringify({ choices: [
    { index: 0, delta: { content }, finish_reason: finish },
] }) } });
const doneMarker = () => ({ done: false, value: { data: '[DONE]' } });
const eof = () => ({ done: true, value: undefined });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(queue = [], { path = '/module/dialogue/', sink = true, cancelWork = Promise.resolve(),
    native = false, gate = Promise.resolve(true), readError = null, cancelError = null, getReaderError = null } = {}) {
    const records = [], statuses = [], callbacks = new Map(), readArguments = [], cancelArguments = [];
    let clock = 1700000000000, releaseCalls = 0, readCalls = 0;
    class FixtureReader {
        read(...args) {
            assert.equal(this, reader, 'Native receiver must survive the wrapper');
            if (readError) throw readError;
            readArguments.push(args); readCalls++;
            const result = queue.shift();
            this.lastReadPromise = result instanceof Promise ? result : Promise.resolve(result ?? eof());
            return this.lastReadPromise;
        }
        cancel(...args) {
            assert.equal(this, reader, 'Native cancellation receiver must survive the wrapper');
            if (cancelError) throw cancelError;
            cancelArguments.push(args);
            return cancelWork;
        }
        releaseLock(...args) {
            assert.equal(this, reader, 'Native release receiver must survive the wrapper');
            assert.deepEqual(args, []); releaseCalls++;
        }
    }
    const reader = new FixtureReader();
    class FixtureReadableStream { getReader() { if (getReaderError) throw getReaderError; return reader; } }
    const original = { getReader: FixtureReadableStream.prototype.getReader,
        read: FixtureReader.prototype.read, cancel: FixtureReader.prototype.cancel,
        releaseLock: FixtureReader.prototype.releaseLock };
    const dispatch = event => { for (const callback of callbacks.get(event.type) || []) callback(event); };
    const diagnostic = { status: 'generating' };
    const context = {
        location: { pathname: path }, Date: { now: () => ++clock },
        ReadableStream: FixtureReadableStream, ReadableStreamDefaultReader: FixtureReader,
        addEventListener: (kind, callback) => callbacks.set(kind, [...(callbacks.get(kind) || []), callback]),
        removeEventListener: (kind, callback) => callbacks.set(kind, (callbacks.get(kind) || []).filter(item => item !== callback)),
        stream: true, canMultiSwipe: false, diagnostic,
        response: { body: { pipeThrough() {} } },
        getEventSourceStream: () => ({ readable: new FixtureReadableStream() }),
        generationFailure: (_payload, status = 502) => Object.assign(Error('fixture generation failure'), { code: `HM-G${status}` }),
        finishDiagnostic: (value, error = null) => {
            if (value.status !== 'generating') return;
            value.status = error ? (error.name === 'AbortError' ? 'cancelled' : 'failed') : 'complete';
            statuses.push(value.status);
            dispatch({ type: 'homer-generation-diagnostic', detail: { status: value.status, private: 'PRIVATE_SENTINEL' } });
        },
        tryParseStreamingError: (_response, raw) => {
            if (JSON.parse(raw)?.error) throw Object.assign(Error('fixture error'), { code: 'HM-G502' });
        },
        getStreamingReply: value => value.choices?.[0]?.delta?.content || '',
        ToolManager: { parseToolCalls() {} }, observeDiagnostic() {}, parseChatCompletionLogprobs() {},
        toastr: { error() {} }, DOMException,
    };
    context.window = { dispatchEvent: dispatch };
    if (sink) context.window.__r37SseCompletionRecord = value => {
        if (value.kind === 'probe_active_check') return gate;
        records.push(JSON.parse(JSON.stringify(value))); return Promise.resolve();
    };
    vm.createContext(context);
    vm.runInContext(native ? nativeProbe : probe, context, { filename: 'r37-test-only-probe.js' });
    vm.runInContext(`async function actualReaderFactory() {\n${actualStreamingBranch}\n}`, context, { filename: openaiFilename });
    return { context, records, statuses, original, reader, FixtureReader, FixtureReadableStream,
        readArguments, cancelArguments, get readCalls() { return readCalls; }, get releaseCalls() { return releaseCalls; },
        create: async () => (await context.actualReaderFactory())(),
        events: kind => records.filter(record => record.kind === kind),
        cleanup: () => context.window.__r37SseCompletionDiagnosis?.cleanup(),
        dispatch,
    };
}

test('actual DONE branch records protocol marker, complete and cancel without claiming parsed EOF', async () => {
    const cancel = deferred();
    const h = harness([parsed('PRIVATE_SENTINEL'), doneMarker()], { cancelWork: cancel.promise });
    const generator = await h.create();
    assert.equal((await generator.next()).done, false);
    assert.equal((await generator.next()).done, true);
    assert.deepEqual(h.statuses, ['complete']);
    assert.equal(h.readCalls, 2);
    assert.equal(h.events('done_marker').length, 1);
    assert.equal(h.events('reader_eof').length, 0);
    assert.equal(h.events('cancel_called')[0].done_seen, true);
    assert.equal(h.events('cancel_called')[0].eof_seen, false);
    assert.equal(h.events('release_lock_called').length, 1);
    assert.equal(h.events('cancel_resolved').length, 0, 'Actual fire-and-forget cancellation is not awaited');
    cancel.resolve(); await tick();
    assert.equal(h.events('cancel_resolved').length, 1);
    assert.ok(!JSON.stringify(h.records).includes('PRIVATE_SENTINEL'));
    assert.ok(h.records.every(record => Number.isInteger(record.wall_ms)));
});

test('native reload active gate installs the same observer and actual DONE/cancel contract', async () => {
    const h = harness([parsed(), doneMarker()], { native: true });
    await tick();
    const generator = await h.create(); await generator.next(); await generator.next(); await tick();
    assert.equal(h.events('reader_created').length, 1);
    assert.equal(h.events('done_marker').length, 1);
    assert.equal(h.events('cancel_called')[0].done_seen, true);
    assert.equal(h.records.some(event => event.kind === 'probe_active_check'), false);
});

test('native reload closed gate leaves prototypes unmodified and emits no diagnostic record', async () => {
    const h = harness([], { native: true, gate: Promise.resolve(false) });
    await tick();
    assert.equal(h.FixtureReader.prototype.read, h.original.read);
    assert.equal(h.FixtureReadableStream.prototype.getReader, h.original.getReader);
    assert.deepEqual(h.records, []);
});

test('native pending active handshake cannot reinstall after cleanup even if its earlier answer is true', async () => {
    const gate = deferred();
    const h = harness([], { native: true, gate: gate.promise });
    const cleaned = vm.runInContext(nativeCleanup, h.context);
    assert.equal(cleaned.not_installed, true);
    gate.resolve(true); await tick();
    assert.equal(h.FixtureReader.prototype.read, h.original.read);
    assert.equal(h.FixtureReadableStream.prototype.getReader, h.original.getReader);
    assert.deepEqual(h.records, []);
});

test('native failed gate binding stays inert without consuming or cancelling a stream', async () => {
    const gate = deferred();
    const h = harness([], { native: true, gate: gate.promise });
    gate.reject(new Error('PRIVATE_SENTINEL')); await tick();
    assert.equal(h.FixtureReader.prototype.read, h.original.read);
    assert.equal(h.cancelArguments.length, 0);
    assert.deepEqual(h.records, []);
});

test('native cleanup restores current prototypes and suppresses a late observed reader result', async () => {
    const read = deferred();
    const h = harness([read.promise], { native: true }); await tick();
    await h.create(); const promise = h.reader.read();
    const count = h.records.length;
    assert.equal(vm.runInContext(nativeCleanup, h.context).restored, true);
    read.resolve(doneMarker()); await promise; await tick();
    assert.equal(h.FixtureReader.prototype.read, h.original.read);
    assert.equal(h.records.length, count);
    assert.equal(h.cancelArguments.length, 0);
});

test('native observer retains synchronous read, cancel and getReader exception identities', async () => {
    const readFailure = new Error('PRIVATE_SENTINEL'), cancelFailure = new Error('PRIVATE_SENTINEL'),
        getReaderFailure = new Error('PRIVATE_SENTINEL');
    const reading = harness([], { native: true, readError: readFailure }); await tick();
    await reading.create();
    // Probe identity is distinct from the actual core's deliberate conversion
    // of non-AbortError stream failures into its existing generation error.
    assert.throws(() => reading.reader.read(), error => error === readFailure);
    const cancelling = harness([], { native: true, cancelError: cancelFailure }); await tick();
    await cancelling.create();
    assert.throws(() => cancelling.reader.cancel(), error => error === cancelFailure);
    const creating = harness([], { native: true, getReaderError: getReaderFailure }); await tick();
    await assert.rejects(creating.create(), error => error === getReaderFailure);
    assert.ok(!JSON.stringify([...reading.records, ...cancelling.records, ...creating.records]).includes('PRIVATE_SENTINEL'));
});

test('actual finish_reason does not become DONE and waits for the parsed reader EOF', async () => {
    const pendingRead = deferred();
    const h = harness([parsed('fixture response', 'stop'), pendingRead.promise]);
    const generator = await h.create();
    await generator.next();
    const finish = generator.next(); await tick();
    assert.equal(h.readCalls, 2);
    assert.deepEqual(h.statuses, []);
    assert.equal(h.events('done_marker').length, 0);
    assert.equal(h.events('reader_eof').length, 0);
    assert.equal(h.events('cancel_called').length, 0);
    pendingRead.resolve(eof());
    assert.equal((await finish).done, true); await tick();
    assert.deepEqual(h.statuses, ['complete']);
    assert.equal(h.events('cancel_called')[0].done_seen, false);
    assert.equal(h.events('cancel_called')[0].eof_seen, true);
});

test('actual premature EOF remains a generation failure and is not reclassified as normal DONE', async () => {
    const h = harness([parsed(), eof()]);
    const generator = await h.create(); await generator.next();
    await assert.rejects(generator.next(), error => error.code === 'HM-G502');
    assert.deepEqual(h.statuses, ['failed']);
    assert.equal(h.events('cancel_called')[0].done_seen, false);
    assert.equal(h.events('cancel_called')[0].eof_seen, true);
});

test('actual empty DONE is still HM-G204 rather than acceptance success', async () => {
    const h = harness([doneMarker()]);
    const generator = await h.create();
    await assert.rejects(generator.next(), error => error.code === 'HM-G204');
    assert.deepEqual(h.statuses, ['failed']);
    assert.equal(h.events('cancel_called')[0].done_seen, true);
    assert.equal(h.events('cancel_called')[0].eof_seen, false);
});

test('actual in-band stream error cannot be laundered by a queued but unconsumed DONE', async () => {
    const h = harness([{ done: false, value: { data: JSON.stringify({ error: { message: 'PRIVATE_SENTINEL' } }) } }, doneMarker()]);
    const generator = await h.create();
    await assert.rejects(generator.next(), error => error.code === 'HM-G502');
    assert.deepEqual(h.statuses, ['failed']);
    assert.equal(h.readCalls, 1);
    assert.equal(h.events('cancel_called')[0].done_seen, false);
    assert.equal(h.events('cancel_called')[0].eof_seen, false);
    assert.ok(!JSON.stringify(h.records).includes('PRIVATE_SENTINEL'));
});

test('actual AbortError preserves its identity and records cancellation without DONE or EOF', async () => {
    const failure = new DOMException('PRIVATE_SENTINEL', 'AbortError');
    const read = deferred();
    const h = harness([read.promise]);
    const generator = await h.create(); const next = generator.next();
    read.reject(failure);
    await assert.rejects(next, error => error === failure); await tick();
    assert.deepEqual(h.statuses, ['cancelled']);
    assert.equal(h.events('read_rejected').length, 1);
    assert.equal(h.events('cancel_called')[0].done_seen, false);
    assert.equal(h.events('cancel_called')[0].eof_seen, false);
    assert.ok(!JSON.stringify(h.records).includes('PRIVATE_SENTINEL'));
});

test('actual consumer return retains generator finally and is not reported as marker or EOF completion', async () => {
    const h = harness([parsed(), doneMarker()]);
    const generator = await h.create(); await generator.next();
    await generator.return(); await tick();
    assert.deepEqual(h.statuses, ['cancelled']);
    assert.equal(h.readCalls, 1);
    assert.equal(h.cancelArguments.length, 1);
    assert.equal(h.releaseCalls, 1);
    assert.equal(h.events('cancel_called')[0].done_seen, false);
    assert.equal(h.events('cancel_called')[0].eof_seen, false);
});

test('the probe preserves native read and cancel promises, results, arguments and receivers', async () => {
    const value = doneMarker(), cancel = deferred();
    const h = harness([value], { cancelWork: cancel.promise });
    await h.create();
    const readPromise = h.reader.read('fixture-argument');
    assert.equal(readPromise, h.reader.lastReadPromise);
    assert.equal(await readPromise, value);
    assert.deepEqual(h.readArguments, [['fixture-argument']]);
    const reason = { private: 'PRIVATE_SENTINEL' };
    assert.equal(h.reader.cancel(reason), cancel.promise);
    assert.equal(h.cancelArguments[0][0], reason);
    cancel.resolve(); await tick();
    assert.ok(!JSON.stringify(h.records).includes('PRIVATE_SENTINEL'));
});

test('another script reader is untouched and no content getter is inspected', async () => {
    let inspected = 0;
    const data = { get data() { inspected++; return 'PRIVATE_SENTINEL'; } };
    const h = harness([{ done: false, value: data }]);
    vm.runInContext('globalThis.otherReader = new ReadableStream().getReader()', h.context,
        { filename: 'http://127.0.0.1/module/dialogue/scripts/other.js' });
    await h.context.otherReader.read();
    assert.equal(inspected, 0);
    assert.equal(h.events('reader_created').length, 0);
    assert.equal(h.events('read_called').length, 0);
});

for (const option of [{ path: '/app/chat.html' }, { sink: false }]) {
    test(`outside the explicit runtime probe boundary ${JSON.stringify(option)} no methods are replaced`, () => {
        const h = harness([], option);
        assert.equal(h.FixtureReader.prototype.read, h.original.read);
        assert.equal(h.FixtureReader.prototype.cancel, h.original.cancel);
        assert.equal(h.FixtureReadableStream.prototype.getReader, h.original.getReader);
        assert.deepEqual(h.records, []);
    });
}

test('cleanup restores owned methods and suppresses pending read notifications without cancelling them', async () => {
    const pendingRead = deferred();
    const h = harness([pendingRead.promise]);
    await h.create(); const readPromise = h.reader.read();
    const before = h.records.length;
    assert.equal(h.cleanup().restored, true);
    assert.equal(h.FixtureReader.prototype.read, h.original.read);
    assert.equal(h.FixtureReader.prototype.cancel, h.original.cancel);
    assert.equal(h.FixtureReader.prototype.releaseLock, h.original.releaseLock);
    assert.equal(h.FixtureReadableStream.prototype.getReader, h.original.getReader);
    pendingRead.resolve(doneMarker()); await readPromise; await tick();
    assert.equal(h.records.length, before);
    assert.equal(h.cancelArguments.length, 0);
});

test('cleanup does not overwrite a method installed after this diagnostic', () => {
    const h = harness();
    const later = function read() { return Promise.resolve(eof()); };
    h.FixtureReader.prototype.read = later;
    h.cleanup();
    assert.equal(h.FixtureReader.prototype.read, later);
});

test('existing generation events emit only a fixed status enum, never event detail', () => {
    const h = harness();
    h.dispatch({ type: 'homer-generation-diagnostic', detail: { status: 'complete', private: 'PRIVATE_SENTINEL' } });
    h.dispatch({ type: 'homer-generation-diagnostic', detail: { status: 'PRIVATE_SENTINEL' } });
    assert.equal(h.events('generation_status').length, 1);
    assert.equal(h.events('generation_status')[0].status, 'complete');
    assert.ok(!JSON.stringify(h.records).includes('PRIVATE_SENTINEL'));
});

test('the bounded producer announces saturation once instead of silently implying absent DONE or EOF', () => {
    const h = harness();
    for (let index = 0; index < 2500; index++) {
        h.dispatch({ type: 'homer-generation-diagnostic', detail: { status: 'complete' } });
    }
    assert.equal(h.records.length, 2001);
    assert.equal(h.events('probe_limit_reached').length, 1);
    assert.ok(h.records.every(record => Number.isSafeInteger(record.document_id)));
});

test('one document shares a local numeric identity while independent documents are not grouped together', async () => {
    const first = harness([parsed(), doneMarker()]), second = harness([parsed(), doneMarker()]);
    for (const h of [first, second]) {
        const generator = await h.create(); await generator.next(); await generator.next(); await tick();
        assert.equal(new Set(h.records.map(record => record.document_id)).size, 1);
        assert.equal(h.events('reader_created')[0].reader_id, 1);
    }
    assert.notEqual(first.records[0].document_id, second.records[0].document_id);
});
