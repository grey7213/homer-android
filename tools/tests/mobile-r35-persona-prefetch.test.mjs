import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/personas.js', import.meta.url), 'utf8');
const helperStart = source.indexOf('let personaAvatarPrefetch =');
const helperEnd = source.indexOf('/** @type {function(string): void} */', helperStart);
const scopeStart = source.indexOf('function homerGreetingScope(');
const scopeEnd = source.indexOf('\nasync function redrawHomerGreeting(', scopeStart);
const loadStart = source.indexOf('async function loadPersonaForCurrentChat(');
const loadEnd = source.indexOf('\n/**', loadStart);
assert.ok(helperStart > 0 && helperEnd > helperStart && scopeStart > 0 && scopeEnd > scopeStart && loadStart > 0 && loadEnd > loadStart);
const code = [source.slice(helperStart, helperEnd), source.slice(scopeStart, scopeEnd), source.slice(loadStart, loadEnd)].join('\n').replaceAll('export ', '');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture({ homer = true } = {}) {
    const requests = [], mutations = [], listeners = new Map();
    const context = {
        chat_metadata: homer ? { homer_bridge: { user_id: 'owner-one', app_id: 'app-one', conversation_id: 'chat-one', runtime: 'dialogue' }, persona: 'avatar-a' } : { persona: 'avatar-a' },
        characters: [{ data: { extensions: { homer_bridge: { app_id: 'app-one' } } } }],
        this_chid: 0, personaLastLoadedChatId: null, currentChatId: 'Homer-chat-one', user_avatar: 'avatar-a',
        getCurrentChatId: () => context.currentChatId,
        window: { addEventListener: (name, fn) => listeners.set(name, fn) },
        getUserAvatars: doRender => {
            // The public API remains a fresh POST. Its actual first line
            // invalidates prefetch when rendering/CRUD requests a fresh list.
            if (doRender) context.invalidatePersonaAvatarPrefetch();
            const wire = deferred(); requests.push({ doRender, ...wire }); return wire.promise;
        },
        power_user: { personas: { 'avatar-a': 'A' }, persona_descriptions: {}, persona_auto_lock: false, default_persona: null },
        setUserAvatar: async avatar => { mutations.push(['avatar', avatar]); context.user_avatar = avatar; },
        updatePersonaUIStates: () => mutations.push(['ui']), saveSettingsDebounced: () => mutations.push(['settings']),
        getConnectedPersonas: () => [], askForPersonaSelection: async () => { throw new Error('unexpected selector'); },
        getCurrentConnectionObj: () => ({}), lockPersona: async () => mutations.push(['lock']),
        t: strings => strings[0], toastr: { success: () => mutations.push(['notice']) },
        console: { log() {}, warn() {} },
    };
    vm.createContext(context); vm.runInContext(code, context);
    return { context, requests, mutations, listeners,
        switchChat: (id, owner = 'owner-one') => { context.currentChatId = `Homer-${id}`; if (homer) { context.chat_metadata.homer_bridge.conversation_id = id; context.chat_metadata.homer_bridge.user_id = owner; } },
        preload: () => context.prefetchPersonaAvatarsForCurrentChat(),
        load: options => context.loadPersonaForCurrentChat(options),
    };
}

test('one fresh read begins before paint and is consumed once by the same verified chat', async () => {
    const f = fixture(); const preload = f.preload(); assert.equal(f.requests.length, 1);
    assert.equal(f.preload(), preload, 'duplicate prefetch must be single-flight');
    const loading = f.load(); assert.equal(f.requests.length, 1, 'lifecycle consumes the existing POST');
    f.requests[0].resolve(['avatar-a']); assert.equal(await loading, true);
    assert.deepEqual(f.mutations, [['ui']]);
    assert.equal(vm.runInContext('personaAvatarPrefetch', f.context), null);
});

