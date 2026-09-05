import {
    changeMainAPI,
    eventSource,
    event_types,
    getRequestHeaders,
    messageEdit,
    saveSettingsDebounced,
    setOnlineStatus,
} from '../../../script.js';
import { oai_settings } from '../../openai.js';
import { allowScopedScripts } from '../regex/engine.js';
import { extension_settings } from '../../extensions.js';
import { getContext } from '../../st-context.js';
import { accountStorage } from '../../util/AccountStorage.js';
import {
    importEmbeddedWorldInfo,
    updateWorldInfoList,
    world_names,
} from '../../world-info.js';
import { loadApprovedExtensions } from './extension-host.js';
import { installRoleplayHubCompatibility } from './roleplayhub-compat.js';
import { installCardStageRuntime } from './card-stage.js';
import { installKeywordInjector } from './keyword-injector.js';

const MODULE_ID = 'homer-bridge';
const urlParams = new URLSearchParams(window.location.search);
const requestedAppId = String(urlParams.get('homer_app_id') || urlParams.get('app_id') || '').trim();
const requestedConversationId = String(
    urlParams.get('homer_conversation_id')
    || urlParams.get('conversation_id')
    || urlParams.get('conv_id')
    || '',
).trim();
const requestedSiteOrigin = String(urlParams.get('homer_site_origin') || '').trim();
const requestedHostChannel = String(urlParams.get('homer_host_channel') || '').trim();
const requestedEmbed = String(urlParams.get('homer_embed') || '').trim();
const HOST_CHANNEL = 'homer:dialogue-host:v1';

let initialized = false;
let bridgeStartScheduled = false;
let launchSessionPreloadPromise = null;
let applicationReady = false;
let resolveApplicationReady;
const applicationReadyPromise = new Promise(resolve => {
    resolveApplicationReady = resolve;
});
let postApplicationReadyWork = Promise.resolve();
let loadingLaunch = false;
let launch = null;
let session = null;
let runtimeVariables = {};
let presetSearchQuery = '';
let syncTimer = null;
let tokenRefreshTimer = null;
let generationSettleTimer = null;
let suppressSync = false;
let generationBusy = false;
let generationSnapshot = null;
let generationRecoveryChain = Promise.resolve();
let rollbackBusy = false;
let lastSyncSignature = '';
let eventHandlersInstalled = false;
let dialogueEventLogMuted = 0;
let messageMenuObserver = null;
let messageMenuRenderQueued = false;
let activeMessageMenuTarget = null;
let messagePressTimer = null;
let messagePressStart = null;
let messagePressTarget = null;
let suppressMessageClickUntil = 0;
let presentationModeBridgeInstalled = false;
const MESSAGE_LONG_PRESS_DELAY = 520;
const MESSAGE_LONG_PRESS_MOVE_TOLERANCE = 12;
let extensionSettingsBridgeInstalled = false;
let embeddedDocumentLookupBridgeInstalled = false;
let extensionSettingsBaseline = null;
let conversationExtensionSettings = null;
let reaffirmExtensionSettingsAfterReady = false;
let extensionSettingsHydrating = false;
let extensionSettingsReplayInProgress = false;
let extensionSettingsPersistTimer = null;
let extensionSettingsPersistChain = Promise.resolve();
let extensionSettingsPersistWaiters = [];
let lastExtensionSettingsScope = '';
let lastExtensionSettingsSignature = '';
let productSurfaceBoundaryInstalled = false;
let upstreamNoticeObserver = null;
const pendingHostNotices = [];
let runtimeUiData = {
    conversations: [],
    models: [],
    modelDefaultId: '',
    mods: [],
    activeModIds: [],
};
let managedConversation = null;
const SESSION_PREFETCH_LIMIT = 2;
const SESSION_CACHE_TTL_MS = 30_000;
const sessionPrefetchCache = new Map();
let sessionPrefetchTimer = null;
let hostStateNotifyTimer = null;

const DEFAULT_MODEL_SETTINGS = Object.freeze({
    model_id: '',
    temperature: 1,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
});

function unwrap(payload) {
    if (payload && typeof payload === 'object' && payload.data !== undefined) {
        return payload.data;
    }
    return payload;
}

function runtimeGate() {
    return document.querySelector('#homer-runtime-gate');
}

function installEmbeddedComposerPolicy() {
    if (requestedEmbed !== '1' || document.documentElement.dataset.homerComposerPolicy === '1') {
        return;
    }
    document.documentElement.dataset.homerComposerPolicy = '1';
    const style = document.createElement('style');
    style.dataset.homerComposerPolicy = '1';
    style.textContent = [
        '#send_textarea ~ .autoComplete-wrap',
        '#send_textarea + .autoComplete-wrap',
        '.autoComplete-wrap:has(+ #send_textarea)',
        '.slashCommandBrowser',
    ].join(',') + '{display:none !important;visibility:hidden !important;pointer-events:none !important;}';
    (document.head || document.documentElement).append(style);
    const updateComposer = () => {
        const composer = document.querySelector('#send_textarea');
        if (composer instanceof HTMLTextAreaElement && composer.placeholder !== '输入想发送的消息') {
            composer.placeholder = '输入想发送的消息';
        }
    };
    const hideAutocomplete = () => {
        document.querySelectorAll('.autoComplete-wrap,.slashCommandBrowser').forEach(node => {
            node.style.setProperty('display', 'none', 'important');
            node.setAttribute('aria-hidden', 'true');
        });
    };
    hideAutocomplete();
    updateComposer();
    new MutationObserver(() => {
        hideAutocomplete();
        updateComposer();
    }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['placeholder'],
    });
}

function setRuntimeGate(title, detail, { error = false } = {}) {
    const gate = runtimeGate();
    if (!gate) {
        return;
    }
    gate.classList.toggle('is-error', Boolean(error));
    gate.setAttribute('aria-busy', String(!error));
    const titleElement = gate.querySelector('.homer-runtime-gate__title');
    const detailElement = gate.querySelector('.homer-runtime-gate__detail');
    if (titleElement && title) {
        titleElement.textContent = String(title);
    }
    if (detailElement && detail) {
        detailElement.textContent = String(detail);
    }
}

async function releaseRuntimeGate() {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const gate = runtimeGate();
    document.documentElement.classList.remove('homer-runtime-pending');
    gate?.classList.add('is-ready');
    gate?.setAttribute('aria-busy', 'false');
    window.setTimeout(() => gate?.remove(), 260);
}

function failRuntimeGate(error) {
    const message = String(error?.message || '对话服务暂时不可用，请稍后重试。');
    document.documentElement.classList.add('homer-runtime-pending');
    setRuntimeGate('对话暂时无法连接', message, { error: true });
}

async function requestJson(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {
        ...getRequestHeaders(),
        ...(options.headers || {}),
    };
    const response = await fetch(url, {
        ...options,
        method,
        headers,
        cache: 'no-store',
    });
    let payload = {};
    try {
        payload = await response.json();
    } catch {
        payload = {};
    }
    if (!response.ok || payload?.result === 'failure') {
        const message = payload?.error?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
        // 只抛，不在这里弹持久错误条。requestJson 有 26 个调用点，很多是
        // 探测性/可容错的（例如 fetchSession 的嵌入式端点失败后还有回退），
        // 在最底层弹条会把这些正常回退渲染成一条不消失的「对话服务连接失败」。
        // 需要提示的调用点自己走 showHostNotice。
        throw new Error(String(message));
    }
    return unwrap(payload);
}

function queryString(appId, conversationId = '') {
    const params = new URLSearchParams({ app_id: appId });
    if (conversationId) {
        params.set('conversation_id', conversationId);
    }
    return params.toString();
}

function clampNumber(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function cloneJsonObject(value) {
    try {
        const cloned = JSON.parse(JSON.stringify(value));
        return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : {};
    } catch {
        return {};
    }
}

function isJsonObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRuntimeTree(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (typeof value !== 'object' || ancestors.has(value)) {
        return false;
    }

    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
        (array && prototype !== Array.prototype)
        || (!array && prototype !== Object.prototype && prototype !== null)
        || !Object.isExtensible(value)
    ) {
        return false;
    }

    ancestors.add(value);
    try {
        for (const key of Reflect.ownKeys(value)) {
            if (array && key === 'length') {
                continue;
            }
            if (typeof key === 'symbol' || (array && !/^(0|[1-9]\d*)$/.test(key))) {
                return false;
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (
                !descriptor
                || !Object.hasOwn(descriptor, 'value')
                || !descriptor.enumerable
                || !descriptor.configurable
                || !descriptor.writable
                || !isPlainRuntimeTree(descriptor.value, ancestors)
            ) {
                return false;
            }
        }
        return true;
    } finally {
        ancestors.delete(value);
    }
}

function cloneJsonValue(value) {
    return JSON.parse(JSON.stringify(value));
}

function synchronizeJsonContainer(target, source, options = {}) {
    if (options.preserveUnsafeNamespaces) {
        if (!isJsonObject(target) || !isJsonObject(source)) {
            return target;
        }
        // A conversation snapshot is an overlay. Card-script sandboxes may
        // expose and save only part of extensionSettings, so an absent
        // top-level namespace must retain its native/baseline value rather than
        // being deleted (regex, TTS and expressions require their defaults).
        for (const [key, value] of Object.entries(source)) {
            const current = target[key];
            if (current === undefined) {
                if (isPlainRuntimeTree(value)) {
                    target[key] = cloneJsonValue(value);
                }
                continue;
            }
            // Some extensions hydrate their JSON settings into class instances
            // and retain references to them. A generic JSON restore cannot
            // recreate those prototypes, so preserve the live namespace and let
            // its owning extension manage deserialization.
            if (!isPlainRuntimeTree(current) || !isPlainRuntimeTree(value)) {
                continue;
            }
            if (
                (Array.isArray(current) && Array.isArray(value))
                || (isJsonObject(current) && isJsonObject(value))
            ) {
                synchronizeJsonContainer(current, value);
            } else {
                target[key] = cloneJsonValue(value);
            }
        }
        return target;
    }

    if (!isPlainRuntimeTree(target) || !isPlainRuntimeTree(source)) {
        return target;
    }
    if (Array.isArray(target) && Array.isArray(source)) {
        target.splice(0, target.length, ...cloneJsonValue(source));
        return target;
    }
    if (isJsonObject(target) && isJsonObject(source)) {
        for (const key of Object.keys(target)) {
            if (!Object.hasOwn(source, key)) {
                delete target[key];
            }
        }
        for (const [key, value] of Object.entries(source)) {
            const current = target[key];
            if (
                (Array.isArray(current) && Array.isArray(value))
                || (isJsonObject(current) && isJsonObject(value))
            ) {
                synchronizeJsonContainer(current, value);
            } else {
                target[key] = cloneJsonValue(value);
            }
        }
        return target;
    }
    return source;
}

function replaceExtensionSettings(value) {
    extensionSettingsHydrating = true;
    try {
        // Real extensions keep long-lived references to their nested settings
        // objects. Mutate those containers in place so a conversation restore
        // cannot leave an extension writing through a stale object reference.
        // Runtime-owned class instances are deliberately preserved because a
        // JSON snapshot cannot reconstruct their methods or custom prototypes.
        synchronizeJsonContainer(extension_settings, cloneJsonObject(value), {
            preserveUnsafeNamespaces: true,
        });
        ensureHomerExtensionSettingDefaults();
    } finally {
        extensionSettingsHydrating = false;
    }
}

function ensureHomerExtensionSettingDefaults() {
    if (!requestedAppId || !requestedConversationId) {
        return;
    }
    const disabledExtensions = new Set(
        Array.isArray(extension_settings.disabledExtensions)
            ? extension_settings.disabledExtensions
            : [],
    );
    disabledExtensions.add('third-party/st-yuzi-phone');
    extension_settings.disabledExtensions = [...disabledExtensions];
    const memoryBooks = extension_settings.STMemoryBooks ||= {};
    const moduleSettings = memoryBooks.moduleSettings ||= {};
    // Homer owns the chat header. Memory Books remains fully available from
    // the settings drawer, but its optional TopInfoBar install notice would
    // otherwise cover the first model-settings interaction.
    moduleSettings.dismissMissingTopInfoBarJobsNotice = true;
}

function captureExtensionSettingsBaseline() {
    ensureHomerExtensionSettingDefaults();
    extensionSettingsBaseline = cloneJsonObject(extension_settings);
    Object.defineProperty(globalThis, '__homerNativeExtensionSettingsSnapshot', {
        configurable: true,
        value: () => cloneJsonObject(extensionSettingsBaseline),
    });
}

function extensionSettingsScope(appId = launch?.app_id, conversationId = launch?.conversation_id) {
    return `${String(appId || '')}\u0000${String(conversationId || '')}`;
}

function extensionSettingsSnapshot() {
    const value = cloneJsonObject(extension_settings);
    return {
        value,
        signature: JSON.stringify(value),
    };
}

async function persistExtensionSettingsSnapshot(options = {}) {
    if (extensionSettingsHydrating || !launch?.app_id || !launch?.conversation_id) {
        return false;
    }
    const appId = String(launch.app_id);
    const conversationId = String(launch.conversation_id);
    const scope = extensionSettingsScope(appId, conversationId);
    const snapshot = extensionSettingsSnapshot();
    if (scope === lastExtensionSettingsScope && snapshot.signature === lastExtensionSettingsSignature) {
        return false;
    }
    await requestJson('/api/homer/runtime-state', {
        method: 'POST',
        body: JSON.stringify({
            app_id: appId,
            conversation_id: conversationId,
            extension_settings: snapshot.value,
        }),
        keepalive: Boolean(options.keepalive) && snapshot.signature.length < 60_000,
    });
    if (scope === extensionSettingsScope()) {
        lastExtensionSettingsScope = scope;
        lastExtensionSettingsSignature = snapshot.signature;
    }
    return true;
}

function flushExtensionSettingsPersist(options = {}) {
    window.clearTimeout(extensionSettingsPersistTimer);
    extensionSettingsPersistTimer = null;
    const waiters = extensionSettingsPersistWaiters;
    extensionSettingsPersistWaiters = [];
    if (!waiters.length && !options.force) {
        return extensionSettingsPersistChain;
    }
    const persist = () => persistExtensionSettingsSnapshot(options);
    extensionSettingsPersistChain = extensionSettingsPersistChain.then(persist, persist);
    extensionSettingsPersistChain.then(
        value => waiters.forEach(waiter => waiter.resolve(value)),
        error => waiters.forEach(waiter => waiter.reject(error)),
    );
    return extensionSettingsPersistChain;
}

function saveConversationExtensionSettings() {
    if (extensionSettingsHydrating || extensionSettingsReplayInProgress) {
        return Promise.resolve(false);
    }
    if (!launch?.app_id || !launch?.conversation_id) {
        saveSettingsDebounced();
        return Promise.resolve(false);
    }
    // If a card helper changes settings during the short core-ready →
    // APP_READY overlap, the post-ready replay must use that newest state,
    // not the snapshot captured at launch. This keeps early interactivity and
    // conversation isolation compatible with extensions that save immediately.
    conversationExtensionSettings = cloneJsonObject(extension_settings);
    window.clearTimeout(extensionSettingsPersistTimer);
    const promise = new Promise((resolve, reject) => {
        extensionSettingsPersistWaiters.push({ resolve, reject });
    });
    // Card helpers commonly `await saveSettingsDebounced()` and immediately
    // refresh the parent page. The upstream debounce returns before its one-
    // second timer runs, so use a zero-delay coalescing queue whose promise only
    // resolves after the current conversation snapshot reaches Homer.
    extensionSettingsPersistTimer = window.setTimeout(() => {
        void (async () => {
            // Card helpers can mutate the public extensionSettings object while
            // an extension still holds the previous value in module-local UI
            // state. Replay the standard load event before persisting so that
            // a later native debounce cannot write the stale value back over
            // the card's change.
            const intended = cloneJsonObject(conversationExtensionSettings || extension_settings);
            extensionSettingsReplayInProgress = true;
            try {
                replaceExtensionSettings(intended);
                await eventSource.emit(event_types.SETTINGS_LOADED);
                replaceExtensionSettings(intended);
                conversationExtensionSettings = cloneJsonObject(extension_settings);
            } finally {
                extensionSettingsReplayInProgress = false;
            }
            await flushExtensionSettingsPersist();
        })().catch(error => {
            console.warn(`${MODULE_ID}: extension settings reconciliation failed`, error);
            void flushExtensionSettingsPersist();
        });
    }, 0);
    return promise;
}

function installExtensionSettingsPersistenceBridge() {
    if (extensionSettingsBridgeInstalled) {
        return;
    }
    const compatibilityApiName = ['Silly', 'Tavern'].join('');
    const compatibilityApi = globalThis[compatibilityApiName];
    if (!compatibilityApi || typeof compatibilityApi.getContext !== 'function') {
        return;
    }
    const nativeGetContext = compatibilityApi.getContext.bind(compatibilityApi);
    compatibilityApi.getContext = () => ({
        ...nativeGetContext(),
        saveSettingsDebounced: saveConversationExtensionSettings,
    });
    Object.defineProperties(compatibilityApi, {
        extensionSettings: {
            configurable: true,
            get: () => extension_settings,
        },
        extension_settings: {
            configurable: true,
            get: () => extension_settings,
        },
        saveSettingsDebounced: {
            configurable: true,
            value: saveConversationExtensionSettings,
        },
    });
    extensionSettingsBridgeInstalled = true;
}

function installEmbeddedDocumentLookupBridge() {
    if (embeddedDocumentLookupBridgeInstalled || requestedEmbed !== '1') {
        return;
    }
    let hostDocument = null;
    try {
        hostDocument = window.top !== window ? window.top.document : null;
    } catch {
        hostDocument = null;
    }
    if (!hostDocument || hostDocument === document) {
        return;
    }

    const nativeGetElementById = document.getElementById.bind(document);
    const nativeQuerySelector = document.querySelector.bind(document);
    const nativeQuerySelectorAll = document.querySelectorAll.bind(document);
    // In an ordinary top-level dialogue runtime, a card-script iframe sees the
    // same document through both window.parent and window.top. Homer's neutral
    // website shell adds one same-origin frame, so a script may mount a dialog
    // in top.document and then look it up through parent.document. Fall back to
    // the host only when the runtime document has no match, preserving normal
    // local selectors while restoring the upstream browsing-context contract.
    Object.defineProperties(document, {
        getElementById: {
            configurable: true,
            value: id => nativeGetElementById(id) || hostDocument.getElementById(id),
        },
        querySelector: {
            configurable: true,
            value: selector => nativeQuerySelector(selector) || hostDocument.querySelector(selector),
        },
        querySelectorAll: {
            configurable: true,
            value: selector => {
                const local = nativeQuerySelectorAll(selector);
                return local.length ? local : hostDocument.querySelectorAll(selector);
            },
        },
    });
    embeddedDocumentLookupBridgeInstalled = true;
}

function conversationModelSettings() {
    const saved = runtimeVariables.homer_model_settings;
    const raw = saved && typeof saved === 'object' ? saved : {};
    const allowedModels = new Set(runtimeUiData.models.map(item => String(item?.id || '')));
    const requestedModelId = String(raw.model_id || '').trim();
    const fallbackModelId = String(
        runtimeUiData.modelDefaultId
        || runtimeUiData.models.find(item => item?.is_default)?.id
        || runtimeUiData.models[0]?.id
        || '',
    );
    return {
        model_id: allowedModels.has(requestedModelId) ? requestedModelId : fallbackModelId,
        temperature: clampNumber(raw.temperature, 0, 2, DEFAULT_MODEL_SETTINGS.temperature),
        top_p: clampNumber(raw.top_p, 0, 1, DEFAULT_MODEL_SETTINGS.top_p),
        frequency_penalty: clampNumber(
            raw.frequency_penalty,
            -2,
            2,
            DEFAULT_MODEL_SETTINGS.frequency_penalty,
        ),
        presence_penalty: clampNumber(
            raw.presence_penalty,
            -2,
            2,
            DEFAULT_MODEL_SETTINGS.presence_penalty,
        ),
    };
}

function selectedModel() {
    const modelId = conversationModelSettings().model_id;
    return runtimeUiData.models.find(item => String(item?.id || '') === modelId) || null;
}

function safeSiteOrigin() {
    if (!requestedSiteOrigin) {
        return '';
    }
    try {
        const url = new URL(requestedSiteOrigin);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return '';
        }
        return url.origin === window.location.origin ? url.origin : '';
    } catch {
        return '';
    }
}

function canNotifyHost() {
    return requestedEmbed === '1'
        && requestedHostChannel === HOST_CHANNEL
        && safeSiteOrigin() === window.location.origin
        && window.parent !== window;
}

function notifyHost(type, payload = {}) {
    if (!canNotifyHost()) {
        return;
    }
    window.parent.postMessage({
        channel: HOST_CHANNEL,
        version: 1,
        type,
        ...payload,
    }, window.location.origin);
}

