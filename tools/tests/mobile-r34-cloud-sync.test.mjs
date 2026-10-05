import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { captureCloudSync, canApplyCloudSync, createCloudSyncQueue, CHAT_KEEPALIVE_MAX_BYTES, CHAT_SAVED_CACHE_MAX_BYTES }
    from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-cloud-sync.mjs';

const scope = JSON.stringify(['test-account', 'test-card', 'test-chat']);
const payload = text => ({ app_id: 'test-card', conversation_id: 'test-chat', title: 'test', messages: [{ mes: text }] });
const snapshot = text => captureCloudSync(scope, payload(text));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('captured payload is immutable relative to mutable runtime messages', () => {
    const input = payload('before'), captured = captureCloudSync(scope, input);
    input.messages[0].mes = 'later';
    assert.equal(captured.payload.messages[0].mes, 'before');
    assert.equal(JSON.parse(captured.body).messages[0].mes, 'before');
});
test('UTF-8 keepalive budget uses bytes, not UTF-16 string length', () => {
    const captured = snapshot('汉'.repeat(9000));
    assert.ok(captured.body.length < CHAT_KEEPALIVE_MAX_BYTES);
    assert.ok(captured.bytes > CHAT_KEEPALIVE_MAX_BYTES);
});
test('overlapping saves execute in order, never last-old-write-wins', async () => {
    const first = deferred(), second = deferred(), started = [];
    const queue = createCloudSyncQueue(x => { started.push(x.payload.messages[0].mes); return started.length === 1 ? first.promise : second.promise; });
    const old = queue.enqueue(snapshot('older')), latestSnapshot = snapshot('newer'), newer = queue.enqueue(latestSnapshot);
    await turn(); assert.deepEqual(started, ['older']);
    first.resolve({ messages: [] }); await old; await turn();
    assert.deepEqual(started, ['older','newer']); assert.equal(queue.pending(scope), latestSnapshot);
    second.resolve({ messages: [] }); await newer; assert.equal(queue.pending(scope), null);
});
test('identical in-flight bodies are single-flight; acknowledged bodies skip transport', async () => {
    const hold = deferred(); let calls = 0;
    const queue = createCloudSyncQueue(() => { calls++; return hold.promise; });
    const a = queue.enqueue(snapshot('same')), b = queue.enqueue(snapshot('same'));
    assert.equal(a, b); await turn(); assert.equal(calls, 1);
    hold.resolve({messages: []}); await a;
    assert.equal((await queue.enqueue(snapshot('same'))).skipped, true); assert.equal(calls,1);
});
test('failed storage write retains last snapshot; explicit retry can succeed', async () => {
    let calls = 0; const queue = createCloudSyncQueue(async () => { if (++calls === 1) throw new Error('offline'); return {messages: []}; });
    const captured = snapshot('retained'); await assert.rejects(queue.enqueue(captured), /offline/);
    assert.equal(queue.pending(scope), captured); assert.equal(calls, 1);
    await queue.enqueue(captured); assert.equal(queue.pending(scope), null); assert.equal(calls, 2);
});
test('older failure does not discard a newer pending snapshot or poison queue', async () => {
    const hold = deferred(); let calls = 0;
    const queue = createCloudSyncQueue(async () => ++calls === 1 ? hold.promise : {messages: []});
    const old = queue.enqueue(snapshot('old')), last = snapshot('latest'), next = queue.enqueue(last);
    const rejected = assert.rejects(old, /offline/); await turn(); hold.reject(new Error('offline'));
    await rejected; await next; assert.equal(calls,2); assert.equal(queue.pending(scope),null);
});
test('different conversation writes retain captured identifiers through queueing', async () => {
    const hold = deferred(), captured = [], queue = createCloudSyncQueue(async x => {captured.push(x.payload.conversation_id); return captured.length === 1 ? hold.promise : {messages: []};});
    const first = queue.enqueue(snapshot('A'));
    const next = queue.enqueue(captureCloudSync('other-scope', {...payload('B'),conversation_id:'other-chat'}));
    await turn(); assert.deepEqual(captured,['test-chat']); hold.resolve({messages: []}); await first; await next;
    assert.deepEqual(captured,['test-chat','other-chat']);
});
test('late response is rejected for another account/chat and newer same-chat version', () => {
    const captured = snapshot('version 1');
    assert.equal(canApplyCloudSync(captured,scope,payload('version 1').messages),true);
    assert.equal(canApplyCloudSync(captured,'different-account-or-chat',payload('version 1').messages),false);
    assert.equal(canApplyCloudSync(captured,scope,payload('version 2').messages),false);
});
test('oversized pagehide snapshot is retained without quota-risking request', async () => {
    const options = [], queue = createCloudSyncQueue(async (_snapshot, option) => {options.push(option);return {messages: []};});
    const big = snapshot('汉'.repeat(9000)); assert.equal((await queue.enqueue(big,{keepaliveOnly:true})).deferred,true);
    assert.equal(queue.pending(scope),big); assert.equal(options.length,0);
    await queue.enqueue(big); assert.deepEqual(options,[{keepalive:false}]); assert.equal(queue.pending(scope),null);
});
test('small pagehide and ordinary writes use bounded keepalive', async () => {
    const options=[],queue=createCloudSyncQueue(async (_snapshot, option)=>{options.push(option);return {messages: []};});
    await queue.enqueue(snapshot('small'),{keepaliveOnly:true}); assert.deepEqual(options,[{keepalive:true}]);
});

