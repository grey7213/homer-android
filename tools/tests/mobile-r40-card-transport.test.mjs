import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardTransport } from '../../sillytavern-runtime/public/scripts/homer-card-transport.mjs';

const REV = 'a'.repeat(64), NEW_REV = 'b'.repeat(64);
const copy = value => JSON.parse(JSON.stringify(value));
const card = { spec: 'chara_card_v2', data: { name: 'Synthetic fixture', extensions: { scripts: ['synthetic-only'], book: { text: 'intact' } } } };
const mirror = { avatar: 'synthetic.png', name: 'Synthetic fixture', data: card.data, json_data: JSON.stringify(card), chat: 'synthetic' };
const freshStats = { chat_size: 120, date_last_chat: 250 };
const mirrorBody = ({ content = mirror, revision = REV, hit = false, stats = freshStats } = {}) => ({
    homer_character_transport: { version: 2, sha256: revision, ...(hit ? { not_modified: true } : {}) },
    ...(hit ? {} : { character: content }), fresh_stats: stats,
});
const response = body => ({ ok: true, status: 200, json: async () => copy(body) });
function harness(kind = 'session-card', row = null) {
    let clock = 100, current = true;
    const calls = [], stored = [], cacheReads = [];
    const storage = { read: async (...args) => { cacheReads.push(args); return copy(row); },
        write: async (...args) => { stored.push(copy(args)); } };
    const api = createCardTransport({ storage, now: () => clock, readTimeoutMs: 15 });
    const replies = [];
    const request = async (path, config) => {
        calls.push({ path, body: config ? JSON.parse(config.body) : null });
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply() : copy(reply);
    };
    const base = { owner: 'fixture-owner', isCurrent: () => current };
    const session = () => api.session('/api/homer/session?app_id=fixture-card&conversation_id=fixture-chat', {
        ...base, appId: 'fixture-card', conversationId: 'fixture-chat', request,
        validate: payload => assert.equal(payload.user.id, base.owner),
    });
    const character = () => api.character('synthetic.png', { ...base, headers: {}, fetcher: request });
    return { api, replies, calls, stored, cacheReads, storage, run: kind === 'session-card' ? session : character,
        expire: () => { clock = 1000; }, stale: () => { current = false; } };
}
const sessionBody = (includeCard = true, revision = REV) => ({
    user: { id: 'fixture-owner' },
    launch: { app_id: 'fixture-card', conversation_id: 'fixture-chat', bridge_token: 'synthetic-nonsecret-token',
        messages: [{ content: 'Fresh cloud body' }], card_transport: { version: 1, sha256: revision },
        ...(includeCard ? { card: copy(card) } : {}) },
});
const row = payload => ({ payload, revision: REV, expiresAt: 500 });

