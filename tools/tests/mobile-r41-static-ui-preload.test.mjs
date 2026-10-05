import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { STATIC_DIALOGUE_UI_RESOURCES, preloadStaticDialogueUi } from '../../sillytavern-runtime/public/scripts/homer-static-ui-preload.mjs';

// A deterministic DOM double verifies scheduling/scope only. It is not proof
// that Chromium reuses downloaded bytes; exact APK/browser checks remain due.
function fixture({ url = 'https://fixture.invalid/module/dialogue/?homer_prewarm=1', supported = true } = {}) {
    const created = [], inserted = [], lookupCalls = [];
    let failNext = false;
    class Link {
        constructor(doc) {
            this.ownerDocument = doc; this.isConnected = false;
            this.rel = ''; this.as = ''; this.href = ''; this.id = '';
            this.relList = { supports: value => supported && value === 'preload' };
            this.listeners = new Map(); this.attrs = new Map();
        }
        setAttribute(name, value) { this.attrs.set(name, String(value)); }
        getAttribute(name) { return this.attrs.get(name) ?? null; }
        addEventListener(name, callback) {
            if (!this.listeners.has(name)) this.listeners.set(name, new Set());
            this.listeners.get(name).add(callback);
        }
        removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
        fire(name) { for (const callback of [...(this.listeners.get(name) || [])]) callback(); }
        remove() { this.isConnected = false; }
    }
    class FixtureDocument {
        constructor() {
            this.URL = url; this.defaultView = { Document: FixtureDocument };
            this.head = { ownerDocument: this, append: link => {
                if (failNext) { failNext = false; throw Error('Synthetic DOM append failure'); }
                link.isConnected = true; inserted.push(link);
            } };
            this.querySelectorAll = () => { throw Error('Instance lookup shim must not be consulted'); };
            this.createElement = () => { throw Error('Instance createElement override must not be consulted'); };
        }
        createElement(tag) {
            assert.equal(tag, 'link', 'Only preload links may be created, never script/style/mounted card nodes');
            const link = new Link(this); created.push(link); return link;
        }
        querySelectorAll(selector) {
            lookupCalls.push({ doc: this, selector });
            assert.equal(selector, 'link[data-homer-static-ui-preload]');
            return inserted.filter(link => link.isConnected && link.getAttribute('data-homer-static-ui-preload') !== null);
        }
    }
    const doc = new FixtureDocument();
    const links = () => inserted.filter(link => link.isConnected);
    return { doc, Link, FixtureDocument, created, inserted, lookupCalls, links,
        run: () => preloadStaticDialogueUi(doc), failAppend: () => { failNext = true; } };
}

test('fixed resource descriptors are immutable, bounded and contain only public presentation CSS/classic JS', () => {
    assert.equal(STATIC_DIALOGUE_UI_RESOURCES.length, 3);
    assert.equal(new Set(STATIC_DIALOGUE_UI_RESOURCES.map(item => item.href)).size, 3);
    assert.deepEqual(STATIC_DIALOGUE_UI_RESOURCES.map(item => item.href), [
        '/assets/vendor/tavo/dist/css/bundle.min.css',
        '/assets/vendor/tavo/dist/js/bundle.min.js', '/assets/css/tavo-chat-ui.css',
    ], 'Only the bounded-retry loader may own a speculative resource');
    assert.ok(Object.isFrozen(STATIC_DIALOGUE_UI_RESOURCES));
    for (const resource of STATIC_DIALOGUE_UI_RESOURCES) {
        assert.ok(Object.isFrozen(resource)); assert.ok(['style', 'script'].includes(resource.as));
        assert.ok(resource.href.startsWith('/assets/')); assert.ok(!resource.href.includes('/api/'));
        assert.deepEqual(Object.keys(resource).sort(), ['as', 'href']);
    }
    assert.throws(() => { STATIC_DIALOGUE_UI_RESOURCES.push({ href: '/api/private', as: 'fetch' }); });
    assert.throws(() => { STATIC_DIALOGUE_UI_RESOURCES[0].href = 'https://external.invalid/private'; });
});