function currentRoleName() {
    return String(
        launch?.card?.data?.name
        || launch?.card?.name
        || launch?.conversation?.app_name
        || '角色对话',
    ).trim().slice(0, 120);
}

function notifyHostConversation(type = 'ready') {
    const payload = {
        app_id: String(launch?.app_id || '').slice(0, 160),
        conversation_id: String(launch?.conversation_id || '').slice(0, 160),
        role_name: currentRoleName(),
    };
    notifyHost('title', payload);
    notifyHost('conversation', payload);
    if (type === 'ready') {
        notifyHost('ready', payload);
    }
    scheduleHostStateNotify(0, type);
}

function notifyHostLoading(message) {
    notifyHost('loading', {
        message: String(message || '正在准备对话…').trim().slice(0, 160),
    });
}

function notifyHostError() {
    notifyHost('error', {
        code: 'DIALOGUE_START_FAILED',
        message: '对话准备失败，请重试。',
    });
}

function hostMessageSnapshot(message, index) {
    const swipes = Array.isArray(message?.swipes) ? message.swipes.map(item => String(item)) : [];
    const swipeIndex = Math.max(0, Math.min(Number(message?.swipe_id || 0), Math.max(0, swipes.length - 1)));
    const content = String(swipes.length ? swipes[swipeIndex] : message?.mes || '').slice(0, 60_000);
    const rawCreatedAt = message?.extra?.homer_created_at || message?.send_date || 0;
    const parsedCreatedAt = typeof rawCreatedAt === 'number'
        ? rawCreatedAt
        : Date.parse(String(rawCreatedAt || ''));
    return {
        id: String(
            message?.extra?.homer_message_id
            || message?.extra?.homer_sync_id
            || `${launch?.conversation_id || 'conversation'}-${index}`,
        ).slice(0, 180),
        role: message?.is_user ? 'user' : 'assistant',
        content,
        created_at: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : 0,
        swipes: swipes.slice(0, 100),
        swipe_index: swipeIndex,
    };
}

function hostConversationSnapshot(conversation) {
    return {
        id: String(conversation?.id || conversation?.conversation_id || '').slice(0, 160),
        app_id: String(conversation?.app_id || '').slice(0, 160),
        title: String(conversation?.title || conversation?.app_name || '角色对话').slice(0, 120),
        app_name: String(conversation?.app_name || conversation?.title || '角色对话').slice(0, 120),
        app_icon: String(conversation?.app_icon || '').slice(0, 2_000),
        last_message: String(conversation?.last_message || '').slice(0, 240),
        updated_at: Number(conversation?.updated_at || 0),
        pinned: Boolean(conversation?.pinned),
    };
}

function notifyHostState(reason = 'update') {
    if (!canNotifyHost() || !launch?.conversation_id) return;
    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const conversation = currentConversationRecord() || launch?.conversation || {};
    notifyHost('state', {
        reason: String(reason || 'update').slice(0, 40),
        state: {
            app_id: String(launch?.app_id || '').slice(0, 160),
            conversation_id: String(launch?.conversation_id || '').slice(0, 160),
            title: currentRoleName(),
            avatar: String(launch?.conversation?.app_icon || '').slice(0, 2_000),
            conversation: hostConversationSnapshot(conversation),
            conversations: runtimeUiData.conversations.slice(0, 100).map(hostConversationSnapshot),
            messages: chat
                .filter(message => !message?.is_system)
                .slice(-120)
                .map(hostMessageSnapshot),
            models: runtimeUiData.models.slice(0, 100).map(model => ({
                id: String(model?.id || '').slice(0, 160),
                name: String(model?.name || model?.model || model?.id || '未命名模型').slice(0, 160),
                model: String(model?.model || '').slice(0, 160),
                price_label: String(model?.price_label || '').slice(0, 120),
            })),
            model_default_id: String(runtimeUiData.modelDefaultId || '').slice(0, 160),
            model_settings: { ...conversationModelSettings() },
            generating: Boolean(generationBusy),
        },
    });
}

function scheduleHostStateNotify(delay = 80, reason = 'update') {
    if (!canNotifyHost()) return;
    window.clearTimeout(hostStateNotifyTimer);
    hostStateNotifyTimer = window.setTimeout(() => {
        hostStateNotifyTimer = null;
        notifyHostState(reason);
    }, Math.max(0, Number(delay) || 0));
}

function openHostRequestedSettings(section) {
    const target = String(section || 'drawer');
    if (target === 'drawer') {
        setDrawerOpen('right');
        return;
    }
    returnToDesktopNavigation();
    if (target === 'model') {
        document.querySelector('#homer-model-dialog')?.showModal();
        return;
    }
    if (target === 'preset') {
        setPanelOpen(true);
        return;
    }
    if (target === 'memory') {
        document.querySelector('#homer-memory-dialog')?.showModal();
        return;
    }
    if (target === 'mod') {
        document.querySelector('#homer-mod-dialog')?.showModal();
    }
}

async function receiveHostCommand(event) {
    if (!canNotifyHost() || event.origin !== window.location.origin || event.source !== window.parent) {
        return;
    }
    const message = event.data;
    if (!message || message.channel !== HOST_CHANNEL || message.version !== 1) {
        return;
    }
    if (message.type === 'request-state') {
        notifyHostState('requested');
        return;
    }
    if (message.type === 'open-settings') {
        openHostRequestedSettings(message.section);
        return;
    }
    if (message.type === 'model-settings') {
        await persistModelSettings(message.settings || {});
        buildRuntimeUi();
        notifyHostState('model-settings');
        return;
    }
    if (message.type === 'switch-conversation') {
        await switchConversation({
            id: String(message.conversation_id || ''),
            app_id: String(message.app_id || ''),
        });
        return;
    }
    if (message.type === 'message-action') {
        const context = getContext();
        const messageId = String(message.message_id || '');
        const index = context.chat.findIndex(item => stableHomerMessageId(item) === messageId
            || cloudHomerMessageId(item) === messageId);
        const target = index >= 0 ? messageMenuTargetForIndex(index) : null;
        if (target) await handleMessageMenuAction(String(message.action || ''), target);
        return;
    }
    if (message.type !== 'draft') return;
    const content = String(message.content || '').slice(0, 10_000);
    if (!content) return;
    const composer = document.querySelector('#send_textarea');
    if (!(composer instanceof HTMLTextAreaElement)) return;
    composer.value = content;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    if (message.submit === true) {
        requestAnimationFrame(() => {
            const sendButton = document.querySelector('#send_but');
            if (sendButton instanceof HTMLElement && !sendButton.matches(':disabled')) {
                sendButton.click();
            }
        });
    }
}

window.addEventListener('message', event => {
    void receiveHostCommand(event).catch(error => {
        console.warn(`${MODULE_ID}: host command failed`, error);
        notifyHost('command-error', { message: String(error?.message || '操作失败').slice(0, 200) });
    });
});

const TECHNICAL_NOTICE_PATTERN = /(?:\bMVU\b|\bSillyTavern\b|\bTavern Helper\b|脚本加载|扩展加载|插件加载|构建信息|build\s*(?:info|version)|extension\s+(?:loaded|installed))/i;

function normalizeHostNotice(message) {
    const value = String(message || '').replace(/\s+/g, ' ').trim();
    if (!value || TECHNICAL_NOTICE_PATTERN.test(value)) {
        return '';
    }
    return value.slice(0, 240);
}

function showHostNotice(message, level = 'info') {
    const text = normalizeHostNotice(message);
    if (!text || requestedEmbed !== '1') {
        return;
    }
    const root = document.querySelector('#homer-runtime-root');
    if (!root) {
        pendingHostNotices.push({ text, level });
        if (pendingHostNotices.length > 4) {
            pendingHostNotices.shift();
        }
        return;
    }
    let stack = root.querySelector('#homer-notice-stack');
    if (!stack) {
        stack = createElement('div', 'homer-notice-stack');
        stack.id = 'homer-notice-stack';
        stack.setAttribute('aria-live', 'polite');
        stack.setAttribute('aria-atomic', 'false');
        root.append(stack);
    }
    stack.replaceChildren();
    const notice = createElement('div', 'homer-notice', text);
    notice.dataset.level = ['success', 'warning', 'error'].includes(level) ? level : 'info';
    stack.append(notice);
    window.setTimeout(() => notice.remove(), 4200);
}

function flushHostNotices() {
    const notices = pendingHostNotices.splice(0);
    for (const notice of notices) {
        showHostNotice(notice.text, notice.level);
    }
}

function mirrorUpstreamToast(toast) {
    if (!(toast instanceof HTMLElement) || toast.dataset.homerNoticeHandled === '1') {
        return;
    }
    toast.dataset.homerNoticeHandled = '1';
    const title = String(toast.querySelector('.toast-title')?.textContent || '').trim();
    const message = String(toast.querySelector('.toast-message')?.textContent || toast.textContent || '').trim();
    const text = [title, message].filter(Boolean).join('：');
    const level = toast.classList.contains('toast-error')
        ? 'error'
        : toast.classList.contains('toast-warning')
            ? 'warning'
            : toast.classList.contains('toast-success')
                ? 'success'
                : 'info';
    showHostNotice(text, level);
}

function installProductSurfaceBoundary() {
    if (productSurfaceBoundaryInstalled || requestedEmbed !== '1') {
        return;
    }
    productSurfaceBoundaryInstalled = true;
    document.documentElement.classList.add('homer-embedded-runtime', 'homer-runtime-pending');

    const parking = createElement('div', 'homer-internal-parking');
    parking.id = 'homer-internal-parking';
    parking.hidden = true;
    parking.inert = true;
    parking.setAttribute('aria-hidden', 'true');
    document.body.append(parking);
    for (const selector of ['#top-bar', '#top-settings-holder']) {
        const panel = document.querySelector(selector);
        if (panel) {
            parking.append(panel);
        }
    }

    upstreamNoticeObserver = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof Element)) {
                    continue;
                }
                if (node.matches('.toast')) {
                    window.queueMicrotask(() => mirrorUpstreamToast(node));
                }
                node.querySelectorAll?.('.toast').forEach(toast => {
                    window.queueMicrotask(() => mirrorUpstreamToast(toast));
                });
            }
        }
    });
    upstreamNoticeObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function siteUrl(pathname) {
    const origin = safeSiteOrigin();
    return origin ? new URL(pathname, `${origin}/`).href : pathname;
}

function siteAssetUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) {
        return '';
    }
    try {
        const origin = safeSiteOrigin();
        const url = new URL(value, origin ? `${origin}/` : window.location.href);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function proxyExtensionAssetUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) {
        return '';
    }
    try {
        const parsed = new URL(value, safeSiteOrigin() || window.location.origin);
        const marker = '/console/api/web/dialogue/extensions/';
        const markerIndex = parsed.pathname.indexOf(marker);
        if (markerIndex < 0) {
            return value;
        }
        const suffix = parsed.pathname.slice(markerIndex + marker.length);
        return `/api/homer/extensions/${suffix}`;
    } catch {
        return value;
    }
}

async function loadAdministratorExtensions() {
    const registry = await requestJson('/api/homer/extensions');
    const list = (Array.isArray(registry) ? registry : registry?.list || []).map(item => ({
        ...item,
        js_url: proxyExtensionAssetUrl(item?.js_url),
        css_url: proxyExtensionAssetUrl(item?.css_url),
    }));
    return loadApprovedExtensions(list);
}

async function fetchSession(appId = '', conversationId = '') {
    const params = new URLSearchParams();
    if (appId) {
        params.set('app_id', appId);
    }
    if (conversationId) {
        params.set('conversation_id', conversationId);
    }
    // `URLSearchParams.prototype.size` only exists from Chrome 113. Android
    // WebView lags well behind that (the API 33 system image ships 109), and on
    // those builds `params.size` is undefined, so the query string was silently
    // dropped: the backend then answered without a `launch` payload and the app
    // died on "没有可启动的角色会话". Deriving the suffix from the serialized
    // string works on every engine.
    const query = params.toString();
    const suffix = query ? `?${query}` : '';
    try {
        const embedded = await requestJson(`/api/homer/session${suffix}`);
        if (embedded?.launch) return embedded;
    } catch (error) {
        // 嵌入式端点失败是预期路径之一，下面还有站点侧回退，这里只记日志。
        console.debug(`${MODULE_ID}: embedded session endpoint unavailable, falling back`, error);
    }
    // LAN/mobile proxies can route the embedded namespace before the Homer
    // backend route is ready. Fall back to the site-owned session endpoint,
    // which carries the same authorization and launch payload.
    const fallback = new URLSearchParams(params);
    fallback.set('launch_only', '1');
    return requestJson(`/console/api/web/dialogue/session?${fallback.toString()}`);
}

function sessionCacheKey(appId = '', conversationId = '') {
    return `${String(appId).trim()}::${String(conversationId).trim()}`;
}

function invalidateCachedSession(appId = '', conversationId = '') {
    sessionPrefetchCache.delete(sessionCacheKey(appId, conversationId));
}

function prefetchSession(appId = '', conversationId = '') {
    const key = sessionCacheKey(appId, conversationId);
    if (!appId || !conversationId) {
        return Promise.resolve(null);
    }
    const cached = sessionPrefetchCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.promise;
    }
    sessionPrefetchCache.delete(key);
    const promise = fetchSession(appId, conversationId).catch(error => {
        sessionPrefetchCache.delete(key);
        throw error;
    });
    sessionPrefetchCache.set(key, {
        promise,
        expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    });
    return promise;
}

async function takePrefetchedSession(appId = '', conversationId = '') {
    const key = sessionCacheKey(appId, conversationId);
    const promise = prefetchSession(appId, conversationId);
    try {
        return await promise;
    } finally {
        // A prefetched payload contains private messages and can be large. Use
        // it once, then release it instead of keeping a second chat in memory.
        sessionPrefetchCache.delete(key);
    }
}

function scheduleSessionPrefetch() {
    window.clearTimeout(sessionPrefetchTimer);
    sessionPrefetchTimer = window.setTimeout(() => {
        const currentId = String(launch?.conversation_id || '');
        const candidates = runtimeUiData.conversations
            .filter(item => String(item?.id || item?.conversation_id || '') !== currentId)
            .slice(0, SESSION_PREFETCH_LIMIT);
        for (const item of candidates) {
            const appId = String(item?.app_id || '').trim();
            const conversationId = String(item?.id || item?.conversation_id || '').trim();
            void prefetchSession(appId, conversationId).catch(() => {});
        }
    }, 650);
}

function setAccessClasses(user) {
    const isAdmin = Boolean(user?.is_admin);
    document.body.classList.add('homer-runtime');
    document.body.classList.toggle('homer-admin', isAdmin);
    document.body.classList.toggle('homer-user', !isAdmin);
    document.documentElement.dataset.homerRole = isAdmin ? 'administrator' : 'user';
}

function enforceStreamingConfiguration() {
    const changed = oai_settings.stream_openai !== true;
    oai_settings.stream_openai = true;
    const toggle = document.querySelector('#stream_toggle');
    if (toggle instanceof HTMLInputElement && !toggle.checked) {
        toggle.checked = true;
    }
    document.documentElement.dataset.homerStreaming = 'true';
    return changed;
}

function applyConnectionConfiguration() {
    if (!session?.runtime || !launch?.bridge_token) {
        return;
    }
    const apiBase = String(
        session.runtime.dialogue_api_base_url
        || `${session.runtime.bridge_base_url || session.runtime.backend_base_url}/console/api/web/dialogue/v1`,
    ).replace(/\/+$/, '');
    const includeHeaders = [
        `Authorization: Bearer ${launch.bridge_token}`,
        'X-Homer-Module: dialogue-module',
    ].join('\n');

    const modelSettings = conversationModelSettings();
    const modelId = modelSettings.model_id || 'homer-cloud';

    $('#main_api').val('openai');
    changeMainAPI('openai');
    oai_settings.chat_completion_source = 'custom';
    oai_settings.custom_url = apiBase;
    oai_settings.custom_model = modelId;
    oai_settings.custom_include_headers = includeHeaders;
    enforceStreamingConfiguration();
    oai_settings.bypass_status_check = true;
    oai_settings.temp_openai = modelSettings.temperature;
    oai_settings.top_p_openai = modelSettings.top_p;
    oai_settings.freq_pen_openai = modelSettings.frequency_penalty;
    oai_settings.pres_pen_openai = modelSettings.presence_penalty;
    $('#chat_completion_source').val('custom').trigger('change');
    $('#custom_api_url_text').val(apiBase);
    $('#custom_model_id').val(modelId);
    $('#custom_include_headers').val(includeHeaders);
    $('#temp_openai').val(modelSettings.temperature);
    $('#top_p_openai').val(modelSettings.top_p);
    $('#freq_pen_openai').val(modelSettings.frequency_penalty);
    $('#pres_pen_openai').val(modelSettings.presence_penalty);
    setOnlineStatus(modelId);
    const composer = document.querySelector('#send_textarea');
    if (composer instanceof HTMLTextAreaElement) {
        composer.disabled = false;
        composer.placeholder = '输入想发送的消息';
    }
    saveSettingsDebounced();
}

function reaffirmConversationConnection() {
    const modelId = conversationModelSettings().model_id || 'homer-cloud';
    enforceStreamingConfiguration();
    setOnlineStatus(modelId);
    const composer = document.querySelector('#send_textarea');
    if (composer instanceof HTMLTextAreaElement) {
        composer.disabled = false;
        composer.placeholder = '输入想发送的消息';
    }
}

async function refreshBridgeToken() {
    if (!launch?.app_id || !launch?.conversation_id) {
        return;
    }
    try {
        const refreshed = await fetchSession(launch.app_id, launch.conversation_id);
        if (refreshed?.launch?.bridge_token) {
            session = refreshed;
            launch = refreshed.launch;
            applyConnectionConfiguration();
            updateRuntimeStatus('已连接', 'online');
        }
    } catch (error) {
        console.warn(`${MODULE_ID}: bridge token refresh failed`, error);
        updateRuntimeStatus('连接待刷新', 'warning');
    }
}

function installTokenRefresh() {
    window.clearInterval(tokenRefreshTimer);
    const ttl = Math.max(120, Number(launch?.bridge_token_ttl_seconds || 900));
    tokenRefreshTimer = window.setInterval(refreshBridgeToken, Math.max(60, ttl - 120) * 1000);
}

function cardFingerprint(card) {
    const text = JSON.stringify(card || {});
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `v2-${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

function cloneCardWithMarker(card) {
    const copy = JSON.parse(JSON.stringify(card || {}));
    const cardSignature = cardFingerprint(copy);
    copy.spec = copy.spec || 'chara_card_v2';
    copy.spec_version = copy.spec_version || '2.0';
    copy.data = copy.data && typeof copy.data === 'object' ? copy.data : {};
    copy.data.extensions = copy.data.extensions && typeof copy.data.extensions === 'object'
        ? copy.data.extensions
        : {};
    copy.data.extensions.homer_bridge = {
        app_id: launch.app_id,
        source: 'homer-cloud',
        card_signature: cardSignature,
        imported_at: new Date().toISOString(),
    };
    copy.data.name = String(copy.data.name || copy.name || '惑梦角色');
    copy.name = copy.data.name;
    return copy;
}

async function waitForStableCharacterForm(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let stableChecks = 0;
    while (Date.now() < deadline) {
        const runtimeShells = [...document.querySelectorAll('#sheld')];
        if (runtimeShells.length > 1) {
            const canonicalShell = runtimeShells.reduce((best, candidate) => {
                const rect = candidate.getBoundingClientRect();
                const area = rect.width * rect.height;
                const bestRect = best.getBoundingClientRect();
                return area >= bestRect.width * bestRect.height ? candidate : best;
            });
            for (const shell of runtimeShells) {
                if (shell !== canonicalShell) {
                    shell.remove();
                }
            }
        }
        const editorPanels = [...document.querySelectorAll('#rm_ch_create_block')];
        // Some extension UI transitions leave a hidden clone of the entire
        // character editor behind. Its fields still target form="form_create",
        // so submitting the canonical form would turn string values into
        // arrays. Keep SillyTavern's first editor and discard only duplicate
        // siblings inside the Homer runtime.
        for (const duplicatePanel of editorPanels.slice(1)) {
            duplicatePanel.remove();
        }
        const seenFormControlIds = new Set();
        const formControls = [...document.querySelectorAll('[id]')]
            .filter(element => element.form?.id === 'form_create');
        for (const control of formControls) {
            if (seenFormControlIds.has(control.id)) {
                control.remove();
                continue;
            }
            seenFormControlIds.add(control.id);
        }
        const formCount = document.querySelectorAll('#form_create').length;
        const formAnimating = $('#form_create:animated').length > 0;
        if (formCount === 1 && !formAnimating) {
            stableChecks += 1;
            if (stableChecks >= 2) {
                return;
            }
        } else {
            stableChecks = 0;
        }
        await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    throw new Error('角色编辑器尚未完成初始化');
}

function enableEmbeddedCardCapabilities(character) {
    if (!character || typeof character !== 'object') {
        return;
    }
    // Homer launches cards chosen from its own library/import flow. Card-scoped
    // regex and TavernHelper scripts are therefore runtime content, not an
    // extension-install permission. Keep extension mutation admin-only while
    // allowing the selected card to behave exactly as it does in SillyTavern.
    allowScopedScripts(character);

    if (character.avatar && character?.data?.character_book) {
        accountStorage.setItem(`AlertWI_${character.avatar}`, 'true');
    }
}

function installCsrfAjaxBridge() {
    const jquery = window.jQuery;
    if (typeof jquery?.ajaxPrefilter !== 'function' || jquery.__homerCsrfPrefilterInstalled) {
        return;
    }
    // TavernHelper intentionally provides isolated jQuery contexts to card
    // scripts. Re-register the SillyTavern CSRF header on the currently active
    // root jQuery instance so legacy synchronous tokenizer calls keep working.
    jquery.ajaxPrefilter((_options, _originalOptions, xhr) => {
        const token = getRequestHeaders()['X-CSRF-Token'];
        if (token) {
            xhr.setRequestHeader('X-CSRF-Token', token);
        }
    });
    Object.defineProperty(jquery, '__homerCsrfPrefilterInstalled', {
        configurable: true,
        value: true,
    });
}

async function ensureEmbeddedWorldInfo(characterId, character) {
    const embeddedBook = character?.data?.character_book;
    if (!embeddedBook || typeof embeddedBook !== 'object') {
        return;
    }
    const bookName = String(embeddedBook.name || `${character?.name || 'Character'}'s Lorebook`).trim();
    if (!bookName) {
        return;
    }

    if (!world_names.includes(bookName)) {
        await updateWorldInfoList();
    }
    if (!world_names.includes(bookName)) {
        // SillyTavern's official importer reads the target character id from
        // this control. Homer selects cards programmatically, so populate the
        // same state the native character panel normally supplies.
        $('#import_character_info').data('chid', characterId);
        await importEmbeddedWorldInfo(true);
    } else if (String(character?.data?.extensions?.world || '') !== bookName) {
        // Preserve an existing (possibly user-edited) book and only link it.
        $('#character_world').val(bookName).trigger('change');
    }
}

