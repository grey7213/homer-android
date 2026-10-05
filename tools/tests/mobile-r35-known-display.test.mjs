import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isHostChromeInlineHidden, setHostChromeDisplay, setHostExpressionWrapperDisplay } from '../../sillytavern-runtime/public/scripts/homer-known-display.mjs';

const script = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const expressions = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/expressions/index.js', import.meta.url), 'utf8');
function functionSource(source, marker) {
    const first = source.indexOf(marker), last = source.indexOf('\n/**', first);
    assert.ok(first > 0 && last > first); return source.slice(first, last).replace('export ', '');
}
function doc(host = true) { return { documentElement: { classList: { contains: name => host && name === 'homer-host-chrome' } } }; }
function element(document) {
    const classes = new Set(); let display = '';
    return { ownerDocument: document, classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name), remove: (...names) => names.forEach(x => classes.delete(x)), contains: x => classes.has(x) },
        style: { set display(value) { display = value; }, get display() { throw new Error('must not read display for layout'); } }, value: () => display };
}
function wrap(elements, calls) {
    return { [Symbol.iterator]: () => elements[Symbol.iterator](),
        toggle: visible => calls.push(['toggle', visible]), show: () => calls.push(['show']), hide: () => calls.push(['hide']),
        text: value => { calls.push(['text', value]); return wrap(elements, calls); },
        prop: (key, value) => { calls.push(['prop', key, value]); return wrap(elements, calls); },
        attr: (key, value) => { calls.push(['attr', key, value]); return wrap(elements, calls); },
        toggleClass: (key, value) => { calls.push(['class', key, value]); return wrap(elements, calls); },
        removeAttr: key => calls.push(['removeAttr', key]),
        off: value => calls.push(['off', value]), removeClass: value => calls.push(['removeClass', value]),
        empty: () => calls.push(['empty']), data: (...args) => calls.push(['data', ...args]), append: value => calls.push(['append', value]),
    };
}

test('known displays are writes only, respect document ownership and keep standalone untouched', () => {
    const document = doc(), local = element(document), foreign = element(doc());
    assert.equal(setHostChromeDisplay([local, foreign], true, 'block', document), true);
    assert.equal(local.value(), 'block'); assert.equal(foreign.value(), '');
    setHostChromeDisplay([local], false, 'block', document); assert.equal(local.value(), 'none');
    const standalone = doc(false), node = element(standalone);
    assert.equal(setHostChromeDisplay([node], true, 'block', standalone), false); assert.equal(node.value(), '');
});

test('known inline-hidden test never reads geometry, and unknown/foreign/standalone controls fall back', () => {
    const document = doc(), local = { id: 'visual-novel-wrapper', ownerDocument: document, style: { display: 'none', getPropertyPriority: () => 'important' } };
    Object.defineProperty(local, 'offsetWidth', { get() { throw Error('geometry flush'); } });
    assert.equal(isHostChromeInlineHidden([local], document), true);
    local.style.display = 'flex';
    assert.equal(isHostChromeInlineHidden([local], document), false);
    local.style.display = 'none';
    assert.equal(isHostChromeInlineHidden([], document), false);
    local.style.getPropertyPriority = () => '';
    assert.equal(isHostChromeInlineHidden([local], document), false, 'CSS may override a non-important inline none');
    local.style.getPropertyPriority = () => 'important';
    local.id = 'card-content';
    assert.equal(isHostChromeInlineHidden([local], document), false, 'card content is never treated as host chrome');
    assert.equal(isHostChromeInlineHidden([local, { ownerDocument: doc(), style: { display: 'none' } }], document), false);
    assert.equal(isHostChromeInlineHidden([{ ownerDocument: doc(false), style: { display: 'none' } }], doc(false)), false);
});

