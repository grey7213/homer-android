import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDeferredListCovers } from '../../.web-cache/tree/frontend/assets/js/deferred-list-covers.mjs';

const host = readFileSync(new URL('../../.web-cache/tree/frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
const renderBegin = host.indexOf('function renderHistory(');
const render = host.slice(renderBegin, host.indexOf('\nfunction renderCachedConversation(', renderBegin));
const helperBegin = host.indexOf('function historyDisplayRows(');
const helper = helperBegin < 0 ? '' : host.slice(helperBegin, renderBegin);
const safeBegin = host.indexOf('function safePreviewImage(');
const safeImage = host.slice(safeBegin, host.indexOf('\nfunction normalizeMessage(', safeBegin));
const coverBegin = host.indexOf('const historyCovers = createDeferredListCovers(');
const coverSetup = host.slice(coverBegin, host.indexOf('\nconst historyCount =', coverBegin));
const drawersBegin = host.indexOf('function closeDrawers(');
const drawers = host.slice(drawersBegin, host.indexOf('\n// Native navigation retains', drawersBegin));

class NodeFixture {
    constructor(tag) {
        this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = ''; this.parent = null;
        this.moves = 0; this.coverWrites = 0; this.classWrites = 0; this.classValue = '';
        this.listeners = new Map(); this.attributes = new Map(); this.connectedRoot = false;
        this.style = new Proxy({}, { set: (target, key, value) => {
            if (key === 'backgroundImage') this.coverWrites++;
            target[key] = value; return true;
        } });
    }
    get className() { return this.classValue; }
    set className(value) { this.classValue = value; this.classWrites++; }
    get isConnected() { return this.connectedRoot || !!this.parent?.isConnected; }
    closest(selector) { return selector === '.preview-history' ? this.scrollRoot : null; }
    contains(node) { for (let current = node; current; current = current.parent) if (current === this) return true; return false; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    getBoundingClientRect() {
        if (this.tagName === 'div') return { left: 0, top: 0, right: 320, bottom: 500, width: 320, height: 500 };
        const button = this.tagName === 'button' ? this : this.parent;
        const index = button?.parent?.children.indexOf(button) ?? 0;
        const top = index * 60;
        return { left: 10, top, right: 50, bottom: top + 40, width: 40, height: 40 };
    }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    insertBefore(child, anchor) {
        if (child === anchor) return;
        child.remove();
        const index = anchor === null ? this.children.length : this.children.indexOf(anchor);
        assert.ok(index >= 0, 'DOM anchor must belong to the selected parent');
        this.children.splice(index, 0, child); child.parent = this; this.moves++;
    }
    remove() {
        if (this.parent) {
            this.parent.children.splice(this.parent.children.indexOf(this), 1);
            this.parent = null;
        }
    }
}

const row = (id = 'fixture-a', extra = {}) => ({
    id, app_id: `${id}-card`, app_name: `Name ${id}`, app_icon: `/media-cache/cover/${id}.png`,
    last_message: `Latest ${id}`, updated_at: 1, ...extra,
});

function harness(rows = [row()]) {
    const list = new NodeFixture('div');
    list.connectedRoot = true;
    const scrollRoot = new NodeFixture('section'); scrollRoot.connectedRoot = true;
    scrollRoot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, bottom: 500, width: 320, height: 500 });
    list.scrollRoot = scrollRoot;
    list.replacements = 0;
    list.replaceChildren = function () { this.children = []; this.replacements++; };
    const observers = [], viewListeners = new Map(), timers = new Map();
    let nextTimer = 0;
    const view = {
        innerWidth: 390, innerHeight: 844,
        IntersectionObserver: class {
            constructor(callback, options) { this.callback = callback; this.options = options; this.nodes = new Set(); observers.push(this); }
            observe(node) { this.nodes.add(node); }
            unobserve(node) { this.nodes.delete(node); }
            disconnect() { this.nodes.clear(); }
        },
        addEventListener(name, callback) { if (!viewListeners.has(name)) viewListeners.set(name, new Set()); viewListeners.get(name).add(callback); },
        removeEventListener(name, callback) { viewListeners.get(name)?.delete(callback); },
        setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
    };
    const bodyClasses = new Set(), body = { classList: {
        contains: value => bodyClasses.has(value),
        add: (...values) => values.forEach(value => bodyClasses.add(value)),
        remove: (...values) => values.forEach(value => bodyClasses.delete(value)),
    } };
    const leftDrawer = new NodeFixture('aside'), rightDrawer = new NodeFixture('aside');
    leftDrawer.setAttribute('aria-hidden', 'true'); rightDrawer.setAttribute('aria-hidden', 'true');
    const document = { body, defaultView: view, createElement(tag) { const node = new NodeFixture(tag); node.ownerDocument = document; return node; } };
    list.ownerDocument = document;
    scrollRoot.ownerDocument = document;
    const scope = {
        URL, location: { href: 'https://fixture.invalid/app/chat.html' }, history: rows,
        historySignature: '', activeConversationId: 'fixture-a', historyList: list, historyCount: { textContent: '' },
        document, window: view, leftDrawer, rightDrawer, scrim: { hidden: true }, createDeferredListCovers,
    };
    vm.createContext(scope);
    vm.runInContext(coverSetup + '\n' + safeImage + '\n' + helper + '\n' + render + '\n' + drawers + '\nglobalThis.historyCovers=historyCovers;', scope);
    function flush() {
        for (const observer of observers) observer.callback([...observer.nodes].map(target => ({
            target, isIntersecting: target.getBoundingClientRect().top < 600 && target.getBoundingClientRect().bottom > -100,
        })));
    }
    return { scope, list, observers, viewListeners, render() { scope.renderHistory(); flush(); },
        open() { scope.openDrawer('left'); flush(); }, close() { scope.closeDrawers(); }, flush };
}

test('actual history renderer ignores unused metadata and updated_at without changing history data', () => {
    const h = harness(); h.render(); const before = h.list.children[0];
    h.scope.history[0].updated_at = 100;
    h.scope.history[0].server_metadata = { unseen_revision: 2 };
    h.render();
    assert.equal(h.list.replacements, 0);
    assert.equal(h.list.children[0], before);
    assert.equal(h.scope.history[0].updated_at, 100);
});

test('only the displayed first 50 description characters determine row changes', () => {
    const h = harness([row('fixture-a', { last_message: 'A'.repeat(50) + 'old tail' })]);
    h.render(); h.scope.history[0].last_message = 'A'.repeat(50) + 'new tail'; h.render();
    assert.equal(h.list.replacements, 0);
    assert.equal(h.list.moves, 1);
    assert.equal(h.list.children[0].children[2].textContent, 'A'.repeat(50));
});

test('cover URL normalization retains a row for equivalent absolute or relative URLs', () => {
    const h = harness(); h.render();
    h.scope.history[0].app_icon = 'https://fixture.invalid/media-cache/cover/fixture-a.png'; h.render();
    assert.equal(h.list.replacements, 0);
    assert.equal(h.list.moves, 1);
});

test('invalid rows do not affect ordered row projection while the original count semantics remain current', () => {
    const h = harness([row(), { id: 'invalid-missing-card', app_name: 'Invalid' }]);
    h.render(); assert.equal(h.list.children.length, 1);
    h.scope.history[1].app_name = 'Different invalid name'; h.render();
    h.scope.history.push({ app_id: 'invalid-missing-id' }); h.render();
    assert.equal(h.list.replacements, 0);
    assert.equal(h.scope.historyCount.textContent, '3');
    h.scope.history[1].app_id = 'valid-card-now'; h.render();
    assert.equal(h.list.replacements, 0);
    assert.equal(h.list.children.length, 2);
});

test('different missing or rejected cover inputs share the actual default avatar', () => {
    const h = harness([row('fixture-a', { app_icon: '' })]); h.open(); h.render();
    const before = h.list.children[0].children[0].style.backgroundImage;
    h.scope.history[0].app_icon = 'javascript:untrusted()'; h.render();
    h.scope.history[0].app_icon = ' '; h.render();
    assert.equal(h.list.replacements, 0);
    assert.match(before, /\/assets\/img\/apk\/avatar\.webp/);
});

for (const field of ['id', 'app_id', 'app_name', 'app_icon', 'last_message']) {
    test(`actual displayed/behavior field ${field} change redraws its row`, () => {
        const h = harness(); h.open(); h.render(); const before = h.list.children[0];
        const cover = before.children[0];
        h.scope.history[0][field] = field === 'app_icon' ? '/media-cache/cover/revised.png' : 'Different'; h.render();
        assert.equal(h.list.replacements, 0);
        assert.equal(h.list.children.length, 1);
        assert.equal(h.list.children[0] === before, field !== 'id');
        if (field !== 'id') {
            assert.equal(h.list.children[0].children[0], cover);
            assert.equal(cover.coverWrites, field === 'app_icon' ? 3 : 1);
            assert.equal(h.list.moves, 1);
        }
        if (field === 'id') assert.equal(h.list.children[0].dataset.conversationId, 'Different');
        if (field === 'app_id') assert.equal(h.list.children[0].dataset.appId, 'Different');
        if (field === 'app_name') assert.equal(h.list.children[0].children[1].textContent, 'Different');
        if (field === 'last_message') assert.equal(h.list.children[0].children[2].textContent, 'Different');
    });
}

test('active selection changes classes without recreating or moving any rows or covers', () => {
    const h = harness([row(), row('fixture-b')]); h.render();
    const before = [...h.list.children];
    h.scope.activeConversationId = 'fixture-b'; h.render();
    assert.equal(h.list.replacements, 0);
    assert.deepEqual(h.list.children, before);
    assert.match(h.list.children[1].className, /is-active/);
    h.scope.activeConversationId = 'absent-a'; h.render();
    h.scope.activeConversationId = 'absent-b'; h.render();
    assert.equal(h.list.moves, 2);
    for (const button of before) assert.equal(button.children[0].coverWrites, 0);
    assert.deepEqual(before.map(button => button.classWrites), [2, 3]);
});

test('real ordering, addition and removal redraw and preserve input order without sorting', () => {
    const h = harness([row(), row('fixture-b')]); h.render();
    h.scope.history.reverse(); h.render();
    assert.equal(h.list.children[0].dataset.conversationId, 'fixture-b');
    h.scope.history.push(row('fixture-c')); h.render();
    assert.equal(h.list.children[2].dataset.conversationId, 'fixture-c');
    h.scope.history.splice(1, 1); h.render();
    assert.equal(h.list.replacements, 0);
    assert.deepEqual(h.list.children.map(node => node.dataset.conversationId), ['fixture-b', 'fixture-c']);
});

test('large history changes selection without any cover writes, row moves or detached focused row', () => {
    const h = harness(Array.from({ length: 600 }, (_, index) => row(`fixture-${index}`)));
    h.scope.activeConversationId = 'fixture-0'; h.render();
    const before = [...h.list.children];
    const focused = before[9];
    const classWrites = before.reduce((count, node) => count + node.classWrites, 0);
    h.scope.activeConversationId = 'fixture-599'; h.render();
    assert.deepEqual(h.list.children, before);
    assert.equal(focused.parent, h.list);
    assert.equal(h.list.moves, 600);
    assert.equal(before.reduce((count, node) => count + node.classWrites, 0), classWrites + 2);
    assert.equal(before.reduce((count, node) => count + node.children[0].coverWrites, 0), 0);
});

test('reordering and inserting retain unrelated button, cover and text identities', () => {
    const h = harness([row(), row('fixture-b')]); h.render();
    const [a, b] = h.list.children;
    const avatar = b.children[0], text = b.children[1];
    h.scope.history = [row('fixture-c'), h.scope.history[1], h.scope.history[0]]; h.render();
    assert.equal(h.list.children[1], b); assert.equal(h.list.children[2], a);
    assert.equal(b.children[0], avatar); assert.equal(b.children[1], text);
    h.scope.history = [h.scope.history[1]]; h.render();
    assert.equal(h.list.children[0], b); assert.equal(a.parent, null);
    assert.equal(avatar.coverWrites, 0);
});

test('duplicate server IDs preserve ordered row multiplicity without conflating node identities', () => {
    const h = harness([row('fixture-a'), row('fixture-a', { app_name: 'Other name' })]); h.render();
    const [a, b] = h.list.children;
    assert.notEqual(a, b);
    h.scope.activeConversationId = 'absent'; h.render();
    assert.equal(h.list.children[0], a); assert.equal(h.list.children[1], b);
    assert.equal(b.children[1].textContent, 'Other name');
    assert.equal(a.children[0].coverWrites, 0); assert.equal(b.children[0].coverWrites, 0);
});

test('empty list actually removes obsolete nodes and retains original count behavior', () => {
    const h = harness(); h.render(); const before = h.list.children[0];
    h.scope.history = []; h.render();
    assert.equal(h.list.children.length, 0); assert.equal(before.parent, null);
    assert.equal(h.scope.historyCount.textContent, '0');
});

test('actual left open schedules only nearby covers and close/reopen retains loaded same URLs', () => {
    const h = harness(Array.from({ length: 600 }, (_, index) => row(`fixture-${index}`))); h.render();
    const before = [...h.list.children];
    assert.equal(before.reduce((sum, button) => sum + button.children[0].coverWrites, 0), 0);
    h.open();
    assert.equal(before.reduce((sum, button) => sum + button.children[0].coverWrites, 0), 10);
    assert.equal(h.observers[0].options.root, h.list.scrollRoot);
    h.close(); h.open(); h.render();
    assert.deepEqual(h.list.children, before);
    assert.equal(before.reduce((sum, button) => sum + button.children[0].coverWrites, 0), 10);
});

test('actual drawer predicate requires left class and aria state, rejects late callbacks after close/right open', () => {
    const h = harness(); h.render(); const cover = h.list.children[0].children[0];
    h.scope.document.body.classList.add('shell-left-open'); h.scope.historyCovers.open(); h.flush();
    assert.equal(cover.coverWrites, 0);
    h.open(); const old = h.observers.at(-1); h.close();
    old.callback([{ target: cover, isIntersecting: true }]); assert.equal(cover.coverWrites, 1);
    h.scope.history[0].app_icon = '/media-cache/cover/revised.png'; h.render();
    assert.equal(cover.coverWrites, 2); // Clear old assigned URL; do not fetch new while closed.
    h.scope.openDrawer('right'); old.callback([{ target: cover, isIntersecting: true }]);
    assert.equal(cover.coverWrites, 2);
    h.open(); assert.equal(cover.coverWrites, 3);
});

test('an offscreen cover loads on actual observer intersection, but a queued closed-drawer entry cannot load it', () => {
    const h = harness(Array.from({ length: 20 }, (_, index) => row(`fixture-${index}`))); h.render(); h.open();
    const far = h.list.children[19].children[0], previous = h.observers.at(-1);
    assert.equal(far.coverWrites, 0);
    h.close(); previous.callback([{ target: far, isIntersecting: true }]);
    assert.equal(far.coverWrites, 0);
    h.open(); h.observers.at(-1).callback([{ target: far, isIntersecting: true }]);
    assert.equal(far.coverWrites, 1);
    h.close(); h.open(); assert.equal(far.coverWrites, 1);
});

test('host pagehide disposal preserves bfcache and releases listeners only for real document destruction', () => {
    const h = harness(); h.render();
    const leave = [...h.viewListeners.get('pagehide')][0];
    leave({ persisted: true }); h.open(); assert.equal(h.list.children[0].children[0].coverWrites, 1);
    leave({ persisted: false });
    assert.equal(h.list.scrollRoot.listeners.get('scroll').size, 0);
    assert.equal(h.viewListeners.get('resize').size, 0);
    h.scope.history[0].app_icon = '/media-cache/cover/new.png'; h.render(); h.open();
    assert.equal(h.list.children[0].children[0].coverWrites, 1);
});

test('bfcache pagehide cancels delayed cover callbacks and pageshow can resume the same registered rows', () => {
    const h = harness(Array.from({ length: 20 }, (_, index) => row(`fixture-${index}`)));
    h.render(); h.open(); const old = h.observers.at(-1), far = h.list.children[19].children[0];
    [...h.viewListeners.get('pagehide')][0]({ persisted: true });
    old.callback([{ target: far, isIntersecting: true }]); assert.equal(far.coverWrites, 0);
    [...h.viewListeners.get('pageshow')][0]({ persisted: true });
    h.observers.at(-1).callback([{ target: far, isIntersecting: true }]); assert.equal(far.coverWrites, 1);
});

test('real ordered projection contains only the displayed behavior fields and filters invalid entries', () => {
    const h = harness();
    assert.equal(typeof h.scope.historyDisplayRows, 'function');
    const rows = h.scope.historyDisplayRows([row('fixture-a', { last_message: 'X'.repeat(60) }), { id: 'invalid' }], 'fixture-a');
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{
        id: 'fixture-a', appId: 'fixture-a-card', roleName: 'Name fixture-a',
        image: 'https://fixture.invalid/media-cache/cover/fixture-a.png',
        description: 'X'.repeat(50), active: true,
    }]);
});
