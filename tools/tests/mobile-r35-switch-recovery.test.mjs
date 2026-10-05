import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const bridge = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
function section(source, start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, 'Actual product source section exists: ' + start);
    return source.slice(a, b);
}
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

function fixture(options = {}) {
    const calls = [], events = [], notices = [], timers = [];
    const card = (app, avatar, name) => ({ name, avatar, chat: '', data: { extensions: { homer_bridge: { app_id: app } } } });
    const oldMessage = { mes: options.large ? 'x'.repeat(3 * 1024 * 1024) : 'old full message', is_user: false,
        swipe_id: 1, swipes: ['first greeting', 'selected greeting'], extra: { homer_sync_id: 'old-stable-id', homer_hidden: true, custom: { kept: true } } };
    const oldMetadata = { integrity: 'old-integrity', persona: 'locked-persona.png',
        homer_bridge: { user_id: 'owner-a', app_id: 'card-a', conversation_id: 'conversation-a', runtime: 'dialogue' },
        custom_memory: { entries: ['kept'] } };
    const previousSession = { user: { id: 'owner-a' }, launch: { app_id: 'card-a', conversation_id: 'conversation-a',
        card: { toJSON() { throw Error('Source card must never be cloned for recovery'); } } } };
    const nextSession = { user: { id: 'owner-a' }, launch: { app_id: 'card-b', conversation_id: 'conversation-b' } };
    const classSet = new Set(), handlers = new Map();
    let mirrorFailures = options.mirrorFailure ? 1 : 0;
    const scope = {
        session: previousSession, launch: previousSession.launch,
        adminConversationDraft: {}, adminConversationConfig: null, lastGenerationDiagnostic: null,
        runtimeVariables: { old: true }, presetSearchQuery: 'old search', runtimeUiData: { old: true },
        extension_settings: { memory: { enabled: true } }, conversationExtensionSettings: { memory: { enabled: true } },
        reaffirmExtensionSettingsAfterReady: false, officialRegexState: { count: 1, errors: [], revision: 'old-rules' },
        lastExtensionSettingsScope: 'card-a\u0000conversation-a', lastExtensionSettingsSignature: 'old signature',
        storageAccountEpoch: 0, owner: 'owner-a', conversationRecoveryBlocked: false,
        loadingLaunch: false, adminBinding: false, generationBusy: false, rollbackBusy: false,
        generationSnapshot: null, suppressSync: false, lastSyncSignature: '', requestedAppId: 'card-a', requestedConversationId: 'conversation-a',
        characters: [card('card-a', 'old.png', 'Old'), card('card-b', 'new.png', 'New')],
        this_chid: '0', chat: [oldMessage], chat_metadata: clone(oldMetadata), dom: ['old-live-iframe'],
        name2: 'Old', selected_group: null, is_group_generating: false, is_send_press: false, isChatSaving: false,
        this_edit_mes_id: undefined, selected_button: '', debounce_timeout: { extended: 100 },
        syncTimer: 1, extensionSettingsPersistTimer: 2, hostStateNotifyTimer: 3,
        extensionSettingsPersistWaiters: [{ resolve: value => calls.push(['waiter', value]) }],
        extensionSettingsHydrating: false, pendingCardScriptCharacter: null, tavoComposer: { refresh: () => calls.push(['composer-refresh']) },
        URL, MODULE_ID: 'isolated-switch-recovery', console: { error: (...args) => calls.push(['error', args[0]]) },
        window: { location: { href: 'https://fixture.test/runtime?homer_app_id=card-a&homer_conversation_id=conversation-a' },
            setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: id => calls.push(['clear-timer', id]),
            history: { pushState: (_state, _title, url) => { scope.window.location.href = String(url); calls.push(['push-url']); },
                replaceState: (_state, _title, url) => { scope.window.location.href = String(url); calls.push(['restore-url']); } } },
        document: { body: { classList: { add: value => classSet.add(value), remove: value => classSet.delete(value) } } },
        performance: { mark: name => calls.push(['mark', name]) },
        reconcileStorageAccount: () => scope.owner,
        cloneJsonValue: clone, cloneJsonObject: clone,
        getContext: () => ({ characterId: scope.this_chid, characters: scope.characters, chatId: scope.getCurrentChatId(),
            chat: scope.chat, chatMetadata: scope.chat_metadata, printMessages: async config => {
                calls.push(['print', scope.this_chid, config]);
                if (options.printFailure && scope.this_chid === '1') throw Error('Target formatter failed');
                scope.dom = scope.chat.map(message => message.mes);
            } }),
        getCurrentChatId: () => scope.characters[scope.this_chid]?.chat,
        waitUntilCondition: async predicate => { if (!predicate()) throw Error('busy'); }, unshallowCharacter: async () => {},
        cancelTtsPlay: () => calls.push(['tts']), resetSelectedGroup: () => { scope.selected_group = null; },
        setCharacterId: id => { scope.this_chid = String(id); calls.push(['activate', String(id)]); },
        setCharacterName: name => { scope.name2 = name; },
        clearChat: async () => { calls.push(['clear', scope.this_chid]); scope.chat.length = 0; scope.dom = []; },
        uuidv4: () => 'new-integrity', $: () => ({ val() {} }), getRequestHeaders: () => ({}),
        loadItemizedPrompts: async id => calls.push(['prompts', id]),
        prepareItemizedPrompts: chatId => ({ chatId, pending: Promise.resolve() }),
        applyPreparedItemizedPrompts: async preparation => scope.loadItemizedPrompts(preparation.chatId),
        fetch: async (_url, config) => {
            const body = JSON.parse(config.body); calls.push(['mirror', body.file_name]);
            if (body.file_name === 'Homer-conversation-b' && mirrorFailures) { mirrorFailures--; return { ok: false }; }
            if (body.file_name === 'Homer-conversation-a' && options.recoveryMirrorFailure) return { ok: false };
            if (body.file_name === 'Homer-conversation-a' && options.accountDuringRecovery) { scope.owner = 'owner-b'; scope.storageAccountEpoch++; }
            if (body.file_name === 'Homer-conversation-b' && options.accountDuringActivation) { scope.owner = 'owner-b'; scope.storageAccountEpoch++; }
            return { ok: true, json: async () => ({ chat_metadata: { integrity: 'mirror-integrity' } }) };
        },
        officialDisplayRules: () => [{ findRegex: 'old', replaceString: 'previous', markdownOnly: true }],
        setOfficialDisplayRules: value => { calls.push(['rules', clone(value)]); return { count: value.scripts.length, errors: [], revision: value.revision }; },
        replaceExtensionSettings: value => { scope.extension_settings = clone(value); calls.push(['restore-settings']); },
        applyConnectionConfiguration: () => calls.push(['connection']), buildRuntimeUi: () => calls.push(['ui']),
        setAccessClasses: () => {}, retainScopeDraft: () => calls.push(['draft']), setDrawerOpen: () => {},
        notifyHostLoading: () => {}, notifyHost: (type, payload) => notices.push({ type, payload }),
        notifyHostConversation: (type = 'ready', payload = {}) => notices.push({ type, app: scope.launch.app_id, payload }),
        notifyHostError: () => notices.push({ type: 'error' }), showHostNotice: (text, level) => notices.push({ type: level, text }),
        failRuntimeGate: error => calls.push(['gate-failed', error.message]),
        setOnlineStatus: value => calls.push(['online', value]), updateRuntimeStatus: () => {},
        scheduleSessionPrefetch: () => {}, replayPendingStorage: async () => {}, installTokenRefresh: () => {}, reaffirmConversationConnection: () => {},
        scrollChatToBottom: config => calls.push(['scroll', config]), scrollOnMediaLoad: () => calls.push(['media']), queueMessageMenuRender: () => {},
        enableTavernHelperCardScripts: async character => calls.push(['card-scripts', character.avatar]),
        captureCloudSync: (id, payload) => ({ scope: id, payload: clone(payload) }), serializeChat: () => clone(scope.chat),
        extensionSettingsScope: (app = scope.launch.app_id, conv = scope.launch.conversation_id) => app + '\u0000' + conv,
        extensionSettingsSnapshot: () => ({ value: clone(scope.extension_settings), signature: JSON.stringify(scope.extension_settings) }),
        event_types: { SETTINGS_LOADED: 'settings', CHAT_CHANGED: 'chat-changed', CHAT_LOADED: 'chat-loaded', CHAT_COMPLETION_SETTINGS_READY: 'generation-settings' },
        eventSource: { on: (event, handler) => handlers.set(event, handler), emit: async (event, id) => {
            events.push([event, id]);
            if (event === 'chat-loaded' && id === 'Homer-conversation-b' && options.pluginFailure) throw Error('Target plugin failed');
            if (event === 'chat-loaded' && id === 'Homer-conversation-a' && options.recoveryPluginFailure) throw Error('Recovery plugin failed');
        } },
        refreshOfficialRegex: async () => calls.push(['refresh-official']),
        commitConversationBeforeSwitch: async () => {
            calls.push(['commit']); if (options.commitFailure) throw Error('Local prepare failed');
        },
        takePrefetchedSession: async () => { if (options.getFailure) throw Error('Target GET failed'); return nextSession; },
        prepareRuntimeState: (app, conv) => ({ app, conv }),
        prepareRuntimeModels: (app, conv) => ({ app, conv }),
        prepareConversationResources: (app, conv) => ({ state: scope.prepareRuntimeState(app, conv), models: scope.prepareRuntimeModels(app, conv), regex: null }),
        invalidateCachedSession: () => {},
        loadRuntimeState: async () => {
            scope.extension_settings = { memory: { enabled: false } };
            if (options.accountDuringHydration) { scope.owner = 'owner-b'; scope.storageAccountEpoch++; }
            if (options.configurationFailure) throw Error('Configuration failed');
        },
        loadRuntimeUiData: async () => {},
        prefetchPersonaAvatarsForConversation: target => calls.push(['early-persona', target]),
        importLaunchCharacter: async () => { await scope.activateCharacterForChat(1, { chatName: 'Homer-conversation-b' }); },
        loadCloudChat: async () => {
            scope.chat_metadata.homer_bridge = { user_id: 'owner-a', app_id: 'card-b', conversation_id: 'conversation-b', runtime: 'dialogue' };
            scope.chat.push({ mes: 'target message', extra: {} });
            if (options.accountChanged) { scope.owner = 'owner-b'; scope.storageAccountEpoch++; throw Error('Account changed'); }
            if (options.accountABA) { scope.storageAccountEpoch += 2; throw Error('Logout and login'); }
            await scope.getContext().printMessages({ scroll: false });
            await scope.eventSource.emit('chat-changed', 'Homer-conversation-b');
            await scope.eventSource.emit('chat-loaded', 'Homer-conversation-b');
            if (options.accountAfterLoad) { scope.owner = 'owner-b'; scope.storageAccountEpoch++; }
        },
    };
    scope.characters[0].chat = 'Homer-conversation-a';
    vm.createContext(scope);
    vm.runInContext(section(script, 'export async function activateCharacterForChat(', '////////// OPTIMZED MAIN API CHANGE FUNCTION')
        .replace(/^export /gm, ''), scope);
    vm.runInContext([
        section(bridge, 'function prepareLaunchMirrorHeader(', 'function prepareInitialCharacterRead('),
        section(bridge, 'function normalizeBootstrapToken(', 'function notifyHostConversation('),
        section(bridge, 'function cloudSyncScope()', 'async function commitConversationBeforeSwitch()'),
        section(bridge, 'function captureExtensionStorage(', 'async function persistExtensionSettingsSnapshot('),
        section(bridge, 'async function syncCloudChat(', 'async function syncCloudChatSnapshot('),
        section(bridge, 'async function switchConversation(', 'async function copyDiagnostic('),
        section(bridge, '    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY,', "    window.addEventListener('homer-generation-diagnostic'"),
    ].join('\n'), scope);
    return { scope, calls, events, notices, previousSession, oldMessage: clone(oldMessage), oldMetadata, classSet, handlers };
}

