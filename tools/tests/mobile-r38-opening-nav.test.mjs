import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const runtime = new URL('../../sillytavern-runtime/public/', import.meta.url);
const bridge = await readFile(new URL('scripts/extensions/homer-bridge/index.js', runtime), 'utf8');
const css = await readFile(new URL('scripts/extensions/homer-bridge/style.css', runtime), 'utf8');
const start = bridge.indexOf('function renderOpeningNavigation(');
const end = bridge.indexOf('\nfunction renderMessageMenuTargets(', start);
assert.ok(start >= 0 && end > start, 'exercise the actual runtime opening renderer');

class Element {
    constructor(tag, className = '', text = '') {
        this.tagName = tag;
        this.className = className;
        this.textContent = text;
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.disabled = false;
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    append(...children) {
        for (const child of children) {
            child.parent = this;
            this.children.push(child);
        }
    }
    remove() {
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }
    querySelector(selector) {
        const name = selector.slice(1);
        for (const child of this.children) {
            if (child.className.split(' ').includes(name)) return child;
            const match = child.querySelector(selector);
            if (match) return match;
        }
        return null;
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    click() {
        let stopped = false;
        if (!this.disabled) this.listeners.get('click')?.({ stopPropagation() { stopped = true; } });
        return stopped;
    }
    get firstElementChild() { return this.children[0]; }
    get lastElementChild() { return this.children.at(-1); }
}

function harness(selected = 5) {
    const calls = [];
    const opening = {
        mes: `opening-${selected}`, swipe_id: selected,
        swipes: Array.from({ length: 19 }, (_, index) => `opening-${index}`),
        extra: { author_script_state: { untouched: true } },
    };
    const element = new Element('div', 'mes');
    const block = new Element('div', 'mes_block');
    element.append(block);
    const context = vm.createContext({
        launch: { card: { data: { first_mes: 'opening-0', alternate_greetings: ['opening-1'] } } },
        generationBusy: false, rollbackBusy: false, loadingLaunch: false,
        createElement: (...args) => new Element(...args),
        messageMenuTargetFromElement: target => ({ element: target, message: context.current }),
        handleMessageMenuAction: (action, target) => { calls.push({ action, target }); },
        setTextIfChanged: (target, value) => { target.textContent = value; },
        current: opening,
    });
    vm.runInContext(bridge.slice(start, end), context);
    const render = (message = context.current, index = 0, editing = false) => {
        context.renderOpeningNavigation(element, message, index, editing);
        return element.querySelector('.homer-opening-nav');
    };
    return { context, opening, element, block, calls, render };
}

test('runtime owns a single labeled opening control next to the existing message body', () => {
    const h = harness();
    const before = structuredClone(h.opening);
    const nav = h.render();
    assert.equal(nav.parent, h.block);
    assert.equal(nav.attributes.get('aria-label'), '切换角色开场');
    assert.equal(nav.children[1].attributes.get('aria-live'), 'polite');
    assert.equal(nav.children[1].textContent, '开场 6 / 19');
    assert.equal(nav.firstElementChild.attributes.get('aria-label'), '上一个开场');
    assert.equal(nav.lastElementChild.attributes.get('aria-label'), '下一个开场');
    assert.equal(nav.firstElementChild.type, 'button');
    assert.equal(nav.lastElementChild.type, 'button');
    assert.equal(h.render(), nav, 'rerender retains the existing buttons and listeners');
    assert.deepEqual(h.opening, before, 'presentation cannot rewrite swipe or author state');
});

test('first/last opening and every runtime busy state retain disabled feedback', () => {
    const h = harness(0);
    const nav = h.render();
    assert.equal(nav.firstElementChild.disabled, true);
    assert.equal(nav.lastElementChild.disabled, false);
    h.context.current.swipe_id = 18;
    h.render();
    assert.equal(nav.firstElementChild.disabled, false);
    assert.equal(nav.lastElementChild.disabled, true);
    for (const busy of ['generationBusy', 'rollbackBusy', 'loadingLaunch']) {
        h.context.current.swipe_id = 5;
        h.context[busy] = true;
        h.render();
        assert.equal(nav.firstElementChild.disabled, true, busy);
        assert.equal(nav.lastElementChild.disabled, true, busy);
        nav.firstElementChild.click();
        nav.lastElementChild.click();
        assert.equal(h.calls.length, 0, 'disabled buttons cannot invoke generation or swipe actions');
        h.context[busy] = false;
    }
    h.render();
    assert.equal(nav.firstElementChild.disabled, false);
    assert.equal(nav.lastElementChild.disabled, false);
});

test('both controls preserve existing swipe actions and resolve the current live message', () => {
    const h = harness();
    const nav = h.render();
    const replacement = { ...h.opening, swipe_id: 2 };
    h.context.current = replacement;
    assert.equal(nav.firstElementChild.click(), true, 'button clicks stay out of the message long-press target');
    assert.equal(nav.lastElementChild.click(), true);
    assert.deepEqual(h.calls.map(({ action }) => action), ['swipe-left', 'swipe-right']);
    for (const call of h.calls) {
        assert.equal(call.target.message, replacement);
        assert.equal(call.target.element, h.element);
    }
    replacement.swipe_id = 0;
    nav.firstElementChild.click();
    replacement.swipe_id = 18;
    nav.lastElementChild.click();
    assert.equal(h.calls.length, 2, 'live endpoint checks never request a new paid candidate');
});

test('edited, historical, non-opening and unavailable candidates keep their original message UI', () => {
    for (const configure of [
        h => [h.opening, 0, true],
        h => [h.opening, 1, false],
        h => [{ ...h.opening, is_user: true }],
        h => [{ ...h.opening, is_system: true }],
        h => [{ ...h.opening, swipes: ['edited-0', 'edited-1'] }],
        h => [{ ...h.opening, swipes: ['opening-0'] }],
        h => { h.context.launch.card.data.alternate_greetings = []; return [h.opening]; },
    ]) {
        const h = harness();
        assert.ok(h.render());
        assert.equal(h.render(...configure(h)), null);
        assert.equal(h.block.children.length, 0);
    }
});

function rule(selector) {
    const position = css.indexOf(`${selector} {`);
    assert.ok(position >= 0, `missing local rule: ${selector}`);
    return css.slice(position, css.indexOf('}', position) + 1);
}

test('44px hit targets and 28px visual surfaces remain independent of late generic button styles', () => {
    const button = rule('body.homer-runtime #chat .homer-opening-nav > button');
    for (const property of ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height']) {
        assert.match(button, new RegExp(`\\b${property}: 44px !important;`));
    }
    assert.match(button, /padding: 0 !important;/);
    assert.match(button, /background: transparent !important;/);
    const surface = rule('body.homer-runtime #chat .homer-opening-nav > button::before');
    assert.match(surface, /width: 28px !important;/);
    assert.match(surface, /height: 28px !important;/);
    assert.match(surface, /pointer-events: none;/);
    const counter = rule('body.homer-runtime #chat .homer-opening-nav > span');
    assert.match(counter, /font-variant-numeric: tabular-nums;/);
    assert.match(counter, /white-space: nowrap;/);
});

test('fixed stroke SVG has visible text fallback when mask support is absent', () => {
    const button = rule('body.homer-runtime #chat .homer-opening-nav > button');
    assert.match(button, /font: 22px\/1 system-ui;/);
    assert.doesNotMatch(button, /font-size: 0/);
    const supportStart = css.indexOf("@supports ((mask-image: url('')) or (-webkit-mask-image: url('')))");
    const supportEnd = css.indexOf('@media (hover: hover)', supportStart);
    assert.ok(supportStart >= 0 && supportEnd > supportStart);
    const supported = css.slice(supportStart, supportEnd);
    assert.match(supported, /font-size: 0 !important;/);
    assert.match(supported, /width: 18px !important;/);
    assert.match(supported, /height: 18px !important;/);
    const svg = decodeURIComponent(supported.match(/data:image\/svg\+xml,([^"\n]+)/)[1]);
    assert.match(svg, /fill='none'/);
    assert.match(svg, /stroke='black'/);
    assert.match(svg, /stroke-width='2'/);
    assert.match(svg, /stroke-linecap='round'/);
    assert.match(supported, /button:last-child::after\s*\{\s*transform: translate\(-50%, -50%\) rotate\(180deg\)/);
    assert.match(css, /homer-opening-nav > button:disabled\s*\{\s*opacity: \.3/);
    assert.match(css, /homer-opening-nav > button:focus-visible\s*\{\s*outline: 2px solid currentColor/);
});
