import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { withQuickReplySettingsHandoff, takeQuickReplySettingsPresets } from '../../sillytavern-runtime/public/scripts/extension-settings-handoff.mjs';

// Synthetic JSON only. No accounts, card scripts or external endpoints run.
const quickReplySource = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/quick-reply/index.js', import.meta.url), 'utf8');
const extensionsSource = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions.js', import.meta.url), 'utf8');
const startupSource = readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const fixture = () => ({ quickReplyPresets: [{ version: 2, name: 'Synthetic fixture', qrList: [{ id: 1, label: 'Synthetic reply', message: 'Fixture only' }], unknown: { nested: ['preserve'] } }] });
const plain = value => JSON.parse(JSON.stringify(value));

function loadSetsHarness({ ok = true, response = fixture() } = {}) {
    const requests = [], created = [], initialized = [], persisted = [];
    const context = vm.createContext({
        takeQuickReplySettingsPresets,
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok, json: async () => response };
        },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-fixture' }),
        QuickReplySet: {
            list: [],
            from(data) {
                created.push(data);
                return { ...data, init() { initialized.push(this.name); }, markPersisted() { persisted.push(this.name); } };
            },
        },
        QuickReply: { from(data) { return { ...data, syntheticInitialized: true }; } },
        log() {},
    });
    const start = quickReplySource.indexOf('const loadSets = async () => {');
    const end = quickReplySource.indexOf('const loadSettings = async () => {', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(`${quickReplySource.slice(start, end)}\nglobalThis.loadSets = loadSets;`, context);
    return { loadSets: context.loadSets, requests, created, initialized, persisted, list: context.QuickReplySet.list };
}

test('handoff captures a deep private clone and retains every JSON preset field', async () => {
    const response = fixture(), expected = plain(response.quickReplyPresets);
    await withQuickReplySettingsHandoff(response, async () => {
        response.quickReplyPresets[0].unknown.nested.push('changed elsewhere');
        const received = takeQuickReplySettingsPresets();
        assert.deepEqual(received, expected);
        received[0].qrList[0].message = 'changed only in initialization';
        assert.equal(response.quickReplyPresets[0].qrList[0].message, 'Fixture only');
        assert.equal(takeQuickReplySettingsPresets(), null, 'exactly one consumption');
    });
    assert.equal(takeQuickReplySettingsPresets(), null, 'no persistent response after initialization');
});

test('empty presets are a valid consumed handoff, not a missing response', async () => {
    await withQuickReplySettingsHandoff({ quickReplyPresets: [] }, () => {
        assert.deepEqual(takeQuickReplySettingsPresets(), []);
        assert.equal(takeQuickReplySettingsPresets(), null);
    });
});

test('handoff preserves return values and is cleared on initialization failure', async () => {
    const value = {};
    assert.equal(await withQuickReplySettingsHandoff(fixture(), () => value), value);
    const failure = Error('Synthetic initialization failure');
    await assert.rejects(withQuickReplySettingsHandoff(fixture(), async () => { throw failure; }), error => error === failure);
    assert.equal(takeQuickReplySettingsPresets(), null);
});

test('invalid or missing response never supplies another initialization with data', async () => {
    for (const response of [null, {}, { quickReplyPresets: null }, { quickReplyPresets: {} }, { quickReplyPresets: 'invalid' }]) {
        let runs = 0;
        await withQuickReplySettingsHandoff(response, () => { runs++; assert.equal(takeQuickReplySettingsPresets(), null); });
        assert.equal(runs, 1);
        assert.equal(takeQuickReplySettingsPresets(), null);
    }
});

test('a non-JSON response fails open to the original fresh fetch, not to stale handoff data', async () => {
    const presets = []; presets.push(presets);
    await withQuickReplySettingsHandoff({ quickReplyPresets: presets }, () => assert.equal(takeQuickReplySettingsPresets(), null));
    assert.equal(takeQuickReplySettingsPresets(), null);
});