async function switchTarget(h) { await h.scope.switchConversation({ app_id: 'card-b', id: 'conversation-b' }); }

test('target success binds the canonical new scope; the source card is not cloned', async () => {
    const h = fixture(); await switchTarget(h);
    assert.equal(h.scope.launch.app_id, 'card-b'); assert.equal(h.scope.hasCanonicalConversationScope(), true);
    assert.equal(h.scope.conversationRecoveryBlocked, false);
    assert.equal(h.notices.filter(item => item.type === 'ready').length, 1);
    assert.equal(h.calls.filter(item => item[0] === 'activate').length, 1);
});

test('actual switch starts target state beside leave, then consumes its exact ticket under verified target launch', async () => {
    const h = fixture(), ticket = { target: 'test-conversation-b' }, modelTicket = { fresh: true }, order = [], catalog = Promise.resolve();
    h.scope.prepareRuntimeState = (app, conv) => {
        assert.equal(h.scope.launch.app_id, 'card-a');
        assert.equal(app, 'card-b'); assert.equal(conv, 'conversation-b');
        order.push('read'); return ticket;
    };
    h.scope.prepareRuntimeModels = (app, conv) => {
        assert.equal(h.scope.launch.app_id, 'card-a');
        assert.equal(app, 'card-b'); assert.equal(conv, 'conversation-b');
        order.push('models-read'); return modelTicket;
    };
    h.scope.commitConversationBeforeSwitch = async () => { order.push('leave'); };
    h.scope.loadRuntimeUiData = prepared => {
        assert.equal(h.scope.launch.app_id, 'card-b');
        assert.equal(prepared, modelTicket);
        return catalog;
    };
    h.scope.loadRuntimeState = async (prepared, modelCatalogWork) => {
        assert.equal(h.scope.launch.app_id, 'card-b');
        assert.equal(h.scope.launch.conversation_id, 'conversation-b');
        assert.equal(prepared, ticket); assert.equal(modelCatalogWork, catalog);
        order.push('consume');
    };
    await h.scope.switchConversation({ app_id: 'card-b', id: 'conversation-b' });
    assert.deepEqual(order, ['read', 'models-read', 'leave', 'consume']);
});

