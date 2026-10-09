// Dependency fixtures for the actual account-scoped product session functions.
// No credentials, HTTP service, card scripts, or real account are involved.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { prepareAcknowledgedPromptStates } from '../../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';
import { sanitizeRuntimeValue } from '../../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-local-runtime.mjs';

// These older fixtures isolate the selected bridge behavior. Real durable
// session storage is exercised independently by the R354 archive tests.
export const emptyLocalSessions = () => ({
    read: async () => null, remember: async () => {}, resource: async () => null,
    rememberResource: async () => {}, list: async () => [],
});

export function sessionVM(source, overrides = {}) {
    const start = source.indexOf('async function preferLocalSession(');
    const end = source.indexOf('\nfunction sessionCacheKey(', start);
    assert.ok(start >= 0 && end > start, 'Product local/session helper section is missing');
    const scope = {
        URLSearchParams, MODULE_ID: 'isolated-session-test', console: { debug() {} },
        storageAccountEpoch: 0, verifiedStorageOwner: '', storageOwner: 'unit-session-owner',
        preparedAdminLaunch: null, scopeDrafts: new Map(),
        sessionReadFences: new WeakMap(), storageAckStamps: new Map(), storageRequests: new Set(),
        acknowledgedPromptTickets: new WeakMap(), prepareAcknowledgedPromptStates,
        cardPreparations: { clear() {} }, sessionPrefetchCache: new Map(),
        localStorage: { getItem: key => key === 'ai_xingyue_logged_in' ? '1'
            : key === 'ai_xingyue_user' ? JSON.stringify({ id: 'unit-session-owner' }) : null },
        chatOutbox: {
            fence: async () => ({ revision: 0, ackRevision: 0, commitId: null }),
            read: async () => null,
        },
        localSessions: emptyLocalSessions(), localRuntime: null, sanitizeRuntimeValue,
        cloneJsonValue: value => JSON.parse(JSON.stringify(value)),
        // The transport cache is tested separately; this established session
        // fixture retains its original controlled request peripheral.
        requestSessionCard: (path, { request }) => request(path),
        ...overrides,
    };
    vm.createContext(scope);
    const storageStart = source.indexOf('function storageAckKey(');
    const storageEnd = source.indexOf('const extensionSyncQueue =', storageStart);
    assert.ok(storageStart >= 0 && storageEnd > storageStart, 'Product account/stamp helper section is missing');
    vm.runInContext(source.slice(storageStart, storageEnd) + '\n' + source.slice(start, end), scope);
    return scope;
}
