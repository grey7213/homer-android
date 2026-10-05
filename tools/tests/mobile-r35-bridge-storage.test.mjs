import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createChatOutbox } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { captureCloudSync, canApplyCloudSync, createCloudSyncQueue } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-cloud-sync.mjs';
import { restoreCanonicalGreeting } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';
import { holdLargeSourceLayout } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-source-layout.mjs';
import { capturePromptMessageState, prepareAcknowledgedPromptStates, restoreAcknowledgedPromptStates, samePromptMessageSource, clearPromptMessageState } from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-prompt-message-state.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';
import { createHash } from 'node:crypto';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';
import { createCardTransportCache, clearCardTransportMemory } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';

// Load actual product functions, rather than rewriting a second implementation.
const source = fs.readFileSync(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
    assert.ok(begin >= 0 && finish > begin, 'Actual bridge section not found: ' + start);
    return source.slice(begin, finish);
}
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise, resolve, reject}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const same = (a,b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const id = (owner='test-owner-a', app='test-card-a', conv='test-conversation-a') => JSON.stringify([owner,app,conv]);
const payload = (text, app='test-card-a', conv='test-conversation-a') => ({app_id:app,conversation_id:conv,title:'Test',messages:[{mes:text,is_user:false,extra:{}}]});
const snapshot = (text, owner='test-owner-a', app='test-card-a', conv='test-conversation-a') =>
    captureCloudSync(id(owner,app,conv), payload(text,app,conv));
const acknowledgement = text => ({messages:[{id:'test-cloud-message',role:'assistant',content:text,created_at:123}]});
const sessionPayload = (text='old cloud', owner='test-owner-a') => ({user:{id:owner},
    launch:{app_id:'test-card-a',conversation_id:'test-conversation-a',card:{name:'Test'},bridge_token:true,
        messages:[{id:'test-cloud-message',role:'assistant',content:text}]}});
const adminPayload = (owner='test-owner-a') => ({user:{id:owner,is_admin:true},
    launch:{app_id:'test-card-a',conversation_id:'test-admin-preview',admin_preview:true,bridge_token:true}});
const canonicalScope = () => ({characterId:0,
    characters:[{data:{extensions:{homer_bridge:{app_id:'test-card-a'}}}}],
    chatId:'Homer-test-conversation-a',
    chatMetadata:{homer_bridge:{user_id:'test-owner-a',app_id:'test-card-a',conversation_id:'test-conversation-a',runtime:'dialogue'}}});

function harness({ cookieOnly = false } = {}) {
    const indexedDB = transactionIDB();
    const outbox = createChatOutbox({indexedDB,databaseName:'bridge-unit'});
    const cache = new Map(cookieOnly ? [] : [['ai_xingyue_logged_in','1'],['ai_xingyue_user',JSON.stringify({id:'test-owner-a'})]]);
    const requests=[],statuses=[],notices=[],events=[],listeners=new Map(),marks=[],memoryClears=[];
    const context = {
        session:{user:{id:'test-owner-a'}},launch:{app_id:'test-card-a',conversation_id:'test-conversation-a',card:{name:'Test'}},
        chat:[{mes:'initial text',is_user:false,extra:{}}],chatOutbox:outbox,
        captureCloudSync,canApplyCloudSync,createCloudSyncQueue,AbortController,URLSearchParams,
        storageOwner:cookieOnly?'':'test-owner-a',verifiedStorageOwner:'',storageAccountEpoch:0,storageRequests:new Set(),outboxReplay:null,
        clearCardTransportMemory:(...args)=>{memoryClears.push(args);clearCardTransportMemory(...args);},
        preparedAdminLaunch:null,scopeDrafts:new Map(),payloadList:value=>value.list||[],
        sessionReadFences:new WeakMap(),storageAckStamps:new Map(),
        acknowledgedPromptTickets:new WeakMap(),capturePromptMessageState,prepareAcknowledgedPromptStates,
        restoreAcknowledgedPromptStates,samePromptMessageSource,clearPromptMessageState,
        cardPreparations:{clear(){}},sessionPrefetchCache:new Map(),MODULE_ID:'isolated-bridge-test',
        localStorage:{getItem:key=>cache.get(key)||null},cloneJsonObject:clone,cloneJsonValue:clone,
        serializeChat:()=>clone(context.chat),canonical:canonicalScope(),getContext:()=>({...context.canonical,chat:context.chat}),
        extension_settings:{memory:{enabled:true,summary:'local test setting'}},extensionSettingsBaseline:{memory:{enabled:false}},
        extensionSettingsHydrating:false,extensionSettingsReplayInProgress:false,extensionSettingsReplayWork:Promise.resolve(),
        extensionSettingsPersistTimer:null,extensionSettingsPersistChain:Promise.resolve(),extensionSettingsPersistWaiters:[],
        lastExtensionSettingsScope:'',lastExtensionSettingsSignature:'',conversationExtensionSettings:null,
        runtimeVariables:{},applicationReady:true,reaffirmExtensionSettingsAfterReady:false,
        conversationRecoveryBlocked:false,suppressSync:false,lastSyncSignature:'',syncTimer:null,requestedAppId:'test-card-a',requestedConversationId:'test-conversation-a',holdLargeSourceLayout,
        queryString:(app,conv)=>new URLSearchParams({app_id:app,conversation_id:conv}).toString(),
        synchronizeJsonContainer:(target,value)=>Object.assign(target,clone(value)),
        replaceExtensionSettings:value=>{context.extension_settings=clone(value);},
        refreshOfficialRegex:async()=>{},
        conversationModelSettings:()=>({model_id:'test-model'}),
        event_types:{SETTINGS_LOADED:'settings-loaded'},
        eventSource:{emit:async event=>events.push(event)},
        queueMessageMenuRender(){},updateRuntimeStatus:(...values)=>statuses.push(values),
        showHostNotice:(...values)=>notices.push(values),
        console:{warn(){},debug(){},error(){}},performance:{mark:value=>marks.push(value)},
        window:{clearTimeout,setTimeout,addEventListener:(name,fn)=>listeners.set(name,fn)},
        requestJson:async(path,options)=>{requests.push({path,options});return acknowledgement('saved');},
        requestSessionCard:(path,{request})=>request(path),
    };
    vm.createContext(context);
    vm.runInContext([
        section('function storageAckKey(', 'const extensionSyncQueue ='),
        section('const extensionSyncQueue =', 'async function replayPendingStorage()'),
        section('const cloudSyncQueue =', 'let eventHandlersInstalled'),
        section('async function replayPendingStorage()', "window.addEventListener('storage'"),
        section("window.addEventListener('storage'", 'let tavoComposer ='),
        section('function extensionSettingsScope(', 'function saveConversationExtensionSettings()'),
        section('async function preferLocalSession(', 'function sessionCacheKey('),
        section('function prepareAdminLaunch(', 'let initialized = false;'),
        section('function cloudSyncScope()', 'function scheduleSync('),
        section('async function loadRuntimeState(', 'async function refreshOfficialRegex('),
        'globalThis.queues={cloudSyncQueue,extensionSyncQueue};',
    ].join('\n'),context);
    const changeOwner = owner => {
        if(owner){cache.set('ai_xingyue_logged_in','1');cache.set('ai_xingyue_user',JSON.stringify({id:owner}));}
        else{cache.delete('ai_xingyue_logged_in');cache.delete('ai_xingyue_user');context.invalidateStorageAccount();return;}
        context.reconcileStorageAccount();
    };
    return {context,outbox,indexedDB,requests,statuses,notices,events,listeners,marks,memoryClears,changeOwner};
}

test('actual bridge logout and owner reconciliation clear verified source memory without deleting durable bytes', async () => {
    const h=harness(), indexedDB=cardTransportIDB();
    const sourceCache=createCardTransportCache({indexedDB,databaseName:'bridge-memory-clear',now:()=>100});
    const sourceCard={name:'Synthetic source',data:{name:'Synthetic source',character_book:{entries:[{content:'intact synthetic world'}]}}};
    const revision=createHash('sha256').update(JSON.stringify(sourceCard)).digest('hex');
    await sourceCache.write('test-owner-a','session-card','test-card-a',revision,sourceCard);
    const hot=()=>sourceCache.read('test-owner-a','session-card','test-card-a',{allowVerifiedMemory:true});
    indexedDB.trace.length=0;
    same((await hot()).payload,sourceCard); assert.deepEqual(indexedDB.trace,[]);
    h.changeOwner(''); assert.equal(h.memoryClears.length,1);
    indexedDB.trace.length=0;
    same((await hot()).payload,sourceCard);
    assert.deepEqual(indexedDB.trace.filter(row=>row.operation==='get').map(row=>row.store),['metadata','entries']);
    h.changeOwner('test-owner-b'); assert.equal(h.memoryClears.length,2);
    indexedDB.trace.length=0;
    same((await hot()).payload,sourceCard);
    assert.deepEqual(indexedDB.trace.filter(row=>row.operation==='get').map(row=>row.store),['metadata','entries']);
    assert.equal(indexedDB.dump('bridge-memory-clear','entries').length,1);
    h.outbox.close();
});

test('actual switch commit barrier finishes while an older cloud ACK is still blocked', async () => {
    const h=harness(), hold=deferred(), sent=deferred();
    h.context.requestJson=async(path,options)=>{h.requests.push({path,options});sent.resolve();return hold.promise;};
    const older=h.context.syncCloudChat();
    await sent.promise;
    h.context.chat[0].mes='newest local before switch';
    const barrier=h.context.commitConversationBeforeSwitch();
    assert.equal(await Promise.race([barrier.then(()=>'committed'),new Promise(resolve=>setTimeout(()=>resolve('blocked'),500))]),'committed');
    const saved=await h.outbox.read(id());
    assert.equal(saved.payload.messages[0].mes,'newest local before switch');
    assert.equal(saved.pending,true);
    assert.ok(await h.outbox.read(id(),'extension-settings'));
    hold.resolve(acknowledgement('initial text'));
    await older;
});

test('actual commit barrier rejects local storage failure and keeps current scope', async () => {
    const h=harness(), original=h.context.launch;
    h.indexedDB.failNextPut=true;
    await assert.rejects(h.context.commitConversationBeforeSwitch(),/本机存档未保存/);
    assert.equal(h.context.launch,original);
    assert.equal(h.requests.length,0);
});

test('generation localOnly returns after durable local commit, without waiting remote ACK', async () => {
    const h=harness(), remote=deferred();
    h.context.requestJson=async()=>remote.promise;
    assert.equal(await h.context.syncCloudChat({localOnly:true}),true);
    assert.equal((await h.outbox.read(id())).pending,true);
    remote.resolve(acknowledgement('saved'));
    await turn();await turn();
});

test('generation localOnly storage failure rejects instead of reporting an unsaved reply as durable', async () => {
    const h=harness();h.indexedDB.failNextPut=true;
    await assert.rejects(h.context.syncCloudChat({localOnly:true}),/本机存档未保存/);
    assert.equal(h.requests.length,0);
});

test('localOnly prepare cannot mark a newer scope as pending when scope changed during IDB commit', async () => {
    const h=harness(), gate=h.indexedDB.holdNextCommit();
    const saved=h.context.syncCloudChat({localOnly:true});
    await gate.reached;
    h.context.launch={app_id:'new-card',conversation_id:'new-conversation',local_pending:'untouched-new-scope'};
    h.context.chat=[{mes:'new scope',extra:{}}];
    gate.release();await saved;
    assert.equal(h.context.launch.local_pending,'untouched-new-scope');
});

test('switch commit barrier rejects a changed account during durable writes', async () => {
    const h=harness(), gate=h.indexedDB.holdNextCommit();
    const saved=h.context.commitConversationBeforeSwitch();
    await gate.reached;h.changeOwner('test-owner-b');gate.release();
    await assert.rejects(saved);
    assert.equal(h.requests.length,0);
});

test('sender rejects queued snapshots from a changed account before any HTTP request', async () => {
    const h=harness(), captured=snapshot('owner a');
    captured.committed=await h.outbox.prepare(captured);
    h.changeOwner('test-owner-b');
    await assert.rejects(h.context.requestScopedStorage(captured,'chat'),/账号已切换/);
    assert.equal(h.requests.length,0);
});

test('account change aborts storage and rejects late response even when transport ignores abort', async () => {
    const h=harness(), remote=deferred(), sent=deferred(), captured=snapshot('owner a');
    captured.committed=await h.outbox.prepare(captured);
    h.context.requestJson=async(path,options)=>{h.requests.push({path,options});sent.resolve();return remote.promise;};
    const request=h.context.requestScopedStorage(captured,'chat');
    await sent.promise;
    h.changeOwner('test-owner-b');
    assert.equal(h.requests[0].options.signal.aborted,true);
    remote.resolve(acknowledgement('old response'));
    await assert.rejects(request,/账号已切换/);
    assert.equal(h.context.storageRequests.size,0);
    assert.equal((await h.outbox.read(id())).pending,true);
});

test('logout then login same owner rejects earlier epoch response', async () => {
    const h=harness(), remote=deferred(), sent=deferred(), captured=snapshot('old login');
    captured.committed=await h.outbox.prepare(captured);
    h.context.requestJson=async()=>{sent.resolve();return remote.promise;};
    const request=h.context.requestScopedStorage(captured,'chat');
    await sent.promise;
    h.changeOwner('');h.changeOwner('test-owner-a');
    remote.resolve(acknowledgement('old epoch'));
    await assert.rejects(request,/账号已切换/);
});

test('account change during local ACK transaction cannot write old cloud IDs/status into stale live runtime', async () => {
    for(const mode of ['another-account','new-login-same-account']){
        const h=harness(), ack=h.outbox.cloudACK.bind(h.outbox), gate=deferred(), started=deferred();
        h.outbox.cloudACK=async(...args)=>{started.resolve();await gate.promise;return ack(...args);};
        const saved=h.context.syncCloudChat();
        await started.promise;
        if(mode==='another-account')h.changeOwner('test-owner-b');
        else{h.changeOwner('');h.changeOwner('test-owner-a');}
        gate.resolve();await saved;
        assert.equal(h.context.chat[0].extra.homer_message_id,undefined);
        assert.equal(h.statuses.length,0);
    }
});

test('account switch during local preflight fence prevents sending old scope under new cookie', async () => {
    const h=harness(), captured=snapshot('old scope'), fence=h.outbox.fence.bind(h.outbox), gate=deferred(), started=deferred();
    captured.committed=await h.outbox.prepare(captured);
    h.outbox.fence=async(...args)=>{const result=await fence(...args);started.resolve();await gate.promise;return result;};
    const request=h.context.requestScopedStorage(captured,'chat');
    await started.promise;h.changeOwner('test-owner-b');gate.resolve();
    await assert.rejects(request,/账号已切换/);
    assert.equal(h.requests.length,0);
});

test('sender preflight rejects obsolete snapshot after a newer durable version', async () => {
    const h=harness(), old=snapshot('old'),latest=snapshot('latest');
    old.committed=await h.outbox.prepare(old);await h.outbox.prepare(latest);
    await assert.rejects(h.context.requestScopedStorage(old,'chat'),/存档已更新/);
    assert.equal(h.requests.length,0);
    assert.equal((await h.outbox.read(id())).payload.messages[0].mes,'latest');
});

test('older queued version is not POSTed after a newer durable snapshot has committed', async () => {
    const h=harness(), remote=deferred(), sent=deferred();
    const blocker=snapshot('blocking another scope','test-owner-a','test-card-b','test-conversation-b');
    blocker.committed=await h.outbox.prepare(blocker);
    h.context.requestJson=async(path,options)=>{
        h.requests.push({path,options});const body=JSON.parse(options.body);
        if(body.app_id==='test-card-b'){sent.resolve();return remote.promise;}
        return acknowledgement(body.messages[0].mes);
    };
    const first=h.context.queues.cloudSyncQueue.enqueue(blocker);
    await sent.promise;
    const old=snapshot('obsolete queued version');old.committed=await h.outbox.prepare(old);
    const rejected=assert.rejects(h.context.queues.cloudSyncQueue.enqueue(old),/存档已更新/);
    const latest=snapshot('newest queued version');latest.committed=await h.outbox.prepare(latest);
    const newest=h.context.queues.cloudSyncQueue.enqueue(latest);
    remote.resolve(acknowledgement('blocking another scope'));
    await first;await rejected;await newest;
    same(h.requests.map(value=>JSON.parse(value.options.body).messages[0].mes),['blocking another scope','newest queued version']);
    assert.equal((await h.outbox.read(id())).pending,false);
});

test('pending local restore preserves full canonical hidden/swipe/extension metadata', async () => {
    const h=harness(), captured=snapshot('full markup <div>not a clipped preview</div>');
    captured.payload.messages[0].swipes=['first','second'];captured.payload.messages[0].swipe_id=1;
    captured.payload.messages[0].extra={homer_hidden:true,custom_card_state:{stage:4},display_text:'rendered'};
    captured.body=JSON.stringify(captured.payload);captured.bytes=new TextEncoder().encode(captured.body).byteLength;
    await h.outbox.prepare(captured);
    const restored=await h.context.preferLocalSession(sessionPayload(),'test-card-a','test-conversation-a',null);
    same(restored.launch.local_chat,captured.payload.messages);
    assert.equal(restored.launch.local_pending,true);
});

test('GET response begun before local ACK cannot replace newly saved complete history', async () => {
    const h=harness(), captured=snapshot('last response'), remote=deferred(), sent=deferred();
    const committed=await h.outbox.prepare(captured);
    h.context.requestJson=async()=>{sent.resolve();return remote.promise;};
    const get=h.context.fetchSession('test-card-a','test-conversation-a');
    await sent.promise;
    await h.outbox.cloudACK(committed,acknowledgement('last response'));
    remote.resolve(sessionPayload('older cloud response'));
    const loaded=await get;
    assert.equal(loaded.launch.local_chat[0].mes,'last response');
    assert.equal(loaded.launch.local_chat[0].extra.homer_message_id,'test-cloud-message');
});

test('valid embedded session uses one GET, not an unnecessary serial site fallback', async () => {
    const h=harness();
    h.context.requestJson=async(path)=>{h.requests.push({path});return sessionPayload();};
    await h.context.fetchSession('test-card-a','test-conversation-a');
    assert.equal(h.requests.length,1);
    assert.ok(h.requests[0].path.startsWith('/api/homer/session?'));
});

test('cookie-only authenticated initial session establishes owner without requiring local login cache', async () => {
    const h=harness({cookieOnly:true});
    h.context.requestJson=async()=>sessionPayload('authenticated initial response');
    assert.equal(h.context.reconcileStorageAccount(),'');
    const loaded=await h.context.fetchSession('test-card-a','test-conversation-a');
    assert.equal(loaded.user.id,'test-owner-a');
    assert.equal(h.context.verifiedStorageOwner,'test-owner-a');
    assert.equal(h.context.reconcileStorageAccount(),'test-owner-a');
    assert.equal(h.context.storageAccountEpoch,0);
});

test('explicit clear with no known owner still invalidates an in-flight cookie-only response', async () => {
    const h=harness({cookieOnly:true}), remote=deferred(),started=deferred();
    h.context.requestJson=async()=>{started.resolve();return remote.promise;};
    const get=h.context.fetchSession('test-card-a','test-conversation-a');
    await started.promise;
    h.listeners.get('homer-account-cleared')();
    assert.equal(h.context.storageAccountEpoch,1);
    remote.resolve(sessionPayload());
    await assert.rejects(get,/账号已切换/);
    assert.equal(h.context.reconcileStorageAccount(),'');
});

test('simultaneous first cookie-only responses accept the same authenticated owner but reject another owner', async () => {
    for(const anotherOwner of [false,true]){
        const h=harness({cookieOnly:true}), first=deferred(),second=deferred(),started=deferred();
        let count=0;
        h.context.requestJson=async()=>{if(++count===2)started.resolve();return count===1?first.promise:second.promise;};
        const a=h.context.fetchSession('test-card-a','test-conversation-a');
        const b=h.context.fetchSession('test-card-a','test-conversation-a');
        await started.promise;first.resolve(sessionPayload());await a;
        second.resolve(sessionPayload('second response',anotherOwner?'test-owner-b':'test-owner-a'));
        if(anotherOwner)await assert.rejects(b,/账号已切换/);
        else assert.equal((await b).user.id,'test-owner-a');
        assert.equal(h.context.reconcileStorageAccount(),'test-owner-a');
        assert.equal(h.context.storageAccountEpoch,0);
    }
});

test('logout and fresh cookie login of same owner never revive an older GET epoch', async () => {
    const h=harness({cookieOnly:true}), old=deferred(),started=deferred();
    let count=0;
    h.context.requestJson=async()=>{if(++count===1){started.resolve();return old.promise;}return sessionPayload('fresh login');};
    const oldGET=h.context.fetchSession('test-card-a','test-conversation-a');
    await started.promise;
    h.listeners.get('homer-account-cleared')();
    const newGET=await h.context.fetchSession('test-card-a','test-conversation-a');
    assert.equal(newGET.launch.messages[0].content,'fresh login');
    old.resolve(sessionPayload('stale same-owner login'));
    await assert.rejects(oldGET,/账号已切换/);
    assert.equal(h.context.reconcileStorageAccount(),'test-owner-a');
});

test('storage-key clear invalidates cookie-only owner even when previous cached owner was empty', async () => {
    const h=harness({cookieOnly:true}), old=deferred(),started=deferred();
    h.context.requestJson=async()=>{started.resolve();return old.promise;};
    const get=h.context.fetchSession('test-card-a','test-conversation-a');
    await started.promise;
    h.listeners.get('storage')({key:'ai_xingyue_user',newValue:null});
    old.resolve(sessionPayload());
    await assert.rejects(get,/账号已切换/);
    assert.equal(h.context.verifiedStorageOwner,'');
});

test('admin preview cookie-only first session and simultaneous same-owner responses remain usable', async () => {
    const h=harness({cookieOnly:true}), first=deferred(),second=deferred(),started=deferred();
    let count=0;
    h.context.requestJson=async()=>{if(++count===2)started.resolve();return count===1?first.promise:second.promise;};
    const a=h.context.fetchSession('test-card-a','',true),b=h.context.fetchSession('test-card-a','',true);
    await started.promise;first.resolve(adminPayload());second.resolve(adminPayload());
    assert.equal((await a).user.is_admin,true);assert.equal((await b).user.id,'test-owner-a');
    assert.equal(h.context.reconcileStorageAccount(),'test-owner-a');
    assert.equal(h.context.storageAccountEpoch,0);
});

test('late administrator preview never survives explicit clear or another account response', async () => {
    for(const anotherAccount of [false,true]){
        const h=harness({cookieOnly:true}),old=deferred(),started=deferred();
        h.context.requestJson=async()=>{started.resolve();return old.promise;};
        const work=h.context.fetchSession('test-card-a','',true);
        await started.promise;
        if(anotherAccount)h.changeOwner('test-owner-b');
        else h.listeners.get('homer-account-cleared')();
        old.resolve(adminPayload());
        await assert.rejects(work,/账号已切换/);
    }
});

test('administrator cookie-only logout/relogin ABA rejects the earlier privileged GET', async () => {
    const h=harness({cookieOnly:true}),old=deferred(),started=deferred();
    let count=0;
    h.context.requestJson=async()=>{if(++count===1){started.resolve();return old.promise;}return adminPayload();};
    const older=h.context.fetchSession('test-card-a','',true);
    await started.promise;h.listeners.get('homer-account-cleared')();
    assert.equal((await h.context.fetchSession('test-card-a','',true)).user.is_admin,true);
    old.resolve(adminPayload());
    await assert.rejects(older,/账号已切换/);
});

test('admin preparation cache never crosses account or same-owner relogin epoch and clears drafts', async () => {
    for(const nextOwner of ['test-owner-b','test-owner-a']){
        const h=harness();let reads=0,configs=0;
        h.context.requestJson=async path=>{
            if(path.startsWith('/api/homer/admin-preview')){reads++;return adminPayload(h.context.reconcileStorageAccount());}
            if(path.endsWith('/models'))return {default_id:'test-model',list:[{id:'test-model'}]};
            configs++;return {revision:configs};
        };
        const first=h.context.prepareAdminLaunch('test-card-a');
        assert.equal(h.context.prepareAdminLaunch('test-card-a'),first);
        await first;
        h.context.scopeDrafts.set('old-scope','old draft');
        if(nextOwner==='test-owner-a')h.changeOwner('');
        h.changeOwner(nextOwner);
        assert.equal(h.context.preparedAdminLaunch,null);
        assert.equal(h.context.scopeDrafts.size,0);
        const fresh=h.context.prepareAdminLaunch('test-card-a');
        assert.notEqual(fresh,first);
        assert.equal((await fresh).user.id,nextOwner);
        assert.equal(reads,2);assert.equal(configs,2);
    }
});

test('admin preparation rejects account change during models or configuration read', async () => {
    for(const phase of ['models','configuration']){
        const h=harness(),remote=deferred(),started=deferred();
        let configs=0;
        h.context.requestJson=async path=>{
            if(path.startsWith('/api/homer/admin-preview'))return adminPayload();
            if(path.endsWith('/models')){
                if(phase==='models'){started.resolve();return remote.promise;}
                return {default_id:'test-model',list:[{id:'test-model'}]};
            }
            configs++;started.resolve();return remote.promise;
        };
        const old=h.context.prepareAdminLaunch('test-card-a');
        await started.promise;h.changeOwner('test-owner-b');
        remote.resolve(phase==='models'?{default_id:'test-model',list:[{id:'test-model'}]}:{revision:1});
        await assert.rejects(old,/账号已切换/);
        assert.equal(h.context.preparedAdminLaunch,null);
        assert.equal(configs,phase==='models'?0:1);
    }
});

test('admin startup single-flight rejects a different first cookie-only owner without replacing established owner', async () => {
    const h=harness({cookieOnly:true}),first=deferred(),second=deferred(),started=deferred();
    let count=0;
    h.context.requestJson=async path=>{
        if(path.endsWith('/models'))return {default_id:'test-model',list:[{id:'test-model'}]};
        if(path.endsWith('/admin-configuration'))return {revision:1};
        if(++count===2)started.resolve();
        return count===1?first.promise:second.promise;
    };
    const a=h.context.prepareAdminLaunch('test-card-a'),b=h.context.prepareAdminLaunch('another-card');
    await started.promise;first.resolve(adminPayload());await a;
    second.resolve(adminPayload('test-owner-b'));
    await assert.rejects(b,/账号已切换/);
    assert.equal(h.context.reconcileStorageAccount(),'test-owner-a');
});

function installOpeningProjection(context) {
    // Extract the real adapter and invoke its real pure normalizer. Plain-text
    // storage fixtures have no display rules; an attempted legacy replay is a
    // test failure, not an identity stub that could bypass the product guard.
    context.restoreCanonicalGreeting=restoreCanonicalGreeting;
    context.getRegexScripts=()=>[];
    context.getRegexedString=()=>assert.fail('plain local fixture must not replay display rules');
    context.regex_placement={AI_OUTPUT:2};
    vm.runInContext(section('function normalizeOpeningMessage(', 'function cloudMessageToDialogue('),context);
}

test('actual loadCloudChat plugin/render failures restore suppression and permit later durable saves', async () => {
    for(const phase of ['render','chat-changed','card-script','chat-loaded']){
        for(const suppressed of [false,true]){
            const h=harness();
            h.context.suppressSync=suppressed;
            h.context.launch.local_chat=[{mes:'complete imported message',is_user:false,extra:{}}];
            const canonical={...canonicalScope(),chat:h.context.chat,chatMetadata:{},
                printMessages:async()=>{if(phase==='render')throw Error('synthetic renderer failure');}};
            h.context.getContext=()=>canonical;
            h.context.conversationModelSettings=()=>({model_id:'test-model'});
            h.context.prefetchPersonaAvatarsForCurrentChat=()=>{};
            h.context.pendingCardScriptCharacter=phase==='card-script'?{name:'test-plugin'}:null;
            h.context.enableTavernHelperCardScripts=async()=>{throw Error('synthetic card helper failure');};
            h.context.event_types.CHAT_CHANGED='chat-changed';h.context.event_types.CHAT_LOADED='chat-loaded';
            h.context.eventSource.emit=async event=>{if(event===phase)throw Error('synthetic lifecycle failure');};
            h.context.scrollChatToBottom=()=>assert.fail('failed load must not report completed scroll');
            h.context.scrollOnMediaLoad=()=>assert.fail('failed load must not attach completed media watcher');
            h.context.scheduleSync=()=>assert.fail('failed load must not schedule completed load');
            h.context.scheduleHostStateNotify=()=>assert.fail('failed load must not notify completed load');
            installOpeningProjection(h.context);
            vm.runInContext(section('async function loadCloudChat(', 'function serializeChat('),h.context);
            await assert.rejects(h.context.loadCloudChat(),/synthetic/);
            assert.equal(h.context.suppressSync,suppressed);
            assert.equal(canonical.chatMetadata.homer_bridge.user_id,'test-owner-a');
            if(!suppressed){
                assert.equal(await h.context.syncCloudChat({localOnly:true}),true);
                assert.equal((await h.outbox.read(id())).payload.messages[0].mes,'complete imported message');
            }
        }
    }
});

test('actual cloud load identifies account before persona prefetch and finishes without disabling future saves', async () => {
    const h=harness(),calls=[];
    h.context.launch.local_chat=[{mes:'actual local canonical',extra:{}}];
    const canonical={...canonicalScope(),chat:h.context.chat,chatMetadata:{homer_preset_overrides:{legacy:true}},printMessages:async()=>calls.push('paint')};
    h.context.getContext=()=>canonical;
    h.context.conversationModelSettings=()=>({model_id:'test-model'});
    h.context.prefetchPersonaAvatarsForCurrentChat=()=>{assert.equal(canonical.chatMetadata.homer_bridge.user_id,'test-owner-a');calls.push('prefetch');};
    h.context.pendingCardScriptCharacter=null;
    h.context.event_types.CHAT_CHANGED='chat-changed';h.context.event_types.CHAT_LOADED='chat-loaded';
    h.context.scrollChatToBottom=()=>calls.push('scroll');
    h.context.scrollOnMediaLoad=()=>calls.push('media');
    h.context.scheduleSync=value=>{assert.equal(value,100);calls.push('sync');};
    h.context.scheduleHostStateNotify=()=>calls.push('notify');
    installOpeningProjection(h.context);
    vm.runInContext(section('async function loadCloudChat(', 'function serializeChat('),h.context);
    await h.context.loadCloudChat();
    assert.equal(h.context.suppressSync,false);
    assert.equal(canonical.chatMetadata.homer_preset_overrides,undefined);
    assert.equal(canonical.chatMetadata.homer_bridge.app_id,'test-card-a');
    same(calls,['prefetch','paint','scroll','media','sync','notify']);
});

test('unrelated scope or extension-kind ACK never invalidates another missing-row chat GET', async () => {
    const h=harness(), remote=deferred(),started=deferred();
    let gets=0;
    h.context.requestJson=async()=>{gets++;started.resolve();return remote.promise;};
    const get=h.context.fetchSession('test-card-a','test-conversation-a');
    await started.promise;
    const other=await h.outbox.prepare(snapshot('another card','test-owner-a','test-card-b','conversation-b'));
    await h.context.acknowledgeStorage(other,acknowledgement('another card'));
    const settings=await h.outbox.prepare(captureCloudSync(id(),{app_id:'test-card-a',conversation_id:'test-conversation-a',
        extension_settings:{memory:{enabled:true}}}),'extension-settings');
    await h.context.acknowledgeStorage(settings,{});
    remote.resolve(sessionPayload('actual unchanged chat'));
    assert.equal((await get).launch.messages[0].content,'actual unchanged chat');
    assert.equal(gets,1);
});

test('same-scope ACK plus row eviction refetches only once instead of accepting an old GET', async () => {
    const h=harness(), remote=deferred(),started=deferred();
    const original=await h.outbox.prepare(snapshot('new saved history'));
    let gets=0;
    h.context.requestJson=async()=>{if(++gets===1){started.resolve();return remote.promise;}return sessionPayload('fresh authoritative history');};
    const get=h.context.fetchSession('test-card-a','test-conversation-a');
    await started.promise;
    await h.context.acknowledgeStorage(original,acknowledgement('new saved history'));
    for(let i=0;i<24;i++){
        const other=await h.outbox.prepare(snapshot('other '+i,'test-owner-a','other-card','other-'+i));
        await h.outbox.cloudACK(other,acknowledgement('other '+i));
    }
    assert.equal(await h.outbox.read(id()),null);
    remote.resolve(sessionPayload('stale previously issued GET'));
    assert.equal((await get).launch.messages[0].content,'fresh authoritative history');
    assert.equal(gets,2);
});

test('bounded ACK stamp token eviction also fences an old missing-row GET', async () => {
    const h=harness(), remote=deferred(),started=deferred();
    let gets=0;
    h.context.requestJson=async()=>{if(++gets===1){started.resolve();return remote.promise;}return sessionPayload('fresh after token eviction');};
    const get=h.context.fetchSession('test-card-a','test-conversation-a');
    await started.promise;
    for(let i=0;i<65;i++)h.context.storageAckStamp(id('test-owner-a','other-card','token-'+i));
    assert.equal(h.context.storageAckStamps.size,64);
    remote.resolve(sessionPayload('old token'));
    assert.equal((await get).launch.messages[0].content,'fresh after token eviction');
    assert.equal(gets,2);
    assert.ok(h.context.storageAckStamps.size<=64);
});

test('old-account session response is rejected, not returned unchanged to caller', async () => {
    const h=harness();h.changeOwner('test-owner-b');
    await assert.rejects(h.context.preferLocalSession(sessionPayload(),'test-card-a','test-conversation-a',null),/账号已切换/);
});

test('account change while restoring local session rejects a late old-account payload', async () => {
    const h=harness(), read=h.outbox.read.bind(h.outbox), gate=deferred(), started=deferred();
    await h.outbox.prepare(snapshot('private test owner a'));
    h.outbox.read=async(...args)=>{const result=await read(...args);started.resolve();await gate.promise;return result;};
    const get=h.context.preferLocalSession(sessionPayload(),'test-card-a','test-conversation-a',null);
    await started.promise;h.changeOwner('test-owner-b');gate.resolve();
    await assert.rejects(get,/账号已切换/);
});

test('extension settings locally commit before remote wait and do not mutate later scope signature', async () => {
    const h=harness(), remote=deferred(), sent=deferred();
    h.context.requestJson=async()=>{sent.resolve();return remote.promise;};
    const saved=h.context.persistExtensionSettingsSnapshot({force:true});
    await sent.promise;
    assert.equal((await h.outbox.read(id(),'extension-settings')).payload.extension_settings.memory.enabled,true);
    h.context.launch={app_id:'other-card',conversation_id:'other-conversation'};
    remote.resolve({extension_settings:{}});
    assert.equal(await saved,true);
    assert.equal(h.context.lastExtensionSettingsScope,'');
    assert.equal(h.context.lastExtensionSettingsSignature,'');
});

test('account change during extension ACK cannot mark old account settings as saved in current scope', async () => {
    const h=harness(), ack=h.outbox.cloudACK.bind(h.outbox), gate=deferred(), started=deferred();
    h.outbox.cloudACK=async(...args)=>{started.resolve();await gate.promise;return ack(...args);};
    const saved=h.context.persistExtensionSettingsSnapshot({force:true});
    await started.promise;h.changeOwner('test-owner-b');gate.resolve();await assert.rejects(saved,/账号已切换/);
    assert.equal(h.context.lastExtensionSettingsScope,'');
    assert.equal(h.context.lastExtensionSettingsSignature,'');
});

test('extension-state stale GET overlays pending settings, not cloud defaults', async () => {
    const h=harness(), settings=captureCloudSync(id(),{app_id:'test-card-a',conversation_id:'test-conversation-a',extension_settings:{memory:{enabled:true}}});
    await h.outbox.prepare(settings,'extension-settings');
    h.context.requestJson=async()=>({extension_settings:{memory:{enabled:false}},variables:{regular_value:7}});
    await h.context.loadRuntimeState();
    assert.equal(h.context.extension_settings.memory.enabled,true);
    assert.equal(h.context.runtimeVariables.regular_value,7);
});

test('late extension-state GET cannot overwrite newly selected account or conversation', async () => {
    for(const mode of ['account','conversation']){
        const h=harness(), remote=deferred(), sent=deferred();
        h.context.requestJson=async()=>{sent.resolve();return remote.promise;};
        const work=h.context.loadRuntimeState();
        await sent.promise;
        if(mode==='account')h.changeOwner('test-owner-b');
        else h.context.launch={app_id:'other-card',conversation_id:'other-conversation'};
        h.context.extension_settings={memory:{summary:'must remain new scope'}};
        remote.resolve({extension_settings:{memory:{summary:'old scope'}},variables:{}});
        await assert.rejects(work,/已切换/);
        assert.equal(h.context.extension_settings.memory.summary,'must remain new scope');
    }
});

test('outbox replay is owner-only, rereads current durable version and never generates', async () => {
    const h=harness(), pending=h.outbox.pending.bind(h.outbox);
    await h.outbox.prepare(snapshot('old listed version'));
    await h.outbox.prepare(snapshot('owner b private test','test-owner-b'));
    h.outbox.pending=async owner=>{
        const result=await pending(owner);
        await h.outbox.prepare(snapshot('newest replay version'));
        return result;
    };
    await h.context.replayPendingStorage();
    assert.equal(h.requests.length,1);
    assert.equal(h.requests[0].path,'/api/homer/sync');
    assert.equal(JSON.parse(h.requests[0].options.body).messages[0].mes,'newest replay version');
    assert.equal((await pending('test-owner-b')).length,1);
});

test('cached skipped ACK clears a recreated outbox row rather than retaining ghost pending forever', async () => {
    const h=harness();
    h.context.chat[0].extra={homer_message_id:'test-cloud-message',homer_sync_id:'test-cloud-message',homer_created_at:123};
    await h.context.syncCloudChat();
    assert.equal((await h.outbox.read(id())).pending,false);
    // Other active runtimes may acknowledge rows in the same account database,
    // evicting this row without changing this bridge's safe deduplication ACK.
    for(let i=0;i<24;i++){
        const row=await h.outbox.prepare(snapshot('other '+i,'test-owner-a','other-card','other-'+i));
        await h.outbox.cloudACK(row,acknowledgement('other '+i));
    }
    assert.equal(await h.outbox.read(id()),null);
    assert.equal(await h.context.syncCloudChat(),true);
    assert.equal(h.requests.length,1,'identical already acknowledged body should use its safe cached ACK');
    assert.equal((await h.outbox.read(id())).pending,false,'cached ACK must acknowledge the recreated commitId');
});

test('actual source activates replay on online/start and rechecks local state at prefetch consume', () => {
    assert.match(source,/addEventListener\('online',[^\n]*replayPendingStorage/);
    assert.ok((source.match(/void replayPendingStorage\(\)/g)||[]).length>=3,'bootstrap/switch replay hooks missing');
    assert.match(section('async function takePrefetchedSession(', 'function scheduleSessionPrefetch('),/preferLocalSession/);
});
