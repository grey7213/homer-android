import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const section = (start, end) => {
    const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `Product function boundary missing: ${start}`);
    return source.slice(first, last);
};
const code = [section('async function refreshBridgeToken()', 'function installTokenRefresh()'),
    section('async function runAction(', 'function setDrawerOpen(')].join('\n');

function fixture({ token = '', read = async () => { throw new Error('Synthetic offline connection'); } } = {}) {
    const chat = Array.from({ length: 5 }, (_, index) => ({ mes: `complete-phone-turn-${index}`,
        extra: { homer_prompt_state: { variables: { turn: index } } } }));
    const calls = { token: [], generation: [], truncation: [], logs: [], notices: [], order: [], configuration: 0, streaming: 0, scope: 0, sync: 0 };
    const busy = new Set();
    const chatContext = { chat, async generate(...args) { calls.order.push('generate'); calls.generation.push(copy(args)); } };
    const launch = { app_id: 'synthetic-app', conversation_id: 'synthetic-conversation', local_session: true,
        bridge_token: token, card: { data: { name: 'Complete local card' } },
        storage: { protocol: 2, complete: true, version: 'a'.repeat(32), message_count: 5 } };
    const h = {
        MODULE_ID: 'generation-guard-test', console: { warn() {}, error() {} }, launch,
        session: { user: { id: 'synthetic-owner' }, runtime: { prior: true } }, adminBinding: false, loadingLaunch: false,
        generationBusy: false, activeGameTurn: null, generationSettleTimer: 12, dialogueEventLogMuted: 0,
        getContext: () => ({ ...chatContext }),
        messageMenuTargetForIndex: index => ({ messageIndex: index }),
        resolveMessageMenuTarget: target => chat[target?.messageIndex]
            ? { messageIndex: target.messageIndex, message: chat[target.messageIndex] } : null,
        fetchSession: async (...args) => { calls.order.push('token'); calls.token.push(args); return read(h, args); },
        applyConnectionConfiguration: () => { calls.configuration++; }, updateRuntimeStatus() {},
        assertCanonicalConversationScope: () => { calls.scope++; },
        truncateAfterMessage: async (target, label) => {
            calls.order.push('truncate'); calls.truncation.push({ index: target.messageIndex, label });
            chat.splice(target.messageIndex + 1); return true;
        },
        enforceStreamingConfiguration: () => { calls.streaming++; },
        logDialogueEvent: async (...args) => { calls.logs.push(copy(args)); },
        showHostNotice: (text, level) => { calls.notices.push({ text, level }); },
        document: { body: { classList: { add: key => busy.add(key), remove: key => busy.delete(key) } } },
        window: { clearTimeout() {} }, scheduleSync: () => { calls.sync++; }, queueMessageMenuRender() {},
    };
    vm.createContext(h); vm.runInContext(code, h);
    return { h, calls, chat, busy };
}

for (const type of ['continue', 'regenerate', 'next']) {
    test(`${type} cannot truncate or generate from a tokenless offline phone archive`, async () => {
        const f = fixture(), original = copy(f.chat), card = copy(f.h.launch.card), storage = copy(f.h.launch.storage);
        await f.h.runAction(type, { messageIndex: 1 });
        assert.deepEqual(f.chat, original);
        assert.deepEqual(f.h.launch.card, card);
        assert.deepEqual(f.h.launch.storage, storage);
        assert.equal(f.calls.token.length, 1);
        assert.deepEqual(copy(f.calls.token[0]), ['synthetic-app', 'synthetic-conversation', false, 0, { forceNetwork: true }]);
        assert.equal(f.calls.truncation.length, 0);
        assert.equal(f.calls.generation.length, 0);
        assert.equal(f.calls.logs.length, 0);
        assert.equal(f.calls.streaming, 0);
        assert.equal(f.calls.configuration, 0);
        assert.equal(f.calls.scope, 1);
        assert.equal(f.calls.notices.at(-1).level, 'warning');
        assert.match(f.calls.notices.at(-1).text, /生成回复需要联网/);
        assert.equal(f.h.generationBusy, false);
        assert.equal(f.h.dialogueEventLogMuted, 0);
        assert.equal(f.h.generationSettleTimer, null);
        assert.equal(f.busy.size, 0);
        // Existing captured storage retry scheduling remains independent of
        // generation; it must not be confused with a provider/model replay.
        assert.equal(f.calls.sync, 1);
    });
}

test('a tokenless successful session response cannot fabricate permission to generate or truncate', async () => {
    const f = fixture({ read: async () => ({ user: { id: 'synthetic-owner' }, launch: { messages: [] } }) });
    const original = copy(f.chat);
    await f.h.runAction('regenerate', { messageIndex: 1 });
    assert.deepEqual(f.chat, original);
    assert.equal(f.calls.token.length, 1);
    assert.equal(f.calls.generation.length, 0);
    assert.equal(f.calls.truncation.length, 0);
    assert.equal(f.calls.notices.at(-1).level, 'warning');
});