test('skipped acknowledged save carries an immutable safe message ACK only', async () => {
    let calls = 0;
    const response = { token: 'forbidden-test-value', config: {}, messages: [{ id: '1', role: 'assistant',
        content: 'safe', token: 'forbidden-test-value', swipes: ['safe'], swipe_index: 0 }] };
    const queue = createCloudSyncQueue(async () => { calls++; return response; });
    await queue.enqueue(snapshot('same'));
    response.messages[0].content = 'mutated after acknowledgement';
    const skipped = await queue.enqueue(snapshot('same'));
    assert.equal(skipped.skipped, true); assert.equal(calls, 1);
    assert.equal(skipped.response.messages[0].content, 'safe');
    assert.equal(JSON.stringify(skipped.response).includes('forbidden-test-value'), false);
    skipped.response.messages[0].swipes[0] = 'mutated by caller';
    assert.equal((await queue.enqueue(snapshot('same'))).response.messages[0].swipes[0], 'safe');
});

test('completed very large saves do not retain unbounded in-memory deduplication copies', async () => {
    let calls = 0;
    const queue = createCloudSyncQueue(async () => { calls++; return {messages: []}; });
    const big = snapshot('x'.repeat(CHAT_SAVED_CACHE_MAX_BYTES));
    await queue.enqueue(big); await queue.enqueue(big);
    assert.equal(calls, 2);
    assert.equal(queue.pending(scope), null);
});

test('aggregate completed dedup cache is bounded while pending scopes are retained', async () => {
    const sent = [];
    const queue = createCloudSyncQueue(async value => { sent.push(value.scope); return {messages: []}; });
    const one = captureCloudSync('bounded-a', payload('a'.repeat(CHAT_SAVED_CACHE_MAX_BYTES / 2)));
    const two = captureCloudSync('bounded-b', payload('b'.repeat(CHAT_SAVED_CACHE_MAX_BYTES / 2)));
    await queue.enqueue(one); await queue.enqueue(two);
    assert.equal((await queue.enqueue(two)).skipped, true);
    await queue.enqueue(one);
    assert.equal(sent.length, 3);
});

const bridge = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url),'utf8');
function adapterContext() {
    const ack = deferred(), statuses=[], chat=[{mes:'old',extra:{}}];
    const context = {session:{user:{id:'test-account'}},launch:{app_id:'test-card',conversation_id:'test-chat',card:{name:'test'}},
        captureCloudSync,canApplyCloudSync,chatOutbox:{prepare:async value=>({scope:value.scope,body:value.body})},
        reconcileStorageAccount:()=> 'test-account',storageAccountEpoch:0,storageAcknowledgementEpoch:0,
        cloudSyncQueue:{enqueue:()=>ack.promise,pending:()=>null},
        serializeChat:()=>chat.map(x=>({mes:x.mes,extra:{...x.extra}})),getContext:()=>({chat,characterId:0,
            characters:[{data:{extensions:{homer_bridge:{app_id:'test-card'}}}}],chatId:'Homer-test-chat',
            chatMetadata:{homer_bridge:{user_id:'test-account',app_id:'test-card',conversation_id:'test-chat',runtime:'dialogue'}}}),
        conversationRecoveryBlocked:false,suppressSync:false,lastSyncSignature:'',MODULE_ID:'test',queueMessageMenuRender(){},updateRuntimeStatus:(...args)=>statuses.push(args),console,
    };
    vm.createContext(context);
    vm.runInContext(bridge.slice(bridge.indexOf('function cloudSyncScope()'),bridge.indexOf('function scheduleSync(')),context);
    return {context,ack,statuses,chat};
}
test('actual bridge adapter cannot write old cloud IDs/status into another conversation', async () => {
    const {context,ack,statuses,chat}=adapterContext(); const running=context.syncCloudChat();
    context.launch={app_id:'next-card',conversation_id:'next-chat'};chat[0].mes='new chat';
    ack.resolve({response:{messages:[{id:'old-server-id'}]}});assert.equal(await running,true);
    assert.equal(chat[0].extra.homer_message_id,undefined);assert.deepEqual(statuses,[]);
});
test('actual bridge adapter cannot write stale IDs into an edited same-scope version', async () => {
    const {context,ack,statuses,chat}=adapterContext();const running=context.syncCloudChat();chat[0].mes='new edit';
    ack.resolve({response:{messages:[{id:'old-server-id'}]}});await running;
    assert.equal(chat[0].extra.homer_message_id,undefined);assert.deepEqual(statuses,[]);
});
test('generation completion waits durable local save and pagehide cancels delayed save timer', () => {
    const completion=bridge.slice(bridge.indexOf('for (const event of [event_types.GENERATION_ENDED'),bridge.indexOf('eventSource.on(event_types.CHAT_CHANGED'));
    assert.match(completion,/window\.clearTimeout\(syncTimer\)[\s\S]*await syncCloudChat\(\{ localOnly: true \}\)/);
    assert.ok(completion.indexOf('await syncCloudChat({ localOnly: true })') < completion.indexOf('generationBusy = isGenerating()'));
    const pagehide=bridge.slice(bridge.indexOf("window.addEventListener('pagehide'"),bridge.indexOf('async function bootstrapLaunch'));
    assert.match(pagehide,/window\.clearTimeout\(syncTimer\)/);assert.match(pagehide,/syncCloudChat\(\{ keepaliveOnly: true \}\)/);
});
