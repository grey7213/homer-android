import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/personas.js', import.meta.url), 'utf8');
const first = source.indexOf('function homerGreetingScope(');
const last = source.indexOf('async function duplicatePersona(', first);
assert.ok(first > 0 && last > first);
const functions = source.slice(first, last).replaceAll('export ', '');

function fixture({ bridge = true, swiped = false } = {}) {
    const calls = [];
    const card = { name: 'Card', first_mes: 'Hello {{user}}', data: {
        alternate_greetings: ['Other {{user}}'], extensions: { homer_bridge: { app_id: 'test-app' } },
    } };
    const message = { name: 'Card', is_user: false, is_system: false, mes: swiped ? 'Other Old' : 'Hello Old',
        send_date: 'test-date', swipe_id: swiped ? 1 : 0, swipes: ['Hello {{user}}', 'Other {{user}}'],
        swipe_info: [{ extra: { display_text: 'Hello Old', preserved: true } }, { extra: { display_text: 'Other Old', preserved: true } }],
        extra: { homer_sync_id: 'greeting-test-chat', homer_message_id: 'test-message', display_text: 'Old display' },
    };
    const scope = {
        characters: [card], chat: [message], this_chid: '0', name1: 'New', name2: 'Card', selected_group: null, is_send_press: false,
        chat_metadata: bridge ? { homer_bridge: { app_id: 'test-app', conversation_id: 'test-chat', runtime: 'dialogue' } } : {},
        getCurrentChatId: () => 'Homer-test-chat',
        regex_placement: { AI_OUTPUT: 2 },
        getRegexedString: (text, placement) => { calls.push(['regex', placement, text]); return text; },
        redisplayChat: async options => {
            calls.push(['paint', options]);
            scope.chat[0].mes = scope.chat[0].mes.replaceAll('{{user}}', scope.name1);
        },
        event_types: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        eventSource: { emit: async (...args) => { calls.push(['event', ...args]); } },
        saveChatConditional: async () => calls.push(['save']),
        createOrEditCharacter: async () => calls.push(['edit-card']),
        reloadCurrentChat: async () => calls.push(['reload']),
    };
    vm.createContext(scope); vm.runInContext(functions, scope);
    return { scope, calls, card, message };
}

test('current Homer greeting changes persona through normal rendering without editing its character', async () => {
    const f = fixture(); const originalCard = JSON.stringify(f.card);
    await f.scope.retriggerFirstMessageOnEmptyChat();
    assert.equal(f.scope.chat[0], f.message); assert.equal(f.message.mes, 'Hello New');
    assert.equal(f.message.send_date, 'test-date');
    assert.equal(f.message.extra.homer_sync_id, 'greeting-test-chat'); assert.equal(f.message.extra.homer_message_id, 'test-message');
    assert.equal(f.message.extra.display_text, undefined); assert.equal(f.message.swipe_info[0].extra.display_text, undefined);
    assert.equal(f.message.swipe_info[0].extra.preserved, true); assert.equal(JSON.stringify(f.card), originalCard);
    assert.deepEqual(f.calls.map(x => x[0]), ['regex', 'regex', 'paint', 'event', 'event', 'save']);
    assert.deepEqual(f.calls.filter(x => x[0] === 'event'), [['event', 'received', 0, 'first_message'], ['event', 'rendered', 0, 'first_message']]);
});

test('chosen alternate opening, cloud identity and raw swipes survive persona refresh', async () => {
    const f = fixture({ swiped: true });
    await f.scope.retriggerFirstMessageOnEmptyChat();
    assert.equal(f.message.swipe_id, 1); assert.equal(f.message.mes, 'Other New');
    assert.deepEqual(Array.from(f.message.swipes), ['Hello {{user}}', 'Other {{user}}']);
    assert.equal(f.message.extra.homer_message_id, 'test-message');
});