test('first preparation schedules exact original URLs without executing JS or applying styles', () => {
    const h = fixture(), outcome = h.run();
    assert.deepEqual(outcome, { started: 3, reused: 0, failed: 0, unsupported: false });
    assert.ok(Object.isFrozen(outcome)); assert.equal(h.links().length, 3);
    for (const [index, link] of h.links().entries()) {
        const resource = STATIC_DIALOGUE_UI_RESOURCES[index];
        assert.equal(link.rel, 'preload'); assert.equal(link.as, resource.as);
        assert.equal(link.href, new URL(resource.href, h.doc.URL).href);
        assert.equal(link.getAttribute('data-homer-static-ui-preload'), resource.href);
        assert.equal(link.id, '', 'Never collide with consumer stylesheet/script IDs');
        assert.equal(link.getAttribute('crossorigin'), null, 'Match existing same-origin classic-script/style request modes');
    }
    assert.equal(h.lookupCalls.length, 1, 'Document prototype lookup bypasses the embedded host shim');
});

test('pending and loaded preparations remain single-flight per local document', () => {
    const h = fixture(); h.run();
    const first = h.links();
    assert.deepEqual(h.run(), { started: 0, reused: 3, failed: 0, unsupported: false });
    first.forEach(link => link.fire('load'));
    assert.deepEqual(h.run(), { started: 0, reused: 3, failed: 0, unsupported: false });
    assert.deepEqual(h.links(), first);
});

test('a failed preload removes only its own hint and a later call can retry the original URL', () => {
    const h = fixture(); h.run();
    const first = h.links()[1], url = first.href;
    first.fire('error'); assert.equal(first.isConnected, false); assert.equal(h.links().length, 2);
    assert.deepEqual(h.run(), { started: 1, reused: 2, failed: 0, unsupported: false });
    const replacement = h.links().find(link => link.href === url);
    assert.notEqual(replacement, first); assert.equal(replacement.rel, 'preload'); assert.equal(replacement.as, 'script');
    first.fire('error'); assert.equal(replacement.isConnected, true, 'Old failure delivery cannot remove the replacement');
});

test('a removed pending hint is replaced without deleting or cancelling other hints', () => {
    const h = fixture(); h.run();
    const first = h.links()[0], others = h.links().slice(1);
    first.remove();
    assert.deepEqual(h.run(), { started: 1, reused: 2, failed: 0, unsupported: false });
    assert.equal(others.every(link => link.isConnected), true);
    assert.equal(h.links().filter(link => link.href === first.href).length, 1);
});

test('DOM insertion failure is contained and remains retryable rather than rejecting prewarm startup', () => {
    const h = fixture(); h.failAppend();
    assert.deepEqual(h.run(), { started: 2, reused: 0, failed: 1, unsupported: false });
    assert.equal(h.links().length, 2);
    assert.deepEqual(h.run(), { started: 1, reused: 2, failed: 0, unsupported: false });
    assert.equal(h.links().length, 3);
});

test('shared URLs never reuse the parent document hint as a substitute for runtime preparation', () => {
    const host = fixture(), runtime = fixture(); host.run();
    // Simulate the instance-level fallback shim used for card compatibility.
    runtime.doc.querySelectorAll = () => host.links();
    const outcome = runtime.run();
    assert.equal(outcome.started, 3);
    assert.equal(runtime.links().every(link => link.ownerDocument === runtime.doc), true);
    assert.equal(host.links().every(link => link.ownerDocument === host.doc), true);
    assert.equal(runtime.links().some(link => host.links().includes(link)), false);
});

