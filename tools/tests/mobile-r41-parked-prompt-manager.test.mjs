import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

// Optional historical RED replay reads the real pre-change shipping Git blob
// into memory. It never rewrites the working product or substitutes render.
const source = process.env.HOMER_PM_BASELINE === '1'
    ? execFileSync('git', ['cat-file', 'blob', '20219dc45ffa232ef61ebbfac0836241f168a55a'], {
        cwd: new URL('../../.web-cache/tree/', import.meta.url), encoding: 'utf8',
    })
    : readFileSync(new URL('../../sillytavern-runtime/public/scripts/PromptManager.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const acorn = require('../../sillytavern-runtime/node_modules/acorn');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const declaration = ast.body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'PromptManager');
assert.ok(declaration, 'execute the complete actual shipping class, including private state');
const classSource = source.slice(declaration.start, declaration.end);
const init = declaration.body.body.find(method => method.key.name === 'init');
const eventStatements = init.value.body.body.filter(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression' && node.expression.callee.type === 'MemberExpression'
    && node.expression.callee.object.name === 'eventSource' && node.expression.callee.property.name === 'on');
const eventSourceCode = eventStatements.map(node => source.slice(node.start, node.end)).join('\n');

const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// A deterministic DOM/observer seam, not a browser, benchmark or timed poll.
// The real class/render/event callbacks run; only its external UI leaves and
// service dependencies are recorded so no generation/network can occur.
function harness({ parked = true, hidden = true, inert = true, busy = false, deferGeneration = false } = {}) {
    const calls = [], observers = [], waits = [], callbacks = new Map();
    const root = {}, parking = { hidden, inert }, outside = {};
    let owner = parked ? parking : null;
    const container = {
        isConnected: true, ownerDocument: null,
        closest(selector) { assert.equal(selector, '.homer-internal-parking'); return owner; },
        getRootNode() { return document; },
        getBoundingClientRect() { throw Error('parking guard must not read layout'); },
        get offsetHeight() { throw Error('parking guard must not read layout'); },
        get offsetWidth() { throw Error('parking guard must not read layout'); },
        getClientRects() { throw Error('parking guard must not read layout'); },
    };
    const scroller = { get scrollTop() { calls.push(['scroll-read']); return 17; }, scrollTo(x, y) { calls.push(['scroll', x, y]); } };
    const document = { documentElement: root, body: root, getElementById: () => ({ closest: () => scroller }) };
    container.ownerDocument = document;
    class MutationObserver {
        constructor(callback) { this.callback = callback; this.active = false; this.observed = []; this.disconnects = 0; observers.push(this); }
        observe(node, options) { this.active = true; this.observed.push({ node, options }); }
        disconnect() { this.active = false; this.disconnects++; }
        takeRecords() { return []; }
    }
    const pendingGeneration = deferred();
    const scope = vm.createContext({ document, MutationObserver, Promise, queueMicrotask,
        main_api: 'openai', is_send_press: busy, is_group_generating: false,
        console: { log() {}, warn() {}, error() {} },
        debounce_timeout: { relaxed: 1 },
        debounce(fn) {
            let args = null;
            const wrapper = (...next) => { args = next; calls.push(['debounced', ...next]); };
            wrapper.flush = () => { if (args) { const next = args; args = null; return fn(...next); } };
            return wrapper;
        },
        waitUntilCondition(predicate, timeout, interval) {
            calls.push(['wait', timeout, interval]);
            if (predicate()) return Promise.resolve();
            const item = deferred(); waits.push({ ...item, predicate }); return item.promise;
        },
        getComputedStyle() { throw Error('parking guard must not read computed style'); },
        event_types: new Proxy({}, { get: (_target, name) => name }),
        eventSource: { on: (event, callback) => callbacks.set(event, callback) },
        t: strings => strings.join(''),
    });
    vm.runInContext(`${classSource}\nglobalThis.Manager = PromptManager;`, scope);
    const manager = new scope.Manager();
    manager.containerElement = container;
    manager.activeCharacter = { id: 'synthetic-a' };
    manager.configuration.promptOrder.strategy = 'character';
    manager.getPromptOrderForCharacter = () => [{ identifier: 'main', enabled: true }];
    manager.profileStart = label => calls.push(['profile-start', label]);
    manager.profileEnd = label => calls.push(['profile-end', label]);
    manager.tryGenerate = () => { calls.push(['generate', manager.activeCharacter?.id]); return deferGeneration ? pendingGeneration.promise : Promise.resolve(); };
    manager.renderPromptManager = async () => { calls.push(['draw', manager.activeCharacter?.id]); };
    manager.renderPromptManagerListItems = async () => { calls.push(['items', manager.activeCharacter?.id]); };
    manager.makeDraggable = () => calls.push(['drag']);
    manager.saveServiceSettings = () => { calls.push(['save', manager.activeCharacter?.id]); return Promise.resolve(); };
    manager.log = () => {};
    vm.runInContext(`globalThis.registerShippingEvents = function () { ${eventSourceCode} };`, scope);
    scope.registerShippingEvents.call(manager);
    return { manager, scope, calls, observers, parking, container, root, waits, callbacks,
        count: kind => calls.filter(call => call[0] === kind).length,
        moveOut() { owner = null; },
        moveTo(next) { owner = next; },
        async notify(target = parking) {
            for (const observer of [...observers]) {
                if (observer.active && observer.observed.some(item => item.node === target)) {
                    observer.callback([{ type: 'childList', target }], observer);
                }
            }
            await microtasks();
        },
        async releaseWait() { scope.is_send_press = scope.is_group_generating = false; for (const item of waits.splice(0)) { assert.equal(item.predicate(), true); item.resolve(); } await microtasks(); },
        async completeGeneration() { pendingGeneration.resolve(); await microtasks(); },
    };
}

test('automatic parked render coalesces dirty flags with one observer and no dry run, drawing, wait or layout', async () => {
    const h = harness();
    h.manager.render(false, false); h.manager.render(true, false); h.manager.render(false, false);
    await microtasks();
    for (const kind of ['generate', 'draw', 'items', 'drag', 'wait', 'scroll-read']) assert.equal(h.count(kind), 0, kind);
    assert.equal(h.observers.length, 1);
    const observed = h.observers[0].observed;
    assert.ok(observed.some(item => item.options.attributes && item.options.attributeFilter.includes('hidden') && item.options.attributeFilter.includes('inert')));
    assert.ok(observed.some(item => item.options.childList && item.options.subtree));
    await h.notify(); assert.equal(h.count('generate'), 0, 'irrelevant mutation while still parked is not an activation');
    h.manager.activeCharacter = { id: 'synthetic-b' };
    h.moveOut(); await h.notify();
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 1);
    assert.ok(h.calls.some(call => call[0] === 'generate' && call[1] === 'synthetic-b'));
    assert.equal(h.observers[0].active, false);
    await h.notify(); assert.equal(h.count('generate'), 1, 'proof consumed once');
});

test('display-only false flags remain display-only after unpark and attribute changes resume automatically', async () => {
    for (const attribute of ['hidden', 'inert']) {
        const h = harness(); h.manager.render(false, false); h.manager.render(false, false); await microtasks();
        assert.equal(h.count('draw'), 0);
        h.parking[attribute] = false; await h.notify();
        assert.equal(h.count('generate'), 0); assert.equal(h.count('draw'), 1);
        assert.equal(h.observers[0].active, false);
    }
});

test('parking requires both strict physical properties; absent, partial, or merely truthy flags retain ordinary rendering', async () => {
    for (const options of [{ parked: false }, { hidden: false }, { inert: false }, { hidden: 'true' }, { inert: 'true' }]) {
        const h = harness(options); h.manager.render(true, false); await microtasks();
        assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 1);
        assert.equal(h.observers.length, 0);
    }
});

