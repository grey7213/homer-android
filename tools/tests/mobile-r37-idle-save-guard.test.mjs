import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extract the shipping functions without changing the frozen product source.
const runtimeSource = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const utilsSource = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/utils.js', import.meta.url), 'utf8');
function extract(source, start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Real source boundaries exist: ${start}`);
    return source.slice(first, last).replaceAll('export ', '');
}
const activationSource = extract(runtimeSource,
    'export async function activateCharacterForChat(', '////////// OPTIMZED MAIN API');
const waitSource = extract(utilsSource,
    'export async function waitUntilCondition(', 'export function uuidv4(');

// Only the clock/environment are synthetic. The wait condition, interval,
// timeout rejection and activation/binder control flow execute real code.
function createClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    const registrations = [];
    const flush = async () => {
        // Drain the read/preparation/apply Promise chain without advancing
        // the synthetic save clock or weakening its timer boundary checks.
        for (let i = 0; i < 50; i++) await Promise.resolve();
    };
    const register = (callback, delay, repeating) => {
        const id = nextId++;
        const milliseconds = Math.max(1, Number(delay) || 0);
        timers.set(id, { id, callback, due: now + milliseconds, interval: repeating ? milliseconds : 0 });
        registrations.push({ id, delay: milliseconds, repeating });
        return id;
    };
    const nextTimer = () => [...timers.values()].sort((a, b) => a.due - b.due || a.id - b.id)[0];
    const advance = async milliseconds => {
        const end = now + milliseconds;
        await flush();
        for (let safety = 0; safety < 1000; safety++) {
            const timer = nextTimer();
            if (!timer || timer.due > end) {
                now = end;
                await flush();
                return;
            }
            now = timer.due;
            if (timer.interval) timer.due += timer.interval;
            else timers.delete(timer.id);
            timer.callback();
            await flush();
        }
        throw new Error('Synthetic clock did not settle');
    };
    const until = async predicate => {
        for (let i = 0; i < 100; i++) {
            await flush();
            if (predicate()) return;
            const timer = nextTimer();
            assert.ok(timer, 'Expected a genuine wait timer before the next operation');
            await advance(timer.due - now);
        }
        throw new Error('Expected condition never occurred');
    };
    return {
        setTimeout: (callback, delay) => register(callback, delay, false),
        setInterval: (callback, delay) => register(callback, delay, true),
        clearTimeout: id => timers.delete(id),
        clearInterval: id => timers.delete(id),
        registrations, timers, advance, until, flush,
        get now() { return now; },
    };
}

function fixture(options = {}) {
    const calls = [];
    const waitCalls = [];
    const clock = createClock();
    const requestHeaders = { 'X-Test-CSRF': 'synthetic-only' };
    const scope = {
        characters: [
            { name: 'Old', avatar: 'old.png', chat: 'Old-chat' },
            { name: 'New', avatar: 'new.png', chat: 'Other-chat' },
        ],
        this_chid: '0', name2: 'Old', chat_metadata: { integrity: 'old-integrity' },
        is_send_press: false, selected_group: null, is_group_generating: false,
        isChatSaving: options.initialSaving === true,
        this_edit_mes_id: 2, selected_button: 'character_edit',
        debounce_timeout: { extended: 50 },
        setTimeout: clock.setTimeout, setInterval: clock.setInterval,
        clearTimeout: clock.clearTimeout, clearInterval: clock.clearInterval,
        unshallowCharacter: async id => {
            calls.push(['unshallow', id]);
            await options.onUnshallow?.(scope, calls);
        },
        clearChat: async config => {
            // Match the old-identity capture/await boundary of real clearChat.
            const oldId = scope.getCurrentChatId();
            calls.push(['clear', scope.this_chid, oldId, { ...config }]);
            if (config.preserveItemizedPrompts) calls.push(['save-prompts', oldId]);
            await options.onClear?.(scope, calls);
        },
        cancelTtsPlay: () => calls.push(['tts']),
        resetSelectedGroup: () => { scope.selected_group = null; calls.push(['group-reset']); },
        setCharacterId: id => { scope.this_chid = String(id); calls.push(['character', String(id)]); },
        setCharacterName: name => { scope.name2 = name; },
        uuidv4: () => 'fresh-integrity',
        $: selector => ({ val(value) { calls.push(['control', selector, value]); } }),
        getRequestHeaders: () => requestHeaders,
        getCurrentChatId: () => scope.characters[scope.this_chid]?.chat,
        loadItemizedPrompts: async id => {
            calls.push(['load-prompts', id]);
        },
        prepareItemizedPrompts: chatId => {
            calls.push(['read-prompts', chatId]);
            return { chatId, pending: Promise.resolve().then(() => options.onLoadPrompts?.(chatId)) };
        },
        applyPreparedItemizedPrompts: async preparation => scope.loadItemizedPrompts(preparation.chatId),
        fetch: async (url, config) => {
            calls.push(['request', url, JSON.parse(config.body), config]);
            return {
                ok: options.headerOk !== false,
                json: async () => {
                    await options.onHeader?.();
                    return options.header || { chat_metadata: {
                        integrity: 'existing-integrity', card_state: { enabled: true },
                    } };
                },
            };
        },
        eventSource: { emit: () => { throw new Error('Activation must not emit provisional chat lifecycle events'); } },
        select_selected_character: () => { throw new Error('Activation must not bind the hidden editor'); },
        getChat: () => { throw new Error('Activation must not load provisional mirror messages'); },
        saveSettingsDebounced: () => { throw new Error('Activation must not save hidden editor settings'); },
        toastr: { info() {} },
    };
    vm.createContext(scope);
    vm.runInContext(`${waitSource}\n${activationSource}`, scope);
    const realWaitUntilCondition = scope.waitUntilCondition;
    scope.waitUntilCondition = (...args) => {
        waitCalls.push({ saving: scope.isChatSaving, characterId: scope.this_chid, chatId: scope.getCurrentChatId() });
        return realWaitUntilCondition(...args);
    };
    const start = operation => {
        const work = { settled: false, rejected: false, value: undefined };
        Promise.resolve().then(operation).then(value => {
            work.settled = true;
            work.value = value;
        }, error => {
            work.settled = true;
            work.rejected = true;
            work.value = error;
        });
        return work;
    };
    const finish = async work => {
        await clock.until(() => work.settled);
        assert.equal(clock.timers.size, 0, 'Real wait clears both interval and timeout');
        if (work.rejected) throw work.value;
        return work.value;
    };
    return { scope, calls, waitCalls, clock, requestHeaders, start, finish };
}

const callsOf = (h, name) => h.calls.filter(call => call[0] === name);
const activate = h => h.start(() => h.scope.activateCharacterForChat(1, { chatName: 'Homer-target' }));

function assertNormalBinding(h) {
    assert.equal(h.scope.this_chid, '1');
    assert.equal(h.scope.name2, 'New');
    assert.equal(h.scope.getCurrentChatId(), 'Homer-target');
    assert.equal(h.scope.chat_metadata.integrity, 'existing-integrity');
    assert.equal(h.scope.chat_metadata.card_state.enabled, true);
    assert.equal(h.scope.this_edit_mes_id, undefined);
    assert.deepEqual(callsOf(h, 'save-prompts'), [['save-prompts', 'Old-chat']]);
    assert.equal(callsOf(h, 'clear').length, 1);
    assert.deepEqual(callsOf(h, 'clear')[0].slice(1), [
        '0', 'Old-chat', { clearData: true, preserveItemizedPrompts: true },
    ]);
    const [request] = callsOf(h, 'request');
    assert.deepEqual(request.slice(1, 3), ['/api/chats/get', {
        avatar_url: 'new.png', file_name: 'Homer-target', metadata_only: true,
    }]);
    assert.equal(request[3].headers, h.requestHeaders);
    assert.equal(request[3].cache, 'no-cache');
    assert.deepEqual(callsOf(h, 'load-prompts'), [['load-prompts', 'Homer-target']]);
}

test('idle cross-card activation binds normally with zero save waits or timer registrations', async () => {
    const h = fixture();
    const result = await h.finish(activate(h));
    assert.equal(result.characterId, '1');
    assert.equal(result.chatId, 'Homer-target');
    assertNormalBinding(h);
    assert.equal(h.waitCalls.length, 0, 'Already-idle save predicates must not enter interval waits');
    assert.equal(h.clock.registrations.length, 0);
    assert.equal(h.clock.now, 0);
});

test('idle direct binder preserves mirror identity and prompt reads without a timer wait', async () => {
    const h = fixture();
    const work = h.start(() => h.scope.bindCharacterChatWithoutLoad('Homer-same-card'));
    await h.finish(work);
    assert.equal(h.scope.this_chid, '0');
    assert.equal(h.scope.chat_metadata.integrity, 'existing-integrity');
    assert.deepEqual(callsOf(h, 'save-prompts'), [['save-prompts', 'Old-chat']]);
    assert.deepEqual(callsOf(h, 'load-prompts'), [['load-prompts', 'Homer-same-card']]);
    assert.equal(callsOf(h, 'clear').length, 1);
    assert.equal(h.waitCalls.length, 0, 'Same-card idle binder must not install a save interval');
    assert.equal(h.clock.registrations.length, 0);
});

test('idle ephemeral activation keeps preview storage isolated and installs no save wait', async () => {
    const h = fixture();
    await h.finish(h.start(() => h.scope.activateCharacterForChat(1, { chatName: 'Preview', ephemeral: true })));
    assert.equal(h.scope.getCurrentChatId(), 'Preview');
    assert.equal(h.scope.chat_metadata.integrity, 'fresh-integrity');
    assert.equal(callsOf(h, 'clear').length, 1);
    assert.equal(callsOf(h, 'clear')[0][3].preserveItemizedPrompts, false);
    for (const name of ['save-prompts', 'request', 'load-prompts']) assert.equal(callsOf(h, name).length, 0);
    assert.equal(h.waitCalls.length, 0, 'Ephemeral storage policy does not require an idle timer');
    assert.equal(h.clock.registrations.length, 0);
});

const busyPoints = [
    { name: 'before unshallow', options: { initialSaving: true }, characterId: '0', clearCount: 0, unshallowCount: 0 },
    { name: 'after unshallow starts a save', options: { onUnshallow: async scope => {
        await Promise.resolve();
        scope.isChatSaving = true;
    } }, characterId: '0', clearCount: 0, unshallowCount: 1 },
    { name: 'after clear starts a save, before binder', options: { onClear: async scope => {
        await Promise.resolve();
        scope.isChatSaving = true;
    } }, characterId: '1', clearCount: 1, unshallowCount: 1 },
];

function assertBlockedAt(h, point, work) {
    assert.equal(work.settled, false);
    assert.equal(h.scope.this_chid, point.characterId);
    assert.equal(callsOf(h, 'clear').length, point.clearCount);
    assert.equal(callsOf(h, 'unshallow').length, point.unshallowCount);
    const preparedReadCount = point.clearCount ? 1 : 0;
    assert.equal(callsOf(h, 'request').length, preparedReadCount, 'Only the already authorized read may overlap an old clear/save');
    assert.equal(callsOf(h, 'load-prompts').length, 0, 'Do not replace old prompts while the save is active');
    assert.equal(h.scope.characters[1].chat, 'Other-chat');
}

for (const point of busyPoints) {
    test(`${point.name}: the actual wait remains blocked through repeated intervals and resumes after saving`, async () => {
        const h = fixture(point.options);
        const work = activate(h);
        await h.clock.until(() => h.waitCalls.some(call => call.saving));
        assertBlockedAt(h, point, work);
        await h.clock.advance(20);
        assertBlockedAt(h, point, work);
        h.scope.isChatSaving = false;
        await h.finish(work);
        assertNormalBinding(h);
        assert.equal(h.waitCalls.filter(call => call.saving).length, 1);
    });

    test(`${point.name}: the actual timeout rejects without crossing the blocked save boundary`, async () => {
        const h = fixture(point.options);
        const work = activate(h);
        await h.clock.until(() => h.waitCalls.some(call => call.saving));
        assertBlockedAt(h, point, work);
        await h.clock.advance(49);
        assertBlockedAt(h, point, work);
        await h.clock.advance(1);
        await assert.rejects(h.finish(work), /Timed out waiting for condition to be true/);
        assert.equal(h.scope.this_chid, point.characterId);
        assert.equal(callsOf(h, 'clear').length, point.clearCount);
        assert.equal(callsOf(h, 'request').length, point.clearCount ? 1 : 0);
        assert.equal(callsOf(h, 'load-prompts').length, 0);
    });
}

test('a second save starting after the first wait recovers is caught after unshallow', async () => {
    const h = fixture({ initialSaving: true, onUnshallow: async scope => { scope.isChatSaving = true; } });
    const work = activate(h);
    await h.clock.until(() => h.waitCalls.filter(call => call.saving).length === 1);
    h.scope.isChatSaving = false;
    await h.clock.until(() => h.waitCalls.filter(call => call.saving).length === 2);
    assert.equal(callsOf(h, 'unshallow').length, 1);
    assert.equal(callsOf(h, 'clear').length, 0);
    await h.clock.advance(20);
    assert.equal(callsOf(h, 'clear').length, 0);
    h.scope.isChatSaving = false;
    await h.finish(work);
    assertNormalBinding(h);
});

for (const first of ['header', 'prompts']) {
    test(`mirror reads overlap and both gate activation when ${first} finishes first`, async () => {
        let releaseHeader, releasePrompts;
        const headerPending = new Promise(resolve => { releaseHeader = resolve; });
        const promptsPending = new Promise(resolve => { releasePrompts = resolve; });
        const h = fixture({ onHeader: () => headerPending, onLoadPrompts: () => promptsPending });
        const work = activate(h);
        await h.clock.until(() => callsOf(h, 'request').length === 1 && callsOf(h, 'read-prompts').length === 1);
        assert.equal(work.settled, false);
        (first === 'header' ? releaseHeader : releasePrompts)();
        await h.clock.flush();
        assert.equal(work.settled, false, `${first} completion cannot skip the other required mirror read`);
        assert.equal(callsOf(h, 'load-prompts').length, 0, 'Loaded events are not emitted by preparation');
        (first === 'header' ? releasePrompts : releaseHeader)();
        await h.finish(work);
        assertNormalBinding(h);
    });
}

test('mirror failures still reject instead of manufacturing a usable integrity identity', async () => {
    const h = fixture({ headerOk: false });
    await assert.rejects(h.finish(activate(h)), /存档标识/);
    assert.equal(callsOf(h, 'clear').length, 1);
    assert.equal(h.scope.chat_metadata.integrity, 'old-integrity', 'A failed read cannot publish a provisional target identity');
    assert.equal(callsOf(h, 'request').length, 1);
});

test('legacy full-array mirror responses keep their existing header integrity', async () => {
    const h = fixture({ header: [{ chat_metadata: { integrity: 'legacy-integrity', preserved: true } }, { mes: 'ignored mirror message' }] });
    await h.finish(activate(h));
    assert.equal(h.scope.chat_metadata.integrity, 'legacy-integrity');
    assert.equal(h.scope.chat_metadata.preserved, true);
    assert.equal(callsOf(h, 'load-prompts').length, 1);
});

test('unshallow replacement is re-read before binding its avatar and character name', async () => {
    const h = fixture({ onUnshallow: async scope => {
        scope.characters[1] = { name: 'Full', avatar: 'full.png', chat: 'Other-chat' };
    } });
    h.scope.characters[1].shallow = true;
    await h.finish(activate(h));
    assert.equal(h.scope.name2, 'Full');
    assert.equal(callsOf(h, 'request')[0][2].avatar_url, 'full.png');
});

test('incomplete unshallow and generation starting during its await still reject before old chat clearing', async () => {
    const incomplete = fixture();
    incomplete.scope.characters[1].shallow = true;
    await assert.rejects(incomplete.finish(activate(incomplete)), /完整读取/);
    assert.equal(callsOf(incomplete, 'clear').length, 0);
    assert.equal(incomplete.scope.this_chid, '0');
    const generating = fixture({ onUnshallow: async scope => { scope.is_send_press = true; } });
    await assert.rejects(generating.finish(activate(generating)), /正在生成/);
    assert.equal(callsOf(generating, 'clear').length, 0);
    assert.equal(generating.scope.this_chid, '0');
});

test('invalid identity/name and active direct/group generation reject before any wait or side effect', async () => {
    for (const configure of [
        h => ({ id: 99, name: 'Target' }),
        h => ({ id: '1.5', name: 'Target' }),
        h => ({ id: 1, name: ' ' }),
        h => { h.scope.is_send_press = true; return { id: 1, name: 'Target' }; },
        h => { h.scope.selected_group = 'synthetic-group'; h.scope.is_group_generating = true; return { id: 1, name: 'Target' }; },
    ]) {
        const h = fixture();
        const { id, name } = configure(h);
        await assert.rejects(h.finish(h.start(() => h.scope.activateCharacterForChat(id, { chatName: name }))), /角色不存在|标识无效|正在生成/);
        assert.equal(h.calls.length, 0);
        assert.equal(h.waitCalls.length, 0);
        assert.equal(h.clock.registrations.length, 0);
        assert.equal(h.scope.this_chid, '0');
        assert.equal(h.scope.chat_metadata.integrity, 'old-integrity');
    }
});