async function enableTavernHelperCardScripts(character) {
    const scripts = character?.data?.extensions?.tavern_helper?.scripts;
    if (!Array.isArray(scripts) || scripts.length === 0) {
        return;
    }
    const deadline = Date.now() + 5000;
    let toggle = null;
    while (Date.now() < deadline && !toggle) {
        const scriptTrees = [...document.querySelectorAll('[data-container-type]')];
        const characterTreeIndex = scriptTrees.findIndex(
            element => element.getAttribute('data-container-type') === 'character',
        );
        const toggles = [...document.querySelectorAll('input[id$="-script-enable-toggle"]')];
        if (characterTreeIndex >= 0 && toggles[characterTreeIndex] instanceof HTMLInputElement) {
            toggle = toggles[characterTreeIndex];
        }
        if (!toggle) {
            await new Promise(resolve => window.setTimeout(resolve, 100));
        }
    }
    if (!toggle) {
        throw new Error('TavernHelper 角色脚本开关尚未就绪');
    }
    if (toggle.checked) {
        return;
    }
    const avatar = String(character?.avatar || '').trim();
    const cardSignature = String(character?.data?.extensions?.homer_bridge?.card_signature || '').trim();
    const scriptSignature = cardSignature || scripts.map(script => [
        String(script?.id || ''),
        String(script?.name || ''),
        String(script?.content || '').length,
    ].join(':')).join('|');
    const trustKey = avatar ? `homer-card-script-ready:${avatar}` : '';
    const previouslyReady = Boolean(
        trustKey
        && scriptSignature
        && localStorage.getItem(trustKey) === scriptSignature,
    );
    toggle.click();

    const characterName = String(character.name || character.data?.name || '').trim();
    const promptDeadline = Date.now() + 5000;
    let checkedSince = 0;
    while (Date.now() < promptDeadline) {
        let confirmed = false;
        for (const dialog of document.querySelectorAll('dialog.popup[open]')) {
            const text = String(dialog.textContent || '');
            const isTavernHelperCardPrompt = text.includes(characterName)
                && (text.includes('酒馆助手') || text.includes('Tavern Helper'))
                && (text.includes('脚本') || text.toLowerCase().includes('script'));
            if (!isTavernHelperCardPrompt) {
                continue;
            }
            const confirm = dialog.querySelector('.popup-button-ok');
            if (confirm instanceof HTMLElement) {
                confirm.click();
                if (trustKey && scriptSignature) {
                    localStorage.setItem(trustKey, scriptSignature);
                }
                confirmed = true;
            }
        }
        if (confirmed) {
            return;
        }
        if (toggle.checked) {
            checkedSince ||= Date.now();
            // Some cards/accounts have already accepted the script policy, so
            // TavernHelper applies the toggle without opening a dialog. Do not
            // pay the full dialog timeout in that normal path; leave enough of
            // a settle window for a deferred confirmation popup to appear.
            const settleMs = previouslyReady ? 75 : 500;
            if (Date.now() - checkedSince >= settleMs) {
                if (trustKey && scriptSignature) {
                    localStorage.setItem(trustKey, scriptSignature);
                }
                return;
            }
        } else {
            checkedSince = 0;
        }
        await new Promise(resolve => window.setTimeout(resolve, 100));
    }
}

async function selectLaunchCharacter(context, characterId, options = {}) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        await context.selectCharacterById(characterId, options);
        // getContext() returns a snapshot. Re-read it after every attempted
        // switch; checking the launch-time snapshot falsely reports failure
        // even though selectCharacterById has already updated the live state.
        if (String(getContext().characterId) === String(characterId)) {
            return;
        }
        // SillyTavern intentionally ignores character switches while a local
        // chat save is settling. A rapid same-tab relaunch should wait and
        // retry, not continue with an undefined/previous character context.
        await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    throw new Error('当前角色会话仍在保存，请稍后重试');
}

async function openLaunchCharacterChat(characterId, { reuseActiveCharacter = false } = {}) {
    const context = getContext();
    const localChatName = `Homer-${String(launch.conversation_id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
    let character = context.characters?.[characterId];
    enableEmbeddedCardCapabilities(character);
    if (reuseActiveCharacter && String(context.characterId) === String(characterId)) {
        // Switching between two cloud conversations of the same card must not
        // re-select/unshallow the character, rescan its worldbook, or re-run
        // already enabled card scripts. Only bind the new local mirror; the
        // cloud payload replaces its messages immediately afterwards.
        installCsrfAjaxBridge();
        if (typeof context.bindCharacterChatWithoutLoad === 'function') {
            await context.bindCharacterChatWithoutLoad(localChatName);
        } else {
            await context.openCharacterChat(localChatName, { persistCharacter: false });
        }
        setOnlineStatus(conversationModelSettings().model_id || 'homer-cloud');
        return;
    }
    // Establish the active character without loading its previous local ST chat.
    // The product opens the cloud-bound mirror below, so loading both chats adds
    // a redundant message render, sprite scan and CHAT_CHANGED lifecycle.
    await selectLaunchCharacter(context, characterId, { switchMenu: false, skipChatLoad: true });
    // A same-character selection unshallows the card and binds the edit form.
    await context.selectCharacterById(characterId, {
        switchMenu: false,
        persistSelection: false,
    });
    await waitForStableCharacterForm();
    character = context.characters?.[characterId];
    await ensureEmbeddedWorldInfo(characterId, character);
    installCsrfAjaxBridge();
    await context.openCharacterChat(localChatName, { persistCharacter: false });
    // TavernHelper creates its character-scoped script store on CHAT_CHANGED.
    // Open the one requested chat first, then enable its card scripts without
    // loading the character's unrelated previous local chat.
    await enableTavernHelperCardScripts(character);
    // Updating the API source can animate the chat shell and briefly leave a
    // hidden duplicate. Broadcast the connected state again after the visible
    // canonical shell has been selected.
    setOnlineStatus(conversationModelSettings().model_id || 'homer-cloud');
}

function getManagedCoverUrl() {
    const raw = String(launch?.card?.data?.extensions?.homer_cover_url || '').trim();
    return siteAssetUrl(raw);
}

// 生成失败恢复。上游返回空回复时 SillyTavern 会留下一条空的 assistant 占位，
// 用户看到的是「发出去了但永远没有回复」。这里在 GENERATION_STARTED 时拍一份
// 快照，结束时若检测到空占位/多出的用户消息，就整轮回滚并明确提示。
function cloneGenerationMessages(messages) {
    try {
        return structuredClone(Array.isArray(messages) ? messages : []);
    } catch {
        try {
            return JSON.parse(JSON.stringify(Array.isArray(messages) ? messages : []));
        } catch {
            return [];
        }
    }
}

function isAssistantChatMessage(message) {
    return Boolean(message) && !message.is_user && !message.is_system
        && String(message.role || 'assistant').toLowerCase() !== 'user';
}

function selectedChatMessageContent(message) {
    if (!message) {
        return '';
    }
    const swipes = Array.isArray(message.swipes) ? message.swipes : [];
    if (swipes.length) {
        const swipeIndex = Math.max(0, Math.min(Number(message.swipe_id || 0), swipes.length - 1));
        return String(swipes[swipeIndex] ?? '');
    }
    return String(message.mes ?? message.content ?? '');
}

function isEmptyGeneratedAssistant(message) {
    if (!isAssistantChatMessage(message)) {
        return false;
    }
    const content = selectedChatMessageContent(message).replace(/​/g, '').trim();
    return ['', '...', '…'].includes(content);
}

function captureGenerationSnapshot(type) {
    const context = getContext();
    return {
        type: String(type || ''),
        chatId: String(context.chatId || ''),
        chat: cloneGenerationMessages(context.chat),
        launchMessages: cloneGenerationMessages(launch?.messages),
    };
}

function generationNeedsRecovery(snapshot, currentChat) {
    if (!snapshot || !Array.isArray(currentChat)) {
        return false;
    }
    const lastMessage = currentChat.at(-1);
    if (isEmptyGeneratedAssistant(lastMessage)) {
        return true;
    }
    if (currentChat.length > snapshot.chat.length && lastMessage?.is_user) {
        return true;
    }
    return ['regenerate', 'swipe'].includes(snapshot.type)
        && currentChat.length < snapshot.chat.length;
}

async function syncLaunchCharacterAvatar(character, force = false) {
    const coverUrl = getManagedCoverUrl();
    const avatar = String(character?.avatar || '').trim();
    if (!coverUrl || !avatar) {
        return false;
    }
    const markerKey = `homer-avatar-sync:${String(launch.app_id || '')}`;
    if (!force && accountStorage.getItem(markerKey) === coverUrl) {
        return false;
    }

    let coverBlob;
    try {
        const coverResponse = await fetch(coverUrl, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'include',
        });
        if (!coverResponse.ok) {
            console.warn(`${MODULE_ID}: cover unavailable (HTTP ${coverResponse.status})`);
            return false;
        }
        coverBlob = await coverResponse.blob();
        if (!String(coverBlob.type || '').toLowerCase().startsWith('image/')) {
            console.warn(`${MODULE_ID}: cover response is not an image; keeping the card avatar`);
            return false;
        }
    } catch (error) {
        console.warn(`${MODULE_ID}: cover synchronization skipped`, error);
        return false;
    }

    const formData = new FormData();
    formData.append('avatar', new File([coverBlob], 'avatar.png', {
        type: coverBlob.type || 'image/png',
    }));
    formData.append('avatar_url', avatar);
    const uploadResponse = await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-store',
    });
    if (!uploadResponse.ok) {
        console.warn(`${MODULE_ID}: avatar upload skipped (HTTP ${uploadResponse.status})`);
        return false;
    }
    accountStorage.setItem(markerKey, coverUrl);

    // Make both the character list and already-rendered message avatars observe
    // the new pixels immediately, while leaving the card metadata untouched.
    const cacheBuster = `homer_cover=${Date.now()}`;
    for (const image of document.querySelectorAll('img')) {
        if (!(image instanceof HTMLImageElement)) {
            continue;
        }
        const src = String(image.getAttribute('src') || '');
        if (!src.includes(encodeURIComponent(avatar)) && !src.includes(avatar)) {
            continue;
        }
        const separator = src.includes('?') ? '&' : '?';
        image.src = `${src}${separator}${cacheBuster}`;
    }
    return true;
}

async function importLaunchCardJson(card, preservedName) {
    const formData = new FormData();
    formData.append(
        'avatar',
        new File([JSON.stringify(card)], `${preservedName}.json`, { type: 'application/json' }),
    );
    formData.append('file_type', 'json');
    formData.append('user_name', String(session?.user?.name || 'Homer 用户'));
    formData.append('preserved_name', preservedName);
    const response = await fetch('/api/characters/import', {
        method: 'POST',
        body: formData,
        headers: getContext().getRequestHeaders({ omitContentType: true }),
        cache: 'no-store',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.error || !result?.file_name) {
        throw new Error('角色卡载入失败');
    }
    return `${String(result.file_name).replace(/\.png$/i, '')}.png`;
}

async function importLaunchCharacter({ reuseActiveCharacter = false } = {}) {
    const context = getContext();
    const card = cloneCardWithMarker(launch.card);
    const safeKey = String(launch.app_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'character';
    const preservedName = `homer-${safeKey}`;
    const expectedAvatar = `${preservedName}.png`;
    let characterId = context.characters.findIndex(item => (
        String(item?.data?.extensions?.homer_bridge?.app_id || '') === String(launch.app_id)
        || item?.avatar === expectedAvatar
    ));
    if (characterId >= 0) {
        const currentSignature = String(
            context.characters[characterId]?.data?.extensions?.homer_bridge?.card_signature || '',
        );
        const desiredSignature = String(card.data.extensions.homer_bridge.card_signature || '');
        const metadataChanged = !currentSignature || currentSignature !== desiredSignature;
        if (metadataChanged) {
            await importLaunchCardJson(card, preservedName);
            await context.getCharacters();
            characterId = context.characters.findIndex(item => (
                String(item?.data?.extensions?.homer_bridge?.app_id || '') === String(launch.app_id)
                || item?.avatar === expectedAvatar
            ));
            if (characterId < 0) {
                throw new Error('角色卡元数据刷新后未找到角色卡');
            }
        }
        // An unchanged imported card already owns the persisted avatar file.
        // Re-uploading the same multi-megabyte cover for every fresh browser
        // session was pure startup work and also forced another full character
        // list refresh. A changed card is re-imported and explicitly refreshed.
        if (metadataChanged) {
            const avatarChanged = await syncLaunchCharacterAvatar(context.characters[characterId], true);
            if (avatarChanged) {
                await context.getCharacters();
                characterId = context.characters.findIndex(item => (
                    String(item?.data?.extensions?.homer_bridge?.app_id || '') === String(launch.app_id)
                    || item?.avatar === expectedAvatar
                ));
                if (characterId < 0) {
                    throw new Error('头像同步后未找到角色卡');
                }
            }
        }
        await openLaunchCharacterChat(characterId, {
            reuseActiveCharacter: reuseActiveCharacter && !metadataChanged,
        });
        return;
    }

    const avatar = await importLaunchCardJson(card, preservedName);
    await context.getCharacters();
    characterId = context.characters.findIndex(item => item?.avatar === avatar);
    if (characterId < 0) {
        characterId = context.characters.findIndex(item => item?.name === card.data.name);
    }
    if (characterId < 0) {
        throw new Error('导入后未找到角色卡');
    }
    const avatarChanged = await syncLaunchCharacterAvatar(context.characters[characterId], true);
    if (avatarChanged) {
        await context.getCharacters();
        characterId = context.characters.findIndex(item => item?.avatar === avatar);
        if (characterId < 0) {
            throw new Error('头像同步后未找到角色卡');
        }
    }
    await openLaunchCharacterChat(characterId);
}

function cloudMessageToDialogue(message, index) {
    const role = String(message?.role || 'assistant');
    const isUser = role === 'user';
    const isSystem = role === 'system';
    const content = String(message?.content || '');
    const createdAt = Number(message?.created_at || Date.now() + index);
    const swipes = Array.isArray(message?.swipes)
        ? message.swipes.map(item => String(item))
        : [];
    const swipeId = Math.max(0, Math.min(Number(message?.swipe_index || 0), Math.max(0, swipes.length - 1)));
    return {
        name: isUser ? String(session?.user?.name || '你') : String(launch?.card?.data?.name || launch?.card?.name || '角色'),
        is_user: isUser,
        is_system: isSystem,
        send_date: new Date(createdAt).toISOString(),
        mes: swipes.length ? swipes[swipeId] : content,
        swipes,
        swipe_id: swipeId,
        swipe_info: swipes.map(() => ({
            send_date: new Date(createdAt).toISOString(),
            gen_started: null,
            gen_finished: null,
            extra: {},
        })),
        extra: {
            homer_message_id: String(message?.id || ''),
            homer_sync_id: String(message?.id || `cloud-${index}`),
            homer_created_at: createdAt,
        },
    };
}

function initialGreetingMessage() {
    const card = launch?.card || {};
    const data = card.data || {};
    const text = String(data.first_mes || card.first_mes || '').trim();
    if (!text) {
        return null;
    }
    return {
        name: String(data.name || card.name || '角色'),
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: text,
        swipes: [text],
        swipe_id: 0,
        swipe_info: [{
            send_date: new Date().toISOString(),
            gen_started: null,
            gen_finished: null,
            extra: {},
        }],
        extra: {
            homer_sync_id: `greeting-${launch.conversation_id}`,
            homer_created_at: Date.now(),
        },
    };
}

async function loadCloudChat({ emitChatChanged = false } = {}) {
    suppressSync = true;
    const context = getContext();
    const messages = Array.isArray(launch.messages)
        ? launch.messages.map(cloudMessageToDialogue)
        : [];
    if (!messages.length) {
        const greeting = initialGreetingMessage();
        if (greeting) {
            messages.push(greeting);
        }
    }
    context.chat.splice(0, context.chat.length, ...messages);
    context.chatMetadata.homer_bridge = {
        app_id: launch.app_id,
        conversation_id: launch.conversation_id,
        runtime: 'dialogue',
    };
    delete context.chatMetadata.homer_preset_overrides;
    context.chatMetadata.homer_model_settings = { ...conversationModelSettings() };
    // The cloud conversation is authoritative. Paint it immediately; a fresh
    // embedded page must not block interactivity on two redundant writes to
    // SillyTavern's compatibility mirror. Normal generation/save hooks keep
    // that mirror current after the user actually changes the conversation.
    await context.printMessages();
    if (emitChatChanged) {
        performance.mark('homer-switch-messages');
    }
    queueMessageMenuRender();
    if (emitChatChanged) {
        await eventSource.emit(event_types.CHAT_CHANGED, context.chatId);
    }
    await eventSource.emit(event_types.CHAT_LOADED, context.chatId);
    suppressSync = false;
    scheduleSync(100);
    scheduleHostStateNotify(0, 'chat-loaded');
}

function serializeChat() {
    const context = getContext();
    return context.chat.map((message, index) => ({
        name: String(message?.name || ''),
        is_user: Boolean(message?.is_user),
        is_system: Boolean(message?.is_system),
        send_date: String(message?.send_date || ''),
        mes: String(message?.mes || ''),
        swipes: Array.isArray(message?.swipes) ? message.swipes.map(item => String(item)) : [],
        swipe_id: Number(message?.swipe_id || 0),
        extra: {
            ...(message?.extra && typeof message.extra === 'object' ? message.extra : {}),
            homer_sync_id: String(
                message?.extra?.homer_sync_id
                || message?.extra?.homer_message_id
                || `${launch.conversation_id}-${message?.send_date || index}-${index}`,
            ),
        },
    }));
}

async function recoverFailedGeneration(snapshot) {
    const context = getContext();
    if (!snapshot || String(context.chatId || '') !== snapshot.chatId) {
        return false;
    }
    if (!generationNeedsRecovery(snapshot, context.chat)) {
        scheduleSync(100);
        return false;
    }

    const previousSuppressSync = suppressSync;
    suppressSync = true;
    try {
        context.chat.splice(0, context.chat.length, ...cloneGenerationMessages(snapshot.chat));
        if (Array.isArray(launch?.messages)) {
            launch.messages.splice(
                0,
                launch.messages.length,
                ...cloneGenerationMessages(snapshot.launchMessages),
            );
        }
        try {
            await context.saveChat();
        } catch (error) {
            console.warn(`${MODULE_ID}: failed generation mirror was not saved locally`, error);
        }
        await context.printMessages();
        dialogueEventLogMuted += 1;
        try {
            await eventSource.emit(event_types.CHAT_LOADED, context.chatId);
        } finally {
            dialogueEventLogMuted = Math.max(0, dialogueEventLogMuted - 1);
        }
    } finally {
        suppressSync = previousSuppressSync;
    }

    lastSyncSignature = '';
    await syncCloudChat();
    const errorMessage = '模型未返回有效回复，本轮消息已撤回。请稍后重试或切换模型。';
    showHostNotice(errorMessage, 'error');
    updateRuntimeStatus('生成失败，消息已撤回', 'warning');
    queueMessageMenuRender();
    return true;
}

async function syncCloudChat() {
    if (suppressSync || !launch?.app_id || !launch?.conversation_id) {
        return;
    }
    const messages = serializeChat();
    const signature = JSON.stringify(messages);
    if (signature === lastSyncSignature) {
        return;
    }
    try {
        const result = await requestJson('/api/homer/sync', {
            method: 'POST',
            body: JSON.stringify({
                app_id: launch.app_id,
                conversation_id: launch.conversation_id,
                title: String(launch?.card?.data?.name || launch?.card?.name || '角色对话'),
                messages,
            }),
        });
        lastSyncSignature = signature;
        const synced = Array.isArray(result?.messages) ? result.messages : [];
        const context = getContext();
        synced.forEach((message, index) => {
            if (!context.chat[index]) {
                return;
            }
            context.chat[index].extra = {
                ...(context.chat[index].extra || {}),
                homer_message_id: String(message?.id || ''),
                homer_sync_id: String(message?.id || context.chat[index].extra?.homer_sync_id || ''),
                homer_created_at: Number(message?.created_at || context.chat[index].extra?.homer_created_at || Date.now()),
            };
        });
        queueMessageMenuRender();
        updateRuntimeStatus('云端已同步', 'online');
    } catch (error) {
        console.warn(`${MODULE_ID}: cloud sync failed`, error);
        updateRuntimeStatus('等待同步', 'warning');
    }
}

function scheduleSync(delay = 900) {
    if (suppressSync) {
        return;
    }
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(syncCloudChat, delay);
}

function confirmHomerAction({
    id = 'homer-confirm-dialog',
    eyebrow = '当前对话',
    title = '确认操作',
    notice = '',
    confirmLabel = '确认',
    danger = false,
} = {}) {
    const existing = document.querySelector(`#${id}`);
    existing?.close();
    existing?.remove();
    const dialog = createElement('dialog', 'homer-sheet-dialog homer-confirm-dialog');
    dialog.id = id;
    const shell = createElement('form', 'homer-sheet-dialog__shell');
    shell.method = 'dialog';
    const head = createElement('header', 'homer-sheet-dialog__head');
    const copy = createElement('div');
    copy.append(
        createElement('div', 'homer-preset-panel__eyebrow', eyebrow),
        createElement('h2', 'homer-sheet-dialog__title', title),
    );
    head.append(copy);
    shell.append(
        head,
        createElement('p', 'homer-sheet-dialog__notice', notice),
    );
    const actions = createElement('footer', 'homer-sheet-dialog__actions');
    const cancel = createElement('button', 'homer-secondary-button', '取消');
    cancel.type = 'submit';
    cancel.value = 'cancel';
    const confirm = createElement(
        'button',
        danger ? 'homer-primary-button homer-danger-button' : 'homer-primary-button',
        confirmLabel,
    );
    confirm.type = 'submit';
    confirm.value = 'confirm';
    actions.append(cancel, confirm);
    shell.append(actions);
    dialog.append(shell);
    document.body.append(dialog);
    return new Promise(resolve => {
        dialog.addEventListener('close', () => {
            const accepted = dialog.returnValue === 'confirm';
            dialog.remove();
            resolve(accepted);
        }, { once: true });
        dialog.showModal();
    });
}