test('automatic request rechecks parking after send/group wait and does not generate until unpark', async () => {
    const h = harness({ parked: false, busy: true });
    h.manager.render(true, false); await microtasks();
    assert.equal(h.waits.length, 1); assert.equal(h.count('generate'), 0);
    h.moveTo(h.parking); await h.releaseWait();
    assert.equal(h.count('generate'), 0); assert.equal(h.observers.length, 1);
    h.moveOut(); await h.notify();
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 1);
});

test('already-started generation settles after repark, defers only drawing, then resumes without a duplicate dry run', async () => {
    const h = harness({ parked: false, deferGeneration: true });
    h.manager.render(true, false); await microtasks();
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 0);
    h.moveTo(h.parking); await h.completeGeneration();
    assert.equal(h.count('draw'), 0);
    assert.ok(h.calls.some(call => call[0] === 'profile-end' && call[1] === 'filling context'));
    h.moveOut(); await h.notify();
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 1);
});

test('explicit render and public one-argument debounce retain their original behavior even while physically parked', async () => {
    const h = harness();
    h.manager.render(); await microtasks();
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 1);
    h.manager.render(false); await microtasks();
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 2);
    h.manager.renderDebounced(); h.manager.renderDebounced.flush(); await microtasks();
    assert.equal(h.count('generate'), 2); assert.equal(h.count('draw'), 3);
    h.manager.renderDebounced(false); h.manager.renderDebounced.flush(); await microtasks();
    assert.equal(h.count('generate'), 2); assert.equal(h.count('draw'), 4);
    assert.equal(h.observers.length, 0);
});

