import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../frontend/assets/js/chat-control-center.js', import.meta.url), 'utf8');
assert.match(source, /export function controlKey\(/);
assert.match(source, /export function controlCenter\(/);

// A small structural DOM fixture for the actual presentation adapter. Native
// browser viewport, SVG rendering and offline checks run separately.
class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.attributes = new Map(); this.dataset = {}; this.listeners = []; this.disabled = false;
        this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); } };
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get textContent() { return this.text ?? this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this.text = String(value); }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    before(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.text = undefined; this.append(...nodes); }
    matches(selector) {
        return selector.split(',').some(part => {
            const term = part.trim(), attr = /^\[([^=]+)="([^"]+)"\]$/.exec(term);
            if (attr) return this.getAttribute(attr[1]) === attr[2];
            if (term.startsWith('.')) return this.className.split(/\s+/).includes(term.slice(1));
            return term === '*' || this.tagName.toLowerCase() === term;
        });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener) { this.listeners.push({ type, listener }); }
    click() { if (!this.disabled) for (const { type, listener } of this.listeners) if (type === 'click') listener(); }
}

function harness() {
    const document = { createElement: tag => new Element(tag), createElementNS: (namespace, tag) => {
        const element = new Element(tag); element.namespaceURI = namespace; return element;
    } };
    const context = vm.createContext({ document });
    vm.runInContext(source.replace(/^export /gm, ''), context);
    return { ...context, document };
}

const ids = { model: 'homer-open-model-settings', preset: 'homer-open-preset-settings',
    memory: 'homer-open-memory-books', mod: 'homer-open-mods', sync: 'homer-chat-storage' };
const labels = { model: '模型设置', preset: '预设开关', memory: '长记忆', mod: 'Mod', appearance: '界面设置', sync: '存档同步' };
function button(label, id = '', preview = false) {
    const row = new Element('button'); row.id = id;
    const copy = new Element('span'); copy.className = preview ? 'preview-setting-row__copy' : 'homer-setting-row__copy';
    const title = new Element('strong'), summary = new Element('small');
    title.textContent = label; summary.textContent = 'Original summary'; copy.append(title, summary); row.append(copy);
    return { row, copy, title, summary };
}

function settingsFixture(order = ['model', 'preset', 'memory', 'mod', 'sync'], preview = false) {
    const root = new Element('dialog'), head = new Element('header'), list = new Element('div'), shortcuts = new Element('div');
    list.className = preview ? 'preview-setting-list' : 'homer-setting-list'; shortcuts.className = 'homer-chat-shortcuts';
    const items = Object.fromEntries(order.map(key => [key, button(labels[key] || 'Future action', preview ? '' : ids[key], preview)]));
    for (const key of order) list.append(items[key].row);
    const appearance = new Element('button'); appearance.setAttribute('aria-label', '界面设置'); shortcuts.append(appearance);
    items.appearance = { row: appearance };
    root.append(head, list, shortcuts);
    return { root, head, list, shortcuts, items };
}

test('known control IDs select semantic keys independently of their translated labels', () => {
    const h = harness();
    for (const [key, id] of Object.entries(ids)) {
        const { row } = button('Unrecognized localized label', id);
        row.setAttribute('aria-label', 'Different label');
        assert.equal(h.controlKey(row), key);
    }
});

test('preview labels and shortcut aria labels select the same semantic controls with trimmed whitespace', () => {
    const h = harness();
    for (const [key, label] of Object.entries(labels)) {
        assert.equal(h.controlKey(button(`  ${label}  `).row), key);
        const row = new Element('button'); row.setAttribute('aria-label', `  ${label}  `);
        assert.equal(h.controlKey(row), key);
    }
});

test('unknown and prototype-looking IDs or labels always resolve to the safe other key', () => {
    const h = harness();
    assert.equal(h.controlKey(new Element('button')), 'other');
    for (const value of ['Future action', 'constructor', 'toString', '__proto__']) {
        assert.equal(h.controlKey(button('Future action', value).row), 'other');
        const row = new Element('button'); row.setAttribute('aria-label', value);
        assert.equal(h.controlKey(row), 'other');
    }
});