test('a failed owner/epoch guard permanently discards this handoff', async () => {
    for (const throws of [false, true]) {
        let current = false;
        await withQuickReplySettingsHandoff(fixture(), () => {
            assert.equal(takeQuickReplySettingsPresets(), null);
            current = true;
            assert.equal(takeQuickReplySettingsPresets(), null, 'cannot revive an observed-invalid owner');
        }, () => { if (throws && !current) throw Error('Synthetic lost owner'); return current; });
    }
});

test('overlapping scopes use fresh fetch rather than pick another scope, then retain only their own remaining scope', async () => {
    const first = deferred(), second = deferred();
    const a = fixture(), b = fixture(); b.quickReplyPresets[0].name = 'Other synthetic scope';
    const pendingA = withQuickReplySettingsHandoff(a, async () => { await first.promise; });
    const pendingB = withQuickReplySettingsHandoff(b, async () => { await second.promise; });
    assert.equal(takeQuickReplySettingsPresets(), null, 'ambiguous concurrency has no handoff');
    first.resolve(); await pendingA;
    assert.deepEqual(takeQuickReplySettingsPresets(), b.quickReplyPresets);
    second.resolve(); await pendingB;
    assert.equal(takeQuickReplySettingsPresets(), null);
});

test('shipping loadSets consumes current presets without a second settings fetch', async () => {
    const response = fixture(), before = plain(response), h = loadSetsHarness();
    await withQuickReplySettingsHandoff(response, () => h.loadSets());
    assert.equal(h.requests.length, 0);
    assert.deepEqual(plain(h.created), before.quickReplyPresets);
    assert.deepEqual(response, before);
    assert.deepEqual(h.initialized, ['Synthetic fixture']);
    assert.deepEqual(h.persisted, ['Synthetic fixture']);
    assert.equal(h.list[0].qrList[0].syntheticInitialized, true);
});

test('shipping loadSets keeps migration on the private copy without executing quick replies', async () => {
    const response = { quickReplyPresets: [{ version: 1, name: 'Legacy synthetic', quickActionEnabled: true,
        quickReplySlots: [{ label: 'Legacy fixture', mes: 'Synthetic source', autoExecute_appStartup: true }], unknown: { keep: true } }] };
    const before = plain(response), h = loadSetsHarness();
    await withQuickReplySettingsHandoff(response, () => h.loadSets());
    assert.equal(h.requests.length, 0);
    assert.equal(h.created[0].version, 2);
    assert.equal(h.created[0].disableSend, true);
    assert.equal(h.created[0].qrList[0].executeOnStartup, true);
    assert.deepEqual(response, before);
});

test('shipping loadSets does not refetch a valid empty preset collection', async () => {
    const h = loadSetsHarness();
    await withQuickReplySettingsHandoff({ quickReplyPresets: [] }, () => h.loadSets());
    assert.equal(h.requests.length, 0); assert.equal(h.list.length, 0);
});

test('shipping loadSets preserves original authenticated POST fallback when no handoff exists', async () => {
    const h = loadSetsHarness();
    await h.loadSets();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/settings/get');
    assert.equal(h.requests[0].options.method, 'POST');
    assert.equal(h.requests[0].options.headers['X-CSRF-Token'], 'synthetic-fixture');
    assert.equal(h.requests[0].options.body, '{}');
    assert.equal(h.list.length, 1);
});

test('shipping loadSets does not migrate or provision presets after a rejected settings fetch', async () => {
    const h = loadSetsHarness({ ok: false });
    await h.loadSets();
    assert.equal(h.requests.length, 1); assert.equal(h.created.length, 0);
});

