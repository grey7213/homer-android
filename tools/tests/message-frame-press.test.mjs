import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createMessagePress } from '../../sillytavern-runtime/public/scripts/homer-message-frames.mjs';
function fixture() {
    let binding = { message: 'exact-message', epoch: 1 }, active = binding, now = 0;
    const calls = [], timers = new Map(); let serial = 0;
    const press = createMessagePress({ capture: () => binding, accepts: value => value && value === active,
        open: (value, point) => calls.push({ value, point }), clearSelection: () => calls.push('cleared'), now: () => now,
        setTimer: fn => { timers.set(++serial, fn); return serial; }, clearTimer: id => timers.delete(id) });
    const event = values => ({ pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 30,
        target: { closest: () => null }, preventDefault() { this.prevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {}, ...values });
    return { press, calls, event, timers, tick: () => { now += 500; for (const fn of [...timers.values()]) fn(); },
        stale: () => { active = { ...binding, epoch: 2 }; }, bindNew: () => { binding = active; } };
}
test('exact held message opens the menu once and clears native text selection', () => {
    const f = fixture(); f.press.down(f.event()); f.tick();
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0], 'cleared');
    assert.deepEqual(f.calls[1].point, { x: 20, y: 30 });
    f.press.cancel(); f.tick(); assert.equal(f.calls.length, 2);
});
for (const reason of ['release', 'scroll', 'multitouch', 'stale']) test(`long press is cancelled/fenced after ${reason}`, () => {
    const f = fixture(); f.press.down(f.event());
    if (reason === 'release') f.press.cancel();
    if (reason === 'scroll') f.press.move(f.event({ clientY: 70 }));
    if (reason === 'multitouch') f.press.down(f.event({ pointerId: 2, isPrimary: false }));
    if (reason === 'stale') f.stale();
    f.tick(); assert.equal(f.calls.length, 0);
});
test('interactive controls keep ordinary click, native selection and context menus', () => {
    const f = fixture(), e = f.event({ target: { closest: () => ({ tagName: 'INPUT' }) } });
    f.press.down(e); f.tick(); f.press.context(e); f.press.select(e); f.press.click(e);
    assert.equal(f.calls.length, 0); assert.equal(e.prevented, undefined);
});
test('release click is suppressed only after a real menu and never across a stale scope', () => {
    const f = fixture(); f.press.down(f.event()); f.tick(); const e = f.event(); f.press.click(e);
    assert.equal(e.prevented, true);
    const control = f.event({ target: { closest: () => ({}) } }); f.press.click(control);
    assert.equal(control.prevented, undefined);
    const duplicate = f.event(); f.press.context(duplicate); assert.equal(f.calls.length, 2);
    f.stale(); const stale = f.event(); f.press.click(stale); assert.equal(stale.prevented, undefined);
});
test('context menu opens without waiting, while stale/empty bindings do not intercept', () => {
    const f = fixture(), e = f.event(); f.press.context(e); assert.equal(e.prevented, true);
    f.stale(); const stale = f.event(); f.press.context(stale); assert.equal(stale.prevented, undefined);
    assert.equal(f.calls.length, 2);
});
test('actual Mod link handler notifies its outer host instead of navigating the runtime document', () => {
    const text = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
    const code = text.slice(text.indexOf("workshop.addEventListener('click'"), text.indexOf("workshop.className='homer-mod-library-link'"));
    assert.ok(code.includes('notifyHost'));
    let handler, embedded = true, closed = 0; const events = [];
    vm.runInNewContext(code, { workshop: { addEventListener(_, fn) { handler = fn; } },
        canNotifyHost: () => embedded, dialog: { close() { closed++; } }, notifyHost: (type, data) => events.push([type, data.target]) });
    const e = { preventDefault() { this.prevented = true; } }; handler(e);
    assert.equal(e.prevented, true); assert.equal(closed, 1); assert.deepEqual(events, [['navigate', '/app/workshop.html']]);
    embedded = false; const standalone = { preventDefault() { this.prevented = true; } }; handler(standalone);
    assert.equal(standalone.prevented, undefined); assert.equal(closed, 1);
});
