import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { syncAdminHostSettings } from '../../frontend/assets/js/admin-host-settings.mjs';

function gate() {
  const privileged = Array.from({length:3}, () => ({tagName:'BUTTON',style:{}})), ordinary=[{style:{}}];
  const root={dataset:{},querySelectorAll:selector=>selector.includes('admin-preview')?privileged:ordinary,querySelector:()=>null};
  const scope={requested:true,ready:true,owner:'qa-owner',appId:'qa-card',conversationId:'qa-preview',
    state:{admin_preview:true,admin_authorized:true,owner_id:'qa-owner',app_id:'qa-card',conversation_id:'qa-preview',generating:false}};
  return {root,scope,privileged,ordinary};
}
test('administrator controls are revoked on loading, scope drift, account change, or ordinary conversation', () => {
  for (const change of [s=>s.ready=false,s=>s.requested=false,s=>s.owner='qa-new-owner',s=>s.conversationId='qa-new-chat',s=>s.state.admin_authorized=false,s=>s.state=null]) {
    const f=gate(); assert.equal(syncAdminHostSettings(f.root,f.scope),true);
    assert.ok(f.privileged.every(node=>!node.hidden&&!node.disabled)); change(f.scope);
    assert.equal(syncAdminHostSettings(f.root,f.scope),false);
    assert.ok(f.privileged.every(node=>node.hidden&&node.disabled));
  }
});

const source=fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
const first=source.indexOf('function openHostRequestedSettings(');
const fn=source.slice(first,source.indexOf('async function receiveHostCommand(',first));
function runtime({admin=true,preview=true,token=true,gate=Promise.resolve()}={}) {
  const calls=[],root={};let owner='qa-owner';
  const scope={session:{user:{id:owner,is_admin:admin}},launch:{admin_preview:preview,bridge_token:token?'synthetic':null},
    loadingLaunch:false,generationBusy:false,rollbackBusy:false,isGenerating:()=>false,
    reconcileStorageAccount:()=>owner,storageAccountEpoch:1,
    refreshAdminConfiguration:async()=>{calls.push('read');await gate;},
    administratorEditor:{open:async (node,kind)=>{assert.equal(node,root);calls.push(kind);}},
    setDrawerOpen:side=>calls.push(side),document:{querySelector:selector=>selector==='#homer-right-drawer'?root:null},
    showHostNotice:()=>calls.push('error')};
  vm.createContext(scope);vm.runInContext(fn,scope);
  return {scope,calls,setOwner:value=>owner=value};
}
test('shipping runtime opens full editors only with current signed admin preview and verified administrator', async () => {
  for(const [target,kind] of [['admin-prompt','prompt'],['admin-worldbook','worldbook'],['admin-regex','regex']]) {
    const f=runtime();await f.scope.openHostRequestedSettings(target);assert.deepEqual(f.calls,['right','read',kind]);
    for(const flags of [{admin:false},{preview:false},{token:false}]) {
      const denied=runtime(flags);await denied.scope.openHostRequestedSettings(target);assert.deepEqual(denied.calls,[]);
    }
  }
});
test('late admin configuration cannot open an editor after scope/account/permission changes',async()=>{
  for(const change of [f=>f.scope.launch={admin_preview:true,bridge_token:'other'},f=>f.setOwner('other-owner'),f=>f.scope.storageAccountEpoch++,f=>f.scope.session.user.is_admin=false,f=>f.scope.generationBusy=true]) {
    let release;const gate=new Promise(resolve=>release=resolve),f=runtime({gate});
    const opened=f.scope.openHostRequestedSettings('admin-worldbook');change(f);release();await opened;
    assert.deepEqual(f.calls,['right','read']);
  }
});
