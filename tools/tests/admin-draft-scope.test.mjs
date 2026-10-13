import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
const begin=source.indexOf('let adminConversationDraft =');
const actual=source.slice(begin,source.indexOf('const MODULE_ID =',begin));
function fixture(){
  let callbacks,requests=0,release,gate=null,owner='synthetic-owner';
  const rules=[];
  const scope={session:{user:{id:owner,is_admin:true}},launch:{admin_preview:true,bridge_token:'synthetic-token',app_id:'synthetic-card',conversation_id:'synthetic-preview'},
    loadingLaunch:false,generationBusy:false,rollbackBusy:false,storageAccountEpoch:1,isGenerating:()=>false,
    reconcileStorageAccount:()=>owner,conversationModelSettings:()=>({model_id:'synthetic-model'}),officialRegexState:{count:0,errors:[]},
    showHostNotice(){},setOfficialDisplayRules:value=>{rules.push(value);return {count:1,errors:[]};},
    adminWorkspace(value){callbacks=value;return {open(){}};},
    requestJson:async(_url,options)=>{requests++;const {draft}=JSON.parse(options.body);if(gate)await gate;return {prompt:{id:'preset'},worldbook:[{id:'entry',content:'Default'}],regex:{id:'regex'},...draft,display_regex:{scripts:[]},library:{}};}};
  vm.createContext(scope);vm.runInContext(actual+'\nglobalThis.getAdminState=()=>({draft:adminConversationDraft,config:adminConversationConfig});globalThis.openAdminEditor=()=>administratorEditor.open({},"worldbook");',scope);
  return {scope,rules,callbacks:()=>callbacks,requests:()=>requests,
    owner:value=>owner=value,hold(){gate=new Promise(resolve=>release=resolve);},release(){release();gate=null;},
    state:()=>JSON.parse(JSON.stringify(scope.getAdminState())),open:()=>scope.openAdminEditor()};
}
const draft={worldbook:[{id:'synthetic-entry',content:'Edited for this preview only'}]};
const mutations=[
  ['different owner',f=>f.owner('other-owner')],
  ['same-owner ABA',f=>{f.owner('other-owner');f.scope.storageAccountEpoch++;f.owner('synthetic-owner');f.scope.storageAccountEpoch++;}],
  ['preview replacement with same IDs',f=>f.scope.launch={...f.scope.launch}],
  ['card drift',f=>f.scope.launch.app_id='other-card'],
  ['conversation drift',f=>f.scope.launch.conversation_id='other-preview'],
  ['token drift',f=>f.scope.launch.bridge_token='other-token'],
  ['privilege revoked',f=>f.scope.session.user.is_admin=false],
  ['preview revoked',f=>f.scope.launch.admin_preview=false],
  ['generation began',f=>f.scope.generationBusy=true],
  ['new launch loading',f=>f.scope.loadingLaunch=true],
  ['rollback began',f=>f.scope.rollbackBusy=true],
];
test('actual applied draft keeps only explicit sections without changing global defaults',async()=>{
  const f=fixture();await f.scope.refreshAdminConfiguration();f.open();await f.callbacks().apply(draft);
  assert.deepEqual(f.state().draft,draft);assert.equal(f.state().config.prompt.id,'preset');assert.equal(f.requests(),2);
});
for(const [name,change]of mutations){
  test(`actual opened editor refuses ${name} before a request`,async()=>{
    const f=fixture();await f.scope.refreshAdminConfiguration();f.open();const before=f.state(),calls=f.requests();change(f);
    await assert.rejects(f.callbacks().apply(draft),/管理会话或账号已变化/);assert.equal(f.requests(),calls);assert.deepEqual(f.state(),before);
  });
  test(`actual pending Apply fences ${name} before config, rules or draft mutation`,async()=>{
    const f=fixture();await f.scope.refreshAdminConfiguration();f.open();const before=f.state(),rules=f.rules.length;f.hold();
    const pending=f.callbacks().apply(draft);change(f);f.release();await assert.rejects(pending,/管理会话或账号已变化/);
    assert.deepEqual(f.state(),before);assert.equal(f.rules.length,rules);
  });
}
test('request-local admin refresh during generation is allowed, but editor Apply is not',async()=>{
  const f=fixture();await f.scope.refreshAdminConfiguration();f.open();f.scope.generationBusy=true;
  await f.scope.refreshAdminConfiguration();assert.equal(f.requests(),2);
  await assert.rejects(f.callbacks().apply(draft));assert.equal(f.requests(),2);
});