test('a matching dataset hint already present in the local document is adopted without another request', () => {
    const h = fixture(), resource = STATIC_DIALOGUE_UI_RESOURCES[0];
    const link = new h.Link(h.doc); link.rel = 'preload'; link.as = resource.as;
    link.href = new URL(resource.href, h.doc.URL).href;
    link.setAttribute('data-homer-static-ui-preload', resource.href); h.doc.head.append(link);
    assert.deepEqual(h.run(), { started: 2, reused: 1, failed: 0, unsupported: false });
    assert.equal(h.links().filter(item => item.href === link.href).length, 1);
    link.fire('error'); assert.equal(link.isConnected, false);
    assert.deepEqual(h.run(), { started: 1, reused: 2, failed: 0, unsupported: false });
});

test('wrong query/as or activated stylesheet is not mistaken for a matching byte-preload hint', () => {
    const h = fixture(), resource = STATIC_DIALOGUE_UI_RESOURCES[2];
    for (const change of ['query', 'as', 'rel']) {
        const link = new h.Link(h.doc); link.rel = 'preload'; link.as = resource.as;
        link.href = new URL(resource.href, h.doc.URL).href;
        if (change === 'query') link.href += '?unrelated=old';
        if (change === 'as') link.as = 'fetch';
        if (change === 'rel') link.rel = 'stylesheet';
        link.setAttribute('data-homer-static-ui-preload', resource.href); h.doc.head.append(link);
    }
    assert.equal(h.run().started, 3);
    assert.equal(h.links().filter(link => link.rel === 'preload' && link.as === 'style'
        && link.href === new URL(resource.href, h.doc.URL).href).length, 1);
});

test('a previously recorded hint with changed request attributes is not reported as a valid reusable preload', () => {
    const h = fixture(); h.run(); const changed = h.links()[0];
    changed.as = 'fetch';
    assert.deepEqual(h.run(), { started: 1, reused: 2, failed: 0, unsupported: false });
    assert.equal(changed.isConnected, true, 'Do not delete another component\'s subsequently changed node');
    assert.equal(h.links().filter(link => link.as === 'style' && link.href === changed.href).length, 1);
});

test('late failure never deletes a hint repurposed by another component or moved to another document', () => {
    for (const mutation of ['rel', 'owner']) {
        const h = fixture(); h.run(); const changed = h.links()[0];
        if (mutation === 'rel') changed.rel = 'stylesheet';
        else changed.ownerDocument = fixture().doc;
        changed.fire('error');
        assert.equal(changed.isConnected, true, 'Only an exact locally owned hint may be removed on failure');
        assert.equal(h.run().started, 1);
    }
});

test('unsupported preload, missing document or non-HTTP document leaves the normal activation path untouched', () => {
    for (const options of [{ supported: false }, { url: 'about:blank' }, { url: 'file:///fixture.html' }]) {
        const h = fixture(options); assert.equal(h.run().unsupported, true); assert.equal(h.links().length, 0);
    }
    assert.equal(preloadStaticDialogueUi(null).unsupported, true);
});

