import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,applyGameCommand,createGameStore,buildGameContext} from '../../frontend/app/assets/js/visual-novel-game-store.mjs';
import {cardTransportIDB} from './helpers/card-transport-idb.mjs';

const owner='synthetic-withdraw';
const setup={id:'game',title:'测试',player:{name:'老师'},world:{scene:'办公室',summary:''},characters:[{id:'a',appId:'app-a',name:'甲',conversationId:'conv-a'},{id:'b',appId:'app-b',name:'乙',conversationId:'conv-b'}]};
const apply=(g,type,values={})=>applyGameCommand(g,{type,...values},{now:100});
const finish=(g,id,reply='已完成回复')=>apply(apply(g,'begin-turn',{requestId:id,...g.active,userText:'最新行动'}),'finish-turn',{requestId:id,reply,canonicalMessageId:'canonical-'+id});

test('withdraw removes only a confirmed latest turn and its own memory/planned invitation; input stays immutable',()=>{
  let g=apply(createGame({...setup,owner},{now:100}),'select',{characterId:'a',channel:'talk'});
  g=finish(g,'previous');g=finish(g,'latest','回复\n[约会邀请:去公园|公园]');
  g=apply(g,'archive-turn',{requestId:'latest'});const before=structuredClone(g);
  const next=apply(g,'withdraw-turn',{requestId:'latest'});
  assert.deepEqual(g,before);assert.equal(next.turns.length,1);assert.equal(next.events.length,0);assert.equal(next.memories.length,0);
  assert.equal(next.turns[0].requestId,'previous');assert.equal(next.revision,g.revision+1);
  assert.equal(buildGameContext(next,'a','talk').includes('去公园'),false);
});

test('withdraw rejects old/cross-channel/pending turns and already-started derived event',()=>{
  let g=finish(createGame({...setup,owner},{now:100}),'first');g=finish(g,'second');
  assert.throws(()=>apply(g,'withdraw-turn',{requestId:'first'}),{code:'VN_GAME_WITHDRAW_INVALID'});
  const other=apply(g,'select',{characterId:'b',channel:'talk'});
  assert.throws(()=>apply(other,'withdraw-turn',{requestId:'second'}),{code:'VN_GAME_WITHDRAW_INVALID'});
  const pending=apply(g,'begin-turn',{requestId:'pending',...g.active,userText:'输入'});
  assert.throws(()=>apply(pending,'withdraw-turn',{requestId:'second'}),{code:'VN_GAME_TURN_PENDING'});
  let invited=finish(apply(g,'select',{characterId:'a',channel:'talk'}),'invite','[约会邀请:公园|公园]');
  invited=apply(invited,'start-date',{eventId:'invite:invite:0'});
  invited=apply(invited,'select',{characterId:'a',channel:'talk'});
  assert.throws(()=>apply(invited,'withdraw-turn',{requestId:'invite'}),{code:'VN_GAME_WITHDRAW_DEPENDENCY'});
});

test('withdraw backup and game revision commit atomically; conflict/backup-limit never changes story',async()=>{
  let serial=0;const store=createGameStore({indexedDB:cardTransportIDB(),now:()=>100,makeId:()=>`save-${++serial}`});
  let g=await store.create(owner,setup);
  const cmd=async(type,values={})=>g=await store.command(owner,g.id,{type,...values},{expectedRevision:g.revision});
  await cmd('begin-turn',{requestId:'first',...g.active,userText:'真实输入'});
  await cmd('finish-turn',{requestId:'first',reply:'原进度保留',canonicalMessageId:'message-first'});
  const before=structuredClone(g);
  await assert.rejects(store.withdraw(owner,g.id,'first',{expectedRevision:g.revision-1}),{code:'VN_GAME_REVISION_CONFLICT'});
  assert.deepEqual(await store.get(owner,g.id),before);
  g=await store.withdraw(owner,g.id,'first',{expectedRevision:g.revision});assert.equal(g.turns.length,0);
  const backups=await store.listCheckpoints(owner,g.id);assert.equal(backups.length,1);assert.equal(backups[0].automatic,true);
  g=await store.restore(owner,g.id,backups[0].id,{expectedRevision:g.revision});assert.equal(g.turns[0].reply,'原进度保留');
  for(let index=0;index<10;index++)await store.checkpoint(owner,g.id,'手动备份'+index);
  const full=structuredClone(g);
  await assert.rejects(store.withdraw(owner,g.id,'first',{expectedRevision:g.revision}),{code:'VN_GAME_CHECKPOINT_LIMIT'});
  assert.deepEqual(await store.get(owner,g.id),full);store.close();
});