test('session miss preserves fresh token/messages and stores only the complete card', async () => {
    const h = harness(); h.replies.push(sessionBody()); const body = await h.run();
    assert.match(h.calls[0].path, /card_cache=1/); assert.doesNotMatch(h.calls[0].path, /card_sha256/);
    assert.deepEqual(body.launch.card, card); assert.equal(body.launch.bridge_token, 'synthetic-nonsecret-token');
    assert.deepEqual(h.stored, [['fixture-owner', 'session-card', 'fixture-card', REV, card]]);
    body.launch.card.data.name = 'Changed live state';
    assert.equal(h.stored[0][4].data.name, 'Synthetic fixture');
});
test('session cache hit still performs authenticated read and restores exact full source', async () => {
    const h = harness('session-card', row(card)); h.replies.push(sessionBody(false)); const body = await h.run();
    assert.match(h.calls[0].path, new RegExp(`card_sha256=${REV}`));
    assert.equal(h.calls.length, 1); assert.deepEqual(body.launch.card, card);
    assert.equal(body.launch.messages[0].content, 'Fresh cloud body'); assert.equal(h.stored.length, 0);
});
test('changed server card replaces prior revision, not a source-signature match', async () => {
    const h = harness('session-card', row(card)); const body = sessionBody(true, NEW_REV); body.launch.card.data.name = 'New source';
    h.replies.push(body); assert.equal((await h.run()).launch.card.data.name, 'New source');
    assert.equal(h.stored[0][3], NEW_REV);
});
test('expired while awaiting session refetches full payload without known revision', async () => {
    const h = harness('session-card', row(card)); h.replies.push(() => { h.expire(); return sessionBody(false); }, sessionBody());
    await h.run(); assert.equal(h.calls.length, 2); assert.doesNotMatch(h.calls[1].path, /card_sha256/);
});
test('mismatched/missing conditional session response never fabricates a launch', async () => {
    const h = harness('session-card', row(card)); h.replies.push(sessionBody(false, NEW_REV), sessionBody(false, NEW_REV));
    await assert.rejects(h.run(), /校验失败/); assert.equal(h.calls.length, 2); assert.equal(h.stored.length, 0);
});
test('old server full body remains supported without transport marker', async () => {
    const h = harness(); const legacy = sessionBody(); delete legacy.launch.card_transport;
    h.replies.push(legacy); assert.deepEqual(await h.run(), legacy); assert.equal(h.stored.length, 0);
});
for (const variant of ['owner', 'app', 'conversation']) test(`session ${variant} mismatch rejects before restoring cache`, async () => {
    const h = harness('session-card', row(card)); const invalid = sessionBody(false);
    if (variant === 'owner') invalid.user.id = 'different-fixture-owner';
    if (variant === 'app') invalid.launch.app_id = 'different-card';
    if (variant === 'conversation') invalid.launch.conversation_id = 'different-chat';
    h.replies.push(invalid); await assert.rejects(h.run()); assert.equal(h.stored.length, 0);
});
test('account epoch changing during authenticated session read rejects cache restoration', async () => {
    const h = harness('session-card', row(card)); h.replies.push(() => { h.stale(); return sessionBody(false); });
    await assert.rejects(h.run(), /账号或会话已变化/);
});
test('a stored card never provides offline access on failed authenticated read', async () => {
    const h = harness('session-card', row(card)); h.replies.push(Error('HTTP 401 synthetic'));
    await assert.rejects(h.run(), /401/); assert.equal(h.stored.length, 0);
});
test('admin preview/incomplete session is never populated or retained from this cache', async () => {
    const h = harness('session-card', row(card)); const preview = sessionBody(false); preview.launch.admin_preview = true;
    h.replies.push(preview); assert.equal((await h.run()).launch.card, undefined); assert.equal(h.stored.length, 0);
});
test('optional unavailable or slow database falls back to a full online read', async () => {
    for (const read of [async () => { throw Error('db unavailable'); }, () => new Promise(() => {})]) {
        const h = harness(); h.storage.read = read; h.replies.push(sessionBody());
        assert.deepEqual((await h.run()).launch.card, card); assert.doesNotMatch(h.calls[0].path, /card_sha256/);
    }
});
test('mirror hit keeps json_data, unknown fields and exact avatar after server confirmation', async () => {
    const h = harness('character-mirror', row(mirror));
    h.replies.push(() => response(mirrorBody({ hit: true })));
    const restored = await (await h.run()).json(); assert.deepEqual(restored, { ...mirror, ...freshStats });
    assert.equal(h.calls[0].body.card_cache, 2);
    assert.deepEqual(h.cacheReads[0].slice(0, 3), ['fixture-owner', 'character-content-v2', 'synthetic.png']);
    assert.equal(typeof h.cacheReads[0][3].onRevision, 'function');
    assert.equal(h.calls[0].body.card_sha256, REV); assert.equal(h.calls.length, 1); assert.equal(h.stored.length, 0);
});
test('mirror server edit returns and caches the changed complete object', async () => {
    const h = harness('character-mirror', row(mirror)); const changed = { ...mirror, json_data: 'Updated synthetic JSON' };
    h.replies.push(() => response(mirrorBody({ content: changed, revision: NEW_REV })));
    assert.deepEqual(await (await h.run()).json(), { ...changed, ...freshStats }); assert.equal(h.stored[0][3], NEW_REV);
    assert.equal(h.stored[0][1], 'character-content-v2');
    assert.deepEqual(h.stored[0][4], changed, 'statistics never enter the content cache');
});
for (const status of [401, 403, 404, 500]) test(`mirror HTTP ${status} cannot be replaced with a cached success`, async () => {
    const h = harness('character-mirror', row(mirror)); h.replies.push(() => ({ ok: false, status }));
    assert.equal((await h.run()).status, status); assert.equal(h.calls.length, 1); assert.equal(h.stored.length, 0);
});
test('mirror cache expires while waiting: retry full read without returning stale object', async () => {
    const h = harness('character-mirror', row(mirror));
    h.replies.push(() => { h.expire(); return response(mirrorBody({ hit: true })); },
        () => response(mirrorBody()));
    assert.deepEqual(await (await h.run()).json(), { ...mirror, ...freshStats }); assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].body.card_sha256, undefined);
});
test('mirror another avatar or account epoch cannot populate the character array', async () => {
    const mismatch = harness('character-mirror'); mismatch.replies.push(() => response(mirrorBody({ content: { ...mirror, avatar: 'other.png' } })));
    await assert.rejects(mismatch.run(), /不一致/);
    const stale = harness('character-mirror', row(mirror)); stale.replies.push(() => { stale.stale(); return response(mirror); });
    await assert.rejects(stale.run(), /账号或会话已变化/);
});

