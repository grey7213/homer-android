import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/system-messages.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function initSystemMessages()');
const end = source.indexOf('\n/**', start);
const implementation = source.slice(start, end).replace('export async function', 'async function');

function fixture() {
    const pending = new Map();
    const calls = [];
    const system_messages = { existing: { mes: 'unchanged until initialized' } };
    const SAFETY_CHAT = [];
    const context = {
        system_messages, SAFETY_CHAT, structuredClone,
        systemUserName: 'System', system_avatar: 'system.png', displayVersion: 'test-runtime',
        lodash: { merge: (base, next) => Object.assign(base, next) },
        t: strings => strings.join(''), getMessageTimeStamp: () => 'test-time',
        renderTemplateAsync: (name, data) => {
            calls.push({ name, data });
            return new Promise((resolve, reject) => pending.set(name, { resolve, reject }));
        },
    };
    vm.createContext(context);
    vm.runInContext(implementation, context);
    return { ...context, calls, pending, run: () => context.initSystemMessages() };
}

test('system templates start together but no partially initialized message map is published', async () => {
    const f = fixture();
    const running = f.run();
    assert.deepEqual(f.calls.map(x => x.name), ['help', 'hotkeys', 'formatting', 'welcome', 'welcomePrompt', 'assistantNote']);
    assert.equal(f.calls.find(x => x.name === 'welcome').data.displayVersion, 'test-runtime');
    f.pending.get('assistantNote').resolve('note');
    f.pending.get('welcome').resolve('welcome');
    await Promise.resolve();
    assert.deepEqual(Object.keys(f.system_messages), ['existing']);
    assert.equal(f.SAFETY_CHAT.length, 0);
    for (const [name, promise] of f.pending) promise.resolve(name);
    await running;
    assert.equal(f.system_messages.help.mes, 'help');
    assert.equal(f.system_messages.hotkeys.mes, 'hotkeys');
    assert.equal(f.system_messages.formatting.mes, 'formatting');
    assert.equal(f.system_messages.welcome.mes, 'welcome');
    assert.equal(f.system_messages.welcome_prompt.mes, 'welcomePrompt');
    assert.equal(f.system_messages.assistant_note.mes, 'note');
    assert.equal(f.system_messages.help.is_system, true);
    assert.equal(f.system_messages.help.extra.swipeable, false);
    assert.equal(f.system_messages.welcome_prompt.extra.isSmallSys, true);
    assert.equal(f.SAFETY_CHAT.length, 1);
});

test('a renderer-handled failure retains the existing undefined result contract', async () => {
    const f = fixture();
    const running = f.run();
    for (const [name, promise] of f.pending) promise.resolve(name === 'help' ? undefined : name);
    await running;
    assert.equal(f.system_messages.help.mes, undefined);
    assert.equal(f.system_messages.welcome.mes, 'welcome');
    assert.equal(f.SAFETY_CHAT.length, 1);
});

test('unexpected renderer rejection does not publish partially ready system messages', async () => {
    const f = fixture();
    const running = f.run();
    f.pending.get('help').reject(new Error('synthetic renderer failure'));
    for (const [name, promise] of f.pending) if (name !== 'help') promise.resolve(name);
    await assert.rejects(running, /synthetic renderer failure/);
    assert.deepEqual(Object.keys(f.system_messages), ['existing']);
    assert.equal(f.SAFETY_CHAT.length, 0);
});
