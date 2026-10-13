import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTimeline, createTimelineBuilder, anchorFor, resolveAnchor, scopeKey, createPresentationStore } from '../../frontend/app/assets/js/visual-novel-core.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const scope = { owner: 'test-owner', appId: 'test-card', conversationId: 'test-conversation' };
const makeMessage = (mes = '你好', extra = {}) => ({ mes, name: '向导', extra: { homer_sync_id: 'local-1', homer_message_id: 'cloud-1', ...extra } });
const makeAnchor = () => anchorFor(buildTimeline([makeMessage()])[0]);
const state = () => ({ cursor: makeAnchor(), settings: { autoAdvance: true, fontSize: 22 }, selectedChoice: null });

test('the fingerprint covers complete UTF-8 text and long messages remain complete', () => {
    const text = `${'长'.repeat(9000)}👩🏽‍🚀末尾`;
    const timeline = buildTimeline([makeMessage(text)]);
    assert.equal(timeline.map(item => item.text).join(''), text);
    assert.equal(timeline[0].fingerprint, `sha256-${createHash('sha256').update(text).digest('hex')}`);
    assert.ok(timeline.length > 15);
    assert.ok(timeline.every(item => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(item.text)).length <= 600));
    const changed = buildTimeline([makeMessage(`${text}后`)]);
    assert.equal(resolveAnchor(changed, anchorFor(timeline[0])).status, 'changed');
});

test('paragraphs split at safe Unicode boundaries, including a grapheme spanning the limit', () => {
    const emoji = '👨‍👩‍👧‍👦';
    const text = `${'x'.repeat(599)}${emoji}${'e\u0301'.repeat(610)}`;
    const timeline = buildTimeline([makeMessage(text)]);
    assert.equal(timeline.map(item => item.text).join(''), text);
    assert.ok(timeline[0].text.endsWith(emoji));
    assert.ok(!timeline.some(item => /^[\uDC00-\uDFFF\u0301\u200d]/u.test(item.text)));
    assert.deepEqual(buildTimeline([makeMessage('一段\n\n第二段')]).map(item => item.text), ['一段', '第二段']);
    const segmenter = Intl.Segmenter;
    try {
        Intl.Segmenter = undefined;
        const fallback = buildTimeline([makeMessage(text)]);
        assert.equal(fallback.map(item => item.text).join(''), text);
        assert.ok(fallback[0].text.endsWith(emoji));
        assert.ok(!fallback.some(item => /^[\uDC00-\uDFFF\u0301\u200d]/u.test(item.text)));
    } finally { Intl.Segmenter = segmenter; }
});

test('sequential legacy tags update only following segments and cues persist across replies', () => {
    const input = '[背景:教室][角色:爱丽丝][立绘:happy]你好。[角色:旁白]窗外下雨。[BGM:rain][mood:calm]雨声响起。';
    const timeline = buildTimeline([makeMessage(input), { id: 'next', content: '继续。', name: '向导' }]);
    assert.deepEqual(timeline.map(item => [item.speaker, item.kind, item.text]), [
        ['爱丽丝', 'dialogue', '你好。'], ['', 'narration', '窗外下雨。'], ['', 'narration', '雨声响起。'], ['向导', 'dialogue', '继续。'],
    ]);
    assert.deepEqual(timeline[0].cues, { background: '教室', portrait: 'happy', bgm: '', mood: '' });
    assert.equal(timeline[1].cues.bgm, '');
    assert.deepEqual(timeline[3].cues, { background: '教室', portrait: 'happy', bgm: 'rain', mood: 'calm' });
});