function confirmRollback(messageIndex) {
    return confirmHomerAction({
        id: 'homer-rollback-dialog',
        title: '确认回溯',
        notice: `将移除第 ${messageIndex + 1} 条及之后的消息；当前页面会立即更新，无需刷新。`,
        confirmLabel: '确认回溯',
        danger: true,
    });
}

async function rollbackToMessage(target, { askConfirmation = true } = {}) {
    let resolved = resolveMessageMenuTarget(target);
    let index = resolved?.messageIndex ?? -1;
    let message = resolved?.message || null;
    let messageId = cloudHomerMessageId(message);
    if (!message || !messageId) {
        showHostNotice('这条消息仍在同步，请稍后再回溯', 'warning');
        return false;
    }
    if (rollbackBusy || generationBusy || loadingLaunch) {
        showHostNotice(generationBusy ? '回复生成完成后才能回溯' : '当前操作尚未完成，请稍候', 'warning');
        return false;
    }
    if (askConfirmation && !await confirmRollback(index)) {
        return false;
    }

    resolved = resolveMessageMenuTarget(target);
    index = resolved?.messageIndex ?? -1;
    message = resolved?.message || null;
    messageId = cloudHomerMessageId(message);
    if (!message || !messageId) {
        showHostNotice('目标消息已经变化，未执行回溯', 'warning');
        return false;
    }

    rollbackBusy = true;
    document.body.classList.add('homer-rollback-busy');
    queueMessageMenuRender();
    const previousSuppressSync = suppressSync;
    try {
        const result = await requestJson(
            siteUrl(`/console/api/web/messages/${encodeURIComponent(messageId)}/rollback`),
            { method: 'POST', body: '{}' },
        );
        const context = getContext();
        suppressSync = true;
        context.chat.splice(index);
        if (Array.isArray(launch?.messages)) {
            const launchIndex = launch.messages.findIndex(item => String(item?.id || '') === messageId);
            if (launchIndex >= 0) {
                launch.messages.splice(launchIndex);
            }
        }
        try {
            await context.saveChat();
        } catch (error) {
            console.warn(`${MODULE_ID}: rolled-back local mirror was not saved`, error);
        }
        await context.printMessages();
        dialogueEventLogMuted += 1;
        try {
            await eventSource.emit(event_types.MESSAGE_DELETED, context.chat.length);
            await eventSource.emit(event_types.CHAT_LOADED, context.chatId);
        } finally {
            dialogueEventLogMuted = Math.max(0, dialogueEventLogMuted - 1);
        }
        lastSyncSignature = JSON.stringify(serializeChat());
        await logDialogueEvent('rewind', index, message);
        closeMessageMenu();
        queueMessageMenuRender();
        updateRuntimeStatus('云端已同步', 'online');
        showHostNotice(`已回溯，移除 ${Number(result?.deleted_count || 0)} 条消息`, 'success');
        return true;
    } catch (error) {
        console.error(`${MODULE_ID}: rollback failed`, error);
        showHostNotice(String(error?.message || '回溯失败，请重试'), 'error');
        return false;
    } finally {
        suppressSync = previousSuppressSync;
        rollbackBusy = false;
        document.body.classList.remove('homer-rollback-busy');
        queueMessageMenuRender();
    }
}

async function loadRuntimeState() {
    const state = await requestJson(
        `/api/homer/runtime-state?${queryString(launch.app_id, launch.conversation_id)}`,
    );
    const savedExtensionSettings = state?.extension_settings
        && typeof state.extension_settings === 'object'
        && !Array.isArray(state.extension_settings)
        ? state.extension_settings
        : {};
    const restoredExtensionSettings = cloneJsonObject(extensionSettingsBaseline || {});
    if (Object.keys(savedExtensionSettings).length) {
        synchronizeJsonContainer(restoredExtensionSettings, savedExtensionSettings);
    }
    conversationExtensionSettings = cloneJsonObject(restoredExtensionSettings || {});
    replaceExtensionSettings(conversationExtensionSettings);
    // Extensions that mirror settings into controls or module-local state have
    // already handled the native global load by this point. Re-emit the normal
    // loaded signal after applying the conversation overlay so those mirrors do
    // not later write stale global values back into the active conversation.
    await eventSource.emit(event_types.SETTINGS_LOADED);
    // Some third-party extensions finalize module-local defaults on APP_READY.
    // When the embedded bridge starts from the earlier core-ready signal, one
    // post-ready replay is required so those defaults cannot overwrite the
    // conversation-scoped state that was just restored.
    reaffirmExtensionSettingsAfterReady = !applicationReady;
    const extensionSnapshot = extensionSettingsSnapshot();
    lastExtensionSettingsScope = extensionSettingsScope();
    lastExtensionSettingsSignature = extensionSnapshot.signature;
    runtimeVariables = state?.variables && typeof state.variables === 'object'
        ? { ...state.variables }
        : {};
    delete runtimeVariables.homer_preset_overrides;
}

async function persistRuntimeVariables() {
    const context = getContext();
    delete context.chatMetadata.homer_preset_overrides;
    context.chatMetadata.homer_model_settings = { ...conversationModelSettings() };
    await requestJson('/api/homer/runtime-state', {
        method: 'POST',
        body: JSON.stringify({
            app_id: launch.app_id,
            conversation_id: launch.conversation_id,
            variables: runtimeVariables,
        }),
    });
}

async function persistModelSettings(settings) {
    runtimeVariables = {
        ...runtimeVariables,
        homer_model_settings: {
            model_id: String(settings.model_id || ''),
            temperature: clampNumber(settings.temperature, 0, 2, 1),
            top_p: clampNumber(settings.top_p, 0, 1, 1),
            frequency_penalty: clampNumber(settings.frequency_penalty, -2, 2, 0),
            presence_penalty: clampNumber(settings.presence_penalty, -2, 2, 0),
        },
    };
    await persistRuntimeVariables();
    applyConnectionConfiguration();
    if (launch?.conversation_id) {
        launch.runtime_config = await requestJson(
            `/api/homer/conversations/${encodeURIComponent(launch.conversation_id)}/runtime-config`,
        );
        renderPresetLists(presetSearchQuery);
    }
    scheduleHostStateNotify(0, 'model-settings');
}

function payloadList(payload) {
    if (Array.isArray(payload)) {
        return payload;
    }
    return Array.isArray(payload?.list) ? payload.list : [];
}

async function loadRuntimeUiData() {
    const conversationId = String(launch?.conversation_id || '');
    const [modelsResult, modLibraryResult, conversationModsResult] = await Promise.allSettled([
        requestJson('/api/homer/models'),
        requestJson('/api/homer/mods/library'),
        requestJson(`/api/homer/mods/conversation/${encodeURIComponent(conversationId)}`),
    ]);
    const modelsPayload = modelsResult.status === 'fulfilled' ? modelsResult.value : {};
    const modLibraryPayload = modLibraryResult.status === 'fulfilled' ? modLibraryResult.value : {};
    const conversationModsPayload = conversationModsResult.status === 'fulfilled'
        ? conversationModsResult.value
        : {};
    runtimeUiData = {
        conversations: runtimeUiData.conversations,
        models: payloadList(modelsPayload).filter(item => item?.enabled !== false),
        modelDefaultId: String(modelsPayload?.default_id || ''),
        mods: payloadList(modLibraryPayload),
        activeModIds: payloadList(conversationModsPayload)
            .map(item => String(item?.id || item?.mod_id || ''))
            .filter(Boolean),
    };
}

async function loadConversationHistory() {
    try {
        const conversationsPayload = await requestJson('/api/homer/conversations');
        runtimeUiData = {
            ...runtimeUiData,
            conversations: payloadList(conversationsPayload),
        };
        populateHistoryList(
            document.querySelector('#homer-history-count'),
            document.querySelector('#homer-history-list'),
        );
        scheduleHostStateNotify(0, 'history');
        scheduleSessionPrefetch();
    } catch (error) {
        console.warn(`${MODULE_ID}: conversation history load failed`, error);
    }
}

function formatConversationTime(value) {
    const timestamp = Number(value || 0);
    if (!timestamp) {
        return '';
    }
    const delta = Date.now() - timestamp;
    if (delta < 60_000) {
        return '刚刚';
    }
    if (delta < 3_600_000) {
        return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`;
    }
    if (delta < 86_400_000) {
        return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`;
    }
    return new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
    }).format(new Date(timestamp));
}

function presetGroups() {
    const preset = launch?.runtime_config?.preset && typeof launch.runtime_config.preset === 'object'
        ? launch.runtime_config.preset
        : {};
    const current = preset.current_prompt || preset.prompt || {};
    const definitions = [{
        kind: String(current.kind || 'global_prompt'),
        label: '当前预设',
        description: '当前模型实际使用的唯一预设',
        config: current,
    }];
    return definitions.map(group => {
        const config = group.config && typeof group.config === 'object' ? group.config : {};
        const presetId = String(config.preset_id || '');
        const entries = Array.isArray(config.entries)
            ? config.entries.map((entry, index) => ({
                ...entry,
                id: String(entry?.id || ''),
                name: String(entry?.name || entry?.id || `条目 ${index + 1}`),
                role: String(entry?.role || 'system'),
                position: String(entry?.position || 'system_before'),
                enabled: Boolean(entry?.enabled),
                inheritedEnabled: Boolean(entry?.inherited_enabled),
                overridden: Boolean(entry?.overridden),
                locked: Boolean(entry?.locked || entry?.toggleable === false),
                toggleable: Boolean(entry?.toggleable && !entry?.locked),
                lockedReason: String(entry?.locked_reason || ''),
                kind: group.kind,
                groupLabel: group.label,
                presetId,
            })).filter(entry => entry.id)
            : [];
        return {
            ...group,
            presetId,
            name: String(config.name || group.label),
            enabled: Boolean(config.enabled),
            entries,
        };
    });
}

async function togglePreset(entry, enabled) {
    if (!entry?.toggleable || !entry?.presetId || !launch?.conversation_id) {
        return;
    }
    const result = await requestJson(
        `/api/homer/conversations/${encodeURIComponent(launch.conversation_id)}/preset-overrides`,
        {
            method: 'POST',
            body: JSON.stringify({
                preset_kind: entry.kind,
                preset_id: entry.presetId,
                items: [{ entry_id: entry.id, enabled: Boolean(enabled) }],
            }),
        },
    );
    if (result?.runtime_config && typeof result.runtime_config === 'object') {
        launch.runtime_config = result.runtime_config;
    } else {
        launch.runtime_config = await requestJson(
            `/api/homer/conversations/${encodeURIComponent(launch.conversation_id)}/runtime-config`,
        );
    }
    renderPresetLists(presetSearchQuery);
}

function createElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text) {
        element.textContent = text;
    }
    return element;
}

function createPresetRow(entry) {
    const row = createElement('label', 'homer-preset-row');
    row.classList.toggle('is-locked', !entry.toggleable);
    const copy = createElement('span', 'homer-preset-row__copy');
    const title = createElement('span', 'homer-preset-row__name', entry.name);
    const positionLabel = entry.position === 'post_history' ? '历史后' : '系统提示';
    const stateLabel = entry.overridden ? '当前对话已调整' : '默认状态';
    const lockLabel = entry.toggleable ? '' : ` · ${entry.lockedReason || '只读条目'}`;
    const meta = createElement(
        'span',
        'homer-preset-row__meta',
        `${positionLabel} · ${entry.role} · ${stateLabel}${lockLabel}`,
    );
    copy.append(title, meta);
    if (entry.toggleable) {
        const control = createElement('span', 'homer-switch');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = entry.enabled;
        input.setAttribute('aria-label', `${entry.name} ${entry.enabled ? '已开启' : '已关闭'}`);
        const slider = createElement('span', 'homer-switch__track');
        input.addEventListener('change', () => {
            const nextEnabled = input.checked;
            input.disabled = true;
            void togglePreset(entry, nextEnabled).catch(error => {
                input.checked = entry.enabled;
                showHostNotice(String(error?.message || '预设条目保存失败'), 'error');
            }).finally(() => {
                input.disabled = false;
            });
        });
        control.append(input, slider);
        row.append(copy, control);
    } else {
        row.append(copy, createElement('span', 'homer-preset-row__state', entry.enabled ? '已启用' : '已停用'));
    }
    return row;
}

function renderPresetContainer(container, groups, query, quick = false) {
    if (!container) {
        return;
    }
    const sections = [];
    for (const group of groups) {
        const matching = query
            ? group.entries.filter(item => `${item.name} ${item.role} ${item.lockedReason}`.toLocaleLowerCase().includes(query))
            : group.entries;
        if (query && !matching.length) {
            continue;
        }
        const section = createElement('section', 'homer-preset-group');
        const head = createElement('header', 'homer-preset-group__head');
        const copy = createElement('span', 'homer-preset-group__copy');
        copy.append(
            createElement('strong', '', group.label),
            createElement('small', '', `${group.name}${group.enabled ? '' : ' · 整体未启用'}`),
        );
        head.append(copy, createElement('span', 'homer-preset-group__count', `${matching.length} 条`));
        section.append(head);
        const values = quick ? matching.slice(0, 3) : matching;
        if (values.length) {
            const list = createElement('div', 'homer-preset-group__list');
            list.append(...values.map(createPresetRow));
            section.append(list);
            if (quick && matching.length > values.length) {
                section.append(createElement('div', 'homer-preset-group__more', `另有 ${matching.length - values.length} 条，请展开查看`));
            }
        } else {
            section.append(createElement(
                'div',
                'homer-empty',
                '当前预设没有向用户开放可切换条目',
            ));
        }
        sections.push(section);
    }
    container.replaceChildren(...sections);
    if (!sections.length) {
        container.append(createElement('div', 'homer-empty', '没有找到匹配的预设条目'));
    }
}

function renderPresetLists(filter = presetSearchQuery) {
    presetSearchQuery = String(filter || '').trim();
    const groups = presetGroups();
    const entries = groups.flatMap(group => group.entries);
    const query = String(filter || '').trim().toLocaleLowerCase();
    const quick = document.querySelector('#homer-preset-quick-list');
    const full = document.querySelector('#homer-preset-full-list');
    const count = document.querySelector('#homer-preset-count');
    const summary = document.querySelector('#homer-preset-summary');
    const toggleable = entries.filter(item => item.toggleable);
    const enabledCount = toggleable.filter(item => item.enabled).length;
    if (count) {
        count.textContent = `${enabledCount}/${toggleable.length} 可切换项已开启`;
    }
    if (summary) {
        summary.textContent = `${enabledCount}/${toggleable.length} 已开启 · 仅本次会话`;
    }
    renderPresetContainer(quick, groups, query, true);
    renderPresetContainer(full, groups, query, false);
}

function updateRuntimeStatus(text, state = 'online') {
    const status = document.querySelector('#homer-runtime-status');
    if (!status) {
        return;
    }
    status.textContent = text;
    status.dataset.state = state;
}

function setPanelOpen(open) {
    const panel = document.querySelector('#homer-preset-panel');
    if (panel) {
        panel.hidden = !open;
    }
    if (open) {
        renderPresetLists();
    }
}

function setFullDialogOpen(open) {
    const dialog = document.querySelector('#homer-preset-dialog');
    if (!dialog) {
        return;
    }
    if (open && !dialog.open) {
        dialog.showModal();
        renderPresetLists();
    } else if (!open && dialog.open) {
        dialog.close();
    }
}

function cloudHomerMessageId(message) {
    const extra = message?.extra && typeof message.extra === 'object' ? message.extra : {};
    return String(
        extra.homer_message_id
        || message?.homer_message_id
        || '',
    ).trim().slice(0, 160);
}

function stableHomerMessageId(message) {
    const extra = message?.extra && typeof message.extra === 'object' ? message.extra : {};
    return String(
        cloudHomerMessageId(message)
        || extra.homer_sync_id
        || '',
    ).trim().slice(0, 160);
}

function homerMessageId(message, index = -1) {
    return stableHomerMessageId(message) || (index >= 0 ? `message-${index}` : '');
}

async function logDialogueEvent(eventType, messageIndex = -1, messageOverride = null) {
    if (dialogueEventLogMuted || !launch?.app_id || !launch?.conversation_id) {
        return;
    }
    const context = getContext();
    const fallbackIndex = context.chat.length ? context.chat.length - 1 : -1;
    const index = Number.isInteger(Number(messageIndex)) && Number(messageIndex) >= 0
        ? Number(messageIndex)
        : fallbackIndex;
    const message = messageOverride || (index >= 0 ? context.chat[index] : null);
    const eventId = globalThis.crypto?.randomUUID?.()
        || `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const payload = {
        event_id: eventId,
        event_type: String(eventType || ''),
        app_id: launch.app_id,
        conversation_id: launch.conversation_id,
        message_id: homerMessageId(message, index),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await requestJson('/api/homer/events', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            return;
        } catch (error) {
            if (attempt === 1) {
                console.warn(`${MODULE_ID}: dialogue event log failed`, eventType, error);
                return;
            }
            await new Promise(resolve => window.setTimeout(resolve, 350));
        }
    }
}

function messageIndexFromElement(element) {
    const raw = element?.getAttribute?.('mesid');
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? index : -1;
}

function messageMenuTargetForIndex(messageIndex, element = null, anchor = {}) {
    const context = getContext();
    const index = Number(messageIndex);
    const message = Number.isInteger(index) && index >= 0 ? context.chat[index] : null;
    if (!message || message?.is_system) {
        return null;
    }
    return {
        messageIndex: index,
        messageId: stableHomerMessageId(message),
        messageRef: message,
        isUser: Boolean(message?.is_user),
        element: element || document.querySelector(`#chat .mes[mesid="${index}"]`),
        anchorX: Number.isFinite(Number(anchor?.x)) ? Number(anchor.x) : null,
        anchorY: Number.isFinite(Number(anchor?.y)) ? Number(anchor.y) : null,
    };
}