function expressionModeFixture(host, oldDisplay = 'none', visible = false, vnMode = false, priority = 'important') {
    const document = doc(host), calls = [];
    const style = display => ({ display, priority, getPropertyPriority() { return this.priority; },
        setProperty(name, value, nextPriority) { this[name] = value; this.priority = nextPriority; } });
    const vn = { id: 'visual-novel-wrapper', ownerDocument: document, style: style(oldDisplay) };
    const single = { id: 'expression-wrapper', ownerDocument: document, style: style('') };
    function wrapper(node, name) {
        return { [Symbol.iterator]: function* () { yield node; },
            is() { calls.push([name, 'geometry']); return visible; },
            show() { calls.push([name, 'show']); }, hide() { calls.push([name, 'hide']); },
            empty() { calls.push([name, 'empty']); }, css() { calls.push([name, 'css']); },
        };
    }
    const wrappedVn = wrapper(vn, 'vn'), wrappedSingle = wrapper(single, 'single');
    const scope = { document, lastMessage: 'old', getContext: () => ({ characterId: 1 }), isVisualNovelMode: () => vnMode,
        isHostChromeInlineHidden: nodes => isHostChromeInlineHidden(nodes, document),
        setHostChromeDisplay: (nodes, state, display) => setHostChromeDisplay(nodes, state, display, document),
        setHostExpressionWrapperDisplay: (nodes, state) => setHostExpressionWrapperDisplay(nodes, state, document),
        $: selector => selector === '#visual-novel-wrapper' ? wrappedVn : wrappedSingle,
    };
    vm.createContext(scope);
    const first = expressions.indexOf('async function moduleWorker(');
    const end = expressions.indexOf('    const currentLastMessage =', first);
    assert.ok(first > 0 && end > first);
    vm.runInContext(expressions.slice(first, end) + 'return vnStateChanged;\n}', scope);
    return { scope, vn, single, calls };
}

test('actual host expression worker does not flush layout for its already hidden VN wrapper', async () => {
    const f = expressionModeFixture(true);
    assert.equal(await f.scope.moduleWorker(), false);
    assert.equal(f.vn.style.display, 'none'); assert.equal(f.single.style.display, 'flex');
    assert.deepEqual(f.calls, []);
});

test('visible/unknown wrapper still uses real visibility and VN transition cleanup', async () => {
    const f = expressionModeFixture(true, 'flex', true, false);
    assert.equal(await f.scope.moduleWorker(), true);
    assert.equal(f.scope.lastMessage, null);
    assert.deepEqual(f.calls, [['vn', 'geometry'], ['vn', 'empty'], ['single', 'css']]);
    const enable = expressionModeFixture(true, 'none', false, true);
    assert.equal(await enable.scope.moduleWorker(), true);
    assert.equal(enable.vn.style.display, 'flex'); assert.equal(enable.single.style.display, 'none');
    assert.equal(enable.vn.style.priority, ''); assert.equal(enable.single.style.priority, 'important');
    const unknownHidden = expressionModeFixture(true, 'none', true, false, '');
    assert.equal(await unknownHidden.scope.moduleWorker(), true);
    assert.equal(unknownHidden.calls[0][1], 'geometry', 'an overridable inline none still needs real visibility');
});

test('standalone expression worker retains its original visibility read and show/hide', async () => {
    const f = expressionModeFixture(false);
    assert.equal(await f.scope.moduleWorker(), false);
    assert.deepEqual(f.calls, [['vn', 'geometry'], ['single', 'show'], ['vn', 'hide']]);
});

test('expression/VN fixed display values match their actual flex layout stylesheet', () => {
    const css = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/expressions/style.css', import.meta.url), 'utf8');
    for (const name of ['expression-wrapper', 'visual-novel-wrapper']) assert.match(css, new RegExp(`#${name}\\s*\\{\\s*display: flex;`));
    assert.match(expressions, /if \(offlineMode\.is\(':visible'\)\)/);
    assert.match(expressions, /if \(!setHostExpressionWrapperDisplay\(element, false\)\) element\.hide\(\)/);
});