test('only explicit validated choice JSON becomes choices; HTML and script remain plain strings', () => {
    const choices = [{ id: 'ask', label: '询问', text: '询问来历' }, { label: '等待', text: '等待一会儿' }];
    const timeline = buildTimeline([makeMessage(`请选择\n\n\`\`\`choices\n${JSON.stringify({ choices })}\n\`\`\``)]);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].choices.length, 2);
    assert.deepEqual(timeline[0].choices[0], choices[0]);
    assert.equal(timeline[0].choices[1].id, buildTimeline([makeMessage(`\`\`\`choices\n${JSON.stringify(choices)}\n\`\`\``)])[0].choices[1].id);
    const explicitJson = buildTimeline([makeMessage(`\`\`\`json\n${JSON.stringify({ type: 'choices', choices })}\n\`\`\``)]);
    assert.equal(explicitJson[0].choices.length, 2);
    for (const body of [JSON.stringify({ choices }), JSON.stringify({ choices: [{ label: '执行', text: '执行', javascript: 'evil()' }] }),
        '{"choices":[{"label":"执行","text":"执行","__proto__":{}}]}', 'evil()', JSON.stringify({ choices: [...choices, { id: 'ask', label: '重复', text: '重复' }] })]) {
        const language = body === JSON.stringify({ choices }) ? 'json' : 'choices';
        const source = `\`\`\`${language}\n${body}\n\`\`\``;
        const rows = buildTimeline([makeMessage(source)]);
        assert.equal(rows.flatMap(item => item.choices).length, 0);
        assert.equal(rows.map(item => item.text).join(''), source);
    }
    const html = '<script>globalThis.bad = true</script><button onclick="bad()">点我</button>';
    assert.equal(buildTimeline([makeMessage(html)])[0].text, html);
    assert.equal(globalThis.bad, undefined);
});

test('fences protect literal tags, user text stays literal, and system messages are excluded', () => {
    const literal = '```text\n[角色:伪造][BGM:music]\n```';
    const timeline = buildTimeline([{ id: 'system', role: 'system', content: '内部提示' }, makeMessage(literal),
        { id: 'user', role: 'user', content: '[背景:我输入的文字]', name: '玩家' }]);
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].text, literal);
    assert.equal(timeline[0].speaker, '向导');
    assert.equal(timeline[1].kind, 'user');
    assert.equal(timeline[1].text, '[背景:我输入的文字]');
    assert.equal(timeline[1].cues.background, '');
    const unclosed = '```html\n[角色:伪造]<script>bad()</script>\n```json\n[背景:不可触发]';
    assert.equal(buildTimeline([makeMessage(unclosed)]).map(item => item.text).join(''), unclosed);
    assert.equal(buildTimeline([makeMessage(unclosed)])[0].cues.background, '');
});

test('anchors survive insertion/reordering and local-to-cloud aliases without using message indexes', () => {
    const original = buildTimeline([makeMessage('第一段\n\n第二段')]);
    const anchor = anchorFor(original[1]);
    const later = buildTimeline([{ id: 'new', content: '前面插入的消息' }, makeMessage('第一段\n\n第二段', { homer_message_id: 'cloud-new' })]);
    const resolved = resolveAnchor(later, anchor);
    assert.equal(resolved.status, 'exact');
    assert.equal(resolved.index, 2);
    assert.equal(resolved.segment.text, '第二段');
    assert.equal(resolveAnchor(buildTimeline([makeMessage('被编辑')]), anchor).status, 'changed');
    assert.equal(resolveAnchor(buildTimeline([{ id: 'unrelated', content: '无关消息' }]), anchor).status, 'missing');
    assert.equal(resolveAnchor(later, { ...anchor, fingerprint: 'not-a-hash' }).status, 'missing');
});

test('swipes are separate anchors; ambiguous anonymous or duplicate IDs do not restore a position', () => {
    const message = { ...makeMessage(), swipes: ['候选一', '候选二'], swipe_id: 0 };
    const anchor = anchorFor(buildTimeline([message])[0]);
    const later = buildTimeline([{ ...message, swipe_id: 1 }]);
    assert.equal(later[0].text, '候选二');
    assert.equal(resolveAnchor(later, anchor).status, 'changed');
    const one = { content: '无固定编号' };
    const anonymous = buildTimeline([one]);
    const duplicated = buildTimeline([one, one]);
    assert.notEqual(duplicated[0].id, duplicated[1].id);
    assert.equal(resolveAnchor(duplicated, anchorFor(anonymous[0])).status, 'missing');
    assert.equal(resolveAnchor(buildTimeline([message, message]), anchor).status, 'missing');
});