test('explicit display-only rendering overrides pending automatic work without adding a dry run or late unpark render', async () => {
    const h = harness(); h.manager.render(true, false); await microtasks();
    assert.equal(h.count('generate'), 0);
    h.manager.render(false); await microtasks();
    assert.equal(h.count('generate'), 0, 'explicit /pm-render refresh=false keeps its display-only contract');
    assert.equal(h.count('draw'), 1); assert.equal(h.observers[0].active, false);
    h.moveOut(); await h.notify();
    assert.equal(h.count('generate'), 0); assert.equal(h.count('draw'), 1);
});

test('display-only completion after unpark supersedes undelivered dirty true without an extra generation, including send-wait recovery', async () => {
    for (const busy of [false, true]) {
        const h = harness({ busy });
        h.manager.render(true, false); await microtasks();
        assert.equal(h.count('generate'), 0); assert.equal(h.observers.length, 1);
        // The real generation's presentation refresh can arrive before the
        // unpark MutationObserver callback. Its false flag must stay false.
        h.moveOut(); h.manager.render(false, false); await microtasks();
        assert.equal(h.count('generate'), 0);
        assert.equal(h.count('draw'), busy ? 0 : 1);
        assert.equal(h.observers[0].active, false);
        await h.notify();
        if (busy) {
            assert.equal(h.waits.length, 1);
            await h.releaseWait();
        }
        assert.equal(h.count('generate'), 0); assert.equal(h.count('draw'), 1);
        await h.notify();
        assert.equal(h.count('generate'), 0); assert.equal(h.count('draw'), 1);
    }
});

test('moving between two owned parking nodes transfers observation before the new node is unparked', async () => {
    const h = harness(); h.manager.render(true, false); await microtasks();
    const nextParking = { hidden: true, inert: true };
    h.moveTo(nextParking); await h.notify(h.parking);
    assert.equal(h.count('generate'), 0);
    const active = h.observers.filter(observer => observer.active);
    assert.equal(active.length, 1);
    assert.ok(active[0].observed.some(item => item.node === nextParking));
    h.manager.activeCharacter = { id: 'synthetic-newest' };
    nextParking.inert = false; await h.notify(nextParking);
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 1);
    assert.ok(h.calls.some(call => call[0] === 'draw' && call[1] === 'synthetic-newest'));
    await h.notify(h.parking); await h.notify(nextParking);
    assert.equal(h.count('draw'), 1);
});

test('an old in-flight dry-run finally cannot downgrade a newer parked true request to display-only', async () => {
    const h = harness({ parked: false, deferGeneration: true });
    h.manager.render(true, false); await microtasks();
    assert.equal(h.count('generate'), 1);
    h.moveTo(h.parking); h.manager.activeCharacter = { id: 'synthetic-newer' };
    h.manager.render(true, false); await microtasks();
    await h.completeGeneration();
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 0);
    h.moveOut(); await h.notify();
    assert.equal(h.count('generate'), 2); assert.equal(h.count('draw'), 1);
    assert.equal(h.calls.filter(call => call[0] === 'generate').at(-1)[1], 'synthetic-newer');
});

test('actual CHAT_LOADED handler still selects the character and saves before deferring only automatic UI work', async () => {
    const h = harness();
    h.callbacks.get('CHAT_LOADED')({ detail: { id: 'synthetic-c', character: { name: 'Synthetic' } } });
    await microtasks();
    assert.equal(h.manager.activeCharacter.id, 'synthetic-c');
    assert.equal(h.count('save'), 1);
    assert.deepEqual(h.calls.find(call => call[0] === 'debounced'), ['debounced', undefined, false]);
    h.manager.renderDebounced.flush(); await microtasks();
    assert.equal(h.count('generate'), 0); assert.equal(h.count('draw'), 0);
    h.moveOut(); await h.notify();
    assert.equal(h.count('generate'), 1); assert.equal(h.count('draw'), 1);
});