test('authoritative expression visibility does not modify unknown, foreign or standalone content', () => {
    const document = doc(), touched = [];
    const node = id => ({ id, ownerDocument: document, style: { setProperty: (...args) => touched.push([id, ...args]) } });
    assert.equal(setHostExpressionWrapperDisplay([node('visual-novel-wrapper')], false, document), true);
    assert.deepEqual(touched, [['visual-novel-wrapper', 'display', 'none', 'important']]);
    assert.equal(setHostExpressionWrapperDisplay([node('card-content')], false, document), false);
    assert.equal(setHostExpressionWrapperDisplay([{ ...node('expression-wrapper'), ownerDocument: doc() }], false, document), false);
    assert.equal(setHostExpressionWrapperDisplay([node('visual-novel-wrapper')], false, doc(false)), false);
    assert.equal(touched.length, 1);
});

function swipeFixture(host) {
    const document = doc(host), pickerCalls = [], counterCalls = [], updated = [];
    const nodes = [element(document), element(document), element(document)];
    const pickers = nodes.map(node => wrap([node], pickerCalls));
    const chat = [{ swipes: ['one', 'two'], swipe_id: 0 }, { swipes: ['one'], swipe_id: 0 }, { swipes: ['one', 'two'], swipe_id: 1 }];
    const divs = chat.map((_, index) => ({ ...element(document), index }));
    const bodyCalls = [];
    const scope = {
        chat, document, setHostChromeDisplay: (elements, visible, display) => setHostChromeDisplay(elements, visible, display, document),
        isSwipingAllowed: () => true, isMessageSwipeable: id => id !== 1,
        getOverswipeBehavior: () => 'regenerate', canOpenSwipePickerForMessage: id => id !== 1, canJumpToSwipeForMessage: () => true,
        OVERSWIPE_BEHAVIOR: { PRISTINE_GREETING: 'pristine', REGENERATE: 'regenerate', EDIT_GENERATE: 'edit' },
        chatElement: { children: () => ({ first: () => ({ attr: () => '0' }), each: fn => divs.forEach((x, i) => fn(i, x)) }) },
        $: target => target === 'body' ? { addClass: name => bodyCalls.push(['add', name]), removeClass: name => bodyCalls.push(['remove', name]) }
            : { find: selector => selector === '.mes_swipe_picker' ? pickers[target.index] : wrap([], counterCalls) },
        updateSwipeCounter: id => updated.push(id), ensureSwipes: () => false, syncMesToSwipe: () => { throw new Error('unexpected sync'); },
        formatSwipeCounter: (current, length) => `${current}/${length}`, INTERACTABLE_CONTROL_CLASS: 'interactable', t: strings => strings[0],
    };
    vm.createContext(scope); vm.runInContext(functionSource(script, 'export function refreshSwipeButtons('), scope);
    return { scope, nodes, divs, pickerCalls, counterCalls, updated, pickers, bodyCalls };
}

test('actual host refresh keeps picker eligibility, classes and counters without jQuery display reads', () => {
    const f = swipeFixture(true); f.scope.refreshSwipeButtons(true, false);
    assert.deepEqual(f.nodes.map(x => x.value()), ['var(--fa-display, inline-block)', 'none', 'var(--fa-display, inline-block)']);
    assert.equal(f.pickerCalls.length, 0); assert.deepEqual(f.updated, [0, 2]);
    assert.equal(f.divs[0].classList.contains('swipes_visible'), true); assert.equal(f.divs[1].classList.contains('swipes_visible'), false);
    assert.equal(f.divs[2].classList.contains('last_swipe'), true);
});

test('standalone refresh uses the original jQuery toggle and disabled swiping still hides all controls', () => {
    const f = swipeFixture(false); f.scope.refreshSwipeButtons();
    assert.deepEqual(f.pickerCalls, [['toggle', true], ['toggle', false], ['toggle', true]]);
    assert.deepEqual(f.nodes.map(x => x.value()), ['', '', '']);
    f.scope.isSwipingAllowed = () => false; f.scope.refreshSwipeButtons();
    assert.deepEqual(f.bodyCalls.at(-1), ['add', 'hideAllSwipeButtons']);
});

