import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { mergeConversationHistory } from '../../frontend/assets/js/conversation-history-merge.mjs';

const row=(id,updated_at=2,last_message='Complete local last message')=>({id,app_id:'qa-card',updated_at,last_message});
const plain=x=>JSON.parse(JSON.stringify(x));
function deferred(){let resolve;const promise=new Promise(yes=>resolve=yes);return {resolve,promise};}
test('empty/partial cloud lists are not deletion; newer local summaries survive stale remote metadata',()=>{
  assert.deepEqual(mergeConversationHistory([row('A')],[]),[row('A')]);
  const merged=mergeConversationHistory([row('A'),row('B')],[row('A',1,'Old remote')]);
  assert.equal(merged.length,2);assert.equal(merged.find(x=>x.id==='A').last_message,'Complete local last message');
  assert.equal(mergeConversationHistory([row('A')],[row('A',3,'')])[0].last_message,'Complete local last message');
});
function actualHost(){
  const source=fs.readFileSync(new URL('../../frontend/app/assets/js/chat.js',import.meta.url),'utf8');
  const first=source.indexOf('async function loadHistory('),fn=source.slice(first,source.indexOf('async function resolveLaunchTarget(',first));
  const request=deferred();let local=[row('A')],owner='qa-owner';const saved=[];
  const scope={mergeConversationHistory,runtimeBindingOwner:()=>owner,runtimeAccountEpoch:0,
    refreshConversationDeletions:async()=>{},filterDeletedConversations:(_owner,rows)=>rows.filter(x=>x.id!=='deleted'),
    readCachedHistory:()=>local,renderHistory(){},writeCachedHistory:rows=>saved.push(plain(rows)),
    api:{conversations:()=>request.promise},history:[]};
  vm.createContext(scope);vm.runInContext(fn,scope);
  return {scope,request,saved,setLocal:value=>local=value,setOwner:value=>owner=value};
}
test('shipping host re-reads phone metadata after cloud response and preserves a concurrently created conversation',async()=>{
  const f=actualHost(),promise=f.scope.loadHistory();await Promise.resolve();
  f.setLocal([row('A'),row('B',3)]);f.request.resolve({data:{list:[row('deleted'),row('A',1,'old')]}});await promise;
  assert.deepEqual(f.saved[0].map(x=>x.id),['B','A']);
});
test('shipping host drops stale account replies instead of merging them into the new account',async()=>{
  const f=actualHost(),promise=f.scope.loadHistory();await Promise.resolve();
  f.setOwner('new-owner');f.scope.runtimeAccountEpoch++;f.setLocal([row('new')]);
  f.request.resolve({data:{list:[row('old')]}});await promise;assert.deepEqual(f.saved,[]);
});
function actualRuntime(){
  const source=fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
  const first=source.indexOf('async function loadConversationHistory('),fn=source.slice(first,source.indexOf('function formatConversationTime(',first));
  const request=deferred();let local=[row('A')],owner='qa-owner';const paints=[];
  const scope={mergeConversationHistory,launch:{admin_preview:false},reconcileStorageAccount:()=>owner,storageAccountEpoch:0,
    refreshConversationDeletions:async()=>{},filterDeletedConversations:(_owner,rows)=>rows.filter(x=>x.id!=='deleted'),
    localSessions:{list:async()=>local},runtimeUiData:{conversations:[]},
    requestJson:()=>request.promise,payloadList:value=>value.list,
    document:{querySelector:()=>null},populateHistoryList:()=>paints.push(plain(scope.runtimeUiData.conversations)),
    scheduleHostStateNotify(){},scheduleSessionPrefetch(){},console:{warn(){}}};
  vm.createContext(scope);vm.runInContext(fn,scope);
  return {scope,request,paints,setLocal:value=>local=value,setOwner:value=>owner=value};
}
test('shipping runtime preserves phone records and a concurrent new session after a stale/empty cloud list',async()=>{
  const f=actualRuntime(),promise=f.scope.loadConversationHistory();
  for(let n=0;n<6;n++)await Promise.resolve();
  f.setLocal([row('A'),row('B',4),row('deleted')]);f.request.resolve({list:[]});await promise;
  assert.deepEqual(plain(f.scope.runtimeUiData.conversations).map(x=>x.id),['B','A']);
  assert.equal(f.paints.length,2);
});
test('shipping runtime drops owner ABA through the storage epoch fence',async()=>{
  const f=actualRuntime(),promise=f.scope.loadConversationHistory();
  for(let n=0;n<6;n++)await Promise.resolve();
  f.scope.storageAccountEpoch+=2;f.setLocal([row('new')]);f.request.resolve({list:[row('old')]});await promise;
  assert.deepEqual(f.paints.flat().map(x=>x.id),['A']);
});