test('generation or another active bind cannot launch an opportunistic target configuration read', async () => {
    for (const flag of ['generationBusy', 'rollbackBusy', 'loadingLaunch', 'adminBinding']) {
        const h = fixture(); h.scope[flag] = true;
        h.scope.prepareRuntimeState = () => { throw new Error('No target read while busy'); };
        h.scope.prepareRuntimeModels = () => { throw new Error('No model read while busy'); };
        await h.scope.switchConversation({ app_id: 'card-b', id: 'conversation-b' });
        assert.equal(h.scope.launch.app_id, 'card-a');
        assert.equal(h.calls.filter(item => item[0] === 'commit').length, 0);
    }
});

for (const failure of ['getFailure', 'commitFailure', 'configurationFailure']) {
    test(failure + ' preserves the original live DOM and does not reactivate/print', async () => {
        const h = fixture({ [failure]: true }); const dom = h.scope.dom, metadata = h.scope.chat_metadata;
        await switchTarget(h);
        assert.equal(h.scope.session, h.previousSession); assert.equal(h.scope.dom, dom); assert.equal(h.scope.chat_metadata, metadata);
        assert.equal(h.calls.filter(item => ['activate', 'print', 'clear'].includes(item[0])).length, 0);
        assert.equal(h.notices.filter(item => item.type === 'conversation-switch-failed').length, 1);
        assert.equal(h.scope.hasCanonicalConversationScope(), true);
    });
}