function messageMenuTargetFromElement(element, anchor = {}) {
    return messageMenuTargetForIndex(messageIndexFromElement(element), element, anchor);
}

function resolveMessageMenuTarget(target) {
    if ((typeof target === 'number' || typeof target === 'string') && Number.isInteger(Number(target))) {
        return messageMenuTargetForIndex(Number(target));
    }
    if (!target || typeof target !== 'object') {
        return null;
    }
    const context = getContext();
    const expectedId = String(target.messageId || '').trim();
    const matches = message => Boolean(
        message
        && !message?.is_system
        && (
            (target.messageRef && message === target.messageRef)
            || (expectedId && stableHomerMessageId(message) === expectedId)
        )
    );
    let index = Number(target.messageIndex);
    let message = Number.isInteger(index) && index >= 0 ? context.chat[index] : null;
    if (!matches(message)) {
        index = expectedId
            ? context.chat.findIndex(item => stableHomerMessageId(item) === expectedId)
            : -1;
        if (index < 0 && target.messageRef) {
            index = context.chat.indexOf(target.messageRef);
        }
        message = index >= 0 ? context.chat[index] : null;
    }
    if (!message || message?.is_system) {
        return null;
    }
    const element = document.querySelector(`#chat .mes[mesid="${index}"]`);
    return {
        ...target,
        messageIndex: index,
        messageId: stableHomerMessageId(message),
        messageRef: message,
        message,
        isUser: Boolean(message?.is_user),
        element,
    };
}

async function truncateAfterMessage(target, actionLabel = '继续操作') {
    let resolved = resolveMessageMenuTarget(target);
    if (!resolved) {
        throw new Error('目标消息已经变化，请重新打开消息菜单');
    }
    const context = getContext();
    let trailingCount = context.chat.length - resolved.messageIndex - 1;
    if (trailingCount <= 0) {
        return true;
    }
    const confirmed = await confirmHomerAction({
        id: 'homer-timeline-confirm-dialog',
        title: `${actionLabel}前需要回溯`,
        notice: `将保留这条消息，并移除其后的 ${trailingCount} 条内容。当前页面会立即更新。`,
        confirmLabel: '回溯并继续',
        danger: true,
    });
    if (!confirmed) {
        return false;
    }
    resolved = resolveMessageMenuTarget(target);
    if (!resolved) {
        throw new Error('目标消息已经变化，未执行操作');
    }
    trailingCount = context.chat.length - resolved.messageIndex - 1;
    if (trailingCount <= 0) {
        return true;
    }
    const previousSuppressSync = suppressSync;
    suppressSync = true;
    dialogueEventLogMuted += 1;
    try {
        while (context.chat.length - 1 > resolved.messageIndex) {
            await context.deleteLastMessage();
        }
        await context.saveChat();
    } finally {
        dialogueEventLogMuted = Math.max(0, dialogueEventLogMuted - 1);
        suppressSync = previousSuppressSync;
    }
    if (!previousSuppressSync) {
        scheduleSync(0);
    }
    return true;
}

function messageMenuActions(resolved) {
    return [
        { id: 'copy', label: '复制', icon: 'fa-regular fa-copy' },
        { id: 'edit', label: '改写', icon: 'fa-solid fa-pen' },
        { id: 'rollback', label: '回溯', icon: 'fa-solid fa-clock-rotate-left', cloud: true },
        { id: 'delete', label: '删除', icon: 'fa-regular fa-trash-can', cloud: true, danger: true },
    ];
}

function ensureMessageMenuDialog() {
    let dialog = document.querySelector('#homer-message-menu-dialog');
    if (dialog) {
        return dialog;
    }
    dialog = createElement('dialog', 'homer-message-menu-dialog');
    dialog.id = 'homer-message-menu-dialog';
    dialog.setAttribute('aria-label', '消息操作');
    const shell = createElement('section', 'homer-message-menu__shell');
    const actions = createElement('div', 'homer-message-menu__actions');
    actions.setAttribute('role', 'menu');
    shell.append(actions);
    dialog.append(shell);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) {
            closeMessageMenu();
            return;
        }
        const button = event.target instanceof Element
            ? event.target.closest('[data-homer-message-menu-action]')
            : null;
        if (!button || button.disabled) {
            return;
        }
        const target = activeMessageMenuTarget;
        const action = String(button.dataset.homerMessageMenuAction || '');
        closeMessageMenu();
        void handleMessageMenuAction(action, target);
    });
    dialog.addEventListener('close', () => {
        activeMessageMenuTarget = null;
        dialog.classList.remove('is-positioning');
        dialog.style.removeProperty('left');
        dialog.style.removeProperty('top');
        document.body.classList.remove('homer-message-menu-open');
    });
    document.body.append(dialog);
    return dialog;
}

function closeMessageMenu() {
    const dialog = document.querySelector('#homer-message-menu-dialog');
    if (dialog?.open) {
        dialog.close();
    } else {
        activeMessageMenuTarget = null;
        document.body.classList.remove('homer-message-menu-open');
    }
}

function positionMessageMenuDialog(dialog, resolved) {
    if (!dialog?.open || window.matchMedia('(max-width: 640px)').matches) {
        dialog?.classList.remove('is-positioning');
        return;
    }
    const anchorElement = resolved?.element?.querySelector('.mes_text')
        || resolved?.element?.querySelector('.mes_block')
        || resolved?.element;
    const rect = anchorElement?.getBoundingClientRect?.();
    if (!rect) {
        dialog.classList.remove('is-positioning');
        return;
    }
    const gap = 10;
    const edge = 12;
    const width = dialog.offsetWidth;
    const height = dialog.offsetHeight;
    const pointerX = resolved?.anchorX === null ? Number.NaN : Number(resolved?.anchorX);
    const pointerY = resolved?.anchorY === null ? Number.NaN : Number(resolved?.anchorY);
    let left;
    let top;
    if (Number.isFinite(pointerX) && Number.isFinite(pointerY)) {
        left = pointerX + gap;
        top = pointerY + gap;
        if (left + width > window.innerWidth - edge) {
            left = pointerX - width - gap;
        }
        if (top + height > window.innerHeight - edge) {
            top = pointerY - height - gap;
        }
    } else {
        left = resolved?.isUser ? rect.right - width : rect.left;
        top = rect.bottom + gap;
        if (top + height > window.innerHeight - edge) {
            top = rect.top - height - gap;
        }
    }
    left = Math.max(edge, Math.min(left, window.innerWidth - width - edge));
    top = Math.max(edge, Math.min(top, window.innerHeight - height - edge));
    dialog.style.left = `${Math.round(left)}px`;
    dialog.style.top = `${Math.round(top)}px`;
    dialog.classList.remove('is-positioning');
}

function renderMessageMenuDialog() {
    const dialog = ensureMessageMenuDialog();
    if (!activeMessageMenuTarget) {
        return;
    }
    const resolved = resolveMessageMenuTarget(activeMessageMenuTarget);
    if (!resolved) {
        if (dialog.open) {
            closeMessageMenu();
        }
        return;
    }
    activeMessageMenuTarget = resolved;
    const actions = dialog.querySelector('.homer-message-menu__actions');
    const swipes = Array.isArray(resolved.message?.swipes) ? resolved.message.swipes : [];
    const swipeCount = Math.max(swipes.length, 1);
    const swipeIndex = Math.max(0, Math.min(Number(resolved.message?.swipe_id || 0), swipeCount - 1));
    dialog.dataset.messageIndex = String(resolved.messageIndex);
    dialog.dataset.messageId = cloudHomerMessageId(resolved.message) || resolved.messageId || '';
    dialog.dataset.messageRole = resolved.isUser ? 'user' : 'assistant';
    const busy = generationBusy || rollbackBusy || loadingLaunch;
    const cloudReady = Boolean(cloudHomerMessageId(resolved.message));
    const buttons = messageMenuActions(resolved).map(action => {
        const button = createElement(
            'button',
            `homer-message-menu__action${action.danger ? ' is-danger' : ''}`,
        );
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.homerMessageMenuAction = action.id;
        const disabledBySwipe = action.id === 'swipe-left' && swipeIndex <= 0;
        const disabled = (busy && action.id !== 'copy') || (action.cloud && !cloudReady) || disabledBySwipe;
        button.disabled = disabled;
        button.setAttribute('aria-disabled', String(disabled));
        if (action.cloud && !cloudReady) {
            button.title = '这条消息同步到云端后可用';
        }
        button.append(
            createElement('span', `homer-message-menu__icon ${action.icon}`),
            createElement('span', 'homer-message-menu__label', action.label),
        );
        return button;
    });
    actions.replaceChildren(...buttons);
    if (dialog.open) {
        requestAnimationFrame(() => positionMessageMenuDialog(dialog, resolved));
    }
}

function openMessageMenu(target) {
    const resolved = resolveMessageMenuTarget(target);
    if (!resolved) {
        showHostNotice('目标消息已经变化，请重新长按', 'warning');
        return;
    }
    const dialog = ensureMessageMenuDialog();
    activeMessageMenuTarget = resolved;
    dialog.classList.add('is-positioning');
    renderMessageMenuDialog();
    document.body.classList.add('homer-message-menu-open');
    if (!dialog.open) {
        dialog.showModal();
    }
    requestAnimationFrame(() => {
        renderMessageMenuDialog();
        dialog.querySelector('.homer-message-menu__action:not(:disabled)')?.focus({ preventScroll: true });
    });
}

function normalizeCharacterVersionLabel(value) {
    const raw = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!raw) {
        return '';
    }
    if (/^version\s+/i.test(raw)) {
        return `v${raw.replace(/^version\s+/i, '')}`;
    }
    if (/^v\s*\d/i.test(raw)) {
        return raw.replace(/^v\s*/i, 'v');
    }
    if (/^\d+(?:\.\d+)*(?:\b|\s|·|-)/.test(raw)) {
        return `v${raw}`;
    }
    return raw;
}

function currentCharacterVersionLabel() {
    const data = launch?.card?.data && typeof launch.card.data === 'object'
        ? launch.card.data
        : {};
    const version = launch?.version && typeof launch.version === 'object'
        ? launch.version
        : {};
    const candidates = [
        data.character_version,
        version.version_name,
        version.label,
        Number(version.version_no) > 0 ? `v${Number(version.version_no)}` : '',
    ];
    for (const candidate of candidates) {
        const label = normalizeCharacterVersionLabel(candidate);
        if (label) {
            return label;
        }
    }
    return '';
}

function messageHeaderName(message) {
    const raw = String(
        message?.name
        || (message?.is_user ? session?.user?.name : currentRoleName())
        || (message?.is_user ? '你' : '角色'),
    ).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (message?.is_user || /^《.+》/.test(raw)) {
        return raw;
    }
    return `《${raw}》`;
}

function messageHeaderTime(message) {
    const raw = message?.send_date || message?.extra?.homer_created_at || '';
    let date;
    if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
        let timestamp = Number(raw || 0);
        if (timestamp > 0 && timestamp < 1_000_000_000_000) {
            timestamp *= 1000;
        }
        date = new Date(timestamp);
    } else {
        date = new Date(String(raw || ''));
    }
    if (!Number.isFinite(date.getTime())) {
        return '';
    }
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(date).replace(/\s+/g, ' ').trim();
}

function setTextIfChanged(element, text) {
    if (element && element.textContent !== text) {
        element.textContent = text;
    }
}

function decorateMessageHeader(messageElement, message, messageIndex) {
    const header = messageElement.querySelector('.ch_name');
    const nameText = header?.querySelector('.name_text');
    const timestamp = header?.querySelector('.timestamp');
    const meta = nameText?.parentElement;
    if (!header || !nameText || !timestamp || !meta) {
        return;
    }

    setTextIfChanged(nameText, messageHeaderName(message));
    setTextIfChanged(timestamp, messageHeaderTime(message));
    timestamp.setAttribute('aria-label', `消息时间：${timestamp.textContent || '未知'}`);

    let version = meta.querySelector('.homer-message-version');
    const versionLabel = message?.is_user ? '' : currentCharacterVersionLabel();
    if (versionLabel) {
        if (!version) {
            version = createElement('span', 'homer-message-version');
            timestamp.before(version);
        }
        setTextIfChanged(version, versionLabel);
        version.title = `当前角色版本：${versionLabel}`;
    } else {
        version?.remove();
    }

    let help = meta.querySelector('.homer-message-help');
    if (!help) {
        help = createElement('button', 'homer-message-help', '?');
        help.type = 'button';
        timestamp.after(help);
    }
    help.title = '查看这条消息的可用操作';
    help.setAttribute('aria-label', `查看第 ${messageIndex + 1} 条消息的操作帮助`);

    const more = header.querySelector('.extraMesButtonsHint');
    if (more) {
        more.classList.add('homer-message-more');
        more.title = '更多消息操作';
        more.tabIndex = 0;
        more.setAttribute('role', 'button');
        more.setAttribute('aria-label', `打开第 ${messageIndex + 1} 条消息的更多操作`);
    }
    const edit = header.querySelector('.mes_edit');
    if (edit) {
        edit.title = '编辑这条消息';
        edit.tabIndex = 0;
        edit.setAttribute('role', 'button');
        edit.setAttribute('aria-label', `编辑第 ${messageIndex + 1} 条消息`);
    }
    header.dataset.homerMessageHeader = 'true';
    header.dataset.homerMessageVersion = versionLabel;
}

function renderMessageMenuTargets() {
    const context = getContext();
    document.querySelectorAll('#chat .mes').forEach(messageElement => {
        messageElement.querySelector('.homer-message-actions')?.remove();
        const index = messageIndexFromElement(messageElement);
        const message = index >= 0 ? context.chat[index] : null;
        const eligible = Boolean(message && !message?.is_system && messageElement.getAttribute('is_system') !== 'true');
        const editing = eligible && Boolean(messageElement.querySelector('.edit_textarea'));
        messageElement.classList.toggle('homer-message-menu-target', eligible);
        messageElement.classList.toggle('homer-message-editing', editing);
        if (!eligible) {
            messageElement.removeAttribute('tabindex');
            messageElement.removeAttribute('aria-haspopup');
            messageElement.removeAttribute('aria-controls');
            messageElement.removeAttribute('aria-label');
            delete messageElement.dataset.messageIndex;
            delete messageElement.dataset.homerMessageId;
            return;
        }
        decorateMessageHeader(messageElement, message, index);
        messageElement.tabIndex = 0;
        messageElement.setAttribute('aria-haspopup', 'dialog');
        messageElement.setAttribute('aria-controls', 'homer-message-menu-dialog');
        messageElement.setAttribute(
            'aria-label',
            `${message?.is_user ? '用户输入' : '角色回复'}，长按或右键打开操作菜单`,
        );
        messageElement.dataset.messageIndex = String(index);
        messageElement.dataset.homerMessageId = stableHomerMessageId(message);
    });
    renderMessageMenuDialog();
}

function queueMessageMenuRender() {
    if (messageMenuRenderQueued) {
        return;
    }
    messageMenuRenderQueued = true;
    requestAnimationFrame(() => {
        messageMenuRenderQueued = false;
        renderMessageMenuTargets();
    });
}

function clearMessagePress() {
    window.clearTimeout(messagePressTimer);
    messagePressTimer = null;
    messagePressStart = null;
    messagePressTarget = null;
}

function eventMessageElement(event) {
    return event.target instanceof Element
        ? event.target.closest('#chat .mes.homer-message-menu-target')
        : null;
}

function isInteractiveMessageTarget(target) {
    return target instanceof Element && Boolean(target.closest(
        'button, a, input, textarea, select, option, iframe, [contenteditable="true"], .mes_buttons, .mes_edit_buttons',
    ));
}

async function copyMessageText(message) {
    const text = String(message?.mes || '');
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const textarea = createElement('textarea', 'homer-clipboard-fallback');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) {
            throw new Error('复制失败');
        }
    }
    showHostNotice('已复制这条消息', 'success');
}

async function openNativeMessageEditor(target) {
    const resolved = resolveMessageMenuTarget(target);
    if (!resolved) {
        throw new Error('目标消息已经变化，无法编辑');
    }
    await messageEdit(resolved.messageIndex);
    requestAnimationFrame(() => {
        queueMessageMenuRender();
        resolved.element?.querySelector('.edit_textarea')?.focus({ preventScroll: true });
    });
}

async function deleteCloudMessage(target) {
    let resolved = resolveMessageMenuTarget(target);
    let messageId = cloudHomerMessageId(resolved?.message);
    if (!resolved || !messageId) {
        showHostNotice('这条消息仍在同步，请稍后再删除', 'warning');
        return false;
    }
    const confirmed = await confirmHomerAction({
        id: 'homer-delete-message-dialog',
        title: '确认删除',
        notice: '只删除这一条消息，其他上下文保留。对话摘要会同步失效并在后续重建。',
        confirmLabel: '删除消息',
        danger: true,
    });
    if (!confirmed) {
        return false;
    }
    resolved = resolveMessageMenuTarget(target);
    messageId = cloudHomerMessageId(resolved?.message);
    if (!resolved || !messageId) {
        showHostNotice('目标消息已经变化，未执行删除', 'warning');
        return false;
    }
    rollbackBusy = true;
    document.body.classList.add('homer-rollback-busy');
    queueMessageMenuRender();
    const previousSuppressSync = suppressSync;
    try {
        const result = await requestJson(
            siteUrl(`/console/api/web/messages/${encodeURIComponent(messageId)}/delete`),
            { method: 'POST', body: '{}' },
        );
        if (result?.deleted !== true) {
            throw new Error('消息不存在或已被删除');
        }
        const context = getContext();
        const { messageIndex, message } = resolved;
        suppressSync = true;
        context.chat.splice(messageIndex, 1);
        if (Array.isArray(launch?.messages)) {
            const launchIndex = launch.messages.findIndex(item => String(item?.id || '') === messageId);
            if (launchIndex >= 0) {
                launch.messages.splice(launchIndex, 1);
            }
        }
        try {
            await context.saveChat();
        } catch (error) {
            console.warn(`${MODULE_ID}: deleted local mirror was not saved`, error);
        }
        await context.printMessages();
        dialogueEventLogMuted += 1;
        try {
            await eventSource.emit(event_types.MESSAGE_DELETED, context.chat.length);
            await eventSource.emit(event_types.CHAT_LOADED, context.chatId);
        } finally {
            dialogueEventLogMuted = Math.max(0, dialogueEventLogMuted - 1);
        }
        lastSyncSignature = JSON.stringify(serializeChat());
        await logDialogueEvent('message_delete', messageIndex, message);
        updateRuntimeStatus('云端已同步', 'online');
        showHostNotice('已删除这条消息', 'success');
        queueMessageMenuRender();
        return true;
    } catch (error) {
        console.error(`${MODULE_ID}: message delete failed`, error);
        showHostNotice(String(error?.message || '删除失败，请重试'), 'error');
        return false;
    } finally {
        suppressSync = previousSuppressSync;
        rollbackBusy = false;
        document.body.classList.remove('homer-rollback-busy');
        queueMessageMenuRender();
    }
}

async function handleMessageMenuAction(action, target) {
    const resolved = resolveMessageMenuTarget(target);
    if (!resolved) {
        showHostNotice('目标消息已经变化，未执行操作', 'warning');
        return;
    }
    if ((generationBusy || rollbackBusy || loadingLaunch) && action !== 'copy') {
        showHostNotice('当前操作完成后再修改对话', 'warning');
        return;
    }
    try {
        if (action === 'copy') {
            await copyMessageText(resolved.message);
            return;
        }
        if (action === 'edit') {
            await openNativeMessageEditor(resolved);
            return;
        }
        if (action === 'rollback') {
            await rollbackToMessage(resolved);
            return;
        }
        if (action === 'delete') {
            await deleteCloudMessage(resolved);
            return;
        }
        if (action === 'swipe-left' || action === 'swipe-right') {
            generationBusy = true;
            document.body.classList.add('homer-generating');
            queueMessageMenuRender();
            try {
                if (!await truncateAfterMessage(resolved, '切换候选回复')) {
                    return;
                }
                const current = resolveMessageMenuTarget(resolved);
                if (!current) {
                    throw new Error('目标消息已经变化');
                }
                dialogueEventLogMuted += 1;
                try {
                    const context = getContext();
                    if (action === 'swipe-left') {
                        await context.swipe.left();
                    } else {
                        await context.swipe.right();
                    }
                } finally {
                    dialogueEventLogMuted = Math.max(0, dialogueEventLogMuted - 1);
                }
                await logDialogueEvent('swipe', current.messageIndex, current.message);
                scheduleSync(100);
            } finally {
                generationBusy = false;
                document.body.classList.remove('homer-generating');
                queueMessageMenuRender();
            }
            return;
        }
        if (['continue', 'regenerate', 'next'].includes(action)) {
            await runAction(action, { messageTarget: resolved });
        }
    } catch (error) {
        console.error(`${MODULE_ID}: message menu action failed`, action, error);
        showHostNotice(String(error?.message || '操作失败，请重试'), 'error');
    }
}