test('only recoverable presentation consumers are hinted; optional picker and imported CSS remain original consumers', () => {
    const frontend = new URL('../../frontend/', import.meta.url);
    const read = path => fs.readFileSync(new URL(path, frontend), 'utf8');
    const picker = read('assets/js/option-picker.js'), adapter = read('assets/js/tavo-chat-ui.js');
    const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
    const actual = new Map(STATIC_DIALOGUE_UI_RESOURCES.map(resource => [resource.href, resource.as]));
    for (const path of [
        '/assets/js/option-picker.js?v=20260917-r8', '/assets/css/chat-design.css?v=20260917-r8',
    ]) assert.ok(bridge.includes(path), 'Shipping bridge still consumes exact ' + path);
    for (const match of picker.matchAll(/new URL\('([^']+\.css(?:\?[^']+)?)',\s*source\)/g)) {
        const url = new URL(match[1], 'https://fixture.invalid/assets/js/option-picker.js?v=20260917-r8');
        assert.equal(actual.has(url.pathname + url.search), false, 'Picker CSS without bounded recovery must not be hinted');
    }
    assert.ok(adapter.includes("const VENDOR = '/assets/vendor/tavo'"));
    assert.ok(adapter.includes("'/assets/css/tavo-chat-ui.css'"));
    for (const path of ['assets/css/chat-design.css', 'assets/css/option-picker.css', 'assets/css/overlay-system.css', 'assets/css/chat-settings-page.css']) {
        const css = read(path), match = css.match(/^@import url\('([^']+)'\)/);
        assert.ok(match, 'Shipping first-level CSS import exists: ' + path);
        const url = new URL(match[1], 'https://fixture.invalid/' + path);
        assert.equal(actual.has(url.pathname + url.search), false, 'Unowned imported stylesheet must not be hinted');
    }
    assert.equal(actual.has('/assets/js/option-picker.js?v=20260917-r8'), false);
    assert.ok(adapter.includes("return presentationAsset(id, href, 'style')"));
    assert.ok(adapter.includes("presentationAsset('homer-tavo-vendor-js'"));
});

const bridgeSource = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const prewarmBegin = bridgeSource.indexOf('async function loadAdministratorExtensions(');
const prewarmEnd = bridgeSource.indexOf('async function preferLocalSession(', prewarmBegin);
assert.ok(prewarmBegin >= 0 && prewarmEnd > prewarmBegin, 'Actual approved-extension/prewarm source exists');

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
async function microtasks() {
    for (let i = 0; i < 12; i++) await Promise.resolve();
}
function prewarmFixture({ prewarmOnly = true, previousPromise = null, hint, owned = true, token = 'synthetic-engine', app = '', launch = null, scheduled = false } = {}) {
    const registry = deferred(), approved = deferred(), presentation = deferred(), calls = [], marks = [], warnings = [];
    const context = {
        prewarmOnly, prewarmBootstrapPromise: previousPromise, administratorExtensionsPromise: null,
        canNotifyHost: () => owned, hostBootstrapEngineToken: token, requestedAppId: app, launch, bridgeStartScheduled: scheduled,
        tavoUiReady: null,
        MODULE_ID: 'static-ui-prewarm-fixture', window: {},
        performance: { mark: value => marks.push(value) }, console: { warn: (...args) => warnings.push(args[0]) },
        preloadStaticDialogueUi: () => {
            calls.push('hint'); return hint ? hint() : { started: 3, reused: 0, failed: 0, unsupported: false };
        },
        requestJson: path => {
            assert.equal(path, '/api/homer/extensions', 'Prewarm only retains the established approved registry request');
            calls.push(path); return registry.promise;
        },
        proxyExtensionAssetUrl: path => path,
        loadApprovedExtensions: list => { calls.push('approved'); assert.ok(Array.isArray(list)); return approved.promise; },
        // Presentation activation is local and empty; scoped engine work remains forbidden.
        fetchSession: () => { throw Error('No prewarm conversation request'); },
        loadTavoUi: () => { calls.push('ui'); return presentation.promise; },
        mountTavoComposer: () => { throw Error('No prewarm composer mounting'); },
        importLaunchCharacter: () => { throw Error('No prewarm card execution'); },
    };
    vm.createContext(context);
    vm.runInContext(bridgeSource.slice(bridgeSource.indexOf('function prepareTavoConversationUi()'), bridgeSource.indexOf('function setComposerDraft(')), context);
    vm.runInContext(bridgeSource.slice(prewarmBegin, prewarmEnd), context);
    return { context, registry, approved, presentation, calls, marks, warnings, start: () => context.beginSharedPrewarm() };
}

test('actual non-prewarm entry returns the existing value without starting hints or approved-extension work', () => {
    for (const previousPromise of [null, Promise.resolve('existing prewarm')]) {
        const h = prewarmFixture({ prewarmOnly: false, previousPromise });
        assert.equal(h.start(), previousPromise); assert.deepEqual(h.calls, []); assert.deepEqual(h.marks, []);
    }
});

test('actual prewarm entry with an existing pending or completed promise returns it without another hint', () => {
    for (const previousPromise of [new Promise(() => {}), Promise.resolve('completed')]) {
        const h = prewarmFixture({ previousPromise });
        assert.equal(h.start(), previousPromise); assert.deepEqual(h.calls, []); assert.deepEqual(h.marks, []);
    }
});

test('actual shared prewarm is single-flight and still awaits the complete approved-extension operation', async () => {
    const h = prewarmFixture(), result = { result: { loaded: ['synthetic-approved-extension'], failed: [] } };
    const pending = h.start();
    assert.equal(h.start(), pending); assert.equal(h.context.prewarmBootstrapPromise, pending);
    assert.deepEqual(h.calls, ['hint', 'ui', '/api/homer/extensions']);
    assert.deepEqual(h.marks, ['homer-prewarm-start']);
    let settled = false; pending.then(() => { settled = true; });
    await microtasks(); assert.equal(settled, false);
    h.registry.resolve([{ id: 'synthetic-approved-extension', js_url: '/assets/synthetic.js', css_url: '' }]);
    await microtasks();
    assert.deepEqual(h.calls, ['hint', 'ui', '/api/homer/extensions', 'approved']);
    assert.equal(settled, false, 'Registry readiness must not bypass the original extension initialization barrier');
    assert.deepEqual(h.marks, ['homer-prewarm-start']);
    h.approved.resolve(result); assert.equal(await pending, result);
    assert.equal(h.start(), pending); assert.equal(h.calls.filter(call => call === 'hint').length, 1);
    assert.deepEqual(h.marks, ['homer-prewarm-start', 'homer-prewarm-shared-ready']);
});

test('actual shared prewarm never reads or awaits the optional hint thenable', async () => {
    let thenReads = 0;
    const optional = Object.defineProperty({}, 'then', { get() { thenReads++; throw Error('Optional hint must not be awaited'); } });
    const h = prewarmFixture({ hint: () => optional }), pending = h.start(), result = { loaded: [] };
    h.registry.resolve([]); h.approved.resolve(result);
    assert.equal(await pending, result); assert.equal(thenReads, 0);
    assert.deepEqual(h.calls, ['hint', 'ui', '/api/homer/extensions', 'approved']);
});

test('a real optional preload failure/retry does not settle or refetch the actual approved-extension barrier', async () => {
    const dom = fixture(), h = prewarmFixture({ hint: () => dom.run() }), pending = h.start();
    assert.equal(dom.links().length, 3);
    dom.links()[0].fire('error'); assert.equal(dom.links().length, 2);
    assert.equal(h.start(), pending, 'Shared prewarm keeps its original single-flight contract');
    assert.equal(h.calls.filter(call => call === 'hint').length, 1);
    // The direct-entry call can retry presentation hints independently while
    // the already-approved extension operation remains the same promise.
    assert.deepEqual(dom.run(), { started: 1, reused: 2, failed: 0, unsupported: false });
    let settled = false; pending.then(() => { settled = true; });
    await microtasks(); assert.equal(settled, false);
    h.registry.resolve([]); await microtasks(); assert.equal(settled, false);
    const result = { loaded: [] }; h.approved.resolve(result); assert.equal(await pending, result);
    assert.equal(h.calls.filter(call => call === '/api/homer/extensions').length, 1);
});

for (const stage of ['registry', 'approved']) {
    test(`actual ${stage} failure retains the existing reported fallback and does not secretly retry`, async () => {
        const h = prewarmFixture(), pending = h.start();
        if (stage === 'registry') h.registry.reject(Error('Synthetic registry failure'));
        else { h.registry.resolve([]); await microtasks(); h.approved.reject(Error('Synthetic approved extension failure')); }
        const reported = await pending;
        assert.equal(reported, h.context.window.__homerDialogueExtensions);
        assert.equal(reported.result.failed.length, 1); assert.equal(reported.result.failed[0].id, 'registry');
        assert.equal(h.warnings.length, 1);
        assert.equal(h.start(), pending, 'Retry policy remains the original sticky result for this document');
        assert.equal(h.calls.filter(call => call === 'hint').length, 1);
        assert.equal(h.calls.filter(call => call === '/api/homer/extensions').length, 1);
        assert.deepEqual(h.marks, ['homer-prewarm-start', 'homer-prewarm-shared-ready']);
        // A fresh document still starts a new authorized operation normally;
        // preload metadata never disables or supplies its extension registry.
        const next = prewarmFixture(), retried = next.start(), result = { loaded: [] };
        next.registry.resolve([]); next.approved.resolve(result);
        assert.equal(await retried, result);
        assert.deepEqual(next.calls, ['hint', 'ui', '/api/homer/extensions', 'approved']);
    });
}

for (const options of [{ owned: false }, { token: '' }, { app: 'selected' }, { launch: {} }, { scheduled: true }]) {
    test(`fixed presentation pre-execution requires an empty owned prewarm (${JSON.stringify(options)})`, () => {
        const h = prewarmFixture(options); h.start();
        assert.deepEqual(h.calls, ['hint', '/api/homer/extensions']);
    });
}

test('presentation remains independent of core/extension readiness and actual install reuses its promise', async () => {
    const h = prewarmFixture(), pending = h.start();
    const prepared = h.context.prepareTavoConversationUi();
    assert.strictEqual(prepared, h.context.tavoUiReady);
    assert.equal(h.calls.filter(call => call === 'ui').length, 1);
    h.registry.resolve([]); h.approved.resolve({ loaded: [] });
    await pending;
    let preparedSettled = false; prepared.then(() => { preparedSettled = true; });
    await microtasks(); assert.equal(preparedSettled, false);
    h.presentation.resolve(); await prepared;
    assert.strictEqual(h.context.prepareTavoConversationUi(), prepared);
});

test('failed empty presentation is handled and resets only its promise for the real installer', async () => {
    const h = prewarmFixture(); h.start(); h.presentation.reject(Error('Synthetic style failure'));
    await microtasks(); assert.equal(h.context.tavoUiReady, null);
    const retry = deferred(); h.context.loadTavoUi = () => retry.promise;
    const installed = h.context.prepareTavoConversationUi();
    retry.resolve(); await installed;
    assert.strictEqual(h.context.tavoUiReady, installed);
    assert.equal(h.context.session, undefined); assert.equal(h.context.launch, null);
});

const adapterSource = fs.readFileSync(new URL('../../frontend/assets/js/tavo-chat-ui.js', import.meta.url), 'utf8');
const assetBegin = adapterSource.indexOf('function presentationAsset(');
const assetEnd = adapterSource.indexOf('function response(', assetBegin);
const loaderBegin = adapterSource.indexOf('export function loadTavoUi(');
const loaderEnd = adapterSource.indexOf('export function decorateTavoMessage(', loaderBegin);
assert.ok(assetBegin >= 0 && assetEnd > assetBegin && loaderBegin >= 0 && loaderEnd > loaderBegin);

// Execute the shipping loader, not a duplicated retry algorithm. This DOM
// double proves Promise/event/timeout boundaries; HTTP cases prove Chromium's
// failed preload memory is transparently consumed and retried in one load.
function consumerFixture() {
    const created = [], inserted = [], timers = new Map(), calls = [];
    let nextTimer = 0, failAppend = false;
    class Node {
        constructor(tag, doc) {
            this.tagName = tag; this.ownerDocument = doc; this.id = '';
            this.isConnected = false; this.listeners = new Map(); this.attrs = new Map();
        }
        setAttribute(name, value) { this.attrs.set(name, String(value)); }
        addEventListener(name, callback) {
            if (!this.listeners.has(name)) this.listeners.set(name, new Set());
            this.listeners.get(name).add(callback);
        }
        removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
        fire(name) {
            if (name === 'load' && this.tagName === 'link') this.sheet = {};
            for (const callback of [...(this.listeners.get(name) || [])]) callback();
        }
        remove() { this.isConnected = false; }
    }
    const classes = { add: () => {}, contains: () => false };
    const doc = { documentElement: { classList: classes }, body: { classList: classes },
        createElement: tag => { const node = new Node(tag, doc); created.push(node); return node; } };
    const append = node => {
        if (failAppend) { failAppend = false; throw Error('Synthetic append failure'); }
        node.isConnected = true; inserted.push(node);
    };
    doc.head = { append }; doc.body.append = append;
    const context = {
        document: doc, window: {}, location: { search: '' }, URLSearchParams, Element: Node,
        VENDOR: '/assets/vendor/tavo', scaffoldMarkup: '<div>synthetic scaffold only</div>',
        loading: undefined, cleanupObserver: null, decorated: new Map(), presentationAssetRequests: new Map(),
        localElementById: id => inserted.find(node => node.isConnected && node.id === id) || null,
        installTavoComposerFocusRelay: () => calls.push('focus'), dispatchOriginalCall: () => {},
        refreshTavoUi: () => calls.push('refresh'), resetTavoDocumentViewport: () => calls.push('viewport'),
        MutationObserver: class { observe() {} },
        setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
    };
    vm.createContext(context);
    vm.runInContext(adapterSource.slice(assetBegin, assetEnd)
        + adapterSource.slice(loaderBegin, loaderEnd).replace('export function', 'function')
        + '\nglobalThis.asset = presentationAsset;globalThis.loadUi = loadTavoUi;', context);
    return { context, created, inserted, timers, calls,
        latest: id => [...inserted].reverse().find(node => node.isConnected && node.id === id),
        nodes: id => inserted.filter(node => node.id === id),
        active: id => inserted.filter(node => node.isConnected && node.id === id),
        expire: () => { const timersNow = [...timers.values()]; timersNow.forEach(timer => timer.callback()); },
        failNextAppend: () => { failAppend = true; },
        activateVendor: () => { context.window.tav = { item: { MessageBubbleItem: class {} }, JSBridge: {
            setConversation: () => calls.push('conversation'),
        } }; },
    };
}

for (const kind of ['style', 'script']) {
    test(`actual ${kind} consumer shares one pending Promise and transparently retries one error with identical URL`, async () => {
        const h = consumerFixture(), href = `/assets/synthetic.${kind === 'style' ? 'css' : 'js'}`;
        const pending = h.context.asset('fixed-public-asset', href, kind);
        assert.equal(h.context.asset('fixed-public-asset', href, kind), pending);
        const first = h.latest('fixed-public-asset'); first.fire('error');
        const second = h.latest('fixed-public-asset');
        assert.notEqual(second, first); assert.equal(first.isConnected, false);
        assert.equal(second[kind === 'style' ? 'href' : 'src'], href);
        assert.equal(h.context.asset('fixed-public-asset', href, kind), pending);
        assert.equal(h.nodes('fixed-public-asset').length, 2);
        first.fire('load'); assert.equal(h.context.presentationAssetRequests.size, 1);
        second.fire('load'); await pending;
        assert.equal(h.context.presentationAssetRequests.size, 0); assert.equal(h.timers.size, 0);
    });

    test(`actual ${kind} consumer rejects a permanent error after two attempts, cleans state, and permits explicit later retry`, async () => {
        const h = consumerFixture(), pending = h.context.asset('fixed', '/assets/fixed', kind);
        const rejection = assert.rejects(pending, /对话.*未能加载/);
        h.latest('fixed').fire('error'); h.latest('fixed').fire('error'); await rejection;
        assert.equal(h.nodes('fixed').length, 2); assert.equal(h.active('fixed').length, 0);
        assert.equal(h.context.presentationAssetRequests.size, 0); assert.equal(h.timers.size, 0);
        const later = h.context.asset('fixed', '/assets/fixed', kind);
        h.latest('fixed').fire('load'); await later; assert.equal(h.nodes('fixed').length, 3);
    });
}

test('style timeout retains its original bounded rejection without an automatic second wait or late-load settlement', async () => {
    const h = consumerFixture(), pending = h.context.asset('style', '/assets/fixed.css', 'style');
    const rejection = assert.rejects(pending, /对话样式未能加载/);
    assert.equal([...h.timers.values()][0].delay, 15000);
    const late = h.latest('style'); h.expire(); await rejection;
    assert.equal(h.nodes('style').length, 1); assert.equal(h.active('style').length, 0);
    late.fire('load'); assert.equal(h.context.presentationAssetRequests.size, 0); assert.equal(h.timers.size, 0);
});

test('script retains load/error settlement without a new timeout that could re-execute a late original script', async () => {
    const h = consumerFixture(), pending = h.context.asset('script', '/assets/fixed.js', 'script');
    assert.equal(h.timers.size, 0, 'A removed classic script is not a reliable execution abort');
    h.expire(); assert.equal(h.context.asset('script', '/assets/fixed.js', 'script'), pending);
    assert.equal(h.nodes('script').length, 1); h.latest('script').fire('load'); await pending;
});

test('synchronous DOM insertion error rejects without speculative re-append and cleans the pending entry', async () => {
    const h = consumerFixture(); h.failNextAppend();
    await assert.rejects(h.context.asset('fixed', '/assets/fixed.css', 'style'), /对话样式未能加载/);
    assert.equal(h.created.length, 1); assert.equal(h.context.presentationAssetRequests.size, 0);
    assert.equal(h.timers.size, 0);
});

for (const failingId of ['homer-tavo-vendor-css', 'homer-tavo-vendor-js', 'homer-tavo-integration-css']) {
    test(`actual full loadTavoUi recovers ${failingId} inside its original shared Promise with exactly one scaffold`, async () => {
        const h = consumerFixture(), pending = h.context.loadUi();
        assert.equal(h.context.loadUi(), pending);
        for (const id of ['homer-tavo-vendor-css', 'homer-tavo-vendor-js', 'homer-tavo-integration-css']) {
            await microtasks(); const first = h.latest(id); assert.ok(first, id);
            if (id === failingId) {
                first.fire('error'); assert.equal(h.context.loadUi(), pending);
                assert.equal(h.nodes(id).length, 2);
            }
            if (id === 'homer-tavo-vendor-js') h.activateVendor();
            h.latest(id).fire('load');
        }
        await pending;
        assert.equal(h.active('homer-tavo-scaffold').length, 1);
        assert.equal(h.calls.filter(call => call === 'conversation').length, 1);
        assert.equal(h.calls.filter(call => call === 'refresh').length, 1);
        assert.equal(h.context.presentationAssetRequests.size, 0); assert.equal(h.timers.size, 0);
    });
}

test('full loader permanent script failure remains explicit, and a subsequent load reuses the one scaffold', async () => {
    const h = consumerFixture(), pending = h.context.loadUi();
    const rejection = assert.rejects(pending, /对话组件未能加载/);
    h.latest('homer-tavo-vendor-css').fire('load'); await microtasks();
    h.latest('homer-tavo-vendor-js').fire('error'); h.latest('homer-tavo-vendor-js').fire('error');
    await rejection; assert.equal(h.active('homer-tavo-scaffold').length, 1);
    const retry = h.context.loadUi(); assert.notEqual(retry, pending); await microtasks();
    h.activateVendor(); h.latest('homer-tavo-vendor-js').fire('load'); await microtasks();
    h.latest('homer-tavo-integration-css').fire('load'); await retry;
    assert.equal(h.active('homer-tavo-scaffold').length, 1);
    assert.equal(h.nodes('homer-tavo-vendor-css').length, 1, 'Loaded stylesheet is retained');
});