for (const failure of ['mirrorFailure', 'printFailure', 'pluginFailure']) {
    test(failure + ' really reactivates and renders old chat before reporting restored usability', async () => {
        const h = fixture({ [failure]: true }); await switchTarget(h);
        assert.equal(h.scope.session, h.previousSession); assert.equal(h.scope.this_chid, '0');
        same(h.scope.chat, [h.oldMessage]); same(h.scope.chat_metadata, h.oldMetadata);
        same(h.scope.dom, [h.oldMessage.mes]); assert.equal(h.scope.hasCanonicalConversationScope(), true);
        const oldPrint = h.calls.findIndex(item => item[0] === 'print' && item[1] === '0');
        assert.ok(oldPrint >= 0); assert.equal(h.scope.conversationRecoveryBlocked, false);
        assert.ok(h.events.some(item => item[0] === 'chat-changed' && item[1] === 'Homer-conversation-a'));
        assert.ok(h.events.some(item => item[0] === 'chat-loaded' && item[1] === 'Homer-conversation-a'));
        assert.ok(h.calls.some(item => item[0] === 'card-scripts' && item[1] === 'old.png'));
        assert.ok(h.calls.some(item => item[0] === 'media'));
        assert.equal(h.notices.filter(item => item.type === 'conversation-switch-failed').length, 1);
        assert.equal(h.scope.captureCurrentChatStorage().payload.messages[0].mes, h.oldMessage.mes);
    });
}

test('large raw chat, selected swipes, message IDs and custom metadata restore in full', async () => {
    const h = fixture({ large: true, pluginFailure: true }); await switchTarget(h);
    assert.equal(h.scope.chat[0].mes.length, 3 * 1024 * 1024); same(h.scope.chat[0], h.oldMessage);
    same(h.scope.chat_metadata, h.oldMetadata);
});

