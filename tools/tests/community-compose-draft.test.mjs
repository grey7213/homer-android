import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../frontend/app/assets/js/community-screen.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const params='),source.indexOf('// Compatibility for previously shared URLs;'));
const copy=v=>JSON.parse(JSON.stringify(v));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const access=overrides=>({available:true,consented:true,local:false,categories:{},media:true,sanctions:[],...overrides});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({edit='',saved,hydrate=value=>Promise.resolve(value),write=true}={}){
  const auth=[],calls=[],writes=[],navigation=[],events=new Map(),drafts=new Map();
  const state={user:{id:'qa-compose-A'},mode:false,enabled:false,preflight:0,uploads:0,writeResponse:{id:'qa-new'},post:{id:edit,is_owner:true,version:2,title:'原帖子',content:'原有正文',images:[],video:'',tags:[]}};
  if(saved)drafts.set('social-draft'+(edit?'-edit-'+edit:''),{draft:copy(saved)});
  const scope={URLSearchParams,JSON,innerHeight:844,clientId:()=> 'qa-id',document:{title:'',documentElement:{style:{setProperty(){}}},addEventListener(){}},
    window:{addEventListener:(name,fn)=>events.set(name,fn)},location:{search:edit?'?edit='+edit:'',pathname:'/app/community-compose.html',replace:url=>navigation.push(url)},
    socialPage:()=>({user:state.user,ready:false,draft:{title:'',content:'',images:[],video:'',tags:[],topic:'交流闲聊',client_id:'qa-id'},topics:['交流闲聊'],muted:false,publishing:false,uploading:false,editorError:'',
      checkContent(){state.preflight++;},uploadImages(){state.uploads++;},uploadVideo(){state.uploads++;},mentionUser(){}}),
    routeLocally:()=>state.mode,localEnabled:()=>state.enabled,getCachedUser:()=>state.user,requireAuth:()=>true,
    hydrateLocalDraft:hydrate,storeLocalDraft:copy,readPageCache:key=>drafts.get(key),writePageCache:(key,user,value)=>{writes.push({key,owner:user.id,value:copy(value)});if(write)drafts.set(key,copy(value));return write;},
    authorizeCommunity:()=>{const gate=deferred();auth.push(gate);return gate.promise;},communitySettings(){},watchPreferences(){},injectLayout(){},
    social:async(path,method='GET',body)=>{calls.push({path,method,body:body&&copy(body)});if(method==='POST'||method==='PATCH')return typeof state.writeResponse==='function'?state.writeResponse():state.writeResponse;return path==='topics'?{list:['交流闲聊']}:copy(state.post);},
  };
  vm.createContext(scope);vm.runInContext(code,scope);const page=scope.window.communityScreen();page.$watch=()=>{};
  return {page,state,auth,calls,writes,navigation,drafts,emit:name=>events.get(name)?.()};
}
const localDraft={title:'本机草稿',content:'无需联网即可恢复的正文',images:[],video:'',tags:['剧情'],client_id:'durable-id'};

