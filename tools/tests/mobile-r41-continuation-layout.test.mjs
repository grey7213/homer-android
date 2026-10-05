import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../frontend/assets/css/chat-design.css', import.meta.url), 'utf8');
const start = source.indexOf('let continuationLayoutObserver;');
const end = source.indexOf('function buildAttachmentDialog()', start);
assert.ok(start >= 0 && end > start);
const actual = source.slice(start, end);

function harness({ runtime = true, hidden = false, composerPresent = true, triggerPresent = true, top = 650 } = {}) {
    const reads = [], writes = [], observers = [], listeners = new Set(), frames = new Map(), cancelled = [];
    let nextFrame = 1;
    const forbiddenRead = name => { reads.push(name); throw new Error(`unexpected layout alternative: ${name}`); };
    const element = tag => ({
        tag, hidden: false, children: [], attributes: {}, events: new Map(), dataset: {},
        style: new Proxy({}, { set(target, key, value) { writes.push([key, value]); target[key] = value; return true; } }),
        append(...children) { this.children.push(...children); },
        setAttribute(key, value) { this.attributes[key] = value; },
        addEventListener(name, fn) { this.events.set(name, fn); },
        close() {}, showModal() {},
        getBoundingClientRect: () => forbiddenRead('trigger.rect'),
        getClientRects: () => forbiddenRead('trigger.rects'),
    });
    const trigger = element('button'); trigger.hidden = hidden;
    const composer = { getBoundingClientRect() { reads.push('composer.rect'); return { top }; }, getClientRects: () => forbiddenRead('composer.rects') };
    const context = {
        window: {
            innerHeight: 800,
            addEventListener(name, callback) { assert.equal(name, 'resize'); listeners.add(callback); },
            removeEventListener(name, callback) { assert.equal(name, 'resize'); listeners.delete(callback); },
            getComputedStyle: () => forbiddenRead('window.computedStyle'),
        },
        document: {
            body: { classList: { contains: name => runtime && name === 'homer-runtime' } },
            querySelector(selector) {
                if (selector === '#homer-continuation-trigger') return triggerPresent ? trigger : null;
                if (selector === '#send_form') return composerPresent ? composer : null;
                throw new Error(`unexpected selector: ${selector}`);
            },
        },
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
            observe(value) { assert.equal(value, composer); this.observed = value; }
            disconnect() { this.disconnected = true; }
        },
        requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { cancelled.push(id); frames.delete(id); },
        getComputedStyle: () => forbiddenRead('computedStyle'),
        createElement(tag, className = '', text = '') { const result = element(tag); result.className = className; result.textContent = text; return result; },
        generationBusy: false, loadingLaunch: false, showHostNotice() {}, runAction() {},
    };
    vm.createContext(context); vm.runInContext(actual, context);
    const rebuild = () => {
        // Execute the actual installation call in buildRuntimeUi, including the
        // legacy block on RED, rather than simulating its scheduling behavior.
        const from = source.indexOf('    // The runtime form shell may fill the viewport;');
        const to = source.indexOf('    bindComposerAttachmentButton();', from);
        assert.ok(from >= 0 && to > from);
        vm.runInContext(`{\n${source.slice(from, to)}\n}`, context);
    };
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(16)); };
    return { context, trigger, reads, writes, observers, listeners, frames, cancelled, rebuild, flush,
        setRuntime(value) { runtime = value; }, setTop(value) { top = value; } };
}

test('shipping runtime CSS hides the removed floating generation control', () => {
    assert.match(css, /body\.has-preview \.preview-generation-row,body\.homer-runtime \.homer-continuation-trigger\{display:none!important\}/);
});

test('hidden runtime control never reads geometry or an alternative layout API', () => {
    const h = harness(); h.context.positionContinuationControl(); h.context.positionContinuationControl(true);
    assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []); assert.equal(h.frames.size, 0);
});

test('hidden runtime rebuild installs no resize observer, window callback, or frame', () => {
    const h = harness(); h.rebuild(); h.rebuild(); h.flush();
    assert.equal(h.observers.length, 0); assert.equal(h.listeners.size, 0); assert.equal(h.frames.size, 0);
    assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
});

test('the control is explicitly hidden when created but its generation dialog remains intact', () => {
    const h = harness(); const controls = h.context.buildContinuationControls();
    const [trigger, dialog] = controls.children;
    assert.equal(trigger.hidden, true); assert.equal(dialog.id, 'homer-generation-dialog');
    const buttons = dialog.children[0].children.filter(node => node.tag === 'button');
    assert.equal(buttons.length, 4); assert.deepEqual(h.reads, []);
});

test('a future non-runtime visible control retains deferred composer anchoring and clamping', () => {
    const h = harness({ runtime: false });
    assert.equal(h.context.buildContinuationControls().children[0].hidden, false);
    h.rebuild(); assert.deepEqual(h.reads, []); assert.equal(h.observers.length, 1); assert.equal(h.frames.size, 1);
    h.flush(); assert.deepEqual(h.reads, ['composer.rect']); assert.equal(h.trigger.style.bottom, '158px');
    h.setTop(900); h.observers[0].callback(); assert.equal(h.trigger.style.bottom, '0px');
    h.setTop(600); [...h.listeners][0]({ type: 'resize' }); assert.equal(h.trigger.style.bottom, '208px');
});

test('explicit hidden state outside runtime also suppresses layout and subscriptions', () => {
    const h = harness({ runtime: false, hidden: true }); h.rebuild(); h.context.positionContinuationControl(true); h.flush();
    assert.deepEqual(h.reads, []); assert.equal(h.observers.length, 0); assert.equal(h.listeners.size, 0); assert.equal(h.frames.size, 0);
});

test('visible-to-runtime rebuild disconnects old subscriptions and cancels queued positioning', () => {
    const h = harness({ runtime: false }); h.rebuild(); const observer = h.observers[0];
    const lateFrame = [...h.frames.values()][0]; h.setRuntime(true); h.rebuild();
    assert.equal(observer.disconnected, true); assert.equal(h.listeners.size, 0); assert.equal(h.frames.size, 0);
    assert.equal(h.cancelled.length, 1); observer.callback(); lateFrame();
    assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
});

test('successive visible rebuilds keep only one observer, resize listener and frame', () => {
    const h = harness({ runtime: false }); h.rebuild(); h.rebuild();
    assert.equal(h.observers.filter(value => !value.disconnected).length, 1);
    assert.equal(h.listeners.size, 1); assert.equal(h.frames.size, 1); h.flush();
    assert.deepEqual(h.reads, ['composer.rect']);
});

test('missing control or composer does not register layout work', () => {
    for (const options of [{ triggerPresent: false }, { composerPresent: false }]) {
        const h = harness({ runtime: false, ...options }); h.rebuild(); h.context.positionContinuationControl(true); h.flush();
        assert.equal(h.frames.size, 0); assert.equal(h.observers.length, 0); assert.equal(h.listeners.size, 0); assert.deepEqual(h.reads, []);
    }
});

test('bootstrap uses the same guard before scheduling a late ready positioning frame', () => {
    assert.ok(/document\.documentElement\.classList\.add\('homer-runtime-ready'\);\s*positionContinuationControl\(true\);/.test(source));
    assert.equal((source.match(/requestAnimationFrame\(positionContinuationControl\)/g) || []).length, 0);
});
