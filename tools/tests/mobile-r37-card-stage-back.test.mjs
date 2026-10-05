import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const oldSnapshot = process.env.R37_CARD_STAGE_BACK_OLD_SNAPSHOT === '1';
const snapshotRoot = '../../output/mobile-r37/card-stage-overlay-before/';
const bridge = fs.readFileSync(new URL(oldSnapshot ? snapshotRoot + 'index.js'
    : '../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const stage = fs.readFileSync(new URL(oldSnapshot ? snapshotRoot + 'card-stage.js'
    : '../../sillytavern-runtime/public/scripts/extensions/homer-bridge/card-stage.js', import.meta.url), 'utf8');
const picker = fs.readFileSync(new URL(oldSnapshot ? snapshotRoot + 'option-picker.js'
    : '../../.web-cache/tree/frontend/assets/js/option-picker.js', import.meta.url), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
console.log('Source mode:', oldSnapshot ? 'Read-only old snapshot VM replay; not an old APK or current shipping source' : 'Current shipping source');
console.log('VM-source SHA256:', JSON.stringify({ bridge: digest(bridge), stage: digest(stage), picker: digest(picker) }));

function section(source, start, end, { optional = false } = {}) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    if (optional && first < 0) return null;
    assert.ok(first >= 0 && last > first, `Actual source boundaries exist: ${start}`);
    return source.slice(first, last);
}

const backSource = section(bridge, 'let runtimeBackHandler = null;', 'function buildRuntimeUi(');
const closeSource = section(stage, 'export function closeCardStageOverlay(', 'function scheduleRefresh(', { optional: true });

// Shipping functions and the complete shipping picker IIFE execute unchanged.
// Only DOM/native-module surroundings are controlled. This verifies the Back
// boundary, not real shadow rendering, focus restoration or Android delivery.
function environment({ previous = null, stageResult = false, loaded = true, panel = false, drawer = false } = {}) {
    const calls = { previous: 0, stage: 0, panel: 0, drawer: 0, selection: 0 };
    const dialogs = [], documentListeners = [];
    let selection = null;
    const root = { querySelector(selector) {
        if (selector === '#homer-preset-panel') return panel ? { hidden: false } : null;
        if (selector === '.homer-chat-drawer.is-open, #homer-left-drawer.is-open, #homer-right-drawer.is-open') return drawer ? {} : null;
        throw new Error(`Unexpected runtime root query: ${selector}`);
    } };
    class Dialog {
        constructor({ visible = true, veto = false } = {}) { this.visible = visible; this.veto = veto; this.events = []; this.closed = []; }
        getClientRects() { return this.visible ? [{}] : []; }
        dispatchEvent(event) { this.events.push(event); if (this.veto) event.preventDefault(); return !event.defaultPrevented; }
        close(value) { this.closed.push(value); }
        closest(selector) { return selector === 'dialog[open]' ? this : null; }
    }
    const context = {
        Event, URL,
        HTMLDialogElement: Dialog,
        document: {
            documentElement: { dataset: {} },
            currentScript: { src: 'https://fixture.invalid/assets/js/option-picker.js' },
            activeElement: null,
            head: { append() {} },
            createElement() { return { dataset: {} }; },
            addEventListener(...args) { documentListeners.push(args); },
            querySelector(selector) {
                if (selector === '#homer-runtime-root') return root;
                if (selector === '[data-homer-cancel-selection]') return selection;
                if (selector === 'link[data-homer-surface-controls]') return null;
                throw new Error(`Unexpected document query: ${selector}`);
            },
            querySelectorAll(selector) {
                if (selector === 'dialog[open]') return dialogs;
                if (selector === '[role="dialog"][aria-modal="true"],.xy-modal') return [];
                throw new Error(`Unexpected document queryAll: ${selector}`);
            },
        },
        window: { addEventListener() {}, HomerApplyTheme() {} },
        location: { href: 'https://fixture.invalid/module/dialogue/', origin: 'https://fixture.invalid' },
        localStorage: { getItem() { return null; } },
        getComputedStyle() { return { visibility: 'visible' }; },
        legacyRuntimeModule: loaded ? { cardExperienceRuntime: { closeTopOverlay() { calls.stage++; return stageResult; } } } : null,
        setPanelOpen(value) { assert.equal(value, false); calls.panel++; },
        setDrawerOpen(...args) { assert.equal(args.length, 0); calls.drawer++; },
    };
    if (previous) context.window.HomerCloseOverlay = () => { calls.previous++; return previous(); };
    vm.createContext(context);
    if (closeSource) vm.runInContext(closeSource.replace(/^export /, ''), context);
    vm.runInContext(backSource, context);
    return {
        context, calls, dialogs, documentListeners,
        install() { context.installRuntimeBackHandler(); return context.window.HomerCloseOverlay; },
        installPicker() { vm.runInContext(picker, context); return context.window.HomerCloseOverlay; },
        back() { return context.window.HomerCloseOverlay(); },
        closeStage() {
            assert.equal(typeof context.closeCardStageOverlay, 'function', 'Shipping closeCardStageOverlay export must exist');
            return context.closeCardStageOverlay();
        },
        addDialog(options) { const dialog = new Dialog(options); dialogs.push(dialog); return dialog; },
        addSelection() {
            selection = { getClientRects() { return [{}]; }, click() { calls.selection++; } };
            return selection;
        },
    };
}