function installMessageMenu() {
    const chat = document.querySelector('#chat');
    if (!chat) {
        window.setTimeout(installMessageMenu, 120);
        return;
    }
    if (chat.dataset.homerMessageMenuInstalled !== 'true') {
        chat.dataset.homerMessageMenuInstalled = 'true';
        chat.addEventListener('pointerdown', event => {
            const touchLike = event.pointerType === 'touch' || event.pointerType === 'pen';
            if ((!touchLike && event.button !== 0) || event.isPrimary === false || isInteractiveMessageTarget(event.target)) {
                return;
            }
            const element = eventMessageElement(event);
            if (!element) {
                return;
            }
            clearMessagePress();
            messagePressStart = {
                x: Number(event.clientX),
                y: Number(event.clientY),
                pointerId: event.pointerId,
            };
            messagePressTarget = messageMenuTargetFromElement(element, {
                x: messagePressStart.x,
                y: messagePressStart.y,
            });
            if (!messagePressTarget) {
                clearMessagePress();
                return;
            }
            messagePressTimer = window.setTimeout(() => {
                const target = messagePressTarget;
                if (target) {
                    suppressMessageClickUntil = Date.now() + 700;
                    window.getSelection?.()?.removeAllRanges?.();
                    openMessageMenu(target);
                }
                clearMessagePress();
            }, MESSAGE_LONG_PRESS_DELAY);
        }, { passive: true });
        chat.addEventListener('pointermove', event => {
            if (!messagePressStart || event.pointerId !== messagePressStart.pointerId) {
                return;
            }
            const distance = Math.hypot(
                Number(event.clientX) - messagePressStart.x,
                Number(event.clientY) - messagePressStart.y,
            );
            if (distance > MESSAGE_LONG_PRESS_MOVE_TOLERANCE) {
                clearMessagePress();
            }
        }, { passive: true });
        for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            chat.addEventListener(eventName, clearMessagePress, { passive: true });
        }
        chat.addEventListener('contextmenu', event => {
            const element = eventMessageElement(event);
            if (!element || element.querySelector('.edit_textarea')) {
                return;
            }
            clearMessagePress();
            event.preventDefault();
            event.stopPropagation();
            openMessageMenu(messageMenuTargetFromElement(element, {
                x: event.clientX,
                y: event.clientY,
            }));
        });
        chat.addEventListener('click', event => {
            const menuTrigger = event.target instanceof Element
                ? event.target.closest('.extraMesButtonsHint, .homer-message-help')
                : null;
            if (menuTrigger) {
                const element = menuTrigger.closest('#chat .mes.homer-message-menu-target');
                if (element) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    openMessageMenu(messageMenuTargetFromElement(element));
                }
                return;
            }
            if (Date.now() >= suppressMessageClickUntil || !eventMessageElement(event)) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        chat.addEventListener('keydown', event => {
            const headerTrigger = event.target instanceof Element
                ? event.target.closest('.extraMesButtonsHint, .homer-message-help, .mes_edit')
                : null;
            if (headerTrigger && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                event.stopPropagation();
                if (headerTrigger.matches('.mes_edit')) {
                    headerTrigger.click();
                } else {
                    const element = headerTrigger.closest('#chat .mes.homer-message-menu-target');
                    if (element) {
                        openMessageMenu(messageMenuTargetFromElement(element));
                    }
                }
                return;
            }
            const keyboardMenu = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
            if (!keyboardMenu) {
                return;
            }
            const element = eventMessageElement(event)
                || (document.activeElement instanceof Element
                    ? document.activeElement.closest('#chat .mes.homer-message-menu-target')
                    : null);
            if (!element) {
                return;
            }
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            openMessageMenu(messageMenuTargetFromElement(element, {
                x: rect.left + rect.width / 2,
                y: rect.top + Math.min(rect.height / 2, 80),
            }));
        });
    }
    messageMenuObserver?.disconnect();
    messageMenuObserver = new MutationObserver(queueMessageMenuRender);
    messageMenuObserver.observe(chat, { childList: true, subtree: true });
    ensureMessageMenuDialog();
    queueMessageMenuRender();
}

async function runAction(type, options = {}) {
    if (generationBusy) {
        return;
    }
    const context = getContext();
    const target = options.messageTarget || (
        Number.isInteger(Number(options.messageIndex))
            ? messageMenuTargetForIndex(Number(options.messageIndex))
            : null
    );
    let resolved = target ? resolveMessageMenuTarget(target) : null;
    if (target && !resolved) {
        showHostNotice('目标消息已经变化，未执行生成', 'warning');
        return;
    }
    const logMessage = resolved?.message || null;
    generationBusy = true;
    document.body.classList.add('homer-generating');
    queueMessageMenuRender();
    try {
        if (resolved) {
            const label = type === 'regenerate' ? '重写' : type === 'next' ? '推进下一回' : '续写';
            if (!await truncateAfterMessage(resolved, label)) {
                return;
            }
            resolved = resolveMessageMenuTarget(resolved);
            if (!resolved) {
                throw new Error('目标消息已经变化');
            }
        }
        dialogueEventLogMuted += 1;
        try {
            enforceStreamingConfiguration();
            if (type === 'next') {
                await context.generate('normal', {
                    quiet_prompt: '自然推进到下一回合或下一段情节，保持角色设定与当前叙事连续。',
                    quietToLoud: true,
                });
            } else {
                await context.generate(type);
            }
        } finally {
            dialogueEventLogMuted = Math.max(0, dialogueEventLogMuted - 1);
        }
        await logDialogueEvent(
            type === 'next' ? 'continue_next' : type,
            resolved?.messageIndex ?? context.chat.length - 1,
            logMessage,
        );
    } catch (error) {
        console.error(`${MODULE_ID}: action failed`, error);
        showHostNotice(String(error?.message || '操作失败，请重试'), 'error');
    } finally {
        window.clearTimeout(generationSettleTimer);
        generationSettleTimer = null;
        generationBusy = false;
        document.body.classList.remove('homer-generating');
        scheduleSync(100);
        queueMessageMenuRender();
    }
}

function setDrawerOpen(side = '') {
    const root = document.querySelector('#homer-runtime-root');
    if (!root) {
        return;
    }
    const left = root.querySelector('#homer-left-drawer');
    const right = root.querySelector('#homer-right-drawer');
    const backdrop = root.querySelector('#homer-drawer-backdrop');
    const desktopLayout = window.matchMedia('(min-width: 761px)').matches;
    const leftOpen = side === 'left';
    const rightOpen = side === 'right';
    left?.classList.toggle('is-open', leftOpen);
    right?.classList.toggle('is-open', rightOpen);
    left?.setAttribute('aria-hidden', String(!leftOpen));
    right?.setAttribute('aria-hidden', String(!rightOpen));
    const desktopLeftOpen = leftOpen && desktopLayout;
    if (backdrop) {
        backdrop.hidden = (desktopLeftOpen && !rightOpen) || (!leftOpen && !rightOpen);
    }
    document.body.classList.toggle('homer-drawer-open', leftOpen || rightOpen);
    document.body.classList.toggle('homer-left-drawer-open', leftOpen);
    if (leftOpen || rightOpen) {
        window.setTimeout(() => {
            (rightOpen ? right : left)?.querySelector('button, a, select, input')?.focus();
        }, 160);
    }
}

function returnToDesktopNavigation() {
    setDrawerOpen();
}

function createSettingButton(icon, label, description, id = '') {
    const button = createElement('button', 'homer-setting-row');
    button.type = 'button';
    if (id) {
        button.id = id;
    }
    button.append(
        createElement('span', 'homer-setting-row__icon', icon),
        createElement('span', 'homer-setting-row__copy'),
        createElement('span', 'homer-setting-row__chevron', '›'),
    );
    const copy = button.querySelector('.homer-setting-row__copy');
    copy.append(
        createElement('strong', 'homer-setting-row__label', label),
        createElement('small', 'homer-setting-row__description', description),
    );
    return button;
}

function createDialogHeader(eyebrow, title, closeLabel, closeHandler) {
    const head = createElement('header', 'homer-sheet-dialog__head');
    const copy = createElement('div');
    copy.append(
        createElement('div', 'homer-preset-panel__eyebrow', eyebrow),
        createElement('h2', 'homer-sheet-dialog__title', title),
    );
    const close = createElement('button', 'homer-icon-button', '×');
    close.type = 'button';
    close.setAttribute('aria-label', closeLabel);
    close.addEventListener('click', closeHandler);
    head.append(copy, close);
    return head;
}

function createRangeField({ key, label, hint, min, max, step, value }) {
    const field = createElement('label', 'homer-model-field');
    field.dataset.key = key;
    const head = createElement('span', 'homer-model-field__head');
    const title = createElement('span', 'homer-model-field__label', label);
    const number = document.createElement('input');
    number.className = 'homer-model-field__number';
    number.type = 'number';
    number.min = String(min);
    number.max = String(max);
    number.step = String(step);
    number.value = String(value);
    number.setAttribute('aria-label', label);
    head.append(title, number);
    const range = document.createElement('input');
    range.className = 'homer-model-field__range';
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.setAttribute('aria-label', `${label}滑块`);
    const sync = (source, target) => {
        target.value = String(clampNumber(source.value, min, max, value));
    };
    range.addEventListener('input', () => sync(range, number));
    number.addEventListener('input', () => sync(number, range));
    field.append(head, range, createElement('small', 'homer-model-field__hint', hint));
    return field;
}

function openMemoryBooks() {
    returnToDesktopNavigation();
    const startedAt = Date.now();
    const tryOpen = () => {
        const item = document.querySelector('#stmb-menu-item');
        if (item instanceof HTMLElement) {
            item.click();
            return;
        }
        if (Date.now() - startedAt < 8000) {
            window.setTimeout(tryOpen, 180);
            return;
        }
        showHostNotice('长记忆模块仍在加载，请稍后重试', 'warning');
    };
    tryOpen();
}

function buildModelDialog() {
    const settings = conversationModelSettings();
    const dialog = createElement('dialog', 'homer-sheet-dialog');
    dialog.id = 'homer-model-dialog';
    const shell = createElement('form', 'homer-sheet-dialog__shell');
    shell.method = 'dialog';
    shell.append(createDialogHeader(
        '仅影响当前会话',
        '模型设置',
        '关闭模型设置',
        () => dialog.close(),
    ));
    shell.append(createElement(
        'p',
        'homer-sheet-dialog__notice',
        '这些参数只用于当前角色的当前对话。不同模型可能会忽略不支持的参数。',
    ));

    const modelField = createElement('label', 'homer-model-select-field');
    modelField.append(createElement('span', 'homer-model-field__label', '当前模型'));
    const select = document.createElement('select');
    select.id = 'homer-model-select';
    select.className = 'homer-model-select';
    for (const model of runtimeUiData.models) {
        const option = document.createElement('option');
        option.value = String(model?.id || '');
        option.textContent = `${String(model?.name || model?.model || model?.id || '未命名模型')}${model?.price_label ? ` · ${model.price_label}` : ''}`
            + `${model?.model && model.model !== model.name ? ` · ${model.model}` : ''}`;
        option.selected = option.value === settings.model_id;
        select.append(option);
    }
    if (!select.options.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '使用网站默认模型';
        select.append(option);
    }
    modelField.append(select);
    shell.append(modelField);

    const fields = createElement('div', 'homer-model-fields');
    fields.append(
        createRangeField({
            key: 'temperature',
            label: '温度',
            hint: '数值越高越有变化，越低越稳定。',
            min: 0,
            max: 2,
            step: 0.05,
            value: settings.temperature,
        }),
        createRangeField({
            key: 'top_p',
            label: 'Top‑P',
            hint: '控制候选词范围，通常保持在 0.8–1。',
            min: 0,
            max: 1,
            step: 0.01,
            value: settings.top_p,
        }),
        createRangeField({
            key: 'frequency_penalty',
            label: '词频惩罚',
            hint: '降低已频繁出现词语再次出现的概率。',
            min: -2,
            max: 2,
            step: 0.05,
            value: settings.frequency_penalty,
        }),
        createRangeField({
            key: 'presence_penalty',
            label: '存在惩罚',
            hint: '鼓励模型尝试对话中尚未出现的新内容。',
            min: -2,
            max: 2,
            step: 0.05,
            value: settings.presence_penalty,
        }),
    );
    shell.append(fields);

    const actions = createElement('footer', 'homer-sheet-dialog__actions');
    const reset = createElement('button', 'homer-secondary-button', '恢复默认');
    reset.type = 'button';
    reset.addEventListener('click', () => {
        select.value = String(runtimeUiData.modelDefaultId || runtimeUiData.models[0]?.id || '');
        const defaults = DEFAULT_MODEL_SETTINGS;
        for (const field of fields.querySelectorAll('.homer-model-field')) {
            const key = field.dataset.key;
            const value = defaults[key];
            field.querySelector('.homer-model-field__range').value = String(value);
            field.querySelector('.homer-model-field__number').value = String(value);
        }
    });
    const cancel = createElement('button', 'homer-secondary-button', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());
    const save = createElement('button', 'homer-primary-button', '保存到本次会话');
    save.type = 'button';
    save.addEventListener('click', async () => {
        const next = {
            model_id: select.value,
        };
        for (const field of fields.querySelectorAll('.homer-model-field')) {
            next[field.dataset.key] = Number(field.querySelector('.homer-model-field__number').value);
        }
        save.disabled = true;
        try {
            await persistModelSettings(next);
            const model = selectedModel();
            const summary = document.querySelector('#homer-model-summary');
            if (summary) {
                summary.textContent = String(model?.name || model?.model || '网站默认模型');
            }
            dialog.close();
            showHostNotice('模型参数已保存到当前会话', 'success');
        } catch (error) {
            showHostNotice(String(error?.message || '模型设置保存失败'), 'error');
        } finally {
            save.disabled = false;
        }
    });
    actions.append(reset, cancel, save);
    shell.append(actions);
    dialog.append(shell);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) {
            dialog.close();
        }
    });
    return dialog;
}

function buildModDialog() {
    const dialog = createElement('dialog', 'homer-sheet-dialog');
    dialog.id = 'homer-mod-dialog';
    const shell = createElement('div', 'homer-sheet-dialog__shell');
    shell.append(createDialogHeader(
        '当前对话独立生效',
        'Mod 管理',
        '关闭 Mod 管理',
        () => dialog.close(),
    ));
    shell.append(createElement(
        'p',
        'homer-sheet-dialog__notice',
        '这里只显示 Mod 名称和说明，不展示角色卡世界书条目。上下移动可调整生效顺序。',
    ));
    const list = createElement('div', 'homer-mod-list');
    for (const mod of runtimeUiData.mods) {
        const modId = String(mod?.id || mod?.mod_id || '');
        if (!modId) {
            continue;
        }
        const row = createElement('div', 'homer-mod-row');
        row.dataset.modId = modId;
        const label = createElement('label', 'homer-mod-row__main');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = runtimeUiData.activeModIds.includes(modId);
        input.setAttribute('aria-label', `启用 ${String(mod?.name || 'Mod')}`);
        const copy = createElement('span', 'homer-mod-row__copy');
        copy.append(
            createElement('strong', '', String(mod?.name || '未命名 Mod')),
            createElement('small', '', String(mod?.summary || '没有说明')),
        );
        label.append(input, copy);
        const order = createElement('span', 'homer-mod-row__order');
        const up = createElement('button', 'homer-mini-button', '↑');
        const down = createElement('button', 'homer-mini-button', '↓');
        up.type = down.type = 'button';
        up.setAttribute('aria-label', `上移 ${String(mod?.name || 'Mod')}`);
        down.setAttribute('aria-label', `下移 ${String(mod?.name || 'Mod')}`);
        up.addEventListener('click', () => {
            const previous = row.previousElementSibling;
            if (previous) {
                list.insertBefore(row, previous);
            }
        });
        down.addEventListener('click', () => {
            const next = row.nextElementSibling;
            if (next) {
                list.insertBefore(next, row);
            }
        });
        order.append(up, down);
        row.append(label, order);
        list.append(row);
    }
    if (!list.children.length) {
        list.append(createElement('div', 'homer-empty', '你的 Mod 收藏库还是空的'));
    }
    shell.append(list);
    const actions = createElement('footer', 'homer-sheet-dialog__actions');
    const workshop = document.createElement('a');
    workshop.className = 'homer-secondary-button';
    workshop.href = siteUrl('/app/workshop.html');
    workshop.textContent = '打开创意工坊';
    const cancel = createElement('button', 'homer-secondary-button', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());
    const save = createElement('button', 'homer-primary-button', '保存 Mod');
    save.type = 'button';
    save.addEventListener('click', async () => {
        const modIds = [...list.querySelectorAll('.homer-mod-row')]
            .filter(row => row.querySelector('input')?.checked)
            .map(row => String(row.dataset.modId || ''))
            .filter(Boolean);
        save.disabled = true;
        try {
            await requestJson(`/api/homer/mods/conversation/${encodeURIComponent(launch.conversation_id)}`, {
                method: 'POST',
                body: JSON.stringify({ mod_ids: modIds }),
            });
            runtimeUiData.activeModIds = modIds;
            const summary = document.querySelector('#homer-mod-summary');
            if (summary) {
                summary.textContent = `${modIds.length} 个已启用`;
            }
            dialog.close();
            showHostNotice('当前会话 Mod 已更新', 'success');
        } catch (error) {
            showHostNotice(String(error?.message || 'Mod 保存失败'), 'error');
        } finally {
            save.disabled = false;
        }
    });
    actions.append(workshop, cancel, save);
    shell.append(actions);
    dialog.append(shell);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) {
            dialog.close();
        }
    });
    return dialog;
}

function currentConversationRecord() {
    return runtimeUiData.conversations.find(item => (
        String(item?.id || '') === String(launch?.conversation_id || '')
    )) || launch?.conversation || null;
}

function updateConversationTitle(title) {
    const clean = String(title || '').trim();
    if (!clean) return;
    if (launch?.conversation) launch.conversation.title = clean;
    const record = runtimeUiData.conversations.find(item => String(item?.id || '') === String(launch?.conversation_id || ''));
    if (record) record.title = clean;
    const role = document.querySelector('#homer-right-drawer .homer-drawer__role');
    if (role) role.textContent = clean;
    populateHistoryList(
        document.querySelector('#homer-history-count'),
        document.querySelector('#homer-history-list'),
    );
    notifyHost('title', { title: clean });
}

function updatePresentationModeControl(detail = {}) {
    const control = document.querySelector('#homer-presentation-mode-toggle');
    const button = control?.querySelector('button');
    if (!control || !button) return;
    const visualAvailable = detail.visualAvailable !== false;
    const mode = detail.mode === 'tavern' ? 'tavern' : 'visual_novel';
    control.dataset.mode = mode;
    control.hidden = !visualAvailable;
    const targetMode = mode === 'tavern' ? 'visual_novel' : 'tavern';
    const targetLabel = targetMode === 'tavern' ? '酒馆模式' : '视觉小说';
    button.dataset.presentationMode = targetMode;
    button.textContent = targetLabel;
    button.setAttribute('aria-label', `切换到${targetLabel}`);
    button.title = `切换到${targetLabel}`;
}

function installPresentationModeBridge() {
    if (presentationModeBridgeInstalled) return;
    presentationModeBridgeInstalled = true;
    document.addEventListener('homer-presentation-mode-state', event => {
        updatePresentationModeControl(event?.detail || {});
    });
}

function buildPresentationModeToggle() {
    const section = createElement('aside', 'homer-presentation-mode-toggle');
    section.id = 'homer-presentation-mode-toggle';
    section.dataset.mode = 'tavern';
    section.hidden = true;
    const button = createElement('button', '', '视觉小说');
    button.type = 'button';
    button.dataset.presentationMode = 'visual_novel';
    button.setAttribute('aria-label', '切换到视觉小说');
    button.addEventListener('click', () => {
        const mode = String(button.dataset.presentationMode || 'visual_novel');
        document.dispatchEvent(new CustomEvent('homer-presentation-mode-request', {
            detail: { mode },
        }));
    });
    section.append(button);
    window.setTimeout(() => {
        document.dispatchEvent(new CustomEvent('homer-presentation-mode-query'));
    }, 0);
    return section;
}

function openRenameDialog(conversation = currentConversationRecord()) {
    managedConversation = conversation;
    const dialog = document.querySelector('#homer-rename-dialog');
    const input = dialog?.querySelector('input');
    if (!(dialog instanceof HTMLDialogElement) || !(input instanceof HTMLInputElement)) return;
    input.value = String(conversation?.title || conversation?.app_name || '');
    dialog.showModal();
    window.setTimeout(() => input.select(), 60);
}