test('another chat, even under the same owner, gets a new server list without a TTL cache', async () => {
    const f = fixture(); f.preload(); const first = f.load(); f.requests[0].resolve(['avatar-a']); await first;
    f.switchChat('chat-two'); f.preload(); assert.equal(f.requests.length, 2);
    const second = f.load(); f.requests[1].resolve(['avatar-a']); await second;
    assert.deepEqual(f.requests.map(x => x.doRender), [false, false]);
});

test('a render/CRUD request ignores the prefetched read and retains the fresh public API', async () => {
    const f = fixture(); f.preload(); const rendered = f.load({ doRender: true });
    assert.equal(f.requests.length, 2); assert.equal(f.requests[1].doRender, true);
    f.requests[1].resolve(['avatar-a']); await rendered;
    f.requests[0].resolve(['old-avatar']); await Promise.resolve();
    assert.deepEqual(f.mutations, [['ui']]);
    const actual = source.slice(source.indexOf('export async function getUserAvatars('), source.indexOf('async function uploadUserAvatar('));
    assert.match(actual, /if \(doRender\) invalidatePersonaAvatarPrefetch\(\);\s*const response = await fetch/);
    assert.doesNotMatch(actual, /takePersonaAvatarPrefetch|personaAvatarPrefetch\.promise/);
});

test('a late read cannot mutate a newly selected chat or clear its persona lock', async () => {
    const f = fixture(); f.preload(); const old = f.load(); f.switchChat('chat-two');
    f.requests[0].resolve(['avatar-b']); assert.equal(await old, false);
    assert.equal(f.context.chat_metadata.persona, 'avatar-a'); assert.equal(f.context.user_avatar, 'avatar-a'); assert.equal(f.mutations.length, 0);
});

test('account clear and identity storage events fence a consumed read, even for the same chat id', async () => {
    for (const name of ['homer-account-cleared', 'storage']) {
        const f = fixture(); f.preload(); const old = f.load(); f.listeners.get(name)({ key: 'ai_xingyue_user' });
        f.requests[0].resolve(['avatar-b']); assert.equal(await old, false); assert.equal(f.mutations.length, 0);
        assert.equal(f.context.personaLastLoadedChatId, null);
    }
});

test('same-owner profile and unchanged login writes keep the fresh in-flight list usable', async () => {
    const f = fixture(); const original = f.preload(); const loading = f.load();
    f.listeners.get('storage')({ key: 'ai_xingyue_user', oldValue: JSON.stringify({ id: 'owner-one', name: 'Old' }),
        newValue: JSON.stringify({ id: 'owner-one', name: 'New', balance: 42 }) });
    f.listeners.get('storage')({ key: 'ai_xingyue_logged_in', oldValue: '1', newValue: '1' });
    assert.equal(vm.runInContext('personaAccountEpoch', f.context), 0);
    f.requests[0].resolve(['avatar-a']); assert.equal(await loading, true); await original;
    assert.equal(f.requests.length, 1); assert.deepEqual(f.mutations, [['ui']]);
});

test('initial matching profile storage is not an account change, but an A-B-A transition fences old reads', async () => {
    const f = fixture(); f.preload(); const loading = f.load();
    f.listeners.get('storage')({ key: 'ai_xingyue_user', oldValue: null, newValue: JSON.stringify({ user_id: 'owner-one' }) });
    assert.equal(vm.runInContext('personaAccountEpoch', f.context), 0);
    f.listeners.get('storage')({ key: 'ai_xingyue_user', oldValue: JSON.stringify({ id: 'owner-one' }), newValue: JSON.stringify({ id: 'owner-two' }) });
    f.listeners.get('storage')({ key: 'ai_xingyue_user', oldValue: JSON.stringify({ id: 'owner-two' }), newValue: JSON.stringify({ id: 'owner-one' }) });
    assert.equal(vm.runInContext('personaAccountEpoch', f.context), 2);
    f.requests[0].resolve(['avatar-b']); assert.equal(await loading, false); assert.equal(f.mutations.length, 0);
});