test('inserting sync produces six valid SVG controls, including the original appearance shortcut', () => {
    const h = harness(), f = settingsFixture();
    h.controlCenter(f.root);
    assert.equal(f.root.querySelectorAll('svg').length, 6);
    for (const [key, { row }] of Object.entries(f.items)) {
        assert.equal(row.dataset.control, key);
        const svg = row.querySelector('svg'), path = svg.querySelector('path');
        assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
        assert.equal(path.namespaceURI, svg.namespaceURI);
        assert.equal(svg.getAttribute('aria-hidden'), 'true');
        assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
        assert.match(path.getAttribute('d'), /^M\d/);
        assert.doesNotMatch(path.getAttribute('d'), /undefined|NaN/);
    }
    assert.match(f.items.sync.row.querySelector('path').getAttribute('d'), /M20 3v5h-5/);
    assert.notEqual(f.items.sync.row.querySelector('path').getAttribute('d'), f.items.appearance.row.querySelector('path').getAttribute('d'));
});

test('reordering and adding an unknown control preserve semantic grouping, existing nodes, handlers and permissions', () => {
    const h = harness(), f = settingsFixture(['sync', 'mod', 'memory', 'other', 'model', 'preset']);
    let clicks = 0;
    const model = f.items.model, sync = f.items.sync;
    model.row.disabled = true; model.row.dataset.permission = 'preserved-policy';
    sync.row.addEventListener('click', () => { clicks++; });
    h.controlCenter(f.root);
    for (const [key, { row, copy, title, summary }] of Object.entries(f.items)) {
        assert.equal(row.dataset.control, key);
        if (copy) {
            assert.equal(row.querySelector('.homer-control-card__copy'), copy);
            assert.equal(copy.firstElementChild, title);
            assert.equal(copy.lastElementChild, summary);
            assert.equal(summary.textContent, 'Original summary');
        }
        assert.equal(row.parentNode.parentNode.firstElementChild.textContent,
            ['model', 'preset', 'memory'].includes(key) ? '对话能力' : '扩展与外观');
    }
    assert.equal(model.row.disabled, true); assert.equal(model.row.dataset.permission, 'preserved-policy');
    assert.equal(sync.row.id, ids.sync); sync.row.click(); assert.equal(clicks, 1);
    assert.equal(f.items.other.row.querySelector('path').getAttribute('d'), 'M4 12h16 M12 4v16');
});

test('control-center repeated preparation is idempotent and never copies or duplicates original action handlers', () => {
    const h = harness(), f = settingsFixture();
    let clicks = 0; f.items.sync.row.addEventListener('click', () => { clicks++; });
    h.controlCenter(f.root);
    const groups = [...f.list.children], path = f.items.sync.row.querySelector('path');
    h.controlCenter(f.root);
    assert.deepEqual(f.list.children, groups);
    assert.equal(f.root.querySelectorAll('.homer-control-caption').length, 1);
    assert.equal(f.root.querySelectorAll('button').length, 6);
    assert.equal(f.items.sync.row.querySelector('path'), path);
    assert.equal(f.items.sync.row.listeners.length, 1);
    f.items.sync.row.click(); assert.equal(clicks, 1);
});

test('preview controls without runtime IDs retain semantic icons and their original summary nodes', () => {
    const h = harness(), f = settingsFixture(['sync', 'model', 'preset', 'memory', 'mod'], true);
    h.controlCenter(f.root);
    for (const [key, item] of Object.entries(f.items)) {
        assert.equal(item.row.dataset.control, key);
        assert.match(item.row.querySelector('path').getAttribute('d'), /^M\d/);
        if (item.copy) assert.equal(item.row.querySelector('.homer-control-card__copy'), item.copy);
    }
});