test('actual automatic history/settings events defer but are still registered and retain pending true requests', async () => {
    for (const event of ['MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_RECEIVED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'WORLDINFO_SETTINGS_UPDATED']) {
        const h = harness(); assert.equal(typeof h.callbacks.get(event), 'function', event);
        h.callbacks.get(event)(); h.manager.renderDebounced.flush(); await microtasks();
        assert.equal(h.count('generate'), 0, event);
        h.moveOut(); await h.notify(); assert.equal(h.count('generate'), 1, event);
    }
});

test('real completion setter and token accounting are not suppressed by parking', () => {
    const h = harness(); let counts = {};
    h.manager.tokenHandler = { resetCounts() { counts = {}; }, getCounts: () => counts, getTotal: () => Object.values(counts).reduce((a, b) => a + b, 0) };
    const messages = { getCollection: () => [{ identifier: 'main', getTokens: () => 17 }, { identifier: 'chatHistory', getTokens: () => 23 }] };
    const overrides = ['main'];
    h.manager.setChatCompletion({ getMessages: () => messages, getOverriddenPrompts: () => overrides });
    assert.equal(h.manager.messages, messages); assert.equal(h.manager.overriddenPrompts, overrides);
    assert.equal(h.manager.tokenUsage, 40); assert.deepEqual(counts, { main: 17, chatHistory: 23 });
    assert.equal(h.observers.length, 0);
});

test('non-openai and no-active-character early exits remain unchanged', async () => {
    for (const configure of [h => { h.scope.main_api = 'textgenerationwebui'; }, h => { h.manager.activeCharacter = null; }]) {
        const h = harness(); configure(h); h.manager.render(true, false); await microtasks();
        assert.equal(h.count('generate'), 0); assert.equal(h.count('wait'), 0); assert.equal(h.observers.length, 0);
    }
});

test('actual OpenAI completion preparation still composes, accounts, squashes and publishes while only its hidden UI is deferred', async () => {
    const openai = readFileSync(new URL('../../sillytavern-runtime/public/scripts/openai.js', import.meta.url), 'utf8');
    const openaiAst = acorn.parse(openai, { ecmaVersion: 'latest', sourceType: 'module' });
    const preparation = openaiAst.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'prepareOpenAIMessages').declaration;
    for (const dryRun of [false, true]) {
        const h = harness(), actions = [], chat = [{ role: 'assistant', content: 'Synthetic fixture only' }];
        let counts = {};
        h.manager.serviceSettings = { openai_max_context: 8192, openai_max_tokens: 512 };
        h.manager.tokenHandler = { resetCounts() { counts = {}; }, getCounts: () => counts, getTotal: () => 17, counts };
        const messages = { getCollection: () => [{ identifier: 'main', getTokens: () => 17 }] };
        Object.assign(h.scope, {
            promptManager: h.manager, power_user: { console_log_prompts: false }, oai_settings: { squash_system_messages: true },
            ChatCompletion: class {
                setTokenBudget(...values) { actions.push(['budget', ...values]); }
                getMessages() { actions.push(['messages']); return messages; }
                getOverriddenPrompts() { return ['main']; }
                async squashSystemMessages() { actions.push(['squash']); }
                getChat() { return chat; }
            },
            preparePromptsForChatCompletion: async args => { actions.push(['prepare', args.name2]); return 'synthetic-prompts'; },
            populateChatCompletion: async (prompts, _completion, args) => { actions.push(['populate', prompts, args.type]); },
        });
        h.scope.eventSource.emit = async (name, detail) => { actions.push(['event', name, detail.dryRun]); assert.equal(detail.chat, chat); };
        vm.runInContext(openai.slice(preparation.start, preparation.end), h.scope);
        const result = await h.scope.prepareOpenAIMessages({ name2: 'Synthetic', type: 'normal' }, dryRun);
        await microtasks();
        assert.equal(result[0], chat);
        assert.equal(h.manager.messages, messages); assert.equal(h.manager.tokenUsage, 17);
        assert.deepEqual(actions, [
            ['budget', 8192, 512], ['prepare', 'Synthetic'], ['populate', 'synthetic-prompts', 'normal'],
            ['messages'], ...(!dryRun ? [['squash']] : []), ['event', 'CHAT_COMPLETION_PROMPT_READY', dryRun],
        ]);
        assert.equal(h.scope.openai_messages_count, 1);
        assert.equal(h.count('generate'), 0); assert.equal(h.count('draw'), 0);
        h.moveOut(); await h.notify();
        assert.equal(h.count('generate'), 0); assert.equal(h.count('draw'), dryRun ? 0 : 1);
    }
    const calls = [];
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
            && node.callee.object.name === 'promptManager' && node.callee.property.name === 'render') calls.push(node);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') walk(value);
        }
    }
    walk(openaiAst);
    assert.equal(calls.length, 3, 'both setup branches and real-generation completion keep their UI refresh');
    assert.deepEqual(calls.map(node => node.arguments.map(argument => argument.value)), [[false, false], [false, false], [false, false]]);
});
