import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { createDeferredListCovers as actualDeferredListCovers } from '../../.web-cache/tree/frontend/assets/js/deferred-list-covers.mjs';

const bridgePath = new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url);
const bridge = readFileSync(bridgePath, 'utf8');
const populateStart = bridge.indexOf('function populateHistoryList(');
const coverStart = bridge.indexOf('let historyCoverLoader = ');
const historySource = bridge.slice(coverStart >= 0 ? coverStart : populateStart, bridge.indexOf('\nlet runtimeBackHandler', populateStart));
const drawerStart = bridge.indexOf('function setDrawerOpen(');
const drawerSource = bridge.slice(drawerStart, bridge.indexOf('\nfunction returnToDesktopNavigation(', drawerStart));

class NodeFixture {
    constructor(tag, document, text = '') {
        this.tagName = tag; this.ownerDocument = document; this.textContent = text;
        this.children = []; this.parent = null; this.dataset = {}; this.attributes = new Map();
        this.style = {}; this.listeners = new Map(); this.id = ''; this.className = '';
        const classes = new Set();
        this.classList = {
            add: (...values) => values.forEach(value => classes.add(value)),
            contains: value => classes.has(value),
            toggle: (value, force) => {
                const include = force === undefined ? !classes.has(value) : Boolean(force);
                if (include) classes.add(value); else classes.delete(value);
                return include;
            },
        };
    }
    get isConnected() { return this.parent ? this.parent.isConnected : this === this.ownerDocument.body; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() {
        if (!this.parent) return;
        this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null;
    }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    toggleAttribute(key, force) { if (force) this.attributes.set(key, ''); else this.attributes.delete(key); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
    contains(node) { for (let current = node; current; current = current.parent) if (current === this) return true; return false; }
    closest(selector) {
        for (let node = this; node; node = node.parent) if (node.matches(selector)) return node;
        return null;
    }
    matches(selector) {
        const [id, className] = selector.startsWith('#') ? selector.slice(1).split('.') : ['', selector.slice(1)];
        return (!id || this.id === id) && (!className || this.classList.contains(className));
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (child.matches(selector)) return child;
            const found = child.querySelector(selector); if (found) return found;
        }
        return null;
    }
}

const row = (id = 'history-a', extra = {}) => ({
    id, app_id: `${id}-card`, app_name: `Name ${id}`, title: `Title ${id}`,
    app_icon: `/media-cache/cover/${id}.png`, last_message: `Message ${id}`, ...extra,
});

function harness(rows = [row(), row('history-b')]) {
    const loaders = [], calls = [], backgrounds = [];
    const document = { querySelector: selector => document.body.querySelector(selector) || document.head.querySelector(selector) };
    document.body = new NodeFixture('body', document);
    document.head = new NodeFixture('head', document);
    document.documentElement = new NodeFixture('html', document);
    const create = (tag, classes = '', text = '') => {
        const node = new NodeFixture(tag, document, text); node.className = classes;
        node.classList.add(...classes.split(' ').filter(Boolean)); return node;
    };
    document.createElement = tag => create(tag);
    const root = create('div'); root.id = 'homer-runtime-root'; root.dataset.appId = 'card-a';
    const left = create('aside'); left.id = 'homer-left-drawer'; left.setAttribute('aria-hidden', 'true');
    const right = create('aside'); right.id = 'homer-right-drawer'; right.setAttribute('aria-hidden', 'true');
    const backdrop = create('button'); backdrop.id = 'homer-drawer-backdrop';
    const list = create('div'); list.id = 'homer-history-list';
    const count = create('span'); count.id = 'homer-history-count';
    left.append(count, list); root.append(left, right, backdrop); document.body.append(root);
    const observers = [];
    const view = {
        addEventListener() {}, removeEventListener() {},
        IntersectionObserver: class {
            constructor(callback, options) { this.callback = callback; this.options = options; this.nodes = new Set(); observers.push(this); }
            observe(node) { this.nodes.add(node); }
            unobserve(node) { this.nodes.delete(node); }
            disconnect() { this.nodes.clear(); }
        },
    };
    document.defaultView = view;
    // The real shared module and extracted bridge execute together. Only native
    // DOM/IntersectionObserver delivery is controlled by this contract fixture.
    const createDeferredListCovers = options => {
        const tracked = new Map();
        const actual = actualDeferredListCovers({ ...options, setCover(node, url) {
            options.setCover(node, url); backgrounds.push([node, url]);
        } });
        const loader = {
            options, tracked, disposed: false,
            set(node, url) { tracked.set(node, url); actual.set(node, url); calls.push(['set', node, url]); },
            retain(nodes) {
                const keep = new Set(nodes); for (const node of tracked.keys()) if (!keep.has(node)) tracked.delete(node);
                actual.retain(nodes);
                calls.push(['retain', [...keep]]);
            },
            open() { actual.open(); calls.push(['open']); },
            close() { actual.close(); calls.push(['close']); },
            dispose() { actual.dispose(); this.disposed = true; tracked.clear(); calls.push(['dispose']); },
            visible(node) {
                const before = backgrounds.length;
                for (const observer of observers) observer.callback([{ target: node, isIntersecting: true }]);
                return backgrounds.length > before;
            },
        };
        loaders.push(loader); return loader;
    };
    const scope = {
        HTMLElement: NodeFixture, document, createElement: create, createDeferredListCovers,
        storageOwner: 'account-a', storageAccountEpoch: 5,
        session: { user: { id: 'account-a' } }, launch: { app_id: 'card-a', conversation_id: 'conversation-a' },
        runtimeUiData: { conversations: rows },
        siteAssetUrl: value => value && !String(value).startsWith('javascript:') ? new URL(value, 'https://fixture.invalid/').href : '',
        siteUrl: value => new URL(value, 'https://fixture.invalid/').href,
        formatConversationTime: () => 'Recent', messagePreview: value => String(value || ''),
        switchConversation: value => calls.push(['switch', value]), openConversationManager: value => calls.push(['manage', value]),
        window: { matchMedia: () => ({ matches: false }), setTimeout: () => {} },
        localStorage: { getItem: () => 'light' }, installHostOverlayTracking: () => {},
        prepareTavoConversationUi: () => Promise.resolve(), installMemoryUi: () => {},
    };
    vm.createContext(scope); vm.runInContext(historySource + '\n' + drawerSource, scope);
    return {
        scope, document, root, left, right, list, count, calls, loaders, backgrounds,
        render: () => scope.populateHistoryList(count, list),
        drawer: side => scope.setDrawerOpen(side),
        avatar: index => list.children[index].children[0].children[0],
        owner: value => { scope.storageOwner = value; },
    };
}

test('runtime registers every history cover without fetching a closed drawer image', () => {
    const h = harness(Array.from({ length: 126 }, (_, index) => row(`history-${index}`)));
    h.render(); assert.equal(h.count.textContent, '126'); assert.equal(h.list.children.length, 126);
    assert.equal(h.loaders.length, 1); assert.equal(h.loaders[0].tracked.size, 126);
    for (let index = 0; index < 126; index++) {
        assert.equal(h.avatar(index).style.backgroundImage, undefined);
        assert.equal(h.loaders[0].visible(h.avatar(index)), false);
    }
    assert.equal(h.backgrounds.length, 0);
});

test('actual drawer toggles enable only current visible covers and closing leaves loaded artwork intact', () => {
    const h = harness(); h.render(); const loader = h.loaders[0], first = h.avatar(0), far = h.avatar(1);
    h.drawer('left'); assert.equal(loader.options.isOpen(), true); assert.equal(loader.visible(first), true);
    assert.equal(first.style.backgroundImage, 'url("https://fixture.invalid/media-cache/cover/history-a.png")');
    assert.equal(far.style.backgroundImage, undefined);
    h.drawer(); assert.equal(loader.options.isOpen(), false); assert.equal(loader.visible(far), false);
    assert.equal(first.style.backgroundImage, 'url("https://fixture.invalid/media-cache/cover/history-a.png")');
    assert.ok(h.calls.some(call => call[0] === 'open')); assert.ok(h.calls.some(call => call[0] === 'close'));
    h.drawer('right'); assert.equal(loader.options.isOpen(), false); assert.equal(h.right.getAttribute('aria-hidden'), 'false');
});

test('new runtime list can register while its root is detached and load only after attachment and explicit opening', () => {
    const h = harness(); h.root.remove(); h.render(); const avatar = h.avatar(0), loader = h.loaders[0];
    assert.equal(loader.tracked.size, 2); assert.equal(loader.visible(avatar), false);
    h.document.body.append(h.root); assert.equal(loader.visible(avatar), false);
    h.drawer('left'); assert.equal(loader.visible(avatar), true);
});

test('runtime eligibility rejects delayed callbacks after account, same-owner login epoch, or chat changes', () => {
    for (const mutate of [h => h.owner('account-b'), h => h.scope.storageAccountEpoch++,
        h => { h.scope.session.user.id = 'account-b'; }, h => { h.scope.launch.app_id = 'card-b'; },
        h => { h.scope.launch.conversation_id = 'conversation-b'; }]) {
        const h = harness(); h.render(); h.drawer('left'); const loader = h.loaders[0]; mutate(h);
        assert.equal(loader.options.isOpen(), false); assert.equal(loader.visible(h.avatar(0)), false);
        assert.equal(h.backgrounds.length, 0);
    }
});

test('runtime eligibility requires the connected current root and both drawer visibility contracts', () => {
    for (const mutate of [h => h.left.setAttribute('aria-hidden', 'true'),
        h => h.left.classList.toggle('is-open', false), h => h.list.remove(), h => h.root.remove()]) {
        const h = harness(); h.render(); h.drawer('left'); const avatar = h.avatar(0); mutate(h);
        assert.equal(h.loaders[0].options.isOpen(), false); assert.equal(h.loaders[0].visible(avatar), false);
    }
});

test('repopulating runtime history retains only newly rendered covers and preserves row actions', () => {
    const h = harness(); h.render(); h.drawer('left'); const old = h.avatar(0);
    const current = row('history-c'); h.scope.runtimeUiData.conversations = [current]; h.render();
    assert.equal(h.loaders.length, 1); assert.equal(h.loaders[0].tracked.size, 1);
    assert.equal(h.loaders[0].tracked.has(old), false); assert.equal(h.loaders[0].visible(old), false);
    const item = h.list.children[0]; item.children[0].listeners.get('click')();
    let stopped = false; item.children[1].listeners.get('click')({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true); assert.equal(h.calls.find(call => call[0] === 'switch')[1], current);
    assert.equal(h.calls.find(call => call[0] === 'manage')[1], current);
});

test('empty runtime history removes registered covers and keeps its existing empty-state copy', () => {
    const h = harness(); h.render(); h.scope.runtimeUiData.conversations = []; h.render();
    assert.equal(h.loaders[0].tracked.size, 0); assert.equal(h.count.textContent, '0');
    assert.equal(h.list.children[0].textContent, '还没有历史会话');
});

test('missing or unsafe image still registers the existing bundled fallback', () => {
    const h = harness([row('history-a', { app_icon: 'javascript:untrusted()' })]); h.render();
    const avatar = h.avatar(0); h.drawer('left'); h.loaders[0].visible(avatar);
    assert.match(avatar.style.backgroundImage, /\/assets\/img\/apk\/avatar\.webp/);
});

test('setCover retains quotation escaping and its empty-url clearing contract', () => {
    const h = harness(); h.render(); const avatar = h.avatar(0), set = h.loaders[0].options.setCover;
    set(avatar, 'https://fixture.invalid/cover"quoted.png');
    assert.equal(avatar.style.backgroundImage, 'url("https://fixture.invalid/cover%22quoted.png")');
    set(avatar, ''); assert.equal(avatar.style.backgroundImage, '');
});

test('explicit runtime teardown disposes callbacks and clears references before removing old root', () => {
    const h = harness(); h.render(); const loader = h.loaders[0];
    assert.equal(typeof h.scope.disposeHistoryCoverLoader, 'function'); h.scope.disposeHistoryCoverLoader();
    assert.equal(loader.disposed, true); h.drawer('left'); assert.equal(loader.visible(h.avatar(0)), false);
    h.render(); assert.equal(h.loaders.length, 2);
    const begin = bridge.indexOf('function buildRuntimeUi('), end = bridge.indexOf("const root = createElement('div', 'homer-runtime-root');", begin);
    const setup = bridge.slice(begin, end);
    assert.ok(setup.indexOf('disposeHistoryCoverLoader();') >= 0);
    assert.ok(setup.indexOf('disposeHistoryCoverLoader();') < setup.indexOf('previousRoot?.remove();'));
    const current = h.loaders[1];
    const originalRemove = h.root.remove.bind(h.root);
    h.root.remove = () => { assert.equal(current.disposed, true, 'The actual setup must dispose before detaching the root'); originalRemove(); };
    vm.runInContext(`function actualRootTeardown() {${setup.slice(setup.indexOf('{') + 1)}}`, h.scope);
    h.scope.actualRootTeardown(); assert.equal(current.disposed, true); assert.equal(h.root.isConnected, false);
});

test('pagehide cancels delayed covers without disposing registered images needed by a restored document', () => {
    const h = harness(); h.render(); h.drawer('left'); const loader = h.loaders[0], avatar = h.avatar(0);
    const begin = bridge.indexOf("window.addEventListener('pagehide', () => {");
    const end = bridge.indexOf('window.clearTimeout(sessionPrefetchTimer);', begin);
    const closeSource = bridge.slice(begin + "window.addEventListener('pagehide', () => {".length, end);
    vm.runInContext(closeSource, h.scope);
    assert.equal(loader.disposed, false); assert.equal(loader.visible(avatar), false);
    h.drawer('left'); assert.equal(loader.visible(avatar), true);
});

test('runtime shared resource uses the same-origin APK/frontend asset route', () => {
    assert.equal(/import\s*\{\s*createDeferredListCovers\s*\}\s*from '\/assets\/js\/deferred-list-covers\.mjs'/.test(bridge), true);
    assert.equal(existsSync(new URL('../../.web-cache/tree/frontend/assets/js/deferred-list-covers.mjs', import.meta.url)), true);
    const routes = readFileSync(new URL('../../android-app/app/src/main/java/org/nebula/horizon/composeai/ctf/ClientAssetRoutes.java', import.meta.url), 'utf8');
    assert.match(routes, /path\.startsWith\("\/assets\/"\)/);
});