test('v2 mirror hits apply new statistics without losing stable fields or mutating cached content', async () => {
    const stable = { ...mirror, arbitrary: { field: 'preserve' } };
    const h = harness('character-mirror', row(stable));
    for (const stats of [freshStats, { chat_size: 999, date_last_chat: 12345 }]) {
        h.replies.push(() => response(mirrorBody({ hit: true, stats })));
        const value = await (await h.run()).json();
        assert.deepEqual(value, { ...stable, ...stats });
        value.data.name = 'Live mutation';
    }
    assert.equal(h.stored.length, 0);
    assert.equal(stable.data.name, 'Synthetic fixture');
    assert.equal(Object.hasOwn(stable, 'chat_size'), false);
});
test('legacy mirror server returns its exact full object without trusting a v2 cache hit', async () => {
    const h = harness('character-mirror', row(mirror));
    const legacy = { ...mirror, ...freshStats, arbitrary: 'still included' };
    h.replies.push(() => response(legacy));
    assert.deepEqual(await (await h.run()).json(), legacy);
    assert.equal(h.stored.length, 0);
});
test('missing/malformed fresh statistics fail without restoring a cached success', async () => {
    for (const stats of [null, [], {}, { chat_size: 0 }, { ...freshStats, date_last_chat: -1 },
        { ...freshStats, chat_size: '120' }, { ...freshStats, arbitrary: 'must not inject' }]) {
        const h = harness('character-mirror', row(mirror));
        h.replies.push(() => response(mirrorBody({ hit: true, stats })));
        await assert.rejects(h.run(), /统计资料无效/);
        assert.equal(h.stored.length, 0);
    }
});
test('v2 refuses statistics smuggled into stable content rather than silently dropping fields', async () => {
    for (const hit of [false, true]) {
        const polluted = { ...mirror, chat_size: 1 };
        const h = harness('character-mirror', row(polluted));
        h.replies.push(() => response(mirrorBody({ hit, content: polluted })));
        await assert.rejects(h.run(), /版本格式无效/);
        assert.equal(h.stored.length, 0);
    }
});
test('wrong mirror content revision retries exactly once without known SHA', async () => {
    const h = harness('character-mirror', row(mirror));
    h.replies.push(() => response(mirrorBody({ hit: true, revision: NEW_REV })),
        () => response(mirrorBody({ content: mirror, revision: NEW_REV })));
    assert.deepEqual(await (await h.run()).json(), { ...mirror, ...freshStats });
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].body.card_sha256, undefined);
});