test('shipping init registers automatic startup only for the existing APP_READY event', async () => {
    const events = [], sequence = [];
    const context = vm.createContext({
        loadSets: async () => { sequence.push('sets'); }, loadSettings: async () => { sequence.push('settings'); }, log() {},
        settings: { config: { setList: [] } },
        SettingsUi: class { render() { sequence.push('render'); return 'synthetic-ui'; } },
        ButtonUi: class { show() { sequence.push('buttons'); } },
        QuickReplyApi: class {}, SlashCommandHandler: class { init() { sequence.push('commands'); } },
        AutoExecuteHandler: class {},
        eventSource: { on(name, callback) { events.push({ name, callback }); } }, event_types: { APP_READY: 'synthetic-APP_READY' },
        document: { querySelector() { return { append() {} }; } },
        finalizeInit: async () => { sequence.push('auto-start'); },
    });
    const start = quickReplySource.indexOf('export async function init() {');
    const end = quickReplySource.indexOf('const finalizeInit = async () => {', start);
    vm.runInContext(quickReplySource.slice(start, end).replace('export async function', 'async function'), context);
    await context.init();
    assert.deepEqual(sequence, ['sets', 'settings', 'render', 'buttons', 'commands']);
    assert.equal(events.length, 1); assert.equal(events[0].name, 'synthetic-APP_READY');
    await events[0].callback(); assert.equal(sequence.at(-1), 'auto-start');
});

function hookHarness(hook) {
    const marks = [], logs = [], timeout = deferred();
    const context = vm.createContext({
        manifests: { 'synthetic-extension': { hooks: { activate: 'init' }, js: 'fixture.js' } },
        extensionAssetUrl: path => `https://fixture.invalid/${path}`,
        importModule: async () => ({ init: hook }),
        performance: { mark: name => marks.push(name) },
        delay: () => timeout.promise,
        console: { debug() {}, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } },
    });
    const start = extensionsSource.indexOf('async function callExtensionHook(');
    const end = extensionsSource.indexOf('\n/**', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(extensionsSource.slice(start, end).replace('await import(url)', 'await importModule(url)'), context);
    return { call: () => context.callExtensionHook('synthetic-extension', 'activate'), marks, logs, timeout };
}

test('shipping hook timing records actual hook start and successful completion', async () => {
    const held = deferred(), h = hookHarness(() => held.promise);
    const pending = h.call(); await tick();
    assert.deepEqual(h.marks, ['homer-extension-hook-start:synthetic-extension:activate']);
    held.resolve(); await pending;
    assert.deepEqual(h.marks, ['homer-extension-hook-start:synthetic-extension:activate', 'homer-extension-hook-complete:synthetic-extension:activate']);
});

test('shipping hook timeout is not counted as completion and late completion is observable', async () => {
    const held = deferred(), h = hookHarness(() => held.promise);
    const pending = h.call(); await tick(); h.timeout.resolve(); await pending;
    assert.deepEqual(h.marks, ['homer-extension-hook-start:synthetic-extension:activate', 'homer-extension-hook-timeout:synthetic-extension:activate']);
    held.resolve(); await tick();
    assert.equal(h.marks.at(-1), 'homer-extension-hook-complete:synthetic-extension:activate');
});

test('shipping hook failure retains catch behavior and never reports successful completion', async () => {
    for (const async of [false, true]) {
        const failure = Error('Synthetic hook failure');
        const h = hookHarness(() => { if (async) return Promise.reject(failure); throw failure; });
        await h.call();
        assert.deepEqual(h.marks, ['homer-extension-hook-start:synthetic-extension:activate', 'homer-extension-hook-error:synthetic-extension:activate']);
        assert.equal(h.logs.length, 1);
    }
});

test('startup handoff wraps only existing extension initialization, not lifecycle or card activation', () => {
    assert.match(startupSource, /import \{ withQuickReplySettingsHandoff \} from '\.\/scripts\/extension-settings-handoff\.mjs';/);
    assert.match(startupSource, /await withQuickReplySettingsHandoff\(data, \(\) => loadExtensionSettings\(settings, isVersionChanged, enableAutoUpdate\)/);
    assert.match(quickReplySource, /import \{ takeQuickReplySettingsPresets \} from '\.\.\/\.\.\/extension-settings-handoff\.mjs';/);
    assert.ok(startupSource.indexOf('await setUserControls(data.enable_accounts)') < startupSource.indexOf('await withQuickReplySettingsHandoff(data,'));
});
