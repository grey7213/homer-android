import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const rawSource = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const source = rawSource.replaceAll('\r\n', '\n');
const first = source.indexOf("//MARK: saveSettings()\nlet lastSavedSettingsSignature = '';");
const last = source.indexOf('\n/**\n * Sets the generation parameters from a preset object.', first);
assert.ok(first >= 0 && last > first, 'Actual shipping settings-save/signature boundaries must exist');
const shipping = source.slice(first, last).replace('export async function saveSettings(', 'async function saveSettings(');
const syntheticMarker = 'SYNTHETIC_SETTINGS_PAYLOAD_NOT_FOR_ERROR_LOG';
const previousSignature = '{"synthetic":"previous-confirmed-settings"}';

// Run the actual source. Only its browser, network, storage and notification
// dependencies are synthetic; no substitute saveSettings implementation exists.
function environment(options = {}) {
    const requests = [], errors = [], warnings = [], toasts = [], events = [], queued = [];
    const initialSettings = { synthetic: 'previous-confirmed-settings' };
    let bodyReads = 0, compressCalls = 0;
    const scope = {
        settingsReady: options.ready !== false,
        settings: initialSettings,
        TempResponseLength: { isCustomized: () => options.customized === true, restore() {} },
        saveSettingsDebounced: (...args) => queued.push(args),
        firstRun: false, currentVersion: 'synthetic-version', name1: 'synthetic-name',
        active_character: 'synthetic-character', active_group: null,
        user_avatar: 'synthetic-avatar', amount_gen: 80, max_context: 512, main_api: 'synthetic-api',
        accountStorage: { getState: () => ({ synthetic: true }) },
        getWorldInfoSettings: () => ({ synthetic: true }),
        textgen_settings: {}, swipes: true, horde_settings: {},
        power_user: { syntheticMarker }, extension_settings: {}, tags: [], tag_map: {},
        nai_settings: {}, kai_settings: {}, oai_settings: {}, background_settings: {},
        proxies: [], selected_proxy: '',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        compressRequest: async request => {
            compressCalls++;
            if (options.compressReject) throw options.compressReject;
            return request;
        },
        fetch: async (url, request) => {
            requests.push({ url, request });
            if (options.fetchReject) throw options.fetchReject;
            const response = {
                ok: options.ok !== false,
                statusText: options.ok === false ? 'synthetic HTTP failure' : 'OK',
                arrayBuffer: () => {
                    bodyReads++;
                    return options.readBody?.(bodyReads) ?? Promise.resolve(new Uint8Array([0, 255, 7]).buffer);
                },
            };
            for (const method of ['json', 'text', 'clone']) Object.defineProperty(response, method, {
                get() { throw new Error('Do not parse, clone or inspect settings-save ACK content'); },
            });
            return response;
        },
        event_types: { SETTINGS_UPDATED: 'SETTINGS_UPDATED' },
        eventSource: { emit: async name => events.push(name) },
        console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
        toastr: { error: (...args) => toasts.push(args) },
        t: strings => strings.join(''),
    };
    vm.createContext(scope);
    vm.runInContext(shipping, scope);
    vm.runInContext(`lastSavedSettingsSignature = ${JSON.stringify(previousSignature)};`, scope);
    return {
        scope, initialSettings, requests, errors, warnings, toasts, events, queued,
        get bodyReads() { return bodyReads; },
        get compressCalls() { return compressCalls; },
        get signature() { return vm.runInContext('lastSavedSettingsSignature', scope); },
    };
}

async function flush() { for (let index = 0; index < 15; index++) await Promise.resolve(); }

function assertUnconfirmed(h) {
    assert.equal(h.scope.settings, h.initialSettings, 'Leave the previous confirmed settings object intact');
    assert.equal(h.signature, previousSignature, 'Do not confirm a signature until the complete response is read');
    assert.equal(h.events.length, 0, 'Do not publish SETTINGS_UPDATED before full response completion');
}

function assertNoAutomaticRetry(h) {
    assert.equal(h.queued.length, 0, 'Response/fetch failures must not add a background retry');
}

function assertNoPayloadLogged(h) {
    const lines = [...h.errors, ...h.warnings, ...h.toasts].map(args => args.map(value =>
        value instanceof Error ? String(value) : typeof value === 'object' ? JSON.stringify(value) : String(value)).join(' '));
    assert.ok(lines.every(line => !line.includes(syntheticMarker)), 'Never log the settings payload');
    assert.ok(lines.every(line => !line.includes('extension_settings') && !line.includes('accountStorage')), 'Do not dump settings fields');
}

test('extract and execute the actual shipping settings-save/signature source', t => {
    t.diagnostic('Shipping script SHA256: ' + crypto.createHash('sha256').update(rawSource).digest('hex'));
    assert.match(shipping, /async function saveSettings\(loopCounter = 0\)/);
    assert.match(shipping, /lastSavedSettingsSignature = payloadJson/);
});