test('pristine single-user/system messages and a generating chat are never replaced or submitted to editor', async () => {
    for (const flag of ['is_user', 'is_system']) {
        const f = fixture(); f.message[flag] = true;
        await f.scope.retriggerFirstMessageOnEmptyChat(); assert.equal(f.calls.length, 0); assert.equal(f.message.mes, 'Hello Old');
    }
    const generating = fixture(); generating.scope.is_send_press = true;
    await generating.scope.retriggerFirstMessageOnEmptyChat(); assert.equal(generating.calls.length, 0);
});

test('tainted or multi-message Homer conversations are unchanged', async () => {
    const tainted = fixture(); tainted.scope.chat_metadata.tainted = true;
    await tainted.scope.retriggerFirstMessageOnEmptyChat(); assert.equal(tainted.calls.length, 0);
    const used = fixture(); used.scope.chat.push({ is_user: true, mes: 'User message' });
    await used.scope.retriggerFirstMessageOnEmptyChat(); assert.equal(used.calls.length, 0);
});

test('wrong app, mirror or incomplete bridge marker does not fall back to stale editor', async () => {
    const badApp = fixture(); badApp.card.data.extensions.homer_bridge.app_id = 'other-app';
    const badMirror = fixture(); badMirror.scope.getCurrentChatId = () => 'Homer-other-chat';
    const missingId = fixture(); delete missingId.scope.chat_metadata.homer_bridge.conversation_id;
    const missingRuntime = fixture(); delete missingRuntime.scope.chat_metadata.homer_bridge.runtime;
    for (const f of [badApp, badMirror, missingId, missingRuntime]) {
        await f.scope.retriggerFirstMessageOnEmptyChat(); assert.equal(f.calls.length, 0); assert.equal(f.message.mes, 'Hello Old');
    }
});

test('real non-bridge administrator character editor and upstream group behavior are retained', async () => {
    const editor = fixture({ bridge: false });
    await editor.scope.retriggerFirstMessageOnEmptyChat(); assert.deepEqual(editor.calls, [['edit-card']]);
    const group = fixture({ bridge: false }); group.scope.selected_group = 'group';
    await group.scope.retriggerFirstMessageOnEmptyChat(); assert.deepEqual(group.calls, [['reload']]);
});

test('empty primary opening shifts to its authored alternate without generating', async () => {
    const f = fixture(); f.card.first_mes = ''; f.message.swipe_id = 0;
    await f.scope.retriggerFirstMessageOnEmptyChat();
    assert.equal(f.message.mes, 'Other New'); assert.equal(f.message.swipe_id, 0);
    assert.equal(f.calls.some(x => x[0] === 'edit-card'), false);
});

test('message-scope change during redraw or a lifecycle event never saves the new conversation', async () => {
    const redraw = fixture(); redraw.scope.redisplayChat = async () => { redraw.scope.chat_metadata.homer_bridge.conversation_id = 'new-chat'; };
    await redraw.scope.retriggerFirstMessageOnEmptyChat();
    assert.equal(redraw.calls.some(x => x[0] === 'event' || x[0] === 'save'), false);
    const event = fixture(); event.scope.eventSource.emit = async () => { event.scope.chat_metadata.homer_bridge.conversation_id = 'new-chat'; };
    await event.scope.retriggerFirstMessageOnEmptyChat(); assert.equal(event.calls.some(x => x[0] === 'save'), false);
});

test('ordinary card regex remains live and no final macro or HTML result is cached', async () => {
    const f = fixture(); let runs = 0;
    f.scope.getRegexedString = text => { runs++; return `${text} dynamic-${runs}`; };
    await f.scope.retriggerFirstMessageOnEmptyChat(); assert.equal(f.message.mes, 'Hello New dynamic-1');
    f.scope.name1 = 'Third'; await f.scope.retriggerFirstMessageOnEmptyChat();
    assert.equal(f.message.mes, 'Hello Third dynamic-3'); assert.equal(runs, 4);
});

test('a failed redraw surfaces failure and does not silently edit or save the card', async () => {
    const f = fixture(); f.scope.redisplayChat = async () => { throw new Error('render failure'); };
    await assert.rejects(f.scope.retriggerFirstMessageOnEmptyChat(), /render failure/);
    assert.equal(f.calls.some(x => ['edit-card', 'save'].includes(x[0])), false);
});