function buildRenameDialog() {
    const dialog = createElement('dialog', 'homer-site-dialog homer-rename-dialog');
    dialog.id = 'homer-rename-dialog';
    dialog.dataset.modal = 'rename';
    const form = createElement('form', 'homer-site-dialog__surface');
    form.method = 'dialog';
    const head = createElement('header', 'homer-rename-dialog__head');
    head.append(createElement('strong', '', '聊天名称'));
    const save = createElement('button', 'homer-primary-button', '保存');
    save.type = 'submit';
    save.value = 'save';
    head.append(save);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = '给聊天取个名字';
    form.append(head, input);
    dialog.append(form);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const conversation = managedConversation || currentConversationRecord();
        const title = input.value.replace(/\s+/g, ' ').trim();
        if (!title) {
            showHostNotice('请输入聊天名称', 'warning');
            return;
        }
        save.disabled = true;
        try {
            const result = await requestJson(`/api/homer/conversations/${encodeURIComponent(conversation.id)}/rename`, {
                method: 'POST',
                body: JSON.stringify({ title }),
            });
            conversation.title = result?.conversation?.title || title;
            if (String(conversation.id) === String(launch?.conversation_id || '')) {
                updateConversationTitle(conversation.title);
            }
            dialog.close();
            await loadConversationHistory();
            showHostNotice('聊天名称已保存', 'success');
        } catch (error) {
            showHostNotice(String(error?.message || '改名失败'), 'error');
        } finally {
            save.disabled = false;
        }
    });
    dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
    });
    return dialog;
}

async function exportConversation(conversation) {
    const result = await requestJson(`/api/homer/conversations/${encodeURIComponent(conversation.id)}/export`, {
        method: 'POST',
        body: '{}',
    });
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${String(conversation.title || conversation.app_name || '聊天').replace(/[\\/:*?"<>|]/g, '_')}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function deleteManagedConversation(conversation) {
    const accepted = await confirmHomerAction({
        id: 'homer-delete-conversation-dialog',
        eyebrow: '会话管理',
        title: '删除这段聊天？',
        notice: '删除后将无法恢复，其他历史会话不会受到影响。',
        confirmLabel: '删除',
        danger: true,
    });
    if (!accepted) return;
    await requestJson(`/api/homer/conversations/${encodeURIComponent(conversation.id)}/delete`, {
        method: 'POST', body: '{}',
    });
    const wasCurrent = String(conversation.id) === String(launch?.conversation_id || '');
    runtimeUiData.conversations = runtimeUiData.conversations.filter(item => String(item?.id || '') !== String(conversation.id));
    if (wasCurrent) {
        const next = runtimeUiData.conversations[0];
        if (next) await switchConversation(next);
        else await startNewConversation();
    } else {
        populateHistoryList(document.querySelector('#homer-history-count'), document.querySelector('#homer-history-list'));
    }
    showHostNotice('聊天已删除', 'success');
}

function buildConversationManagerDialog() {
    const dialog = createElement('dialog', 'homer-site-dialog homer-chat-manage-dialog');
    dialog.id = 'homer-chat-manage-dialog';
    dialog.dataset.modal = 'chat-manage';
    dialog.setAttribute('aria-label', '会话管理');
    const surface = createElement('section', 'homer-site-dialog__surface');
    const actions = createElement('div', 'homer-chat-manage__actions');
    const definitions = [
        ['pin', '置顶'], ['rename', '改名'], ['new', '开始新聊天'], ['copy', '复制聊天'], ['export', '导出'],
    ];
    for (const [action, label] of definitions) {
        const button = createElement('button', '', label);
        button.type = 'button';
        button.dataset.action = action;
        actions.append(button);
    }
    const remove = createElement('button', 'homer-chat-manage__danger', '删除');
    remove.type = 'button';
    remove.dataset.action = 'delete';
    surface.append(actions, remove);
    dialog.append(surface);
    dialog.addEventListener('click', async event => {
        if (event.target === dialog) {
            dialog.close();
            return;
        }
        const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
        if (!(button instanceof HTMLButtonElement) || !managedConversation) return;
        const conversation = managedConversation;
        const action = button.dataset.action;
        dialog.close();
        try {
            if (action === 'rename') return openRenameDialog(conversation);
            if (action === 'new') return void startNewConversation();
            if (action === 'pin') {
                const pinned = !Boolean(conversation.pinned);
                await requestJson(`/api/homer/conversations/${encodeURIComponent(conversation.id)}/pin`, {
                    method: 'POST', body: JSON.stringify({ pinned }),
                });
                await loadConversationHistory();
                showHostNotice(pinned ? '聊天已置顶' : '已取消置顶', 'success');
                return;
            }
            if (action === 'copy') {
                const result = await requestJson(`/api/homer/conversations/${encodeURIComponent(conversation.id)}/copy`, {
                    method: 'POST', body: '{}',
                });
                await loadConversationHistory();
                showHostNotice('聊天副本已创建', 'success');
                const copied = result?.conversation;
                if (copied) await switchConversation(copied);
                return;
            }
            if (action === 'export') {
                await exportConversation(conversation);
                showHostNotice('聊天已导出', 'success');
                return;
            }
            if (action === 'delete') await deleteManagedConversation(conversation);
        } catch (error) {
            showHostNotice(String(error?.message || '会话操作失败'), 'error');
        }
    });
    return dialog;
}

function openConversationManager(conversation) {
    managedConversation = conversation;
    const dialog = document.querySelector('#homer-chat-manage-dialog');
    const pin = dialog?.querySelector('[data-action="pin"]');
    if (pin) pin.textContent = conversation?.pinned ? '取消置顶' : '置顶';
    dialog?.showModal();
}

async function importConversationFile(file) {
    const text = await file.text();
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error('聊天文件不是有效的 JSON');
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages)) {
        throw new Error('聊天文件缺少 messages 列表');
    }
    payload.conversation = {
        ...(payload.conversation || {}),
        app_id: payload?.conversation?.app_id || launch?.app_id || '',
        app_name: payload?.conversation?.app_name || launch?.conversation?.app_name || '',
        app_icon: payload?.conversation?.app_icon || launch?.conversation?.app_icon || '',
    };
    return requestJson('/api/homer/conversations/import', {
        method: 'POST', body: JSON.stringify(payload),
    });
}

function buildNewConversationMenu() {
    const dialog = createElement('dialog', 'homer-site-dialog homer-new-chat-dialog');
    dialog.id = 'homer-new-chat-dialog';
    dialog.dataset.modal = 'new-chat';
    const surface = createElement('section', 'homer-site-dialog__surface homer-new-chat-menu');
    const create = createElement('button', '', '创建聊天');
    const importButton = createElement('button', '', '导入聊天');
    create.type = importButton.type = 'button';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.hidden = true;
    create.addEventListener('click', () => { dialog.close(); void startNewConversation(); });
    importButton.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        dialog.close();
        try {
            const result = await importConversationFile(file);
            await loadConversationHistory();
            const conversation = result?.conversation;
            if (conversation) await switchConversation(conversation);
            showHostNotice('聊天已导入', 'success');
        } catch (error) {
            showHostNotice(String(error?.message || '导入聊天失败'), 'error');
        } finally {
            input.value = '';
        }
    });
    surface.append(create, importButton, input);
    dialog.append(surface);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    return dialog;
}

function buildAttachmentDialog() {
    const dialog = createElement('dialog', 'homer-site-dialog homer-attachment-dialog');
    dialog.id = 'homer-attachment-dialog';
    dialog.dataset.modal = 'attachments';
    dialog.setAttribute('aria-label', '添加内容');
    const surface = createElement('section', 'homer-site-dialog__surface');
    const grid = createElement('div', 'homer-attachment-grid');
    const definitions = [
        ['gallery', '▧', '相册'], ['camera', '◉', '拍照'], ['image', '◇', '生图'],
    ];
    for (const [action, icon, label] of definitions) {
        const button = createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.append(createElement('span', 'homer-attachment-icon', icon), createElement('span', '', label));
        grid.append(button);
    }
    const ai = createElement('button', 'homer-ai-help', '◌  AI帮答');
    ai.type = 'button';
    ai.dataset.action = 'ai-help';
    surface.append(grid, ai);
    dialog.append(surface);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) { dialog.close(); return; }
        const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
        if (!button) return;
        const action = button.dataset.action;
        dialog.close();
        if (action === 'gallery') {
            document.querySelector('#file_form_input')?.click();
        } else if (action === 'camera') {
            const camera = document.createElement('input');
            camera.type = 'file'; camera.accept = 'image/*'; camera.capture = 'environment';
            camera.addEventListener('change', () => {
                const target = document.querySelector('#file_form_input');
                if (target instanceof HTMLInputElement && camera.files?.length) {
                    try { target.files = camera.files; target.dispatchEvent(new Event('change', { bubbles: true })); } catch { target.click(); }
                }
            }, { once: true });
            camera.click();
        } else if (action === 'ai-help') {
            document.querySelector('#option_impersonate')?.click();
        } else {
            const imageButton = [...document.querySelectorAll('button, a, [role="button"]')].find(item => /生图|生成图片|image generation/i.test(String(item.textContent || item.getAttribute('title') || '')));
            if (imageButton instanceof HTMLElement) imageButton.click();
            else showHostNotice('当前模型没有启用生图能力', 'warning');
        }
    });
    return dialog;
}

function buildMemoryDialog() {
    const dialog = createElement('dialog', 'homer-site-dialog homer-memory-dialog');
    dialog.id = 'homer-memory-dialog';
    dialog.dataset.modal = 'memory-settings';
    const surface = createElement('section', 'homer-site-dialog__surface');
    surface.append(
        createDialogHeader('CURRENT CHAT', '长记忆', '关闭长记忆', () => dialog.close()),
        createElement('p', 'homer-sheet-dialog__notice', '记忆只绑定当前会话，不展示角色卡世界书正文。'),
    );
    const card = createElement('button', 'homer-memory-card');
    card.type = 'button';
    card.append(createElement('strong', '', 'Memory Books'), createElement('small', '', '自动整理本次对话中的长期事实'));
    card.addEventListener('click', () => { dialog.close(); openMemoryBooks(); });
    surface.append(card);
    dialog.append(surface);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    return dialog;
}

function bindComposerAttachmentButton() {
    const button = document.querySelector('#options_button');
    if (!(button instanceof HTMLElement) || button.dataset.homerAttachmentBound === '1') return;
    button.dataset.homerAttachmentBound = '1';
    button.setAttribute('aria-label', '添加内容');
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        document.querySelector('#options')?.classList.remove('openDrawer');
        document.querySelector('#homer-attachment-dialog')?.showModal();
    }, { capture: true });
}

function populateHistoryList(historyCount, historyList) {
    if (!(historyCount instanceof HTMLElement) || !(historyList instanceof HTMLElement)) {
        return;
    }
    historyCount.textContent = String(runtimeUiData.conversations.length);
    historyList.replaceChildren();
    for (const conversation of runtimeUiData.conversations) {
        const item = createElement('div', 'homer-history-item');
        item.dataset.conversationId = String(conversation?.id || conversation?.conversation_id || '');
        item.dataset.appId = String(conversation?.app_id || '');
        item.classList.toggle(
            'is-active',
            String(conversation?.id || '') === String(launch?.conversation_id || ''),
        );
        const avatar = createElement('span', 'homer-history-item__avatar');
        const avatarUrl = siteAssetUrl(conversation?.app_icon)
            || siteUrl('/assets/img/apk/avatar.webp?v=20260831-silvercat-v1');
        avatar.style.backgroundImage = `url("${avatarUrl.replaceAll('"', '%22')}")`;
        const copy = createElement('span', 'homer-history-item__copy');
        const itemHead = createElement('span', 'homer-history-item__head');
        itemHead.append(
            createElement('strong', '', String(conversation?.title || conversation?.app_name || '未命名会话')),
            createElement('time', '', formatConversationTime(conversation?.updated_at)),
        );
        copy.append(
            itemHead,
            createElement('small', '', String(conversation?.last_message || '开始新的故事').slice(0, 72)),
        );
        const main = createElement('button', 'homer-history-item__main');
        main.type = 'button';
        main.append(avatar, copy);
        main.addEventListener('click', () => void switchConversation(conversation));
        const more = createElement('button', 'homer-history-item__more', '⋮');
        more.type = 'button';
        more.setAttribute('aria-label', `管理 ${String(conversation?.title || conversation?.app_name || '会话')}`);
        more.addEventListener('click', event => {
            event.stopPropagation();
            openConversationManager(conversation);
        });
        item.append(main, more);
        historyList.append(item);
    }
    if (!historyList.children.length) {
        historyList.append(createElement('div', 'homer-empty', '还没有历史会话'));
    }
}

function buildRuntimeUi() {
    document.querySelector('#homer-runtime-root')?.remove();
    const root = createElement('div', 'homer-runtime-root');
    root.id = 'homer-runtime-root';

    const roleName = String(
        launch?.card?.data?.name
        || launch?.card?.name
        || launch?.conversation?.app_name
        || '角色对话',
    );
    const header = createElement('header', 'homer-chat-header');
    const menu = createElement('button', 'homer-header-button', '☰');
    menu.type = 'button';
    menu.setAttribute('aria-label', '打开导航与历史会话');
    menu.addEventListener('click', () => {
        const leftDrawer = document.querySelector('#homer-left-drawer');
        setDrawerOpen(leftDrawer?.classList.contains('is-open') ? '' : 'left');
    });
    const title = createElement('div', 'homer-chat-header__title homer-chat-header__title--empty');
    title.id = 'homer-conversation-title';
    title.setAttribute('aria-hidden', 'true');
    const settingsButton = createElement('button', 'homer-header-button', '⚙');
    settingsButton.type = 'button';
    settingsButton.setAttribute('aria-label', '打开对话设置');
    settingsButton.addEventListener('click', () => setDrawerOpen('right'));
    header.append(menu, title, settingsButton);

    const backdrop = createElement('button', 'homer-drawer-backdrop');
    backdrop.id = 'homer-drawer-backdrop';
    backdrop.type = 'button';
    backdrop.hidden = true;
    backdrop.setAttribute('aria-label', '关闭侧栏');
    backdrop.addEventListener('click', () => {
        const rightIsOpen = document.querySelector('#homer-right-drawer')?.classList.contains('is-open');
        rightIsOpen ? returnToDesktopNavigation() : setDrawerOpen();
    });

    const leftDrawer = createElement('aside', 'homer-drawer homer-drawer--left');
    leftDrawer.id = 'homer-left-drawer';
    leftDrawer.setAttribute('aria-label', '导航与历史会话');
    leftDrawer.setAttribute('aria-hidden', 'true');
    const leftHead = createElement('header', 'homer-drawer__head');
    leftHead.classList.add('homer-drawer__head--left');
    const brand = createElement('div');
    brand.append(createElement('h2', 'homer-drawer__title', '惑梦（Homer）'));
    const leftClose = createElement('button', 'homer-icon-button', '×');
    leftClose.type = 'button';
    leftClose.setAttribute('aria-label', '关闭导航');
    leftClose.addEventListener('click', () => setDrawerOpen());
    leftHead.append(brand, leftClose);
    const navigation = createElement('nav', 'homer-main-navigation');
    const navigationItems = [
        ['⌂', '我的', '/app/me.html'],
        ['⌕', '探索', '/app/explore.html'],
        ['♡', '收藏', '/app/favorites.html'],
        ['✦', '创意工坊', '/app/workshop.html'],
    ];
    for (const [icon, label, path] of navigationItems) {
        const link = document.createElement('a');
        link.className = 'homer-main-navigation__item';
        link.href = siteUrl(path);
        // 在 APK / 站点 iframe 里让宿主换页，而不是在 iframe 内部整页跳转。宿主侧是
        // 常驻 WebView，收到 navigate 会原地切页并保留旧页面；直接在 iframe 里加载
        // 站点页也会被主站的 frame-ancestors 'none' 拒掉。
        link.addEventListener('click', event => {
            if (!canNotifyHost()) return;
            event.preventDefault();
            notifyHost('navigate', { target: path });
        });
        link.append(
            createElement('span', 'homer-main-navigation__icon', icon),
            createElement('span', '', label),
        );
        navigation.append(link);
    }
    const historySection = createElement('section', 'homer-history');
    const historyHead = createElement('div', 'homer-history__head');
    const historyMeta = createElement('span', 'homer-history__meta');
    const historyCount = createElement('span', '', '0');
    historyCount.id = 'homer-history-count';
    const newConversation = createElement('button', 'homer-history__new', '+');
    newConversation.id = 'homer-history-new';
    newConversation.type = 'button';
    newConversation.setAttribute('aria-label', '为当前角色新建对话');
    newConversation.addEventListener('click', () => {
        document.querySelector('#homer-new-chat-dialog')?.showModal();
    });
    historyMeta.append(historyCount, newConversation);
    historyHead.append(createElement('h3', '', '历史会话'), historyMeta);
    const historyList = createElement('div', 'homer-history__list');
    historyList.id = 'homer-history-list';
    populateHistoryList(historyCount, historyList);
    historySection.append(historyHead, historyList);
    leftDrawer.append(leftHead, navigation, historySection);

    const rightDrawer = createElement('aside', 'homer-drawer homer-drawer--right');
    rightDrawer.id = 'homer-right-drawer';
    rightDrawer.setAttribute('aria-label', '对话设置');
    rightDrawer.setAttribute('aria-hidden', 'true');
    const rightHead = createElement('header', 'homer-drawer__head');
    const settingCopy = createElement('div');
    settingCopy.append(
        createElement('span', 'homer-drawer__eyebrow', 'CURRENT CHAT'),
        createElement('h2', 'homer-drawer__title', '对话设置'),
    );
    const rightClose = createElement('button', 'homer-icon-button', '×');
    rightClose.type = 'button';
    rightClose.setAttribute('aria-label', '关闭设置');
    rightClose.addEventListener('click', returnToDesktopNavigation);
    rightHead.append(settingCopy, rightClose);
    const settingList = createElement('div', 'homer-setting-list');
    const currentModel = selectedModel();
    const modelButton = createSettingButton(
        '◉',
        '模型设置',
        String(currentModel?.name || currentModel?.model || '网站默认模型'),
        'homer-open-model-settings',
    );
    modelButton.querySelector('.homer-setting-row__description').id = 'homer-model-summary';
    modelButton.addEventListener('click', () => {
        returnToDesktopNavigation();
        document.querySelector('#homer-model-dialog')?.showModal();
    });
    const presetButton = createSettingButton(
        '☷',
        '预设开关',
        '仅作用于当前对话',
        'homer-open-preset-settings',
    );
    presetButton.querySelector('.homer-setting-row__description').id = 'homer-preset-summary';
    presetButton.addEventListener('click', () => {
        returnToDesktopNavigation();
        setPanelOpen(true);
    });
    const favoritesLink = document.createElement('a');
    favoritesLink.className = 'homer-setting-row';
    favoritesLink.href = siteUrl('/app/favorites.html');
    favoritesLink.append(
        createElement('span', 'homer-setting-row__icon', '♡'),
        createElement('span', 'homer-setting-row__copy'),
        createElement('span', 'homer-setting-row__chevron', '›'),
    );
    favoritesLink.querySelector('.homer-setting-row__copy').append(
        createElement('strong', 'homer-setting-row__label', '收藏'),
        createElement('small', 'homer-setting-row__description', '管理已收藏的角色卡'),
    );
    const memoryButton = createSettingButton(
        '∞',
        '长记忆',
        'Memory Books · 当前对话记忆',
        'homer-open-memory-books',
    );
    memoryButton.addEventListener('click', () => {
        returnToDesktopNavigation();
        document.querySelector('#homer-memory-dialog')?.showModal();
    });
    const modButton = createSettingButton(
        '◇',
        'Mod',
        `${runtimeUiData.activeModIds.length} 个已启用`,
        'homer-open-mods',
    );
    modButton.querySelector('.homer-setting-row__description').id = 'homer-mod-summary';
    modButton.addEventListener('click', () => {
        returnToDesktopNavigation();
        document.querySelector('#homer-mod-dialog')?.showModal();
    });
    settingList.append(modelButton, presetButton, favoritesLink, memoryButton, modButton);
    rightDrawer.append(
        rightHead,
        createElement('p', 'homer-drawer__role', String(launch?.conversation?.title || roleName)),
        settingList,
        createElement(
            'p',
            'homer-privacy-note',
            '角色卡世界书正文受创作者保护。你只能通过预设开关调整创作者允许开放的条目。',
        ),
    );

    const panel = createElement('section', 'homer-preset-panel');
    panel.id = 'homer-preset-panel';
    panel.hidden = true;
    const panelHead = createElement('header', 'homer-preset-panel__head');
    const heading = createElement('div');
    heading.append(
        createElement('div', 'homer-preset-panel__eyebrow', '当前模型绑定预设'),
        createElement('h2', 'homer-preset-panel__title', '本次会话开关'),
    );
    const close = createElement('button', 'homer-icon-button', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭预设面板');
    close.addEventListener('click', () => setPanelOpen(false));
    panelHead.append(heading, close);

    const statusGrid = createElement('div', 'homer-status-grid');
    const runtimeStatus = createElement('div', 'homer-status-pill');
    runtimeStatus.append(createElement('i', 'homer-status-dot'));
    const runtimeText = createElement('span', '', '会话能力已连接');
    runtimeText.id = 'homer-runtime-status';
    runtimeText.dataset.state = 'online';
    runtimeStatus.append(runtimeText);
    const count = createElement('div', 'homer-status-pill homer-status-pill--gold', '读取预设…');
    count.id = 'homer-preset-count';
    statusGrid.append(runtimeStatus, count);

    const notice = createElement(
        'p',
        'homer-preset-notice',
        '这里只显示当前模型实际使用的一个预设，以及后台明确允许用户切换的条目；不会展示提示词或世界书正文。',
    );
    const quickList = createElement('div', 'homer-preset-list');
    quickList.id = 'homer-preset-quick-list';
    const expand = createElement('button', 'homer-expand-button', '展开全部条目');
    expand.type = 'button';
    expand.addEventListener('click', () => setFullDialogOpen(true));
    panel.append(panelHead, statusGrid, notice, quickList, expand);

    const dialog = createElement('dialog', 'homer-preset-dialog');
    dialog.id = 'homer-preset-dialog';
    const dialogShell = createElement('div', 'homer-preset-dialog__shell');
    const dialogHead = createElement('header', 'homer-preset-dialog__head');
    const dialogHeading = createElement('div');
    dialogHeading.append(
        createElement('div', 'homer-preset-panel__eyebrow', '当前模型唯一预设'),
        createElement('h2', 'homer-preset-dialog__title', '预设条目控制台'),
    );
    const dialogClose = createElement('button', 'homer-icon-button', '×');
    dialogClose.type = 'button';
    dialogClose.setAttribute('aria-label', '关闭全部条目');
    dialogClose.addEventListener('click', () => setFullDialogOpen(false));
    dialogHead.append(dialogHeading, dialogClose);
    const search = document.createElement('input');
    search.className = 'homer-preset-search';
    search.type = 'search';
    search.placeholder = '搜索当前预设条目';
    search.setAttribute('aria-label', '搜索预设条目');
    search.addEventListener('input', () => renderPresetLists(search.value));
    const fullList = createElement('div', 'homer-preset-list homer-preset-list--full');
    fullList.id = 'homer-preset-full-list';
    dialogShell.append(dialogHead, search, fullList);
    dialog.append(dialogShell);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) {
            setFullDialogOpen(false);
        }
    });

    root.append(
        header,
        backdrop,
        leftDrawer,
        rightDrawer,
        panel,
        dialog,
        buildModelDialog(),
        buildModDialog(),
        buildMemoryDialog(),
        buildRenameDialog(),
        buildConversationManagerDialog(),
        buildNewConversationMenu(),
        buildAttachmentDialog(),
        buildPresentationModeToggle(),
    );
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            setDrawerOpen();
            setPanelOpen(false);
        }
    });
    document.body.append(root);
    bindComposerAttachmentButton();
    renderPresetLists();
    flushHostNotices();
    // Navigation is a drawer on every viewport.  Opening it automatically on
    // desktop/landscape makes the background runtime visibly rearrange the
    // local first frame several seconds after launch.
    setDrawerOpen();
}

