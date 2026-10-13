import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { creatorRevenueRate, creatorRevenuePercent, creatorEarnings } from '../../.web-cache/tree/frontend/assets/js/creator-revenue-contract.mjs';
import { authorizedAdminHostScope, syncAdminHostSettings } from '../../.web-cache/tree/frontend/assets/js/admin-host-settings.mjs';

test('revenue percent uses exact basis points and server ACK must match request', () => {
  assert.equal(creatorRevenuePercent('35.01'),3501);
  assert.equal(creatorRevenuePercent('0'),0);
  assert.equal(creatorRevenuePercent('100.00'),10000);
  for (const invalid of ['-1','100.01','1e2','NaN','35.001','']) assert.throws(()=>creatorRevenuePercent(invalid));
  assert.equal(creatorRevenueRate({data:{rate_bps:3500}},3500),3500);
  for(const bad of [undefined,{}, {rate_bps:'3500'},{rate_bps:10001},{rate_bps:-1},{rate_bps:0}]) assert.throws(()=>creatorRevenueRate(bad,3500));
});

test('revenue data cannot treat recharges or malformed totals as earnings',()=>{
  const base={unit:'积分',creator_points:35,invite_points:null,cards:[{id:'card',name:'合成卡',points:35}]};
  assert.equal(creatorEarnings({data:base}),base);
  assert.throws(()=>creatorEarnings({...base,creator_points:500}));
  assert.throws(()=>creatorEarnings({...base,cards:[{id:'card',points:-1}]}));
  assert.throws(()=>creatorEarnings({...base,invite_points:'100'}));
  assert.throws(()=>creatorEarnings({...base,creator_points:70,cards:[...base.cards,...base.cards]}));
  assert.throws(()=>creatorEarnings({unit:'元',creator_points:500,cards:[]}));
});

const valid=()=>({requested:true,ready:true,owner:'synthetic-owner',appId:'synthetic-card',conversationId:'preview-1',state:{admin_preview:true,admin_authorized:true,owner_id:'synthetic-owner',app_id:'synthetic-card',conversation_id:'preview-1',generating:false}});
test('admin presentation requires verified live owner/app/conversation, not a URL or cached administrator',()=>{
  assert.equal(authorizedAdminHostScope(valid()),true);
  for(const key of ['owner','appId','conversationId'])assert.equal(authorizedAdminHostScope({...valid(),[key]:'stale'}),false);
  for(const key of ['requested','ready'])assert.equal(authorizedAdminHostScope({...valid(),[key]:false}),false);
  for(const key of ['admin_preview','admin_authorized','owner_id','app_id','conversation_id']){
    const scope=valid();delete scope.state[key];assert.equal(authorizedAdminHostScope(scope),false);
  }
  assert.equal(authorizedAdminHostScope({...valid(),state:{is_admin:true,admin_preview:true}}),false);
});

test('switch from admin preview to ordinary history revokes controls and preserves protected user switches',()=>{
  const admin={tagName:'BUTTON',hidden:true,disabled:true,style:{display:'none'}},normal={hidden:false,style:{display:''}},note={textContent:''};
  const root={dataset:{},querySelectorAll:s=>s==='[data-admin-preview-only]'?[admin]:[normal],querySelector:()=>note};
  assert.equal(syncAdminHostSettings(root,valid()),true);
  assert.equal(admin.hidden,false);assert.equal(admin.disabled,false);assert.equal(normal.hidden,true);
  assert.match(note.textContent,/应用到本次会话/);
  const ordinary=valid();ordinary.requested=false;ordinary.state.admin_preview=false;
  assert.equal(syncAdminHostSettings(root,ordinary),false);
  assert.equal(admin.hidden,true);assert.equal(admin.disabled,true);assert.equal(admin.style.display,'none');assert.equal(normal.hidden,false);
  assert.match(note.textContent,/正文受创作者保护/);
});

test('admin controls remain disabled while generating and are initially hidden in the host',async()=>{
  const admin={tagName:'BUTTON',style:{}},root={dataset:{},querySelectorAll:s=>s==='[data-admin-preview-only]'?[admin]:[],querySelector:()=>null};
  const scope=valid();scope.state.generating=true;syncAdminHostSettings(root,scope);assert.equal(admin.disabled,true);
  const html=await readFile(new URL('../../.web-cache/tree/frontend/app/chat.html',import.meta.url),'utf8');
  for(const kind of ['prompt','worldbook','regex']) assert.match(html,new RegExp(`data-runtime-section="admin-${kind}"[^>]*hidden disabled style="display:none"`));
});
