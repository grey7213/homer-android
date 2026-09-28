import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const bridge=fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
const fetchFn=bridge.slice(bridge.indexOf('async function fetchSession('),bridge.indexOf('function sessionCacheKey('));
test('preview denied by backend never falls back to normal session creation',async()=>{
 const paths=[];const scope={URLSearchParams,requestJson:async path=>{paths.push(path);throw Error('403')},console};
 vm.createContext(scope);vm.runInContext(fetchFn,scope);
 await assert.rejects(scope.fetchSession('a','',true),/403/);
 assert.equal(paths.length,1);assert.equal(paths[0],'/api/homer/admin-preview?app_id=a');
});
test('unsigned or non-admin preview responses are rejected',async()=>{
 for(const preview of [{user:{is_admin:false},launch:{admin_preview:true,bridge_token:'test'}},{user:{is_admin:true},launch:{bridge_token:'test'}},{user:{is_admin:true},launch:{admin_preview:true}}]){
  const scope={URLSearchParams,requestJson:async()=>preview,console};vm.createContext(scope);vm.runInContext(fetchFn,scope);
  await assert.rejects(scope.fetchSession('a','',true),/管理员试聊不可用/);
 }
});
test('normal session is explicitly normal even after preview was requested',async()=>{
 const paths=[];const scope={adminPreviewRequested:true,URLSearchParams,requestJson:async path=>{paths.push(path);return{launch:{card:{},bridge_token:'test'}}},console};
 vm.createContext(scope);vm.runInContext(fetchFn,scope);await scope.fetchSession('a','normal');
 assert.deepEqual(paths,['/api/homer/session?app_id=a&conversation_id=normal']);
});
test('composer draft storage is scoped, restores emptiness, and is bounded',()=>{
 const start=bridge.indexOf('const scopeDrafts = new Map();');const end=bridge.indexOf('function prepareAdminLaunch(');
 const field={value:'ordinary draft',dispatchEvent:()=>{}};
 const scope={launch:{app_id:'a',conversation_id:'n'},session:{user:{id:'u'}},document:{querySelector:()=>field},Event:class{},Map};
 vm.createContext(scope);vm.runInContext(bridge.slice(start,end),scope);scope.retainScopeDraft();
 scope.launch={app_id:'a',conversation_id:'p',admin_preview:true};scope.restoreScopeDraft();assert.equal(field.value,'');
 field.value='preview draft';scope.retainScopeDraft();scope.launch={app_id:'a',conversation_id:'n'};scope.restoreScopeDraft();assert.equal(field.value,'ordinary draft');
 scope.session={user:{id:'other'}};scope.restoreScopeDraft();assert.equal(field.value,'');
 for(let i=0;i<20;i++){scope.launch.conversation_id=String(i);scope.retainScopeDraft()}
 assert.equal(vm.runInContext('scopeDrafts.size',scope),12);
});