test('HTTP ok waits for the entire body before updating settings, signature and SETTINGS_UPDATED', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const h = environment({ readBody: () => pending });
    let settled = false;
    const work = h.scope.saveSettings().then(() => { settled = true; });
    await flush();
    assert.equal(h.bodyReads, 1, 'An HTTP-ok ACK body must be consumed completely');
    assert.equal(settled, false, 'The real save remains pending while the body is incomplete');
    assertUnconfirmed(h);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/settings/save');
    assert.equal(h.requests[0].request.method, 'POST');
    release(new Uint8Array([0, 255, 7]).buffer);
    await work;
    assert.notEqual(h.scope.settings, h.initialSettings);
    assert.equal(h.signature, h.requests[0].request.body);
    assert.deepEqual(h.events, ['SETTINGS_UPDATED']);
    assert.equal(h.errors.length, 0);
    assertNoAutomaticRetry(h);
});

test('body-read rejection leaves settings/signature unconfirmed and enters the original catch without retry', async () => {
    const originalError = new TypeError('synthetic response-body read rejected');
    const h = environment({ readBody: () => Promise.reject(originalError) });
    assert.equal(await h.scope.saveSettings(), undefined, 'Preserve the original catch/return behavior');
    assert.equal(h.bodyReads, 1);
    assertUnconfirmed(h);
    assert.equal(h.requests.length, 1);
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0][0], 'Error saving settings:');
    assert.equal(h.errors[0][1], originalError, 'The original catch reports the exact read failure');
    assert.equal(h.toasts.length, 1);
    assertNoAutomaticRetry(h);
    assertNoPayloadLogged(h);
});

test('HTTP error keeps the original error path, never consumes a body and never retries', async () => {
    const h = environment({ ok: false, readBody: () => { throw Error('HTTP error body must remain unread'); } });
    await h.scope.saveSettings();
    assert.equal(h.bodyReads, 0);
    assertUnconfirmed(h);
    assert.equal(h.requests.length, 1);
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0][0], 'Error saving settings:');
    assert.equal(h.errors[0][1].message, 'Failed to save settings: synthetic HTTP failure');
    assert.equal(h.toasts.length, 1);
    assertNoAutomaticRetry(h);
    assertNoPayloadLogged(h);
});

test('after a read failure an explicit same-payload save retries once, then complete ACK preserves deduplication', async () => {
    const readFailure = new TypeError('synthetic first read failed');
    const h = environment({ readBody: count => count === 1
        ? Promise.reject(readFailure) : Promise.resolve(new Uint8Array([1, 2]).buffer) });
    await h.scope.saveSettings();
    assertUnconfirmed(h);
    assert.equal(h.requests.length, 1);
    assertNoAutomaticRetry(h);
    await h.scope.saveSettings();
    assert.equal(h.requests.length, 2, 'Only an explicit caller retry resends an unconfirmed payload');
    assert.equal(h.requests[1].request.body, h.requests[0].request.body);
    assert.equal(h.bodyReads, 2);
    assert.equal(h.signature, h.requests[1].request.body);
    assert.deepEqual(h.events, ['SETTINGS_UPDATED']);
    await h.scope.saveSettings();
    assert.equal(h.requests.length, 2, 'The unchanged fully confirmed payload still deduplicates');
    assert.equal(h.bodyReads, 2);
    assert.equal(h.compressCalls, 2);
    assertNoAutomaticRetry(h);
    assertNoPayloadLogged(h);
});

test('HTTP-ok response bytes are discarded without introducing JSON/text parsing semantics', async () => {
    const h = environment();
    await h.scope.saveSettings();
    assert.equal(h.bodyReads, 1);
    assert.equal(h.signature, h.requests[0].request.body);
    assert.deepEqual(h.events, ['SETTINGS_UPDATED']);
    assert.equal(h.errors.length, 0);
    assertNoPayloadLogged(h);
});

test('existing fetch/compression rejection paths do not consume a response or confirm/retry settings', async () => {
    for (const kind of ['fetchReject', 'compressReject']) {
        const originalError = new TypeError('synthetic ' + kind);
        const h = environment({ [kind]: originalError });
        await h.scope.saveSettings();
        assertUnconfirmed(h);
        assert.equal(h.bodyReads, 0);
        assert.equal(h.requests.length, kind === 'fetchReject' ? 1 : 0);
        assert.equal(h.errors.length, 1);
        assert.equal(h.errors[0][1], originalError);
        assertNoAutomaticRetry(h);
        assertNoPayloadLogged(h);
    }
});

test('existing not-ready and customized-response-length guards remain before the request', async () => {
    for (const options of [{ ready: false }, { customized: true }]) {
        const h = environment(options);
        await h.scope.saveSettings();
        assertUnconfirmed(h);
        assert.equal(h.requests.length, 0);
        assert.equal(h.bodyReads, 0);
        assert.equal(h.compressCalls, 0);
        assert.equal(h.queued.length, 1, 'Preserve the preexisting pre-save scheduling policy');
    }
});
