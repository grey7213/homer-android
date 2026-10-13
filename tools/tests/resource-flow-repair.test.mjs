import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resourceExportPayload, exportResource } from '../../frontend/app/assets/js/resource-export.mjs';

test('SAF device fixture matches category and MIME before asserting real cancellation/write ACK', () => {
  const source=fs.readFileSync(new URL('../../android-app/app/src/androidTest/java/org/nebula/horizon/composeai/ctf/ResourceExportDeviceTest.java',import.meta.url),'utf8');
  assert.match(source,/filter\.addCategory\(Intent\.CATEGORY_OPENABLE\)/);
  assert.match(source,/filter\.addDataType\("application\/json"\)/);
  assert.match(source,/filter\.match\(expected\.getAction\(\),expected\.getType\(\)/);
  assert.match(source,/Exactly one real SAF request must reach/);
  assert.match(source,/waitForPicker\(monitor\);\s*waitFor\("window\.qaState\?\.state==='cancelled'"\)/);
  assert.match(source,/waitForPicker\(monitor\);waitFor\("window\.qaState\?\.state==='saved'"\)/);
});

test('native page readiness cancellation does not erase file-write completion', () => {
  const source=fs.readFileSync(new URL('../../android-app/app/src/main/java/org/nebula/horizon/composeai/ctf/HomerActivity.java',import.meta.url),'utf8');
  const finish=source.slice(source.indexOf('public void onPageFinished(WebView view, String url)',source.indexOf('private final class LiveClient')),source.indexOf('public void onReceivedError',source.indexOf('private final class LiveClient')));
  assert.match(finish,/readinessHandler\.removeCallbacksAndMessages\(null\)/);
  assert.doesNotMatch(finish,/\bhandler\.removeCallbacksAndMessages/);
  assert.match(source,/handler\.post\(\(\)->resourceExportResult\(export/);
  assert.match(source,/readinessHandler\.postDelayed\(this::pollLiveReady/);
});

test('resource export retains exact importable structured payload and sane filename', () => {
  const source = { prompts: [{ identifier:'main',content:'保持原文',enabled:false }], prompt_order:[{order:['main']}] };
  const result = resourceExportPayload('../QA:name',source);
  assert.deepEqual(JSON.parse(result.content),source);
  assert.equal(result.mime,'application/json');assert.equal(result.filename,'_QA_name.json');
  assert.equal(resourceExportPayload('模板','<div>test</div>').mime,'text/html');
  assert.throws(()=>resourceExportPayload('large','字'.repeat(3*1024*1024)),/8 MB/);
});

test('Android export completes only after matching saved ACK; cancel/failure do not claim success', async () => {
  const events = new EventTarget(); let message;
  const emit=(state,id=message.requestId)=>{const event=new Event('homer-resource-export-result');event.detail={requestId:id,state,message:'写入失败'};events.dispatchEvent(event);};
  const native={exportWorkshopResource(payload){message=JSON.parse(payload);}};
  const payload=resourceExportPayload('QA',{regex_scripts:[]});
  let done=false; const pending=exportResource(payload,{native,window:events}).then(value=>{done=true;return value;});
  emit('saved','not-this-export');await Promise.resolve();assert.equal(done,false);
  emit('saved');assert.deepEqual(await pending,{saved:true,filename:'QA.json'});
  const cancelled=exportResource(payload,{native,window:events});emit('cancelled');assert.deepEqual(await cancelled,{saved:false});
  const failed=exportResource(payload,{native,window:events});emit('failed');await assert.rejects(failed,/写入失败/);
  assert.throws(()=>exportResource(payload,{native:{},window:events}),/更新软件/);
  await assert.rejects(exportResource(payload,{native:{exportWorkshopResource(){throw Error('bridge failed');}},window:events}),/bridge failed/);
});

const rawFarm=fs.readFileSync(new URL('../../frontend/app/assets/js/farm.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
function farmHarness(api={}) {
  const user={id:'qa-owner'}, storage=new Map();
  const context={window:{},document:{addEventListener(){}},api,getCachedUser:()=>user,setCachedUser(){},ApiError:Error,
    readPageCache:(key)=>storage.get(key),writePageCache:(key,owner,value)=>{storage.set(key,structuredClone(value));return true;},
    requireAuth:()=>true,injectLayout(){},loadPublicSiteSettings:async()=>({}),Date,Number,Math,Map,Set,crypto:globalThis.crypto,
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  vm.runInNewContext(rawFarm,context);const page=context.window.farmPage();page.user=user;
  const state={account_balance:{points:500},profile:{points:500,coins:500,xp:0,energy:5,streak_days:60},plots:[{plot_no:1,crop_kind:'code_carrot',ready:true,unlocked:true,planted_at:1,ready_at:2}]};
  page.applyState({data:structuredClone(state)});
  return {page,user,state,storage};
}

test('farm verified harvest updates plot and unified balance exactly once without stale credits', async () => {
  let credits=0;
  const {page,state}=farmHarness({credits:()=>{credits++;return {points:500};}});
  const next={...state,account_balance:{points:600},profile:{...state.profile,points:600,coins:600,xp:10},plots:[{plot_no:1,crop_kind:null,unlocked:true}]};
  assert.equal(await page.runAction('harvest',1,async()=>({data:{action:'harvest',state:next,points_added:10}}),'收获成功'),true);
  assert.equal(page.points,600);assert.equal(page.xp,10);assert.equal(page.plots[0].empty,true);assert.equal(credits,0);
  assert.equal(page.busy,false);assert.equal(page.toast.type,'success');assert.equal(Object.keys(page.actionKeys).length,0);
});

test('farm timeout preserves same idempotency key for manual retry; failed reread never success', async () => {
  const {page,state}=farmHarness({farmState:async()=>{throw Error('读取失败');}});let first,second;
  assert.equal(await page.runAction('harvest',1,async key=>{first=key;throw Error('超时');},'收获成功'),false);
  assert.equal(page.plots[0].ready,true);assert.equal(page.actionError,'超时');assert.equal(page.toast.type,'error');
  assert.equal(await page.runAction('harvest',1,async key=>{second=key;return {data:{action:'harvest'}};},'收获成功'),false);
  assert.equal(first,second);assert.equal(page.toast.type,'error');
  assert.equal(await page.runAction('harvest',1,async()=>({data:{state}}),'收获成功'),false);
  assert.equal(page.toast.type,'error');assert.match(page.actionError,/未确认/);
});

test('farm incompatible server does not submit, and late pre-harvest refresh cannot undo action', async () => {
  let submitted=0;const {page,state}=farmHarness();
  page.applyState({data:{...state,account_balance:null}});
  assert.equal(await page.runAction('harvest',1,async()=>{submitted++;},'收获成功'),false);assert.equal(submitted,0);assert.match(page.actionError,/服务/);
  page.applyState({data:state});assert.equal(page.loadError,'');
  let resolveRead;const ready=new Promise(resolve=>{resolveRead=resolve;});
  const {page:other,state:old}=farmHarness({farmState:()=>ready});
  const pending=other.loadState();
  const next={...old,account_balance:{points:590},profile:{...old.profile,points:590,coins:590,xp:10},plots:[{plot_no:1,crop_kind:null,unlocked:true}]};
  await other.runAction('harvest',1,async()=>({data:{state:next}}),'收获成功');
  resolveRead({data:old});assert.equal(await pending,false);assert.equal(other.plots[0].empty,true);assert.equal(other.points,590);
});

test('comment drafts isolate account/post/live-sandbox and clear only confirmed send', async () => {
  const store=new Map();const original=globalThis.localStorage;
  globalThis.localStorage={getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
  try {
    const {readCommentDraft,writeCommentDraft,clearCommentDraft}=await import('../../frontend/app/assets/js/comment-draft.mjs');
    const a={id:'qa-a'},b={id:'qa-b'},draft={content:'隔离评论',images:[],replyTarget:{id:'comment-1',author:'QA'},client_id:'same-retry-id'};
    assert.equal(writeCommentDraft('post-1',a,draft),true);
    assert.deepEqual(readCommentDraft('post-1',a),draft);
    assert.equal(readCommentDraft('post-2',a),null);assert.equal(readCommentDraft('post-1',b),null);assert.equal(readCommentDraft('post-1',a,true),null);
    writeCommentDraft('post/1',a,{...draft,content:'另一个帖子'});
    assert.deepEqual(readCommentDraft('post-1',a),draft);assert.equal(readCommentDraft('post1',a),null);
    clearCommentDraft('post-1',b);assert.deepEqual(readCommentDraft('post-1',a),draft);
    clearCommentDraft('post-1',a);assert.equal(readCommentDraft('post-1',a),null);
  }finally{globalThis.localStorage=original;}
});