function installOrder(h, order) {
    if (order === 'picker-first') { h.installPicker(); h.install(); }
    else { h.install(); h.installPicker(); }
}

test('actual stage export returns false without loading the legacy runtime', () => {
    const h = environment({ loaded: false });
    assert.equal(h.closeStage(), false);
    assert.equal(h.calls.stage, 0);
});

test('actual stage export tolerates missing runtime/method and consumes strict true only', () => {
    for (const value of [{}, { cardExperienceRuntime: {} }]) {
        const h = environment(); h.context.legacyRuntimeModule = value;
        assert.equal(h.closeStage(), false);
    }
    for (const value of [false, undefined, null, 0, 1, 'true', true]) {
        const h = environment({ stageResult: value });
        assert.equal(h.closeStage(), value === true);
        assert.equal(h.calls.stage, 1);
    }
});

test('previous handled or vetoed cancellation retains priority without calling stage', () => {
    for (const reason of ['handled', 'vetoed']) {
        const h = environment({ previous: () => true, stageResult: true, panel: true, drawer: true });
        h.install(); assert.equal(h.back(), true, reason);
        assert.deepEqual(h.calls, { previous: 1, stage: 0, panel: 0, drawer: 0, selection: 0 });
    }
});

test('visible native dialog returns false for Native cancel without calling stage or fallback', () => {
    const h = environment({ stageResult: true, panel: true, drawer: true });
    const dialog = h.addDialog({ veto: true });
    h.install(); assert.equal(h.back(), false);
    assert.equal(dialog.events.length, 0, 'Bridge must leave native dialog cancellation to the existing handler');
    assert.deepEqual(h.calls, { previous: 0, stage: 0, panel: 0, drawer: 0, selection: 0 });
});

test('actual stage handled result wins over preset and drawer fallback', () => {
    const h = environment({ stageResult: true, panel: true, drawer: true });
    h.install(); assert.equal(h.back(), true);
    assert.deepEqual(h.calls, { previous: 0, stage: 1, panel: 0, drawer: 0, selection: 0 });
});

test('no stage overlay keeps the ordinary preset fallback', () => {
    const h = environment({ panel: true, drawer: true });
    h.install(); assert.equal(h.back(), true);
    assert.equal(h.calls.panel, 1); assert.equal(h.calls.drawer, 0);
});

test('no stage overlay keeps the ordinary drawer fallback', () => {
    const h = environment({ drawer: true });
    h.install(); assert.equal(h.back(), true);
    assert.equal(h.calls.panel, 0); assert.equal(h.calls.drawer, 1);
});

test('no overlay keeps the false result for normal Native navigation', () => {
    const h = environment({ loaded: false });
    h.install(); assert.equal(h.back(), false);
});

test('repeated bridge installation retains function identity rather than wrapping itself', () => {
    const h = environment({ previous: () => false, stageResult: true });
    const installed = h.install();
    for (let index = 0; index < 5; index++) assert.equal(h.install(), installed);
    assert.equal(h.back(), true);
    assert.equal(h.calls.previous, 1); assert.equal(h.calls.stage, 1);
});

test('actual picker and bridge delegate stage Back in both loading orders', () => {
    for (const order of ['picker-first', 'picker-later']) {
        const h = environment({ stageResult: true }); installOrder(h, order);
        assert.equal(h.back(), true, order);
        assert.equal(h.calls.stage, 1, order);
    }
});

test('actual picker preserves preventDefault dialog cancellation before a stage overlay', () => {
    for (const order of ['picker-first', 'picker-later']) {
        const h = environment({ stageResult: true });
        const dialog = h.addDialog({ veto: true }); installOrder(h, order);
        assert.equal(h.back(), true, order);
        assert.equal(dialog.events.length, 1); assert.equal(dialog.events[0].type, 'cancel');
        assert.equal(dialog.events[0].cancelable, true); assert.equal(dialog.events[0].defaultPrevented, true);
        assert.equal(dialog.closed.length, 0); assert.equal(h.calls.stage, 0);
    }
});

test('actual picker retains visible selection priority before delegating to stage', () => {
    for (const order of ['picker-first', 'picker-later']) {
        const h = environment({ stageResult: true }); h.addSelection(); installOrder(h, order);
        assert.equal(h.back(), true, order);
        assert.equal(h.calls.selection, 1); assert.equal(h.calls.stage, 0);
    }
});

test('actual picker/bridge no-overlay result remains false without recursive chaining', () => {
    for (const order of ['picker-first', 'picker-later']) {
        const h = environment({ loaded: false }); installOrder(h, order);
        assert.equal(h.back(), false, order);
        assert.equal(h.calls.panel, 0); assert.equal(h.calls.drawer, 0);
    }
});

test('reinstall after picker replacement retains a finite stable prior chain', () => {
    const h = environment({ previous: () => false, stageResult: true });
    h.install(); h.installPicker(); const installed = h.install();
    for (let index = 0; index < 5; index++) assert.equal(h.install(), installed);
    assert.equal(h.back(), true);
    assert.equal(h.calls.previous, 1); assert.equal(h.calls.stage, 1);
});