test('incremental projection stays identical through edits, swipes, inserts, scene changes and speaker defaults', () => {
    const build = createTimelineBuilder();
    const messages = [{ id: 'a', content: '[背景:教室][角色:向导]第一段' },
        { id: 'b', content: '第二段', swipes: ['第二段', '候选改变'], swipe_id: 0 },
        { id: 'c', content: '[背景:花园]第三段' }, { id: 'd', content: '第四段' },
        { content: '无编号', role: 'user' }];
    let options = { characterName: '向导', userName: '玩家' };
    const compare = () => assert.deepEqual(build(messages, options), buildTimeline(messages, options));
    compare(); compare();
    messages[0].content = '[背景:海边][角色:新角色]第一段'; compare();
    assert.equal(build(messages, options)[1].cues.background, '海边');
    assert.equal(build(messages, options)[3].cues.background, '花园');
    messages[1].swipe_id = 1; compare();
    messages.unshift({ id: 'new', content: '[BGM:theme]插入的段落' }); compare();
    messages.splice(2, 1); compare();
    messages.reverse(); compare();
    options = { characterName: '另一个默认角色', userName: '新的玩家' }; compare();
    assert.ok(build(messages, options).some(item => item.kind === 'user' && item.speaker === '新的玩家'));
    messages[0].content += '\n\n追加段落'; compare();
    build.clear(); compare();
    assert.deepEqual(build([]), []);
});

test('cached timelines do not retain caller mutations or confuse duplicated message IDs', () => {
    const build = createTimelineBuilder();
    const choice = '```choices\n[{"id":"ask","label":"询问","text":"询问"}]\n```';
    const messages = [{ id: 'same', content: '[背景:教室]原文\n' + choice }, { id: 'same', content: '另外一段' }];
    const expected = buildTimeline(messages);
    const changed = build(messages);
    changed[0].text = '不能污染缓存'; changed[0].cues.background = '错误';
    changed[0].choices[0].label = '错误'; changed[0].messageAliases.push('错误');
    assert.deepEqual(build(messages), expected);
    messages.reverse();
    assert.deepEqual(build(messages), buildTimeline(messages));
    const independent = createTimelineBuilder();
    assert.deepEqual(independent([{ id: 'same', content: '另一个会话' }]), buildTimeline([{ id: 'same', content: '另一个会话' }]));
});

test('scope keys cannot collide through delimiters and missing scopes fail closed', () => {
    assert.notEqual(scopeKey({ owner: 'a:b', appId: 'c', conversationId: 'd' }), scopeKey({ owner: 'a', appId: 'b:c', conversationId: 'd' }));
    for (const invalid of [null, {}, { ...scope, owner: '' }, { ...scope, conversationId: undefined }]) {
        assert.throws(() => scopeKey(invalid), { code: 'VN_SCOPE_REQUIRED' });
    }
});

test('unavailable/failed/blocked storage is not replaced with a pretend durable memory store', async () => {
    const absent = createPresentationStore({ indexedDB: null });
    await assert.rejects(absent.save(scope, state()), { code: 'VN_STORE_UNAVAILABLE' });
    const failedFactory = cardTransportIDB(); failedFactory.openError = true;
    await assert.rejects(createPresentationStore({ indexedDB: failedFactory }).load(scope), { code: 'VN_STORE_UNAVAILABLE' });
    const blockedFactory = cardTransportIDB(); blockedFactory.blockNextOpen = true;
    await assert.rejects(createPresentationStore({ indexedDB: blockedFactory }).load(scope), { code: 'VN_STORE_BLOCKED' });
    const factory = cardTransportIDB();
    await assert.rejects(createPresentationStore({ indexedDB: factory }).load({}), { code: 'VN_SCOPE_REQUIRED' });
    assert.equal(factory.openCount, 0);
});

