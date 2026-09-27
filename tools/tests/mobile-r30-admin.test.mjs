import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../../frontend/assets/js/admin-dialogue.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/,'').replace('export function','function');
function fixture(native=false){
 const listeners=[],sent=[],timers=new Map(); let id=0;
 const child={postMessage:(data,origin)=>sent.push({data,origin})};
 const navigations=[];
 const scope={api:{admin:{apps:async()=>({data:{list:[{id:'a'}]}})}},URLSearchParams,location:{origin:'http://localhost',assign:url=>navigations.push(url)},document:{querySelector:()=>({contentWindow:child})},window:{HomerNative:native?{supportsSharedConversationHost(){assert.equal(this,scope.window.HomerNative);return true}}:undefined,addEventListener:(_,fn)=>listeners.push(fn)},performance:{mark:()=>{}},setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:n=>timers.delete(n)};
 vm.createContext(scope);vm.runInContext(source+';globalThis.model=adminDialogue()',scope);
 const model=scope.model;
 const emit=(type,extra={},origin='http://localhost',sender=child)=>listeners.forEach(fn=>fn({origin,source:sender,data:{channel:'homer:dialogue-host:v1',version:1,type,...extra}}));
 return {model,emit,sent,timers,listeners,navigations};
}
test('Android admin launches retained chat host and never builds a second iframe',async()=>{
 const f=fixture(true);f.model.preparePreviewRuntime();assert.equal(f.model.previewUrl,'');assert.equal(f.listeners.length,0);
 f.model.previewCard='card & 1';await f.model.startPreview();
 assert.equal(f.navigations.length,1);
 const target=new URL(f.navigations[0],'http://localhost');assert.equal(target.pathname,'/app/chat.html');
 assert.equal(target.searchParams.get('app_id'),'card & 1');assert.equal(target.searchParams.get('admin_preview'),'1');
 assert.equal(f.sent.length,0);assert.equal(f.timers.size,0);
});
test('runtime is created once without nonce or card scripts in URL',()=>{
 const f=fixture();f.model.preparePreviewRuntime();const url=f.model.previewUrl;f.model.preparePreviewRuntime();
 assert.equal(f.listeners.length,1);assert.equal(f.model.previewUrl,url);assert.ok(url.includes('homer_prewarm=1'));assert.ok(!url.includes('nonce'));assert.ok(!url.includes('app_id'));
});
test('reject foreign windows/origins; bind queued click exactly once at core-ready',async()=>{
 const f=fixture();f.model.previewCard='a';await f.model.startPreview();assert.equal(f.sent.length,0);
 f.emit('core-ready',{},'https://other.invalid');f.emit('core-ready',{},'http://localhost',{});assert.equal(f.sent.length,0);
 f.emit('core-ready');f.emit('core-ready');assert.equal(f.sent.length,1);assert.equal(f.sent[0].data.type,'bind-admin-preview');
 assert.equal(f.model.previewStarted,false);f.emit('ready',{app_id:'wrong'});assert.equal(f.model.previewStarted,false);
 f.emit('ready',{app_id:'a'});assert.equal(f.model.previewStarted,true);assert.equal(f.model.previewStarting,false);assert.equal(f.timers.size,0);
});
test('double click single-flights; failed bind can be retried in same frame',async()=>{
 const f=fixture();f.model.preparePreviewRuntime();f.emit('core-ready');f.model.previewCard='a';
 await f.model.startPreview();await f.model.startPreview();assert.equal(f.sent.length,1);const url=f.model.previewUrl;
 f.emit('command-error',{message:'连接失败'});assert.equal(f.model.previewStarting,false);assert.equal(f.model.previewError,'连接失败');
 await f.model.startPreview();assert.equal(f.sent.length,2);assert.equal(f.model.previewUrl,url);
});

test('early bridge availability may prepare reads but cannot bind before core-ready',async()=>{
 const f=fixture();f.model.previewCard='a';await f.model.startPreview();
 f.emit('bridge-available');
 assert.deepEqual(f.sent.map(x=>x.data.type),['prepare-admin-preview']);
 assert.equal(f.model.previewCoreReady,false);assert.equal(f.model.previewStarted,false);
 f.emit('core-ready');f.emit('core-ready');
 assert.deepEqual(f.sent.map(x=>x.data.type),['prepare-admin-preview','bind-admin-preview']);
 f.emit('ready',{app_id:'a'});assert.equal(f.model.previewStarted,true);
});

test('admin selected-card startup reads single-flight and retry after rejection',async()=>{
 const text=fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
 const fn=text.slice(text.indexOf('function prepareAdminLaunch('),text.indexOf('let initialized = false;'));
 let reads=0,configs=0,rejectNext=false;
 const scope={adminPreviewRequested:true,preparedAdminLaunch:null,Date,payloadList:x=>x.list||[],fetchSession:async id=>{reads++;if(rejectNext){rejectNext=false;throw Error('offline')};return{launch:{app_id:id}}},requestJson:async(url)=>{if(url.endsWith('/models'))return{default_id:'m',list:[{id:'m'}]};configs++;return{revision:configs}}};
 vm.createContext(scope);vm.runInContext(fn,scope);
 const first=scope.prepareAdminLaunch('a');assert.equal(scope.prepareAdminLaunch('a'),first);
 const result=await first;assert.equal(reads,1);assert.equal(configs,1);assert.equal(result.adminStartupData.config.revision,1);
 rejectNext=true;await assert.rejects(scope.prepareAdminLaunch('b'),/offline/);
 await scope.prepareAdminLaunch('b');assert.equal(reads,3);assert.equal(configs,2);
});
test('cancel reset preserves current frame and does not bind or generate',async()=>{
 const f=fixture();f.model.preparePreviewRuntime();f.emit('core-ready');f.model.previewStarted=true;f.model.previewCard='b';f.model.confirmPreviewReset=async()=>false;
 await f.model.startPreview();assert.equal(f.sent.length,0);assert.equal(f.model.previewStarted,true);
});
test('normal native chats still preserve prompt logs; only ephemeral tests skip',()=>{
 const native=fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js',import.meta.url),'utf8');
 assert.match(native,/async function clearChat\(\{ clearData = false, preserveItemizedPrompts = true \} = \{\}\)/);
 assert.match(native,/bindCharacterChatWithoutLoad\(file_name, \{ ephemeral = false \} = \{\}\)/);
 assert.match(native,/preserveItemizedPrompts: !ephemeral/);
});
test('late token refresh cannot mutate a newly switched preview',async()=>{
 const bridge=fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
 const fn=bridge.slice(bridge.indexOf('async function refreshBridgeToken()'),bridge.indexOf('function installTokenRefresh()'));
 let resolve;
 const original={app_id:'a',conversation_id:'preview-a',admin_preview:true,bridge_token:'old'};
 const scope={launch:original,session:{},adminBinding:false,loadingLaunch:false,fetchSession:()=>new Promise(r=>resolve=r),applyConnectionConfiguration:()=>assert.fail('stale refresh applied'),updateRuntimeStatus:()=>assert.fail('stale status'),console};
 vm.createContext(scope);vm.runInContext(fn,scope);const pending=scope.refreshBridgeToken();
 scope.launch={app_id:'b',conversation_id:'preview-b',bridge_token:'new'};
 resolve({launch:{bridge_token:'stale'}});await pending;
 assert.equal(scope.launch.bridge_token,'new');assert.equal(original.bridge_token,'old');
});
