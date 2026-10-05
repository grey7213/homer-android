import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bridge = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const baseline = JSON.parse(readFileSync(new URL('./fixtures/message-header339-baseline.json', import.meta.url), 'utf8')).functions;
function shippingFunction(name, optional = false) {
    const start = bridge.indexOf(`function ${name}(`);
    if (optional && start < 0) return '';
    assert.ok(start >= 0, `actual shipping function ${name}`);
    const end = bridge.indexOf('\nfunction ', start + 1);
    assert.ok(end > start);
    return bridge.slice(start, end).trimEnd();
}
const current = Object.fromEntries(Object.keys(baseline).map(name => [name, shippingFunction(name)]));

// DOM-shaped seam only: execute the real shipping header and menu functions,
// without importing the bridge's unrelated runtime/bootstrap side effects.
class Element {
    constructor(className = '', text = '') {
        this.className = className; this.textContent = text; this.children = [];
        this.dataset = {}; this.attributes = {}; this.classes = new Set(className.split(' '));
        this.classList = { add: name => this.classes.add(name), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    querySelector(selector) {
        for (const child of this.children) {
            if (child.classes.has(selector.slice(1))) return child;
            const nested = child.querySelector(selector); if (nested) return nested;
        }
        return null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); }
    before(node) { const p = this.parentElement; node.parentElement = p; p.children.splice(p.children.indexOf(this), 0, node); }
    after(node) { const p = this.parentElement; node.parentElement = p; p.children.splice(p.children.indexOf(this) + 1, 0, node); }
    snapshot() {
        return { className: this.className, text: this.textContent, attributes: this.attributes,
            classes: [...this.classes], dataset: this.dataset, title: this.title, type: this.type,
            tabIndex: this.tabIndex, children: this.children.map(child => child.snapshot()) };
    }
}
function messageElement(index, missingHeader = false) {
    const element = new Element('mes'); element.index = index;
    element.append(new Element('homer-message-actions'));
    if (!missingHeader) {
        const header = new Element('ch_name'), meta = new Element('meta');
        meta.append(new Element('name_text'), new Element('timestamp'));
        header.append(meta, new Element('extraMesButtonsHint'), new Element('mes_edit'));
        element.append(header);
    }
    return element;
}
function harness(messages, { old = false, missingHeader = false } = {}) {
    const events = [], counts = { constructors: 0, formats: 0, parses: 0 };
    const state = { zone: 'UTC', constructorError: null, formatErrorAt: 0, formatError: null };
    const elements = messages.map((_, i) => messageElement(i, missingHeader));
    const RealDate = Date;
    class TrackedDate extends RealDate {
        constructor(value) { counts.parses++; events.push(['parse', value]); super(value); }
    }
    function DateTimeFormat(locale, options) {
        counts.constructors++; events.push(['constructor', locale, { ...options }, state.zone]);
        if (state.constructorError) throw state.constructorError;
        const formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: state.zone });
        return { format(date) {
            counts.formats++; events.push(['format', date.getTime()]);
            if (counts.formats === state.formatErrorAt) throw state.formatError;
            return formatter.format(date);
        } };
    }
    const scope = vm.createContext({ Date: TrackedDate, Intl: { DateTimeFormat },
        getContext: () => ({ chat: messages }),
        imageGenerationUi: { render: () => events.push(['image']) },
        document: { querySelectorAll: selector => { assert.equal(selector, '#chat .mes'); return elements; } },
        messageIndexFromElement: element => element.index,
        messageHeaderName: message => message.is_user ? '你' : '《角色》',
        currentCharacterVersionLabel: () => 'v1',
        createElement: (_tag, className, text) => new Element(className, text),
        renderOpeningNavigation: (_element, _message, index, editing) => events.push(['opening', index, editing]),
        decorateTavoMessage: (element, options) => events.push(['tavo', element.index, JSON.stringify(options)]),
        stableHomerMessageId: message => `synthetic-${messages.indexOf(message)}`,
        renderMessageMenuDialog: () => events.push(['dialog']),
        renderMessageSelection: () => events.push(['selection']),
    });
    vm.runInContext([
        old ? '' : shippingFunction('createMessageHeaderTimeFormatter', true),
        shippingFunction('setTextIfChanged'),
        ...Object.values(old ? baseline : current),
    ].join('\n'), scope);
    return { scope, counts, state, events, elements,
        render: () => scope.renderMessageMenuTargets(),
        snapshot: () => elements.map(element => element.snapshot()),
        withoutConstructors: () => events.filter(event => event[0] !== 'constructor'),
        times: () => elements.map(element => element.querySelector('.timestamp')?.textContent),
    };
}
const dates = () => [
    { send_date: 'invalid' }, { send_date: 1704067200 }, { send_date: '1704067260000', is_user: true },
    { send_date: '2024-02-29T13:42:00Z' }, { extra: { homer_created_at: '2025-08-01T00:00:00Z' } },
    { send_date: 0 }, { send_date: '-1' }, { send_date: 8.64e16 },
];

test('one lazy formatter per actual synchronous menu pass, preserving all header and menu output', () => {
    const next = harness(dates()), old = harness(dates(), { old: true });
    next.render(); old.render();
    assert.equal(next.counts.constructors, 1);
    assert.equal(old.counts.constructors, old.counts.formats);
    assert.ok(old.counts.constructors > 1);
    assert.equal(next.counts.parses, dates().length);
    assert.equal(next.counts.formats, old.counts.formats);
    assert.deepEqual(next.snapshot(), old.snapshot());
    assert.deepEqual(next.withoutConstructors(), old.withoutConstructors());
});

