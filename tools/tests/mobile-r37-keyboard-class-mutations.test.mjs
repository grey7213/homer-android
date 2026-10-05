import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the entire actual keyboard module, not a duplicated observer.
// DOM fixture records selector traversals separately from focus/scroll effects.
const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/keyboard.js', import.meta.url), 'utf8');
function fixture({ has = true } = {}) {
    const callbacks = [], scans = [], listeners = [];
    const classTokens = text => String(text || '').split(/[\t\n\f\r ]+/).filter(Boolean);
    class Element {
        constructor(classes = '', parent = null, id = '') {
            this.nodeType = 1; this.parentElement = parent; this.children = []; this.id = id;
            this.attrs = new Map([['class', classes]]); this.isConnected = true;
            this.scrollTop = 10; this.scrollLeft = 20; this.clicks = 0;
            if (parent) parent.children.push(this);
            this.classList = {
                contains: name => classTokens(this.attrs.get('class')).includes(name),
                add: name => this.attrs.set('class', [...new Set([...classTokens(this.attrs.get('class')), name])].join(' ')),
            };
        }
        getAttribute(name) { return this.attrs.get(name) ?? null; }
        hasAttribute(name) { return this.attrs.has(name); }
        setAttribute(name, value) { this.attrs.set(name, String(value)); }
        removeAttribute(name) { this.attrs.delete(name); }
        matches(query) {
            return query.split(',').some(selector => {
                const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
                if (selector.includes(':has(')) return this.id === 'extension-child' && classes.every(name => this.children.some(child => child.classList.contains(name)));
                if (selector.includes('#fixture-custom')) return this.id === 'fixture-custom' && classes.every(name => this.classList.contains(name));
                // Other ID/tag selectors are irrelevant to this class fixture;
                // the actual browser regression covers the complete DOM.
                if (selector.includes('#') || selector.includes(' ') || selector.includes('[')) return false;
                return classes.length > 0 && classes.every(name => this.classList.contains(name));
            });
        }
        querySelectorAll(query) {
            scans.push({ element: this, query });
            const all = [];
            const visit = parent => { for (const child of parent.children) { if (child.matches(query)) all.push(child); visit(child); } };
            visit(this); return all;
        }
        addEventListener(name, callback) { listeners.push({ element: this, name, callback }); }
        contains(node) { while (node) { if (node === this) return true; node = node.parentElement; } return false; }
        click() { this.clicks++; }
    }
    const body = new Element('homer-runtime');
    const document = { body, activeElement: null,
        querySelectorAll: query => body.querySelectorAll(query),
        addEventListener: (name, callback) => listeners.push({ element: document, name, callback }),
    };
    const context = vm.createContext({ Element, HTMLElement: Element, Node: { ELEMENT_NODE: 1 }, document,
        CSS: { supports: () => has }, console: { debug() {} },
        MutationObserver: class {
            constructor(callback) { callbacks.push(callback); }
            observe(target, options) { context.observation = { target, options }; }
        }, setTimeout: callback => callback(),
    });
    vm.runInContext(source.replace(/^export /gm, ''), context);
    const deliver = records => callbacks[0](records);
    const mutate = (node, classes, { old = node.getAttribute('class'), missing = false } = {}) => {
        node.setAttribute('class', classes);
        const record = { type: 'attributes', target: node, attributeName: 'class' };
        if (!missing) record.oldValue = old;
        deliver([record]);
    };
    return { context, body, document, Element, scans, listeners, deliver, mutate, reset: () => { scans.length = 0; } };
}

test('pure body launch/theme/switching classes do not rescan descendants', () => {
    const h = fixture(); new h.Element('menu_button', h.body);
    h.context.initKeyboard(); h.reset();
    h.mutate(h.body, 'homer-runtime homer-switching-chat');
    h.mutate(h.body, 'homer-runtime homer-dark is-ready');
    assert.equal(h.scans.length, 0);
    assert.equal(h.context.observation.options.attributeOldValue, true);
});

test('reordering/duplicating unchanged class membership creates no keyboard work', () => {
    const h = fixture(); h.body.setAttribute('class', 'menu_button homer-runtime');
    h.mutate(h.body, 'homer-runtime menu_button menu_button');
    assert.equal(h.scans.length, 0);
    assert.equal(h.body.getAttribute('tabindex'), '0', 'The changed control itself still gets focus repair');
});

test('unrelated control classes repair externally removed tabindex without a descendant scan', () => {
    const h = fixture(), row = new h.Element('menu_button', h.body);
    h.context.initKeyboard(); row.removeAttribute('tabindex'); h.reset();
    h.mutate(row, row.getAttribute('class') + ' is-active');
    assert.equal(row.getAttribute('tabindex'), '0'); assert.equal(h.scans.length, 0);
});