test('profile removal, malformed profile, explicit logout and clear all remain account changes', async () => {
    for (const event of [
        { key: 'ai_xingyue_user', oldValue: '{"id":"owner-one"}', newValue: null },
        { key: 'ai_xingyue_user', oldValue: '{"id":"owner-one"}', newValue: 'broken' },
        { key: 'ai_xingyue_logged_in', oldValue: '1', newValue: '0' }, { key: null },
    ]) {
        const f = fixture(); f.preload(); const loading = f.load(); f.listeners.get('storage')(event);
        f.requests[0].resolve(['avatar-b']); assert.equal(await loading, false); assert.equal(f.mutations.length, 0);
    }
});

test('different account with the same mirror cannot consume the old owner filename list', async () => {
    const f = fixture(); f.preload(); f.switchChat('chat-one', 'owner-two'); const loading = f.load();
    assert.equal(f.requests.length, 2); f.requests[1].resolve(['avatar-a']); await loading;
    f.requests[0].resolve(['other-private-avatar']); await Promise.resolve(); assert.deepEqual(f.mutations, [['ui']]);
});

test('a forced list refresh during an awaited preload fences the old list before any persona mutation', async () => {
    const f = fixture(); f.preload(); const loading = f.load();
    const rendered = f.context.getUserAvatars(true); f.requests[1].resolve(['avatar-a']); await rendered;
    f.requests[0].resolve(['avatar-b']); assert.equal(await loading, false); assert.equal(f.mutations.length, 0);
});

test('failed consumed preload rejects normally without silent old-list fallback or settings edits', async () => {
    const f = fixture(); f.preload(); const loading = f.load();
    f.requests[0].reject(new Error('fresh read failed')); await assert.rejects(loading, /fresh read failed/);
    assert.equal(f.requests.length, 1); assert.equal(f.mutations.length, 0);
});

test('invalid owner/card/mirror scopes cannot prefetch or update the Homer persona', async () => {
    const cases = [f => { delete f.context.chat_metadata.homer_bridge.user_id; },
        f => { f.context.characters[0].data.extensions.homer_bridge.app_id = 'another-app'; },
        f => { f.context.currentChatId = 'Homer-other'; }];
    for (const change of cases) {
        const f = fixture(); change(f); assert.equal(f.preload(), null);
        const loading = f.load(); f.requests[0].resolve(['avatar-b']); assert.equal(await loading, false); assert.equal(f.mutations.length, 0);
    }
});

test('ordinary non-Homer persona loading remains a fresh read with its original selection logic', async () => {
    const f = fixture({ homer: false }); assert.equal(f.preload(), null);
    const loading = f.load(); f.requests[0].resolve(['avatar-a']); assert.equal(await loading, true);
    assert.deepEqual(f.mutations, [['ui']]);
});

test('a genuine current locked-persona change still selects its avatar and updates UI', async () => {
    const f = fixture(); f.context.chat_metadata.persona = 'avatar-b'; f.preload();
    const loading = f.load(); f.requests[0].resolve(['avatar-a', 'avatar-b']); assert.equal(await loading, true);
    assert.deepEqual(f.mutations, [['avatar', 'avatar-b'], ['ui']]); assert.equal(f.context.user_avatar, 'avatar-b');
});

function activateTarget(f, app = 'app-two', conversation = 'chat-two', owner = 'owner-one') {
    f.context.characters.push({ data: { extensions: { homer_bridge: { app_id: app } } } });
    f.context.this_chid = f.context.characters.length - 1;
    f.context.chat_metadata.homer_bridge = { user_id: owner, app_id: app, conversation_id: conversation, runtime: 'dialogue' };
    f.context.currentChatId = 'Homer-' + conversation.replace(/[^a-zA-Z0-9_-]/g, '');
}