async function startNewConversation() {
    if (loadingLaunch || generationBusy || !launch?.app_id) {
        showHostNotice(generationBusy ? '回复生成完成后才能新建对话' : '当前会话仍在准备，请稍候', 'warning');
        return;
    }
    loadingLaunch = true;
    document.body.classList.add('homer-switching-chat');
    try {
        const created = await requestJson('/api/homer/conversations/start', {
            method: 'POST',
            body: JSON.stringify({
                app_id: launch.app_id,
                app_name: launch?.conversation?.app_name || launch?.card?.data?.name || '',
                app_icon: launch?.conversation?.app_icon || '',
                version_id: launch?.conversation?.version_id || launch?.version_id || '',
            }),
        });
        const conversation = {
            ...created,
            id: created?.conversation_id,
            app_id: created?.app_id || launch.app_id,
            title: created?.app_name || '新对话',
        };
        loadingLaunch = false;
        await switchConversation(conversation);
        void loadConversationHistory();
    } catch (error) {
        console.error(`${MODULE_ID}: conversation create failed`, error);
        showHostNotice(String(error?.message || '新建对话失败'), 'error');
    } finally {
        loadingLaunch = false;
        document.body.classList.remove('homer-switching-chat');
    }
}

async function switchConversation(conversation) {
    const targetConversationId = String(conversation?.id || conversation?.conversation_id || '').trim();
    const targetAppId = String(conversation?.app_id || '').trim();
    if (!targetConversationId || !targetAppId) {
        showHostNotice('这条历史会话缺少角色信息，暂时无法切换', 'error');
        return;
    }
    if (targetConversationId === String(launch?.conversation_id || '')) {
        setDrawerOpen();
        return;
    }
    if (loadingLaunch || generationBusy) {
        showHostNotice(generationBusy ? '回复生成完成后才能切换会话' : '会话正在切换，请稍候', 'warning');
        if (!loadingLaunch) notifyHostConversation('conversation-switch-failed');
        return;
    }

    const previous = {
        session,
        launch,
        runtimeVariables: { ...runtimeVariables },
        presetSearchQuery,
        runtimeUiData,
        extensionSettings: cloneJsonObject(extension_settings),
        extensionSettingsScope: lastExtensionSettingsScope,
        extensionSettingsSignature: lastExtensionSettingsSignature,
    };
    loadingLaunch = true;
    performance.mark('homer-switch-start');
    document.body.classList.add('homer-switching-chat');
    setDrawerOpen();
    notifyHostLoading('正在切换历史会话…');
    notifyHost('conversation-switching', {
        app_id: targetAppId.slice(0, 160),
        conversation_id: targetConversationId.slice(0, 160),
        role_name: String(conversation?.app_name || conversation?.title || '角色对话').slice(0, 120),
    });
    try {
        const currentAppId = String(launch?.app_id || '');
        const currentConversationId = String(launch?.conversation_id || '');
        const sameCharacterCard = currentAppId === targetAppId;
        const [, , nextSession] = await Promise.all([
            flushExtensionSettingsPersist(),
            syncCloudChat(),
            takePrefetchedSession(targetAppId, targetConversationId),
        ]);
        invalidateCachedSession(currentAppId, currentConversationId);
        performance.mark('homer-switch-session');
        if (!nextSession?.launch) {
            throw new Error('没有找到目标历史会话');
        }
        session = nextSession;
        launch = nextSession.launch;
        runtimeVariables = {};
        presetSearchQuery = '';
        lastSyncSignature = '';
        setAccessClasses(session?.user);
        await Promise.all([
            loadRuntimeState(),
            loadRuntimeUiData(),
        ]);
        performance.mark('homer-switch-hydrated');
        applyConnectionConfiguration();
        // Keep the website-owned shell visible while a large card and its
        // worldbook finish importing into the dialogue engine.
        buildRuntimeUi();
        await importLaunchCharacter({ reuseActiveCharacter: sameCharacterCard });
        performance.mark('homer-switch-card');
        await loadCloudChat({ emitChatChanged: sameCharacterCard });
        performance.mark('homer-switch-cloud');
        buildRuntimeUi();
        installTokenRefresh();
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('homer_app_id', launch.app_id);
        nextUrl.searchParams.set('homer_conversation_id', launch.conversation_id);
        nextUrl.searchParams.delete('app_id');
        nextUrl.searchParams.delete('conversation_id');
        nextUrl.searchParams.delete('conv_id');
        window.history.pushState({
            homer_app_id: launch.app_id,
            homer_conversation_id: launch.conversation_id,
        }, '', nextUrl);
        updateRuntimeStatus('云端已同步', 'online');
        reaffirmConversationConnection();
        window.setTimeout(reaffirmConversationConnection, 800);
        document.body.classList.remove('homer-runtime-error');
        notifyHostConversation();
        scheduleSessionPrefetch();
        performance.mark('homer-switch-ready');
    } catch (error) {
        session = previous.session;
        launch = previous.launch;
        runtimeVariables = previous.runtimeVariables;
        presetSearchQuery = previous.presetSearchQuery;
        runtimeUiData = previous.runtimeUiData;
        replaceExtensionSettings(previous.extensionSettings);
        await eventSource.emit(event_types.SETTINGS_LOADED);
        lastExtensionSettingsScope = previous.extensionSettingsScope;
        lastExtensionSettingsSignature = previous.extensionSettingsSignature;
        applyConnectionConfiguration();
        buildRuntimeUi();
        console.error(`${MODULE_ID}: conversation switch failed`, error);
        showHostNotice(String(error?.message || '历史会话切换失败'), 'error');
        // The host exposes its local shell while this switch runs.  Restore the
        // previous ready runtime immediately if the target cannot be loaded.
        notifyHostConversation('conversation-switch-failed');
    } finally {
        loadingLaunch = false;
        document.body.classList.remove('homer-switching-chat');
    }
}

function installEventHandlers() {
    if (eventHandlersInstalled) {
        return;
    }
    eventHandlersInstalled = true;
    eventSource.on(event_types.MESSAGE_SENT, messageIndex => {
        scheduleSync();
        void logDialogueEvent('message_send', Number(messageIndex));
        queueMessageMenuRender();
        scheduleHostStateNotify(0, 'message-sent');
    });
    eventSource.on(event_types.MESSAGE_EDITED, messageIndex => {
        scheduleSync();
        void logDialogueEvent('message_edit', Number(messageIndex));
        queueMessageMenuRender();
        scheduleHostStateNotify(0, 'message-edited');
    });
    eventSource.on(event_types.MESSAGE_DELETED, messageIndex => {
        scheduleSync();
        void logDialogueEvent('message_delete', Number(messageIndex));
        queueMessageMenuRender();
        scheduleHostStateNotify(0, 'message-deleted');
    });
    eventSource.on(event_types.MESSAGE_SWIPED, messageIndex => {
        scheduleSync();
        void logDialogueEvent('swipe', Number(messageIndex));
        queueMessageMenuRender();
        scheduleHostStateNotify(0, 'message-swiped');
    });
    for (const event of [event_types.MESSAGE_RECEIVED, event_types.MESSAGE_UPDATED]) {
        eventSource.on(event, () => {
            scheduleSync();
            queueMessageMenuRender();
            scheduleHostStateNotify(60, 'message-updated');
        });
    }
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        enforceStreamingConfiguration();
        // SillyTavern and prompt extensions use dry-run generations to assemble or
        // count prompts. A dry run has no matching GENERATION_ENDED event, so it
        // must never put Homer message actions into a persistent busy state.
        if (dryRun) {
            return;
        }
        window.clearTimeout(generationSettleTimer);
        generationSettleTimer = null;
        generationSnapshot = captureGenerationSnapshot(type);
        generationBusy = true;
        document.body.classList.add('homer-generating');
        queueMessageMenuRender();
        scheduleHostStateNotify(0, 'generation-started');
    });
    for (const event of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
        eventSource.on(event, () => {
            window.clearTimeout(generationSettleTimer);
            generationSettleTimer = null;
            const snapshot = generationSnapshot;
            generationSnapshot = null;
            // 串成一条链，避免连点重生成时两次恢复互相踩。
            generationRecoveryChain = generationRecoveryChain.then(async () => {
                try {
                    const recovered = await recoverFailedGeneration(snapshot);
                    if (!recovered) {
                        scheduleSync(100);
                    }
                } catch (error) {
                    console.error(`${MODULE_ID}: failed generation recovery did not complete`, error);
                    showHostNotice('回复生成失败，请刷新当前会话后重试。', 'error');
                    updateRuntimeStatus('生成恢复失败', 'warning');
                }
                await new Promise(resolve => {
                    generationSettleTimer = window.setTimeout(resolve, 300);
                });
                generationBusy = false;
                document.body.classList.remove('homer-generating');
                generationSettleTimer = null;
                queueMessageMenuRender();
                scheduleHostStateNotify(0, 'generation-ended');
            });
        });
    }
    eventSource.on(event_types.CHAT_CHANGED, () => {
        closeMessageMenu();
        window.setTimeout(renderPresetLists, 100);
        window.setTimeout(queueMessageMenuRender, 100);
    });
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        enforceStreamingConfiguration();
        void saveConversationExtensionSettings().catch(error => {
            console.warn(`${MODULE_ID}: extension settings persistence failed`, error);
        });
    });
    window.addEventListener('online', refreshBridgeToken);
    window.addEventListener('pagehide', () => {
        window.clearTimeout(sessionPrefetchTimer);
        sessionPrefetchCache.clear();
        void flushExtensionSettingsPersist({ force: true, keepalive: true }).catch(() => {});
    });
}

async function bootstrapLaunch(preloadedSession = null, administratorExtensionsPromise = Promise.resolve()) {
    if (loadingLaunch || !requestedAppId) {
        if (!requestedAppId) {
            failRuntimeGate(new Error('缺少角色会话参数，请从惑梦角色页重新进入。'));
        }
        return;
    }
    loadingLaunch = true;
    performance.mark('homer-bootstrap-start');
    notifyHostLoading('正在同步当前会话…');
    try {
        setRuntimeGate('正在确认会话', '正在读取账号、角色与云端存档…');
        session = preloadedSession || await fetchSession(requestedAppId, requestedConversationId);
        setAccessClasses(session?.user);
        if (!session?.launch) {
            throw new Error('没有可启动的角色会话');
        }
        launch = session.launch;
        setRuntimeGate('正在恢复配置', '同步模型、预设、扩展与当前对话设置…');
        notifyHostLoading('正在读取角色卡配置…');
        await Promise.all([
            loadRuntimeState(),
            loadRuntimeUiData(),
        ]);
        performance.mark('homer-bootstrap-hydrated');
        applyConnectionConfiguration();
        // Render navigation/settings immediately so the user never falls
        // through to the inherited runtime UI during a large card import.
        buildRuntimeUi();
        setRuntimeGate('正在装载角色卡', '解析世界书、正则、脚本与角色资源…');
        notifyHostLoading('正在装载角色卡、世界书与扩展…');
        // Extension discovery can run beside session/UI hydration, but card
        // import must not start until every administrator-approved compatibility
        // hook is active.
        await administratorExtensionsPromise;
        performance.mark('homer-bootstrap-extensions');
        // The embedded client already has settings, extensions and characters
        // at core-ready. Do not keep the visible cloud conversation behind the
        // standalone runtime's remaining backgrounds/tokenizers/personas work.
        // Extensions that attach APP_READY-time listeners receive an explicit
        // state replay below once that non-critical initialization completes.
        performance.mark('homer-bootstrap-core-ready');
        await importLaunchCharacter({ reuseActiveCharacter: true });
        setRuntimeGate('正在恢复对话', '载入云端消息并校准候选回复…');
        performance.mark('homer-bootstrap-card-imported');
        notifyHostLoading('正在恢复云端对话…');
        await loadCloudChat();
        performance.mark('homer-bootstrap-cloud-loaded');
        buildRuntimeUi();
        installEventHandlers();
        installMessageMenu();
        installTokenRefresh();
        // Native startup may normalize the API selectors after the early
        // core-ready configuration. Reapply the conversation bridge once all
        // upstream initialization has finished so the first send uses Homer,
        // not an empty/default provider.
        applyConnectionConfiguration();
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.set('homer_app_id', launch.app_id);
        cleanUrl.searchParams.set('homer_conversation_id', launch.conversation_id);
        cleanUrl.searchParams.delete('app_id');
        cleanUrl.searchParams.delete('conversation_id');
        cleanUrl.searchParams.delete('conv_id');
        window.history.replaceState({}, '', cleanUrl);
        updateRuntimeStatus('云端已同步', 'online');
        reaffirmConversationConnection();
        window.setTimeout(reaffirmConversationConnection, 800);
        setRuntimeGate('梦境已就绪', '正在呈现完整对话界面…');
        await releaseRuntimeGate();
        document.documentElement.classList.add('homer-runtime-ready');
        performance.mark('homer-bootstrap-ready');
        notifyHostConversation();
        void applicationReadyPromise.then(async () => {
            await postApplicationReadyWork;
            performance.mark('homer-bootstrap-app-ready');
            applyConnectionConfiguration();
            await eventSource.emit(event_types.CHAT_CHANGED, getContext().chatId);
            await eventSource.emit(event_types.CHAT_LOADED, getContext().chatId);
            reaffirmConversationConnection();
        }).catch(error => {
            console.warn(`${MODULE_ID}: post-ready extension replay failed`, error);
        });
        // History can be large and is not part of the current conversation's
        // critical path. Populate only its existing drawer nodes after the
        // chat is interactive; do not rebuild or navigate the page.
        window.setTimeout(() => {
            void loadConversationHistory();
        }, 250);
    } catch (error) {
        console.error(`${MODULE_ID}: launch failed`, error);
        document.body.classList.add('homer-runtime-error');
        failRuntimeGate(error);
        showHostNotice(String(error?.message || '对话模块启动失败'), 'error');
        notifyHostError();
    } finally {
        loadingLaunch = false;
    }
}

async function startHomerBridge() {
    runtimeGate()?.querySelector('.homer-runtime-gate__retry')?.addEventListener('click', () => {
        document.body.classList.remove('homer-runtime-error');
        setRuntimeGate('正在重新连接', '重新读取账号、角色卡与云端存档…');
        void bootstrapLaunch();
    });
    setRuntimeGate('正在连接惑梦', '确认登录状态、角色存档与对话扩展…');
    notifyHostLoading('正在初始化对话能力…');
    const launchSessionPromise = requestedAppId
        ? (launchSessionPreloadPromise ||= fetchSession(requestedAppId, requestedConversationId))
        : fetchSession();
    const administratorExtensionsPromise = loadAdministratorExtensions().catch(error => {
        console.warn(`${MODULE_ID}: administrator extensions failed`, error);
        window.__homerDialogueExtensions = {
            result: {
                loaded: [],
                skipped: [],
                failed: [{ id: 'registry', reason: String(error?.message || error) }],
            },
            list: [],
        };
    });
    try {
        const launchSession = await launchSessionPromise;
        session = launchSession;
        setAccessClasses(launchSession?.user);
        captureExtensionSettingsBaseline();
        installPresentationModeBridge();
        installRoleplayHubCompatibility();
        installCardStageRuntime();
        await bootstrapLaunch(launchSession, administratorExtensionsPromise);
    } catch (error) {
        console.error(`${MODULE_ID}: launch bootstrap failed`, error);
        failRuntimeGate(error);
        notifyHostError();
    }
}

export async function init() {
    if (initialized) {
        return;
    }
    initialized = true;
    installProductSurfaceBoundary();
    installEmbeddedComposerPolicy();
    notifyHostLoading('正在准备对话…');
    ensureHomerExtensionSettingDefaults();
    installExtensionSettingsPersistenceBridge();
    installKeywordInjector({
        active: Boolean(requestedAppId),
        persist: saveConversationExtensionSettings,
        logEvent: logDialogueEvent,
    });
    // Built-in extensions activate while settings load, so the bridge cannot
    // start directly from this hook. The host runtime announces a narrower
    // core-ready point after settings/extensions/characters are available;
    // standalone initialization can then finish in parallel. APP_READY remains
    // a safe fallback for upstream runtimes that do not emit the early event.
    const scheduleBridgeStart = () => {
        if (bridgeStartScheduled) {
            return;
        }
        bridgeStartScheduled = true;
        void startHomerBridge();
    };
    // Begin read-only session/UI/extension hydration at core-ready. The
    // bootstrap itself gates character selection and chat loading on APP_READY,
    // so third-party APP_READY-time CHAT_CHANGED subscriptions remain intact.
    window.addEventListener('homer:runtime-core-ready', () => {
        if (requestedAppId && !launchSessionPreloadPromise) {
            launchSessionPreloadPromise = fetchSession(requestedAppId, requestedConversationId);
        }
        scheduleBridgeStart();
    }, { once: true });
    eventSource.once(event_types.APP_READY, () => {
        applicationReady = true;
        resolveApplicationReady?.();
        // Do not widen the runtime document lookup surface while upstream
        // built-in extensions are still activating.  In particular, their
        // startup probes must only see the runtime DOM; falling through into
        // the website shell can make an unrelated host control look like an
        // upstream setting node and stall extension activation.  Card scripts
        // do not run before APP_READY, so installing the compatibility bridge
        // here preserves their parent/top lookup contract without extending
        // the critical startup path.
        installEmbeddedDocumentLookupBridge();
        scheduleBridgeStart();
        if (!reaffirmExtensionSettingsAfterReady || !conversationExtensionSettings) {
            return;
        }
        reaffirmExtensionSettingsAfterReady = false;
        postApplicationReadyWork = (async () => {
            replaceExtensionSettings(conversationExtensionSettings);
            await eventSource.emit(event_types.SETTINGS_LOADED);
            const snapshot = extensionSettingsSnapshot();
            lastExtensionSettingsScope = extensionSettingsScope();
            lastExtensionSettingsSignature = snapshot.signature;
        })().catch(error => {
            console.warn(`${MODULE_ID}: post-ready conversation settings replay failed`, error);
        });
    });
}
