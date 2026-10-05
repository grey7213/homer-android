import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const adapter = fs.readFileSync(new URL('../../frontend/assets/js/tavo-chat-ui.js', import.meta.url), 'utf8');
const vendor = fs.readFileSync(new URL('../../frontend/assets/vendor/tavo/dist/js/bundle.min.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const composerStart = vendor.indexOf('window.tav.ChatComposer=class');
const composerEnd = vendor.indexOf(',(()=>{var e,t;let n=null,r=null,i=null', composerStart);
assert.ok(composerStart >= 0 && composerEnd > composerStart, 'extract the pinned real vendor composer');
console.log('Actual composer contract source SHA256:', JSON.stringify(Object.fromEntries(
    Object.entries({ adapter, vendor, bridge }).map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')]))));

function harness(initial = {}, optionOverrides = {}) {
    class EventSurface {
        listeners = new Map();
        addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
        removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
        dispatchEvent(event) { for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event); return true; }
    }
    class FixtureElement extends EventSurface {
        constructor() {
            super(); this.hidden = false; this.value = ''; this.disabled = false; this.readOnly = false;
            this.placeholder = ''; this.className = ''; this.children = []; this.dataset = {}; this.attributes = new Map();
            this.parentNode = null; this.offsetWidth = 0; this.offsetHeight = 48; this.scrollHeight = 48;
            this.style = { values: new Map(), getPropertyValue(name) { return this.values.get(name) || ''; },
                setProperty(name, value) { this.values.set(name, value); }, removeProperty(name) { this.values.delete(name); } };
            const names = new Set(); this.classList = { add: (...items) => items.forEach(item => names.add(item)),
                contains: name => names.has(name), remove: name => names.delete(name) };
        }
        append(...items) { for (const item of items) { this.children.push(item); item.parentNode = this; } }
        replaceChildren(...items) { this.children = []; this.append(...items); }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
        blur() {}
        get firstChild() { return this.children[0]; }
        getBoundingClientRect() { return { top: 0, height: 48, width: 390, right: 390, bottom: 48, left: 0 }; }
    }
    const roles = Object.fromEntries(['input', 'plus', 'plus-icon', 'asr-cancel-recording', 'trailing', 'trailing-icon',
        'attachments', 'group-repliers', 'shortcut-bar', 'asr-overlay', 'asr-cancel', 'asr-fill-input', 'asr-release-hint',
        'asr-waveform'].map(name => [name, new FixtureElement()]));
    // Instrument the real vendor's geometry dependencies, not a substitute
    // resize function. A positive width makes its existing method run fully.
    const geometry = { offsetWidth: 0, computedStyle: 0, scrollHeight: 0, heightWrites: 0, overflowWrites: 0 };
    let inputWidth = 1, inputHeight = 48;
    Object.defineProperties(roles.input, {
        offsetWidth: { get() { geometry.offsetWidth++; return inputWidth; }, set(value) { inputWidth = value; } },
        scrollHeight: { get() { geometry.scrollHeight++; return inputHeight; }, set(value) { inputHeight = value; } },
    });
    for (const [property, counter] of [['height', 'heightWrites'], ['overflowY', 'overflowWrites']]) {
        let value;
        Object.defineProperty(roles.input.style, property, { get() { return value; }, set(next) { geometry[counter]++; value = next; } });
    }
    for (const name of ['asr-cancel-recording', 'asr-cancel', 'asr-fill-input']) roles[name].append(new FixtureElement());
    roles['asr-overlay'].append(new FixtureElement());
    const shell = new FixtureElement(); shell.append(roles.input);
    const root = new FixtureElement();
    root.querySelector = selector => roles[/data-tav-role="([^"]+)"/.exec(selector)?.[1]] || null;
    const container = new FixtureElement(); container.append(root);
    const document = new EventSurface(); document.body = new FixtureElement(); document.documentElement = new FixtureElement();
    document.head = new FixtureElement(); document.fonts = new EventSurface(); document.baseURI = 'https://fixture.invalid/';
    document.createElement = () => new FixtureElement(); document.hidden = false;
    document.getElementById = () => null; document.querySelector = () => null;
    const links = new Map(['homer-tavo-vendor-css', 'homer-tavo-integration-css'].map(id => [id, { ownerDocument: document, sheet: {} }]));
    class FixtureDocument {}
    FixtureDocument.prototype.getElementById = id => links.get(id) || null;
    FixtureDocument.prototype.querySelector = () => null;
    const window = new EventSurface(); window.parent = window; window.innerHeight = 844; window.scrollX = window.scrollY = 0;
    window.devicePixelRatio = 1; window.visualViewport = new EventSurface();
    Object.assign(window.visualViewport, { height: 844, offsetTop: 0 });
    let frameId = 0; const frames = new Map();
    window.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
    window.cancelAnimationFrame = id => frames.delete(id);
    window.setTimeout = () => ++frameId; window.clearTimeout = () => {};
    window.matchMedia = () => new EventSurface();
    window.getComputedStyle = element => {
        if (element === roles.input) geometry.computedStyle++;
        return { color: '#fff', lineHeight: '25.6px', paddingTop: '0', paddingBottom: '0' };
    };
    window.scrollTo = (x, y) => { window.scrollX = x; window.scrollY = y; };
    const colors = new Map();
    const calls = { configure: 0, snapshot: 0, chat: 0, theme: 0, viewport: 0, onText: 0, onSubmit: 0, onStop: 0, onPlus: 0 };
    window.tav = { item: { MessageBubbleItem: class {} }, chatView: { chatState: 'idle' },
        chatComposer: { root, dispose() {}, updateViewport() {} }, JSBridge: {
            setConversation() {},
            _applyConfig(config) { calls.theme++; window.tav.config = config; window.tav.chatComposer.updateViewport(config.webViewport || {}); },
            configureComposer(config) { calls.configure++; window.tav.chatComposer.configure(config); },
            applyComposerSnapshot(snapshot) { calls.snapshot++; return window.tav.chatComposer.applySnapshot(snapshot); },
            updateChatState(chatState) { calls.chat++; window.dispatchEvent({ type: 'chatStateChanged', detail: { chatState } }); },
            callFlutter(method, params) { context.dispatchOriginalCall(JSON.stringify({ method, params })); },
            callFlutterWithResult(method, params) { context.dispatchOriginalCall(JSON.stringify({ method, params })); return Promise.resolve(null); },
            _handleFlutterResponse() {},
        } };
    window.addEventListener('chatStateChanged', event => { window.tav.chatView.chatState = event.detail.chatState; });
    const context = vm.createContext({ window, document, Document: FixtureDocument, Element: FixtureElement, HTMLTextAreaElement: FixtureElement,
        URL, URLSearchParams, location: { search: '' }, queueMicrotask, MutationObserver: class { observe() {} },
        getComputedStyle: () => ({ getPropertyValue: name => colors.get(name) || '' }),
        setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
        __spreadValues: (left, right) => Object.assign(left, right), __spreadProps: (left, right) => Object.assign(left, right) });
    vm.runInContext(vendor.slice(composerStart, composerEnd), context);
    const updateViewport = window.tav.ChatComposer.prototype.updateViewport;
    window.tav.ChatComposer.prototype.updateViewport = function (...args) { calls.viewport++; return updateViewport.apply(this, args); };
    // This harness exercises composer lifecycle, not message metadata. The
    // metadata module is covered by packaged presentation E2E tests.
    context.updateMessagePresentation = () => {};
    vm.runInContext(adapter.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
    const state = { scope: 'owner:conversation:a', text: 'draft', generating: false, disabled: false, ...initial };
    const options = { container, getState: () => state,
        onText: text => { calls.onText++; state.text = text; },
        onSubmit: text => { calls.onSubmit++; state.text = ''; state.generating = true; },
        onStop: () => { calls.onStop++; state.generating = false; }, onPlus: () => { calls.onPlus++; },
        ...optionOverrides,
    };
    return { context, window, document, calls, roles, colors, state, options, root, container, geometry, FixtureElement,
        mount: () => context.mountTavoComposer(options),
        async settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
    };
}

test('actual adapter and vendor skip all composer writes on identical refreshes', async () => {
    const h = harness(); const controller = await h.mount(); const before = { ...h.calls };
    for (let i = 0; i < 5; i++) controller.refresh();
    assert.deepEqual(h.calls, before);
    assert.equal(h.roles.input.value, 'draft');
});

test('actual text, disabled configuration and generating state update independently', async () => {
    const h = harness(); const controller = await h.mount(); let before = { ...h.calls };
    h.state.text = 'changed'; controller.refresh();
    assert.equal(h.calls.configure, before.configure); assert.equal(h.calls.snapshot, before.snapshot + 1);
    assert.equal(h.calls.chat, before.chat); assert.equal(h.roles.input.value, 'changed');
    before = { ...h.calls }; h.state.disabled = true; controller.refresh();
    assert.equal(h.calls.configure, before.configure + 1); assert.equal(h.roles.input.disabled, true);
    assert.equal(h.roles.plus.disabled, true); assert.equal(h.roles.trailing.disabled, true);
    h.state.disabled = false; h.state.generating = true; controller.refresh();
    assert.equal(h.roles.input.disabled, false); assert.equal(h.roles.trailing.dataset.action, 'stop');
    assert.equal(h.roles.trailing.getAttribute('aria-label'), '停止生成'); assert.equal(h.window.tav.chatView.chatState, 'generating');
    before = { ...h.calls }; controller.refresh(); assert.deepEqual(h.calls, before);
});

test('scope identity refreshes the complete config and snapshot without leaking an old draft', async () => {
    const h = harness(); const controller = await h.mount(); const initialIdentity = { ...controller.identity }; const before = { ...h.calls };
    h.state.scope = 'owner:conversation:b'; h.state.text = 'second'; controller.refresh();
    assert.equal(controller.identity.navigationSession, initialIdentity.navigationSession + 1);
    assert.equal(h.calls.configure, before.configure + 1); assert.equal(h.calls.snapshot, before.snapshot + 1);
    assert.equal(h.window.tav.chatComposer.snapshot.navigationSession, controller.identity.navigationSession);
    assert.equal(h.roles.input.value, 'second');
    h.context.dispatchOriginalCall(JSON.stringify({ method: 'composerTextChanged', params: { ...initialIdentity, text: 'late draft' } }));
    await h.settle(); assert.equal(h.state.text, 'second'); assert.equal(h.calls.onText, 0);
});

test('complete config changes including placeholder/send key and external config edits reconcile', async () => {
    const h = harness(); const controller = await h.mount();
    h.state.placeholder = 'new placeholder'; h.state.sendKey = 'primaryEnter'; controller.refresh();
    assert.equal(h.roles.input.placeholder, 'new placeholder'); assert.equal(h.roles.input.enterKeyHint, 'enter');
    let before = h.calls.configure; h.window.tav.chatComposer.config.labels.cancel = 'external'; controller.refresh();
    assert.equal(h.calls.configure, before + 1); assert.equal(h.window.tav.chatComposer.config.labels.cancel, '取消');
    before = h.calls.configure; controller.refresh(); assert.equal(h.calls.configure, before);
});

test('same desired state still repairs actual vendor input, snapshot and chat state drift', async () => {
    const h = harness(); const controller = await h.mount();
    let before = h.calls.snapshot; h.roles.input.value = 'external'; controller.refresh();
    assert.equal(h.calls.snapshot, before + 1); assert.equal(h.roles.input.value, 'draft');
    before = h.calls.snapshot; h.window.tav.chatComposer.snapshot.preparing = true; controller.refresh();
    assert.equal(h.calls.snapshot, before + 1); assert.equal(h.window.tav.chatComposer.snapshot.preparing, false);
    before = h.calls.chat; h.window.tav.chatView.chatState = 'generating'; controller.refresh();
    assert.equal(h.calls.chat, before + 1); assert.equal(h.window.tav.chatView.chatState, 'idle');
    h.roles.input.disabled = true; h.roles.input.readOnly = true; h.roles.input.placeholder = 'external';
    h.roles.trailing.dataset.action = 'stop'; controller.refresh();
    assert.equal(h.roles.input.disabled, false); assert.equal(h.roles.input.readOnly, false);
    assert.equal(h.roles.input.placeholder, '随便聊聊…'); assert.equal(h.roles.trailing.dataset.action, 'send');
    h.roles['trailing-icon'].className = 'external'; h.root.hidden = true;
    h.window.tav.chatComposer.inlineLoading.hidden = false; controller.refresh();
    assert.equal(h.roles['trailing-icon'].className, 'tav-composer-send-icon tavo-composer-send-icon');
    assert.equal(h.root.hidden, false); assert.equal(h.window.tav.chatComposer.inlineLoading.hidden, true);
});

test('real vendor Submit and Stop callbacks settle and reconcile actual controls', async () => {
    const h = harness(); const controller = await h.mount();
    h.window.tav.chatComposer._activateTrailing(); await h.settle();
    assert.equal(h.calls.onSubmit, 1); assert.equal(h.state.generating, true); assert.equal(h.roles.input.value, '');
    assert.equal(h.roles.trailing.dataset.action, 'stop');
    h.window.tav.chatComposer._activateTrailing(); await h.settle();
    assert.equal(h.calls.onStop, 1); assert.equal(h.state.generating, false); assert.equal(h.roles.trailing.dataset.action, 'send');
    const before = { ...h.calls }; controller.refresh(); assert.deepEqual(h.calls, before);
});

test('real text callback and plus action remain usable after external input edits', async () => {
    const h = harness(); await h.mount();
    h.roles.input.value = 'typed locally';
    h.context.dispatchOriginalCall(JSON.stringify({ method: 'composerTextChanged', params: { ...h.window.tav.chatComposer.config, text: h.roles.input.value } }));
    await h.settle(); assert.equal(h.state.text, 'typed locally'); assert.equal(h.roles.input.value, 'typed locally');
    await h.window.tav.chatComposer._openPlus(); await h.settle(); assert.equal(h.calls.onPlus, 1);
});

test('actual resize viewport listener, theme changes and host insets are not suppressed', async () => {
    const h = harness(); const controller = await h.mount();
    const beforeViewport = h.calls.viewport; h.window.visualViewport.height = 600;
    h.window.dispatchEvent({ type: 'resize' }); assert.equal(h.calls.viewport, beforeViewport + 1);
    assert.equal(h.window.tav.chatComposer.bottomOcclusion, 244);
    let before = h.calls.theme; h.colors.set('--chat-bg', '#334455'); controller.refresh();
    assert.equal(h.calls.theme, before + 1); assert.equal(h.window.tav.config.webViewport.backgroundColor, '#334455');
    before = h.calls.theme; h.window.tav.config.chatTheme.consoleStyle.fontSize = 32; controller.refresh();
    assert.equal(h.calls.theme, before + 1); assert.equal(h.window.tav.config.chatTheme.consoleStyle.fontSize, 16);
    h.document.documentElement.classList.add('homer-host-chrome');
    h.context.setTavoHostInsets({ top: 60, bottom: 90 });
    assert.equal(h.document.documentElement.style.getPropertyValue('--homer-host-top'), '60px');
    assert.equal(h.document.documentElement.style.getPropertyValue('--homer-host-bottom'), '90px');
    h.context.setTavoHostInsets({ top: 70, bottom: 100 });
    assert.equal(h.document.documentElement.style.getPropertyValue('--homer-host-top'), '70px');
});

test('dispose and remount keep a fresh vendor instance and old controller inert', async () => {
    const h = harness(); const first = await h.mount(); const previous = h.window.tav.chatComposer;
    const second = await h.mount(); assert.notEqual(h.window.tav.chatComposer, previous); assert.equal(previous.disposed, true);
    const before = { ...h.calls }; first.refresh(); assert.deepEqual(h.calls, before);
    assert.equal(second.disposed, false); assert.equal(h.roles.input.value, 'draft');
});

test('disabled and generating guards still deny programmatic Submit while text remains scoped', async () => {
    const h = harness({ disabled: true }); const controller = await h.mount();
    h.window.tav.chatComposer._submit(); await h.settle(); assert.equal(h.calls.onSubmit, 0);
    h.roles.input.value = 'allowed draft';
    h.context.dispatchOriginalCall(JSON.stringify({ method: 'composerTextChanged', params: { ...controller.identity, text: h.roles.input.value } }));
    await h.settle(); assert.equal(h.state.text, 'allowed draft'); assert.equal(h.roles.input.disabled, true);
    h.state.disabled = false; h.state.generating = true; controller.refresh();
    h.window.tav.chatComposer._submit(); await h.settle(); assert.equal(h.calls.onSubmit, 0);
    assert.equal(h.roles.trailing.dataset.action, 'stop');
});

test('selection mode stays intentional and resize listeners survive identical refreshes', async () => {
    const h = harness(); const controller = await h.mount(); const composer = h.window.tav.chatComposer;
    composer.setSelectionMode(true); controller.refresh(); assert.equal(h.root.hidden, true);
    composer.setSelectionMode(false); controller.refresh(); assert.equal(h.root.hidden, false);
    const before = h.calls.viewport; h.window.visualViewport.height = 700;
    h.window.visualViewport.dispatchEvent({ type: 'resize' }); assert.equal(h.calls.viewport, before + 1);
    assert.equal(composer.bottomOcclusion, 144);
});

test('inputSizing false skips actual proxy geometry while scope, config, snapshot and controls still reconcile', async () => {
    const h = harness({}, { inputSizing: false }); const controller = await h.mount();
    const originalIdentity = { ...controller.identity }, before = { ...h.calls };
    h.state.scope = 'owner:conversation:b'; h.state.text = 'second synthetic draft';
    h.state.placeholder = 'updated placeholder'; h.state.disabled = true; controller.refresh();
    assert.equal(controller.identity.navigationSession, originalIdentity.navigationSession + 1);
    assert.equal(h.calls.configure, before.configure + 1); assert.equal(h.calls.snapshot, before.snapshot + 1);
    assert.equal(h.window.tav.chatComposer.snapshot.navigationSession, controller.identity.navigationSession);
    assert.equal(h.roles.input.value, h.state.text); assert.equal(h.roles.input.placeholder, h.state.placeholder);
    assert.equal(h.roles.input.disabled, true); assert.equal(h.roles.plus.disabled, true); assert.equal(h.roles.trailing.disabled, true);
    h.state.disabled = false; h.state.generating = true; controller.refresh();
    assert.equal(h.roles.input.disabled, false); assert.equal(h.roles.trailing.dataset.action, 'stop');
    assert.equal(h.roles.trailing.getAttribute('aria-label'), '停止生成');
    h.window.tav.chatComposer.setSelectionMode(true); controller.refresh(); assert.equal(h.root.hidden, true);
    h.window.tav.chatComposer.setSelectionMode(false); controller.refresh(); assert.equal(h.root.hidden, false);
    h.colors.set('--chat-bg', '#334455'); controller.refresh();
    assert.equal(h.window.tav.config.webViewport.backgroundColor, '#334455'); assert.ok(h.calls.theme >= 2);
    const viewportBefore = h.calls.viewport;
    h.window.visualViewport.height = 600; h.window.dispatchEvent({ type: 'resize' });
    assert.equal(h.calls.viewport, viewportBefore + 1); assert.equal(h.window.tav.chatComposer.bottomOcclusion, 244);
    assert.deepEqual(h.geometry, { offsetWidth: 0, computedStyle: 0, scrollHeight: 0, heightWrites: 0, overflowWrites: 0 });
});

test('default and explicitly enabled callers retain the original actual vendor sizing entry', async () => {
    for (const inputSizing of [undefined, true, () => true]) {
        const h = harness({}, inputSizing === undefined ? {} : { inputSizing }); const controller = await h.mount();
        assert.ok(h.geometry.offsetWidth > 0); assert.ok(h.geometry.computedStyle > 0);
        assert.ok(h.geometry.scrollHeight > 0); assert.ok(h.geometry.heightWrites > 0); assert.ok(h.geometry.overflowWrites > 0);
        if (inputSizing === undefined) assert.equal(h.window.tav.chatComposer._resizeInput, h.window.tav.ChatComposer.prototype._resizeInput);
        const before = { ...h.geometry }; controller.refresh(); assert.deepEqual(h.geometry, before);
        h.state.text = 'new synthetic default draft'; controller.refresh(); assert.ok(h.geometry.heightWrites > before.heightWrites);
    }
});

test('dynamic inputSizing restores sizing on same-state refresh after leaving the hidden proxy mode', async () => {
    let enabled = false;
    const h = harness({}, { inputSizing: () => enabled }); const controller = await h.mount();
    assert.equal(h.geometry.offsetWidth, 0);
    enabled = true; const beforeCalls = { ...h.calls }; controller.refresh();
    assert.ok(h.geometry.offsetWidth > 0); assert.ok(h.geometry.heightWrites > 0);
    assert.deepEqual(h.calls, beforeCalls, 'mode exit does not reconfigure the conversation');
    const before = { ...h.geometry }; controller.refresh(); assert.deepEqual(h.geometry, before);
    enabled = false; h.state.text = 'still synthetic and hidden'; controller.refresh();
    assert.deepEqual(h.geometry, before);
    enabled = true; h.document.fonts.dispatchEvent({ type: 'loadingdone' });
    assert.ok(h.geometry.heightWrites > before.heightWrites, 'existing vendor event callbacks re-evaluate the gate');
});

test('hidden proxy preserves real callbacks and rejects both old identities and already queued old-scope callbacks', async () => {
    const h = harness({}, { inputSizing: false }); const controller = await h.mount();
    h.context.dispatchOriginalCall(JSON.stringify({ method: 'composerTextChanged', params: { ...controller.identity, text: 'typed synthetic' } }));
    await h.settle(); assert.equal(h.calls.onText, 1); assert.equal(h.state.text, 'typed synthetic');
    h.window.tav.chatComposer._activateTrailing(); await h.settle(); assert.equal(h.calls.onSubmit, 1);
    assert.equal(h.roles.trailing.dataset.action, 'stop');
    h.window.tav.chatComposer._activateTrailing(); await h.settle(); assert.equal(h.calls.onStop, 1);
    assert.equal(h.roles.trailing.dataset.action, 'send');
    await h.window.tav.chatComposer._openPlus(); await h.settle(); assert.equal(h.calls.onPlus, 1);
    const oldIdentity = { ...controller.identity }, before = { ...h.calls };
    h.context.dispatchOriginalCall(JSON.stringify({ method: 'composerTextChanged', params: { ...oldIdentity, text: 'late synthetic' } }));
    h.state.scope = 'owner:conversation:b'; h.state.text = 'next synthetic'; controller.refresh(); await h.settle();
    assert.equal(h.calls.onText, before.onText); assert.equal(h.state.text, 'next synthetic');
    for (const method of ['composerTextChanged', 'composerSubmit', 'composerStop', 'composerOpenPlus']) {
        h.context.dispatchOriginalCall(JSON.stringify({ method, params: { ...oldIdentity, text: 'old synthetic' } }));
    }
    await h.settle();
    for (const method of ['onText', 'onSubmit', 'onStop', 'onPlus']) assert.equal(h.calls[method], before[method]);
    h.state.disabled = true; controller.refresh(); h.window.tav.chatComposer._submit(); await h.settle();
    assert.equal(h.calls.onSubmit, before.onSubmit);
    assert.equal(h.geometry.offsetWidth, 0);
});

test('hidden proxy gate is instance-local and late disposed sizing cannot affect a default remount', async () => {
    const h = harness({}, { inputSizing: false }); const first = await h.mount(); const previous = h.window.tav.chatComposer;
    h.window.dispatchEvent({ type: 'configChanged', detail: { config: { theme: { synthetic: true } } } });
    h.document.fonts.dispatchEvent({ type: 'loadingdone' });
    h.roles.input.dispatchEvent({ type: 'input' });
    assert.equal(h.geometry.offsetWidth, 0);
    delete h.options.inputSizing; const second = await h.mount();
    assert.equal(previous.disposed, true); assert.equal(first.disposed, true); assert.equal(second.disposed, false);
    assert.equal(h.window.tav.chatComposer._resizeInput, h.window.tav.ChatComposer.prototype._resizeInput);
    assert.ok(h.geometry.offsetWidth > 0);
    const before = { ...h.geometry }; previous._resizeInput(); first.refresh(); assert.deepEqual(h.geometry, before);
});

function actualSection(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `actual source boundaries: ${start}`);
    return source.slice(first, last);
}

async function mountActualRuntime({ embedded = true, chrome = true, embed = '1', channel = 'synthetic-host', site = 'https://fixture.invalid' } = {}) {
    const h = harness();
    h.window.location = { origin: 'https://fixture.invalid' }; h.window.parent = embedded ? {} : h.window;
    if (chrome) h.document.documentElement.classList.add('homer-host-chrome');
    const canonical = new h.FixtureElement(), send = { matches: () => false, click: () => h.calls.onSubmit++ };
    canonical.value = 'canonical synthetic draft';
    h.document.querySelector = selector => ({ '#form_sheld': h.container, '#send_textarea': canonical, '#send_but': send }[selector] || null);
    Object.assign(h.context, { requestedEmbed: embed, requestedHostChannel: channel, HOST_CHANNEL: 'synthetic-host', requestedSiteOrigin: site,
        loadingLaunch: false, rollbackBusy: false, conversationRecoveryBlocked: false, generationBusy: false,
        scopeDraftKey: () => h.state.scope, scopeDrafts: new Map(), Event,
        isGenerating: () => h.state.generating, assertCanonicalConversationScope: () => { h.calls.scopeAssert = (h.calls.scopeAssert || 0) + 1; },
        getContext: () => ({ stopGeneration: () => { h.calls.onStop++; h.state.generating = false; } }),
        queueMessageMenuRender: () => {}, scheduleHostStateNotify: () => {},
    });
    vm.runInContext(actualSection(bridge, 'function safeSiteOrigin()', 'function notifyHost('), h.context);
    vm.runInContext(actualSection(bridge, 'let tavoComposer = null;', 'const imageGenerationUi ='), h.context);
    await h.context.installTavoConversationUi();
    return { ...h, canonical, controller: vm.runInContext('tavoComposer', h.context) };
}

test('actual runtime caller suppresses proxy sizing only for the same-origin embedded host-owned chrome', async t => {
    const cases = [
        ['qualified host-owned runtime', {}, true],
        ['standalone caller with chrome class', { embedded: false }, false],
        ['embedded without host chrome', { chrome: false }, false],
        ['embedded without embed opt-in', { embed: '0' }, false],
        ['embedded with wrong channel', { channel: 'other-synthetic-channel' }, false],
        ['embedded with foreign origin', { site: 'https://other-fixture.invalid' }, false],
    ];
    for (const [name, options, suppressed] of cases) await t.test(name, async () => {
        const h = await mountActualRuntime(options);
        assert.equal(h.geometry.offsetWidth === 0, suppressed);
        assert.equal(h.canonical.value, 'canonical synthetic draft'); assert.equal(h.roles.input.value, h.canonical.value);
        assert.equal(h.window.tav.chatComposer.config.actionsEnabled, true);
    });
});

test('actual host-owned runtime retains canonical input/send/stop ABI and restores sizing on chrome exit', async () => {
    const h = await mountActualRuntime(); const canonicalIdentity = h.canonical;
    h.context.dispatchOriginalCall(JSON.stringify({ method: 'composerTextChanged', params: { ...h.controller.identity, text: 'new canonical synthetic' } }));
    await h.settle(); assert.equal(h.canonical, canonicalIdentity); assert.equal(h.canonical.value, 'new canonical synthetic');
    assert.equal(h.roles.input.value, h.canonical.value); assert.equal(h.context.scopeDrafts.get(h.state.scope), h.canonical.value);
    h.window.tav.chatComposer._activateTrailing(); await h.settle(); assert.equal(h.calls.onSubmit, 1); assert.equal(h.calls.scopeAssert, 1);
    h.state.generating = true; h.controller.refresh(); h.window.tav.chatComposer._activateTrailing(); await h.settle();
    assert.equal(h.calls.onStop, 1); assert.equal(h.state.generating, false);
    assert.equal(h.geometry.offsetWidth, 0);
    h.document.documentElement.classList.remove('homer-host-chrome'); h.controller.refresh(); assert.ok(h.geometry.offsetWidth > 0);
    assert.equal(h.canonical, canonicalIdentity); assert.equal(h.canonical.value, 'new canonical synthetic');
});