test('no constructor for invalid dates, absent headers, ineligible messages or an empty pass', () => {
    for (const [messages, options] of [
        [[{}, { send_date: 'invalid' }, { send_date: 8.64e16 }], {}],
        [[{ send_date: 1704067200 }], { missingHeader: true }],
        [[{ send_date: 1704067200, is_system: true }], {}], [[], {}],
    ]) {
        const next = harness(messages, options), old = harness(messages, { ...options, old: true });
        next.render(); old.render();
        assert.equal(next.counts.constructors, 0);
        assert.deepEqual(next.snapshot(), old.snapshot());
        assert.deepEqual(next.withoutConstructors(), old.withoutConstructors());
    }
});

test('each new pass resolves timezone again, with no sharing after a previous pass or standalone call', () => {
    const messages = [{ send_date: 1704067200 }, { send_date: 1704070800 }];
    const next = harness(messages), old = harness(messages, { old: true });
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/New_York', 'UTC']) {
        next.state.zone = old.state.zone = zone;
        next.render(); old.render();
        assert.deepEqual(next.times(), old.times());
    }
    assert.equal(next.counts.constructors, 4);
    assert.equal(old.counts.constructors, 8);
    const prior = next.counts.constructors;
    assert.equal(next.scope.messageHeaderTime(messages[0]), old.scope.messageHeaderTime(messages[0]));
    assert.equal(next.counts.constructors, prior + 1);
    next.render(); assert.equal(next.counts.constructors, prior + 2);
});

test('standalone time and standalone header decoration preserve per-call construction and parse behavior', () => {
    const next = harness(dates()), old = harness(dates(), { old: true });
    for (const message of dates()) {
        assert.equal(next.scope.messageHeaderTime(message), old.scope.messageHeaderTime(message));
    }
    for (let i = 0; i < dates().length; i++) {
        next.scope.decorateMessageHeader(next.elements[i], dates()[i], i);
        old.scope.decorateMessageHeader(old.elements[i], dates()[i], i);
    }
    assert.deepEqual(next.counts, old.counts);
    assert.deepEqual(next.events, old.events);
    assert.deepEqual(next.snapshot(), old.snapshot());
});

test('constructor and per-message format exceptions propagate unchanged and the next pass can retry', () => {
    const messages = [{ send_date: 'invalid' }, { send_date: 1704067200 }, { send_date: 1704070800 }];
    for (const kind of ['constructor', 'format']) {
        const error = new Error(`synthetic ${kind} failure`);
        const next = harness(messages), old = harness(messages, { old: true });
        for (const h of [next, old]) {
            if (kind === 'constructor') h.state.constructorError = error;
            else { h.state.formatErrorAt = 2; h.state.formatError = error; }
            assert.throws(h.render, actual => actual === error);
        }
        assert.deepEqual(next.snapshot(), old.snapshot());
        assert.deepEqual(next.withoutConstructors(), old.withoutConstructors());
        next.state.constructorError = old.state.constructorError = null;
        next.state.formatErrorAt = old.state.formatErrorAt = 0;
        const before = next.counts.constructors;
        next.render(); old.render();
        assert.equal(next.counts.constructors, before + 1);
        assert.deepEqual(next.snapshot(), old.snapshot());
    }
});

test('timestamp getter/coercion exceptions remain visible, without eager formatter construction', () => {
    const error = new Error('synthetic timestamp coercion failure');
    const message = { send_date: { toString() { throw error; } } };
    for (const old of [false, true]) {
        const h = harness([message], { old });
        assert.throws(h.render, actual => actual === error);
        assert.equal(h.counts.constructors, 0);
    }
});

test('hidden system messages, editing flags and repeated passes keep the existing eligibility rules', () => {
    const messages = [
        { is_system: true, send_date: 1704067200 },
        { is_system: true, send_date: 1704067200, extra: { homer_hidden: true, homer_collapsed: true } },
        { is_user: true, send_date: 1704070800 },
    ];
    const next = harness(messages), old = harness(messages, { old: true });
    for (const h of [next, old]) h.elements[2].append(new Element('edit_textarea'));
    for (let pass = 0; pass < 2; pass++) {
        next.render(); old.render();
        assert.deepEqual(next.snapshot(), old.snapshot());
        assert.deepEqual(next.withoutConstructors(), old.withoutConstructors());
    }
    assert.equal(next.counts.constructors, 2);
    assert.equal(next.counts.formats, 4);
});

test('formatter options remain exact and deterministic synthetic dates match the previous shipping implementation', () => {
    let seed = 0x340;
    const messages = Array.from({ length: 128 }, (_, i) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return { send_date: i % 9 ? 1_000_000_000_000 + seed * 200 : `invalid-${seed}`, is_user: !!(i % 2) };
    });
    const next = harness(messages), old = harness(messages, { old: true });
    next.render(); old.render();
    assert.equal(next.counts.constructors, 1);
    assert.deepEqual(next.events.find(event => event[0] === 'constructor'), old.events.find(event => event[0] === 'constructor'));
    assert.deepEqual(next.snapshot(), old.snapshot());
    assert.equal(next.counts.parses, 128);
    assert.equal(next.counts.formats, old.counts.formats);
});
