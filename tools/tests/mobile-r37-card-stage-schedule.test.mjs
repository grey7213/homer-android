import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/card-stage.js', import.meta.url), 'utf8');
function extract(start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Shipping source boundaries exist: ${start}`);
    return source.slice(first, last);
}
const stateSource = extract('const COMPONENT_TYPES =', 'function currentCharacter(');
const schedulerSource = extract('function scheduleRefresh(', 'export function installCardStageRuntime(');
const installerSource = source.slice(source.indexOf('export function installCardStageRuntime(')).replace(/^export /, '');

// Execute the shipping scheduler and lifecycle registration; only timers,
// current conversation and rendering callbacks are synthetic. Timer ID 0 is
// intentional, so a truthiness-based pending check cannot hide duplicate work.
function environment({ onRefresh = null } = {}) {
    let nextTimer = 0, current = 'initial';
    const timers = new Map(), registrations = [], calls = [], handlers = new Map();
    const eventNames = ['CHAT_CHANGED', 'CHAT_LOADED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
        'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED'];
    const context = {
        window: {
            setTimeout(callback, delay) {
                const id = nextTimer++;
                timers.set(id, callback); registrations.push({ id, delay }); return id;
            },
            clearTimeout(id) { timers.delete(id); },
        },
        refreshStage() { calls.push(['full', current]); return onRefresh?.(context) ?? Promise.resolve(); },
        renderMessage(id) { calls.push(['point', id, current]); return Promise.resolve(); },
        event_types: Object.fromEntries(eventNames.map(name => [name, name])),
        eventSource: {
            on(name, callback) {
                if (!handlers.has(name)) handlers.set(name, []);
                handlers.get(name).push(callback);
            },
        },
        document: { addEventListener() {} },
        composerInsert() {}, composerSubmit() {}, generateFromStage() {}, exitArchiveStage() {},
        setPresentationMode() {}, publishPresentationMode() {}, presentationMode() {},
    };
    vm.createContext(context);
    vm.runInContext([stateSource, schedulerSource, installerSource].join('\n'), context);
    const flushOne = () => {
        const entry = timers.entries().next().value;
        assert.ok(entry, 'An actual scheduled callback must be pending');
        timers.delete(entry[0]); entry[1]();
    };
    return {
        context, timers, registrations, calls, handlers,
        setCurrent(value) { current = value; },
        schedule(...args) { context.scheduleRefresh(...args); },
        emit(name, ...args) { for (const callback of handlers.get(name) || []) callback(...args); },
        flushOne,
        flushWave() { const count = timers.size; for (let index = 0; index < count; index++) flushOne(); },
    };
}

test('same pending wave has one full refresh, retaining its first zero-delay timer including ID 0', () => {
    const h = environment();
    h.schedule();
    const originalTimer = h.timers.get(0);
    for (const value of [undefined, null, {}, [], { detail: { id: 'later' } }]) h.schedule(value);
    h.setCurrent('latest');
    assert.equal(h.timers.size, 1, 'Full refreshes waiting to start must coalesce');
    assert.equal(h.timers.get(0), originalTimer, 'Later events must not move the first timer');
    assert.deepEqual(h.registrations, [{ id: 0, delay: 0 }]);
    h.flushWave();
    assert.deepEqual(h.calls, [['full', 'latest']]);
});

test('a full request after a flush runs against the new conversation', () => {
    const h = environment();
    h.setCurrent('A'); h.schedule(); h.flushWave();
    h.setCurrent('B'); h.schedule();
    assert.equal(h.timers.size, 1);
    h.flushWave();
    assert.deepEqual(h.calls, [['full', 'A'], ['full', 'B']]);
});

test('a full request while an earlier asynchronous refresh is in flight is not dropped', async () => {
    const resolvers = [];
    const h = environment({ onRefresh: () => new Promise(resolve => resolvers.push(resolve)) });
    h.setCurrent('A'); h.schedule(); h.flushOne();
    assert.equal(resolvers.length, 1);
    h.setCurrent('B'); h.schedule();
    assert.equal(h.timers.size, 1, 'Pending timer state must clear before starting refreshStage');
    h.flushOne();
    assert.deepEqual(h.calls, [['full', 'A'], ['full', 'B']]);
    assert.equal(resolvers.length, 2);
    resolvers.forEach(resolve => resolve());
    await Promise.resolve();
});

test('a reentrant full request made inside refreshStage keeps a separate next callback', () => {
    let requested = false;
    const h = environment({ onRefresh(context) {
        if (!requested) { requested = true; context.scheduleRefresh(); }
    } });
    h.schedule(); h.flushOne();
    assert.equal(h.timers.size, 1);
    h.flushOne();
    assert.deepEqual(h.calls, [['full', 'initial'], ['full', 'initial']]);
});

test('numeric and string point requests retain their IDs, duplicates, order and zero-delay behavior', () => {
    const h = environment();
    h.schedule(0); h.schedule(7); h.schedule(); h.schedule('4'); h.schedule(7);
    assert.equal(h.timers.size, 5);
    assert.ok(h.registrations.every(timer => timer.delay === 0));
    h.flushWave();
    assert.deepEqual(h.calls, [['point', 0, 'initial'], ['point', 7, 'initial'], ['full', 'initial'],
        ['point', '4', 'initial'], ['point', 7, 'initial']]);
});

test('undefined, null and object payloads still select a full refresh', () => {
    for (const value of [undefined, null, {}, [], { detail: { id: 5 } }]) {
        const h = environment(); h.schedule(value); h.flushWave();
        assert.deepEqual(h.calls, [['full', 'initial']]);
    }
});

test('installation retains both chat lifecycle events, deletion and every point event', () => {
    const h = environment();
    h.context.installCardStageRuntime(); h.context.installCardStageRuntime();
    assert.deepEqual([...h.handlers.keys()], ['CHAT_CHANGED', 'CHAT_LOADED', 'CHARACTER_MESSAGE_RENDERED',
        'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']);
    assert.ok([...h.handlers.values()].every(callbacks => callbacks.length === 1));
    h.flushWave();
    for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'MESSAGE_DELETED']) {
        h.setCurrent(name); h.emit(name, { detail: { id: 'event-payload' } }); h.flushWave();
    }
    for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED']) {
        h.emit(name, 8); h.flushWave();
    }
    assert.deepEqual(h.calls.slice(0, 4), [['full', 'initial'], ['full', 'CHAT_CHANGED'], ['full', 'CHAT_LOADED'], ['full', 'MESSAGE_DELETED']]);
    assert.deepEqual(h.calls.slice(4), Array.from({ length: 5 }, () => ['point', 8, 'MESSAGE_DELETED']));
});