test('pending authorization paints/restores draft and permits only phone writes, not publish/preflight/media',async()=>{
  const f=fixture({saved:localDraft});const enter=f.page.enter();await tick();
  assert.equal(f.page.ready,true);assert.equal(f.page.draft.content,localDraft.content);assert.equal(f.page.composeAuthorized,false);
  f.page.draft.content+='，继续写';f.page.saveDraft();await f.page.publish();f.page.checkContent();f.page.uploadImages({target:{value:'x'}});
  assert.equal(f.writes.at(-1).value.draft.content,f.page.draft.content);assert.equal(f.calls.length,0);assert.equal(f.state.preflight,0);assert.equal(f.state.uploads,0);
  f.auth[0].resolve(access());await enter;assert.equal(f.page.composeAuthorized,true);
});
test('failed authorization keeps writable draft with a visible retry state',async()=>{
  const f=fixture({saved:localDraft});const enter=f.page.enter();await tick();f.auth[0].reject(Error('合成网络不可用'));await enter;
  assert.equal(f.page.ready,true);assert.equal(f.page.gateError,'合成网络不可用');assert.equal(f.page.composeAuthorized,false);f.page.saveDraft();assert.equal(f.writes.at(-1).value.draft.client_id,'durable-id');
});
test('retry never replaces current typing with an older saved draft',async()=>{
  const f=fixture({saved:localDraft});const first=f.page.enter();await tick();f.auth[0].reject(Error('offline'));await first;f.page.draft.content='正在写的新文字';
  const retry=f.page.enter(true);await tick();assert.equal(f.page.draft.content,'正在写的新文字');f.auth[1].resolve(access());await retry;
});
test('publishing rechecks current sanctions; mute leaves the draft and sends no write',async()=>{
  const f=fixture({saved:localDraft});const enter=f.page.enter();await tick();f.auth[0].resolve(access());await enter;
  const publish=f.page.publish();await tick();f.auth[1].resolve(access({sanctions:[{kind:'mute'}]}));await publish;
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);assert.match(f.page.editorError,/禁言/);assert.equal(f.drafts.get('social-draft').draft.content,localDraft.content);
});
test('confirmed publication clears draft only after ACK; outgoing identity is retained',async()=>{
  const f=fixture({saved:localDraft});const enter=f.page.enter();await tick();f.auth[0].resolve(access());await enter;
  const ack=deferred();f.state.writeResponse=()=>ack.promise;const publish=f.page.publish();await tick();f.auth[1].resolve(access());await tick();
  assert.equal(f.page.publishing,true);assert.ok(f.drafts.get('social-draft').draft);assert.equal(f.calls.at(-1).body.client_id,'durable-id');
  ack.resolve({id:'confirmed'});await publish;assert.equal(f.drafts.get('social-draft').draft,null);assert.deepEqual(f.navigation,['/app/community-post.html?id=confirmed']);
});
test('empty server ACK is not publication and cannot discard draft',async()=>{
  const f=fixture({saved:localDraft});const enter=f.page.enter();await tick();f.auth[0].resolve(access());await enter;f.state.writeResponse={};
  const publish=f.page.publish();await tick();f.auth[1].resolve(access());await publish;assert.match(f.page.editorError,/未确认/);assert.ok(f.drafts.get('social-draft').draft);assert.equal(f.navigation.length,0);
});
test('declining agreement keeps private draft before leaving the community',async()=>{
  const f=fixture({saved:localDraft});const enter=f.page.enter();await tick();f.auth[0].resolve(null);await enter;assert.equal(f.writes.at(-1).value.draft.content,localDraft.content);assert.deepEqual(f.navigation,['/app/explore.html']);
});
test('editing without a local draft requires actual owner data before exposing an editor',async()=>{
  const f=fixture({edit:'other'});f.state.post.is_owner=false;const enter=f.page.enter();assert.equal(f.page.ready,false);f.auth[0].resolve(access());await enter;
  assert.equal(f.page.ready,false);assert.equal(f.page.composeAuthorized,false);assert.match(f.page.gateError,/自己的帖子/);f.page.saveDraft();assert.equal(f.writes.length,0);
});
test('own post loads real version/content, while cached edits can be read offline',async()=>{
  const f=fixture({edit:'own'});const enter=f.page.enter();f.auth[0].resolve(access());await enter;assert.equal(f.page.ready,true);assert.equal(f.page.draft.version,2);assert.equal(f.page.draft.content,'原有正文');
  const offline=fixture({edit:'own',saved:localDraft});const pending=offline.page.enter();await tick();assert.equal(offline.page.ready,true);offline.auth[0].reject(Error('offline'));await pending;assert.equal(offline.page.draft.content,localDraft.content);
});
test('late draft hydration cannot populate a different account',async()=>{
  const loaded=deferred(),f=fixture({saved:localDraft,hydrate:()=>loaded.promise});const enter=f.page.enter();f.state.user={id:'qa-compose-B'};loaded.resolve(localDraft);await enter;
  assert.equal(f.page.ready,false);assert.equal(f.page.draft.content,'');assert.equal(f.auth.length,0);assert.equal(f.writes.length,0);
});
test('logout/login ABA invalidates the prior permission promise',async()=>{
  const f=fixture({saved:localDraft});const init=f.page.init();await tick();f.emit('homer-account-cleared');f.state.user={id:'qa-compose-B'};f.state.user={id:'qa-compose-A'};
  f.auth[0].resolve(access());await init;assert.equal(f.page.composeAuthorized,false);assert.equal(f.page.ready,false);assert.equal(f.calls.length,0);
});
test('older retry cannot override newer failed authorization',async()=>{
  const f=fixture({saved:localDraft});const first=f.page.enter();await tick();const second=f.page.enter(true);await tick();f.auth[1].reject(Error('new failure'));await second;
  f.auth[0].resolve(access());await first;assert.equal(f.page.composeAuthorized,false);assert.equal(f.page.gateError,'new failure');
});
test('changing local/live mode fences saved drafts and publication',async()=>{
  const f=fixture({saved:localDraft});const enter=f.page.enter();await tick();f.auth[0].resolve(access());await enter;f.state.mode=true;f.state.enabled=true;
  const before=f.writes.length;f.page.saveDraft();await f.page.publish();assert.equal(f.writes.length,before);assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
});
test('quota failure is visible and never claims a saved draft',async()=>{
  const f=fixture({saved:localDraft,write:false});const enter=f.page.enter();await tick();f.page.saveDraft();assert.equal(f.page.draftSaved,false);assert.match(f.page.editorError,/保存失败/);f.auth[0].reject(Error('offline'));await enter;
});