test('a fresh target read starts while the old card is still selected, without persona mutations', async () => {
    const f = fixture();
    const early = f.context.prefetchPersonaAvatarsForConversation({ userId: 'owner-one', appId: 'app-two', conversationId: 'chat-two' });
    assert.equal(f.requests.length, 1); assert.deepEqual(f.mutations, []);
    assert.equal(f.context.this_chid, 0); assert.equal(f.context.currentChatId, 'Homer-chat-one');
    assert.equal(f.context.chat_metadata.persona, 'avatar-a');
    f.requests[0].resolve(['avatar-a']); await early;
    assert.deepEqual(f.mutations, [], 'settling the early read must not select/render a persona');
    activateTarget(f);
    assert.equal(f.preload(), early, 'the later preprint hook reuses only this target ticket');
    assert.equal(await f.load(), true); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.mutations, [['ui']]);
});

test('an early ticket is not permission to consume with an invalid canonical character or mirror', async () => {
    for (const damage of [
        f => { f.context.characters[f.context.this_chid].data.extensions.homer_bridge.app_id = 'wrong-card'; },
        f => { f.context.currentChatId = 'Homer-wrong-mirror'; },
        f => { f.context.chat_metadata.homer_bridge.runtime = 'wrong-runtime'; },
        f => { delete f.context.chat_metadata.homer_bridge.user_id; },
    ]) {
        const f = fixture();
        f.context.prefetchPersonaAvatarsForConversation({ userId: 'owner-one', appId: 'app-two', conversationId: 'chat-two' });
        activateTarget(f); damage(f);
        const loading = f.load(); assert.equal(f.requests.length, 2, 'invalid canonical scope cannot consume the target read');
        f.requests[0].resolve(['old-private-avatar']); f.requests[1].resolve(['avatar-b']);
        assert.equal(await loading, false); assert.deepEqual(f.mutations, []);
    }
});

test('the early filename read cannot cross into another owner even with the same card and mirror', async () => {
    const f = fixture();
    f.context.prefetchPersonaAvatarsForConversation({ userId: 'owner-one', appId: 'app-two', conversationId: 'chat-two' });
    activateTarget(f, 'app-two', 'chat-two', 'owner-two');
    const loading = f.load(); assert.equal(f.requests.length, 2);
    f.requests[0].resolve(['owner-one-private-avatar']); f.requests[1].resolve(['avatar-a']); await loading;
    assert.deepEqual(f.mutations, [['ui']]); assert.equal(f.context.user_avatar, 'avatar-a');
});

test('character ID still participates in the consumed read fence although early start has no character', async () => {
    const f = fixture();
    f.context.prefetchPersonaAvatarsForConversation({ userId: 'owner-one', appId: 'app-two', conversationId: 'chat-two' });
    activateTarget(f); const loading = f.load();
    f.context.characters.push({ data: { extensions: { homer_bridge: { app_id: 'app-two' } } } });
    f.context.this_chid = f.context.characters.length - 1;
    f.requests[0].resolve(['avatar-b']); assert.equal(await loading, false);
    assert.deepEqual(f.mutations, []);
});

test('each explicit A-B-A switch makes a fresh request and fences the consumed old A result', async () => {
    const f = fixture();
    const start = conversationId => f.context.prefetchPersonaAvatarsForConversation({ userId: 'owner-one', appId: 'app-one', conversationId });
    start('chat-one'); const old = f.load();
    start('chat-two'); f.switchChat('chat-two'); start('chat-one'); f.switchChat('chat-one');
    assert.equal(f.requests.length, 3);
    f.requests[0].resolve(['old-avatar']); assert.equal(await old, false);
    assert.deepEqual(f.mutations, []);
    assert.equal(f.preload(), f.requests[2].promise, 'preprint reuses only the newest explicit A request');
    f.context.personaLastLoadedChatId = null;
    const current = f.load(); f.requests[2].resolve(['avatar-a']); assert.equal(await current, true);
    f.requests[1].resolve(['unused-B-avatar']); assert.equal(f.requests.length, 3);
});

