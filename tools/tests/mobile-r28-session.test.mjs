import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const text = await readFile(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
const start = text.indexOf('async function fetchSession(');
const end = text.indexOf('\nfunction sessionCacheKey(', start);
assert(start > 0 && end > start);
const full = { launch: { app_id: 'card', conversation_id: 'saved', card: { data: {} }, messages: [], bridge_token: 'test-only' } };

for (const behavior of ['unavailable', 'reservation-only', 'complete']) {
    test(`session ${behavior}: preserve existing conversation and require full runtime payload`, async () => {
        const paths = [];
        const scope = { adminPreviewRequested: false, URLSearchParams, MODULE_ID: 'test', console: { debug() {} }, requestJson: async path => {
            paths.push(path);
            if (paths.length === 1) {
                if (behavior === 'unavailable') throw Error('offline bridge');
                if (behavior === 'reservation-only') return { launch: { app_id: 'card', conversation_id: 'saved' } };
            }
            return full;
        } };
        vm.runInNewContext(text.slice(start, end), scope);
        assert.equal(await scope.fetchSession('card', 'saved'), full);
        assert.equal(paths.length, behavior === 'complete' ? 1 : 2);
        for (const path of paths) {
            const url = new URL(path, 'https://test.invalid');
            assert.equal(url.searchParams.get('conversation_id'), 'saved');
            assert.equal(url.searchParams.has('launch_only'), false);
        }
    });
}

test('incomplete fallback fails explicitly instead of caching a disconnected chat', async () => {
    const scope = { adminPreviewRequested: false, URLSearchParams, MODULE_ID: 'test', console: { debug() {} }, requestJson: async () => ({ launch: { app_id: 'card' } }) };
    vm.runInNewContext(text.slice(start, end), scope);
    await assert.rejects(scope.fetchSession('card', 'saved'), /会话数据不完整/);
});

test('admin workspace never falls back to creating a normal conversation', async () => {
    const paths = [];
    const scope = { adminPreviewRequested: true, URLSearchParams, MODULE_ID: 'test', requestJson: async path => { paths.push(path); throw Error('admin denied'); } };
    vm.runInNewContext(text.slice(start, end), scope);
    await assert.rejects(scope.fetchSession('card', '', true), /admin denied/);
    assert.equal(paths.length, 1); assert.ok(paths[0].startsWith('/api/homer/admin-preview?'));
});