test('normal tokenless generation without a message target also stays offline and preserves the complete phone history', async () => {
    const f = fixture(), original = copy(f.chat);
    await f.h.runAction('normal');
    assert.deepEqual(f.chat, original);
    assert.equal(f.calls.token.length, 1);
    assert.equal(f.calls.generation.length, 0);
    assert.equal(f.calls.truncation.length, 0);
    assert.equal(f.calls.notices.at(-1).level, 'warning');
});

test('a current-scope token refresh precedes truncation and performs exactly one authorized generation', async () => {
    const f = fixture({ read: async () => ({ user: { id: 'synthetic-owner' }, runtime: { refreshed: true },
        launch: { bridge_token: 'synthetic-refreshed-token', bridge_token_ttl_seconds: 900,
            card: { name: 'Must not replace phone card' }, messages: [{ content: 'Must not replace phone history' }],
            storage: { protocol: 2, complete: true, version: 'b'.repeat(32), message_count: 1 } } }) });
    const original = copy(f.chat), card = copy(f.h.launch.card), storage = copy(f.h.launch.storage);
    await f.h.runAction('regenerate', { messageIndex: 1 });
    assert.deepEqual(f.calls.order, ['token', 'truncate', 'generate']);
    assert.deepEqual(f.calls.generation, [['regenerate']]);
    assert.deepEqual(f.chat, original.slice(0, 2));
    assert.deepEqual(f.h.launch.card, card);
    assert.deepEqual(f.h.launch.storage, storage);
    assert.equal(f.calls.configuration, 1);
    assert.equal(f.calls.scope, 2);
    assert.equal(f.calls.streaming, 1);
    assert.equal(f.calls.logs.length, 1);
    assert.equal(f.calls.notices.length, 0);
    assert.equal(f.h.generationBusy, false);
    assert.equal(f.h.dialogueEventLogMuted, 0);
    assert.equal(f.busy.size, 0);
});

test('a phone archive with an already live token does not refresh again before its one generation', async () => {
    const f = fixture({ token: 'synthetic-live-token' });
    await f.h.runAction('next', { messageIndex: 1 });
    assert.equal(f.calls.token.length, 0);
    assert.equal(f.calls.scope, 1);
    assert.deepEqual(f.calls.order, ['truncate', 'generate']);
    assert.equal(f.calls.generation.length, 1);
    assert.equal(f.calls.generation[0][0], 'normal');
    assert.equal(f.calls.generation[0][1].quietToLoud, true);
    assert.equal(f.calls.logs[0][0], 'continue_next');
});

test('an old token refresh cannot truncate or generate after the active launch changes, even when the new launch has a token', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ read: async () => { await gate; return { user: { id: 'synthetic-owner' },
        launch: { bridge_token: 'synthetic-old-launch-token' } }; } });
    const original = copy(f.chat), originalLaunch = f.h.launch;
    const generation = f.h.runAction('regenerate', { messageIndex: 1 });
    assert.equal(f.calls.token.length, 1);
    f.h.launch = { app_id: 'other-app', conversation_id: 'other-conversation', bridge_token: 'synthetic-current-token' };
    release(); await generation;
    assert.deepEqual(f.chat, original);
    assert.equal(originalLaunch.bridge_token, '');
    assert.equal(f.h.launch.bridge_token, 'synthetic-current-token');
    assert.equal(f.calls.configuration, 0);
    assert.equal(f.calls.truncation.length, 0);
    assert.equal(f.calls.generation.length, 0);
    assert.equal(f.calls.logs.length, 0);
    assert.equal(f.calls.notices.at(-1).level, 'warning');
    assert.equal(f.h.generationBusy, false);
    assert.equal(f.busy.size, 0);
});

test('the existing generation-busy guard never refreshes or replays another model request', async () => {
    const f = fixture(), original = copy(f.chat);
    f.h.generationBusy = true;
    await f.h.runAction('regenerate', { messageIndex: 1 });
    assert.deepEqual(f.chat, original);
    assert.equal(f.calls.token.length, 0);
    assert.equal(f.calls.truncation.length, 0);
    assert.equal(f.calls.generation.length, 0);
    assert.equal(f.calls.sync, 0);
    assert.equal(f.calls.notices.length, 0);
});

test('an existing token cannot bypass a failed canonical scope check before destructive generation truncation', async () => {
    const f = fixture({ token: 'synthetic-stale-token' }), original = copy(f.chat);
    f.h.assertCanonicalConversationScope = () => { throw new Error('Synthetic canonical scope mismatch'); };
    await f.h.runAction('regenerate', { messageIndex: 1 });
    assert.deepEqual(f.chat, original);
    assert.equal(f.calls.token.length, 0);
    assert.equal(f.calls.truncation.length, 0);
    assert.equal(f.calls.generation.length, 0);
    assert.equal(f.calls.logs.length, 0);
    assert.equal(f.calls.streaming, 0);
    assert.equal(f.calls.notices.at(-1).level, 'error');
    assert.match(f.calls.notices.at(-1).text, /canonical scope mismatch/);
    assert.equal(f.h.generationBusy, false);
    assert.equal(f.busy.size, 0);
});