test('even a repeated explicit target start is fresh rather than a TTL list reuse', async () => {
    const f = fixture(); const target = { userId: 'owner-one', appId: 'app-one', conversationId: 'chat-one' };
    const first = f.context.prefetchPersonaAvatarsForConversation(target);
    const second = f.context.prefetchPersonaAvatarsForConversation(target);
    assert.notEqual(first, second); assert.equal(f.requests.length, 2);
    f.requests[0].resolve(['old-avatar']); f.requests[1].resolve(['avatar-a']);
    assert.equal(f.preload(), second); assert.equal(await f.load(), true); assert.deepEqual(f.mutations, [['ui']]);
});

test('CRUD invalidation after an early start forces a fresh canonical read instead of using the old result', async () => {
    const f = fixture();
    f.context.prefetchPersonaAvatarsForConversation({ userId: 'owner-one', appId: 'app-two', conversationId: 'chat-two' });
    f.requests[0].resolve(['old-avatar']); await f.requests[0].promise;
    const rendered = f.context.getUserAvatars(true); f.requests[1].resolve(['avatar-a']); await rendered;
    activateTarget(f); f.preload(); const loading = f.load();
    assert.equal(f.requests.length, 3); f.requests[2].resolve(['avatar-a']); assert.equal(await loading, true);
    assert.deepEqual(f.mutations, [['ui']]);
});

test('logout/relogin fences early tickets and a late rejection cannot erase a newer one', async () => {
    const f = fixture(); const target = { userId: 'owner-one', appId: 'app-two', conversationId: 'chat-two' };
    f.context.prefetchPersonaAvatarsForConversation(target);
    f.listeners.get('homer-account-cleared')();
    const newest = f.context.prefetchPersonaAvatarsForConversation(target);
    f.requests[0].reject(new Error('old aborted request')); await Promise.resolve();
    activateTarget(f); assert.equal(f.preload(), newest);
    const loading = f.load(); f.requests[1].resolve(['avatar-a']); assert.equal(await loading, true);
    assert.equal(f.requests.length, 2); assert.deepEqual(f.mutations, [['ui']]);
});

test('missing authenticated target fields cannot start a filename read', () => {
    const f = fixture();
    for (const target of [undefined, {}, { userId: 'owner-one' }, { appId: 'app-one', conversationId: 'chat-one' },
        { userId: 'owner-one', appId: '', conversationId: 'chat-one' }]) {
        assert.equal(f.context.prefetchPersonaAvatarsForConversation(target), null);
    }
    assert.equal(f.requests.length, 0); assert.deepEqual(f.mutations, []);
});

test('actual bridge starts the verified target read before hydration and keeps the later canonical preprint hook', () => {
    const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
    const switching = bridge.slice(bridge.indexOf('async function switchConversation('), bridge.indexOf('async function copyDiagnostic('));
    const bootstrap = bridge.slice(bridge.indexOf('async function bootstrapLaunch('), bridge.indexOf('async function startHomerBridge('));
    for (const part of [switching, bootstrap]) {
        const assign = part.indexOf('launch = '), early = part.indexOf('prefetchPersonaAvatarsForConversation({');
        const hydrate = part.indexOf('loadRuntimeState(');
        assert.ok(assign >= 0 && early > assign && hydrate > early);
        assert.match(part.slice(early, hydrate), /userId: session\.user\?\.id \|\| session\.user\?\.user_id/);
        assert.match(part.slice(early, hydrate), /appId: launch\.app_id, conversationId: launch\.conversation_id/);
    }
    const cloudLoad = bridge.slice(bridge.indexOf('async function loadCloudChat('), bridge.indexOf('function serializeChat('));
    assert.ok(cloudLoad.indexOf('prefetchPersonaAvatarsForCurrentChat()') < cloudLoad.indexOf('context.printMessages'));
});