for (const failure of ['recoveryMirrorFailure', 'recoveryPluginFailure']) {
    test(failure + ' stays failed/blocked, with no false restored ready/state or generation/sync', async () => {
        const h = fixture({ pluginFailure: true, [failure]: true }); await switchTarget(h);
        assert.equal(h.scope.conversationRecoveryBlocked, true); assert.ok(h.classSet.has('homer-runtime-error'));
        assert.equal(h.notices.filter(item => item.type === 'conversation-switch-failed' || item.type === 'ready').length, 0);
        assert.equal(h.notices.filter(item => item.type === 'error' && !item.text).length, 1);
        assert.throws(() => h.scope.captureCurrentChatStorage(), /完整恢复/);
        assert.equal(h.scope.captureExtensionStorage({ force: true }), null);
        assert.equal(await h.scope.syncCloudChat(), false);
        await assert.rejects(h.handlers.get('generation-settings')({ model: 'test-model' }), /完整恢复/);
        assert.equal(h.calls.filter(item => item[0] === 'refresh-official').length, 0);
    });
}

for (const failure of ['accountChanged', 'accountABA']) {
    test(failure + ' never resurrects the old session or chat after its epoch is invalidated', async () => {
        const h = fixture({ [failure]: true }); await switchTarget(h);
        assert.notEqual(h.scope.session, h.previousSession); assert.equal(h.scope.conversationRecoveryBlocked, true);
        assert.equal(h.calls.filter(item => item[0] === 'activate' && item[1] === '0').length, 0);
        assert.equal(h.notices.filter(item => item.type === 'conversation-switch-failed' || item.type === 'ready').length, 0);
        assert.throws(() => h.scope.captureCurrentChatStorage());
    });
}

test('account changed while the old mirror is being read prevents copying old messages into the new account', async () => {
    const h = fixture({ pluginFailure: true, accountDuringRecovery: true }); await switchTarget(h);
    assert.equal(h.scope.conversationRecoveryBlocked, true); assert.equal(h.scope.chat.length, 0);
    assert.equal(h.notices.filter(item => item.type === 'conversation-switch-failed' || item.type === 'ready').length, 0);
});

for (const stage of ['accountDuringHydration', 'accountDuringActivation', 'accountAfterLoad']) {
    test(stage + ' is fenced even when the awaited work returns successfully', async () => {
        const h = fixture({ [stage]: true }); await switchTarget(h);
        assert.equal(h.scope.conversationRecoveryBlocked, true);
        assert.notEqual(h.scope.session, h.previousSession);
        assert.equal(h.notices.filter(item => item.type === 'ready' || item.type === 'conversation-switch-failed').length, 0);
        if (stage !== 'accountAfterLoad') assert.equal(h.calls.filter(item => item[0] === 'print').length, 0);
    });
}

test('an account change during provider configuration is rechecked after its network await', async () => {
    const h = fixture();
    h.scope.refreshOfficialRegex = async () => { h.scope.owner = 'owner-b'; h.scope.storageAccountEpoch++; };
    await assert.rejects(h.handlers.get('generation-settings')({ model: 'test-model' }), /完整恢复/);
});

test('every canonical scope component is verified before chat/settings capture and provider configuration', async () => {
    const cases = [
        h => { h.scope.chat_metadata.homer_bridge.user_id = 'another-owner'; },
        h => { h.scope.chat_metadata.homer_bridge.app_id = 'another-app'; },
        h => { h.scope.chat_metadata.homer_bridge.conversation_id = 'another-conversation'; },
        h => { h.scope.chat_metadata.homer_bridge.runtime = 'another-runtime'; },
        h => { h.scope.characters[0].data.extensions.homer_bridge.app_id = 'another-app'; },
        h => { h.scope.characters[0].chat = 'Homer-another-conversation'; },
        h => { h.scope.owner = 'another-owner'; },
    ];
    for (const change of cases) {
        const h = fixture(); change(h);
        assert.throws(() => h.scope.captureCurrentChatStorage(), /完整恢复/);
        assert.equal(h.scope.captureExtensionStorage({ force: true }), null);
        assert.equal(await h.scope.syncCloudChat(), false);
        await assert.rejects(h.handlers.get('generation-settings')({ model: 'test-model' }), /完整恢复/);
    }
});