test('ASCII class-token changes are not conflated with NBSP or other Unicode whitespace', () => {
    for (const separator of ['\u00a0', '\u2028', '\u2029', '\u2003']) {
        const h = fixture(), child = new h.Element('menu_button', h.body);
        child.setAttribute('tabindex', '4');
        h.body.setAttribute('class', 'homer-runtime disabled' + separator + 'theme');
        assert.equal(h.body.classList.contains('disabled'), false);
        h.mutate(h.body, 'homer-runtime disabled theme');
        assert.equal(child.hasAttribute('tabindex'), false);
        h.mutate(h.body, 'homer-runtime disabled' + separator + 'theme');
        assert.equal(child.getAttribute('tabindex'), '4');
    }
});

test('related interactable classes still initialize the actual node and descendants', () => {
    const h = fixture(), row = new h.Element('row', h.body), child = new h.Element('menu_button', row);
    h.mutate(row, 'row menu_button');
    assert.equal(row.getAttribute('tabindex'), '0'); assert.equal(child.getAttribute('tabindex'), '0');
    assert.equal(row.classList.contains('interactable'), true); assert.ok(h.scans.length > 0);
});

for (const state of ['disabled', 'not_focusable']) {
    test(`${state} ancestor removes and then restores explicit descendant tabindex`, () => {
        const h = fixture(), child = new h.Element('menu_button', h.body);
        child.setAttribute('tabindex', '4');
        h.mutate(h.body, 'homer-runtime ' + state);
        assert.equal(child.hasAttribute('tabindex'), false);
        assert.equal(child.getAttribute('data-original-tabindex'), '4');
        h.mutate(h.body, 'homer-runtime');
        assert.equal(child.getAttribute('tabindex'), '4');
    });
}

test('new scroll-reset class binds once and unrelated later state does not duplicate listener', () => {
    const h = fixture(), region = new h.Element('region', h.body);
    h.mutate(region, 'region scroll-reset-container');
    h.mutate(region, 'region scroll-reset-container is-active');
    const bound = h.listeners.filter(row => row.element === region && row.name === 'focusout');
    assert.equal(bound.length, 1); bound[0].callback({});
    assert.equal(region.scrollTop, 0); assert.equal(region.scrollLeft, 0);
});

test('added fragment/subtree remains initialized synchronously and ancestor-deduplicated', () => {
    const h = fixture(), row = new h.Element('', h.body), child = new h.Element('menu_button scroll-reset-container', row);
    h.deliver([{ type: 'childList', addedNodes: [row] }, { type: 'childList', addedNodes: [child] }]);
    assert.equal(child.getAttribute('tabindex'), '0');
    assert.equal(h.scans.filter(scan => scan.element === row).length, 2);
    assert.equal(h.scans.filter(scan => scan.element === child).length, 0);
});

test('removed/detached nodes remain ignored', () => {
    const h = fixture(), row = new h.Element('menu_button', h.body); row.isConnected = false;
    h.deliver([{ type: 'childList', addedNodes: [row] }]);
    assert.equal(h.scans.length, 0); assert.equal(row.hasAttribute('tabindex'), false);
});

test('missing oldValue stays conservative, null old class is a valid initial value', () => {
    const h = fixture(), child = new h.Element('menu_button', h.body);
    h.mutate(h.body, 'homer-runtime is-ready', { missing: true });
    assert.equal(child.getAttribute('tabindex'), '0'); assert.ok(h.scans.length > 0);
    h.reset(); h.mutate(h.body, 'homer-runtime', { old: null });
    assert.equal(h.scans.length, 0);
});

test('custom selector registration always preserves conservative class subtree handling', () => {
    const h = fixture(), child = new h.Element('', h.body, 'fixture-custom');
    h.context.registerInteractableType('#fixture-custom.homer-ready');
    h.reset(); h.mutate(child, 'homer-ready');
    assert.equal(child.getAttribute('tabindex'), '0'); assert.ok(h.scans.length > 0);
    h.reset(); h.mutate(h.body, 'homer-runtime theme-unrelated');
    assert.ok(h.scans.length > 0, 'Unknown custom selector dependencies are never guessed');
});

test('default has-selector descendant class remains relevant when supported', () => {
    const h = fixture(), region = new h.Element('', h.body, 'extension-child'), button = new h.Element('', region);
    h.mutate(button, 'extensionsMenuExtensionButton');
    assert.ok(h.scans.length > 0);
});

test('keyboard Enter and modifier/disabled guards remain the actual original logic', () => {
    const h = fixture(), row = new h.Element('menu_button', h.body), child = new h.Element('', row);
    h.context.initKeyboard();
    const key = h.listeners.find(row => row.name === 'keydown').callback;
    key({ key: 'Enter', target: child }); assert.equal(row.clicks, 1);
    key({ key: 'Enter', target: child, shiftKey: true }); assert.equal(row.clicks, 1);
    row.classList.add('disabled'); key({ key: 'Enter', target: child }); assert.equal(row.clicks, 1);
});