test('save waits for transaction completion; reopening restores sanitized reading state and bookmarks', async () => {
    const indexedDB = cardTransportIDB();
    const store = createPresentationStore({ indexedDB });
    await store.load(scope);
    const gate = indexedDB.holdNextCommit('readwrite');
    let complete = false;
    const writing = store.save(scope, { ...state(), accountToken: 'synthetic-secret-must-not-store', messages: ['original'], credits: 123,
        settings: { ...state().settings, typewriterSpeed: 0, fontSize: 100, volume: 3, voice: true, extra: 'drop-me' },
        selectedChoice: { anchor: makeAnchor(), choiceId: 'ask', text: 'do-not-store' } }).then(value => { complete = true; return value; });
    await gate.reached;
    assert.equal(complete, false);
    assert.equal(indexedDB.dump('homer-vn-reading-bookmarks', 'reading_bookmarks').length, 0);
    gate.release();
    const saved = await writing;
    assert.equal(saved.settings.fontSize, 26);
    assert.equal(saved.settings.volume, 1);
    assert.equal(saved.settings.typewriterSpeed, 10);
    await store.putSave(scope, { id: 'slot-1', name: '阅读书签', anchor: makeAnchor(), createdAt: 100, accountToken: 'drop-me' });
    store.close();
    const reopened = createPresentationStore({ indexedDB });
    const restored = await reopened.load(scope);
    assert.equal(restored.settings.autoAdvance, false);
    assert.equal(restored.settings.voice, true);
    assert.deepEqual(restored.selectedChoice, { anchor: makeAnchor(), choiceId: 'ask' });
    assert.equal((await reopened.listSaves(scope))[0].name, '阅读书签');
    const persisted = JSON.stringify(indexedDB.dump('homer-vn-reading-bookmarks', 'reading_bookmarks'));
    for (const forbidden of ['accountToken', 'messages', 'credits', 'synthetic-secret-must-not-store', 'do-not-store', 'drop-me']) assert.ok(!persisted.includes(forbidden));
    assert.equal(await reopened.deleteSave(scope, 'slot-1'), true);
    assert.equal(await reopened.deleteSave(scope, 'slot-1'), false);
    reopened.close();
    await assert.rejects(reopened.load(scope), { code: 'VN_STORE_CLOSED' });
});

test('owner/app/conversation isolation, 24-slot capacity, and quota errors preserve earlier reading state', async () => {
    const indexedDB = cardTransportIDB();
    const store = createPresentationStore({ indexedDB });
    await store.save(scope, state());
    for (const other of [{ ...scope, owner: 'other' }, { ...scope, appId: 'other' }, { ...scope, conversationId: 'other' }]) {
        assert.equal(await store.load(other), null);
        assert.deepEqual(await store.listSaves(other), []);
    }
    for (let index = 0; index < 24; index++) await store.putSave(scope, { id: `slot-${index}`, name: `书签${index}`, anchor: makeAnchor(), createdAt: index });
    await assert.rejects(store.putSave(scope, { id: 'slot-over', name: '超额', anchor: makeAnchor(), createdAt: 25 }), { code: 'VN_BOOKMARK_LIMIT' });
    assert.equal((await store.listSaves(scope)).length, 24);
    await store.putSave(scope, { id: 'slot-0', name: '覆盖同一阅读书签', anchor: makeAnchor(), createdAt: 26 });
    assert.equal((await store.listSaves(scope))[0].name, '覆盖同一阅读书签');
    indexedDB.failNextPut = true;
    await assert.rejects(store.save(scope, { ...state(), cursor: anchorFor(buildTimeline([makeMessage('新位置')])[0]) }), { code: 'VN_STORE_WRITE_FAILED' });
    assert.deepEqual((await store.load(scope)).cursor, makeAnchor());
    assert.equal((await store.listSaves(scope)).length, 24);
    store.close();
});

test('old WebView durability options fall back to a real IndexedDB transaction, not memory', async () => {
    const indexedDB = cardTransportIDB(); indexedDB.strictUnsupported = true;
    const store = createPresentationStore({ indexedDB });
    await store.save(scope, state());
    assert.deepEqual((await store.load(scope)).cursor, makeAnchor());
    assert.ok(indexedDB.trace.some(item => item.event === 'transaction-complete' && item.mode === 'readwrite'));
    store.close();
});

test('invalid stored records fail closed and missing object stores never fabricate empty state', async () => {
    const indexedDB = cardTransportIDB();
    const store = createPresentationStore({ indexedDB });
    await store.save(scope, state());
    const key = scopeKey(scope);
    const raw = indexedDB.dump('homer-vn-reading-bookmarks', 'reading_bookmarks')[0];
    indexedDB.seed('homer-vn-reading-bookmarks', 'reading_bookmarks', key, { ...raw,
        state: { ...raw.state, updatedAt: { accountToken: 'do-not-expose' } } });
    await assert.rejects(store.load(scope), { code: 'VN_STATE_INVALID' });
    indexedDB.seed('homer-vn-reading-bookmarks', 'reading_bookmarks', key, { ...raw, version: 2 });
    await assert.rejects(store.listSaves(scope), { code: 'VN_STATE_INVALID' });
    indexedDB.database('homer-vn-reading-bookmarks').stores.delete('reading_bookmarks');
    await assert.rejects(store.load(scope), { code: 'VN_STORE_UNAVAILABLE' });
    store.close();
});