test('actual counter refresh retains text, accessibility and picker behavior through fixed display', async () => {
    const f = swipeFixture(true); const counter = wrap([], f.counterCalls);
    vm.runInContext(functionSource(script, 'export async function updateSwipeCounter('), f.scope);
    await f.scope.updateSwipeCounter(0, { message: f.scope.chat[0], messageElement: { find: selector => selector === '.mes_swipe_picker' ? f.pickers[0] : counter } });
    assert.equal(f.nodes[0].value(), 'var(--fa-display, inline-block)'); assert.equal(f.pickerCalls.length, 0);
    assert.ok(f.counterCalls.some(x => x[0] === 'text' && x[1] === '1/2'));
    assert.ok(f.counterCalls.some(x => x[0] === 'attr' && x[1] === 'role' && x[2] === 'button'));
});

function expressionFixture(host) {
    const document = doc(host), open = element(document), empty = element(document);
    const openCalls = [], emptyCalls = [], imageCalls = [], listCalls = [];
    const scope = { document, lastMessage: 'old', extension_settings: { expressions: { custom: [] } },
        setHostChromeDisplay: (elements, visible, display) => setHostChromeDisplay(elements, visible, display, document),
        $: selector => selector === '#open_chat_expressions' ? wrap([open], openCalls)
            : selector === '#no_chat_expressions' ? wrap([empty], emptyCalls)
                : selector === 'img.expression' ? wrap([], imageCalls) : wrap([], listCalls),
        getListItem: async label => `sprite-${label}`, getPlaceholderImage: label => ({ label }),
    };
    vm.createContext(scope);
    // The visibility helper is immediately followed by a column-zero enum doc.
    vm.runInContext(functionSource(expressions, 'function setExpressionPanelVisibility(')
        + functionSource(expressions, 'function removeExpression(')
        + functionSource(expressions, 'async function drawSpritesList('), scope);
    return { scope, open, empty, openCalls, emptyCalls, imageCalls, listCalls };
}

test('actual host expression removal still clears image state while showing its empty state without layout reads', () => {
    const f = expressionFixture(true); f.scope.removeExpression();
    assert.equal(f.scope.lastMessage, null); assert.equal(f.open.value(), 'none'); assert.equal(f.empty.value(), 'block');
    assert.deepEqual(f.imageCalls, [['off', 'error'], ['prop', 'src', ''], ['removeClass', 'default']]);
    assert.equal(f.openCalls.length, 0); assert.equal(f.emptyCalls.length, 0);
});

test('actual host sprite list restores the populated panel and renders sprite options', async () => {
    const f = expressionFixture(true);
    const result = await f.scope.drawSpritesList('synthetic', ['joy'], [{ label: 'joy', files: [{ imageSrc: 'synthetic.png' }] }]);
    assert.equal(f.open.value(), 'block'); assert.equal(f.empty.value(), 'none');
    assert.equal(result.length, 1); assert.equal(result[0].label, 'joy');
    assert.ok(f.listCalls.some(x => x[0] === 'append' && x[1] === 'sprite-joy'));
    assert.equal(f.openCalls.length + f.emptyCalls.length, 0);
});

test('standalone expression panels retain their original show/hide behavior', async () => {
    const f = expressionFixture(false); f.scope.removeExpression(); await f.scope.drawSpritesList('synthetic', [], []);
    assert.deepEqual(f.openCalls, [['hide'], ['show']]); assert.deepEqual(f.emptyCalls, [['show'], ['hide']]);
    assert.equal(f.open.value(), ''); assert.equal(f.empty.value(), '');
});

test('fixed values are sourced from actual FA and DIV CSS rather than guessed geometry', () => {
    const fa = fs.readFileSync(new URL('../../sillytavern-runtime/public/css/fontawesome.min.css', import.meta.url), 'utf8');
    assert.match(fa, /display:var\(--fa-display,inline-block\)/);
    const settings = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/expressions/settings.html', import.meta.url), 'utf8');
    assert.match(settings, /<div id="no_chat_expressions"/); assert.match(settings, /<div id="open_chat_expressions">/);
});
