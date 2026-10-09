import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameStore} from '../../frontend/app/assets/js/visual-novel-game-store.mjs';
import {createSyncedGameStore} from '../../frontend/app/assets/js/visual-novel-game-sync.mjs';
import {cardTransportIDB} from './helpers/card-transport-idb.mjs';

const owner='synthetic-archive-owner';
const setup={id:'archive-game',title:'合成工坊故事',player:{name:'测试玩家'},world:{scene:'测试书店',summary:''},
  characters:[{id:'person',appId:'private-card',name:'测试人物',versionId:'v1',conversationId:'dedicated-conversation',avatar:'',
  themeRoleId:'mod-d7c8d252-8f12-433c-acb2-f8d02daa6963-0',mediaRef:{resourceId:'608761ee-d235-437d-90f7-aa22d97786d8',revisionId:'d7c8d252-8f12-433c-acb2-f8d02daa6963',sha256:'a'.repeat(64),roleUid:'test-role'}}]};
const copy=value=>structuredClone(value);
function fixture(){
  const remote=new Map(),receipts=new Map(),posts=[];let n=0,offline=false,lost=false;
  const client={
    async saveArchiveGame(body){posts.push(copy(body));if(offline)throw Error('offline');
      const receipt=receipts.get(body.commit_id);if(receipt)return copy(receipt);
      const before=remote.get(body.game_id);if((before?.version||'')!==body.expected_version)throw Object.assign(Error('conflict'),{status:409});
      const result={game_id:body.game_id,version:(++n).toString(16).padStart(32,'0')};
      remote.set(body.game_id,{...result,bundle:copy(body.bundle)});receipts.set(body.commit_id,result);
      if(lost){lost=false;throw Error('lost ack');}return result;
    },
    async archiveSaves(params){if(offline)throw Error('offline');if(params.game_id)return copy(remote.get(params.game_id));
      return {items:[...remote.values()].map(row=>({id:row.game_id,version:row.version})),pages:1};}
  };
  function phone(options={}){
    const idb=cardTransportIDB(),base=createGameStore({indexedDB:idb,makeId:()=>`branch-${++n}`,isCurrent:options.isCurrent});
    const states=[],timers=[];
    const store=createSyncedGameStore({store:base,client,onStatus:state=>states.push(state.state),schedule:fn=>{timers.push(fn);return 0;},events:null,...options});
    return {store,base,states,idb,timers};
  }
  return {phone,client,remote,posts,offline:v=>offline=v,lost:v=>lost=v};
}

test('local commit precedes upload; offline pending persists without generation or media IO',async()=>{
  const f=fixture(),p=f.phone();f.offline(true);const game=await p.store.create(owner,setup);assert.equal(game.id,setup.id);assert.equal(f.posts.length,0);
  await p.store.sync(owner,game.id);const meta=await p.base.syncState(owner,game.id);assert.ok(meta.pending.commitId);assert.equal(meta.pending.bundle.game.owner,owner);
  assert.equal(p.states.at(-1),'pending');assert.equal((await p.base.get(owner,game.id)).revision,0);
  f.offline(false);await p.store.sync(owner,game.id);assert.equal(f.posts[0].commit_id,f.posts[1].commit_id);assert.equal(p.states.at(-1),'synced');p.store.close();
});

test('explicit too-large rejection releases only unsaved frozen outbox, so reduced branches can back up',async()=>{
  const f=fixture(),p=f.phone();let reject=true;
  const save=f.client.saveArchiveGame;f.client.saveArchiveGame=async body=>{if(reject)throw Object.assign(Error('size'),{status:413});return save(body);};
  const game=await p.store.create(owner,setup);await p.store.sync(owner,game.id);
  assert.equal((await p.store.syncState(owner,game.id)).pending,null);assert.equal(p.states.at(-1),'too_large');
  assert.deepEqual(await p.store.get(owner,game.id),game);
  reject=false;await p.store.sync(owner,game.id);assert.equal(p.states.at(-1),'synced');p.store.close();
});

test('lost ACK retries exact frozen body before newer local progress, no duplicate cloud version',async()=>{
  const f=fixture(),p=f.phone();let g=await p.store.create(owner,setup);f.lost(true);await p.store.sync(owner,g.id);assert.ok((await p.base.syncState(owner,g.id)).pending);
  g=await p.store.command(owner,g.id,{type:'update-world',summary:'更晚的本机剧情'},{expectedRevision:g.revision});
  await p.store.sync(owner,g.id);assert.deepEqual(f.posts[0],f.posts[1]);assert.equal(f.posts.length,3);
  assert.notEqual(f.posts[2].commit_id,f.posts[1].commit_id);assert.equal(f.remote.get(g.id).bundle.game.world.summary,'更晚的本机剧情');
  assert.equal((await p.base.syncState(owner,g.id)).pending,null);p.store.close();
});

test('fresh phone restores full game and branch bodies without local media or any POST',async()=>{
  const f=fixture(),first=f.phone();let g=await first.store.create(owner,setup);
  g=await first.store.command(owner,g.id,{type:'begin-turn',requestId:'request',...g.active,userText:'实际行动'},{expectedRevision:g.revision});
  g=await first.store.command(owner,g.id,{type:'finish-turn',requestId:'request',reply:'完整已确认剧情',canonicalMessageId:'canonical-id'},{expectedRevision:g.revision});
  const branch=await first.store.checkpoint(owner,g.id,'分支一');await first.store.sync(owner,g.id);const before=f.posts.length;first.store.close();
  const next=f.phone();await next.store.pull(owner);const restored=await next.store.get(owner,g.id);assert.deepEqual(restored,g);
  assert.equal(f.posts.length,before);assert.equal(restored.characters[0].mediaRef.sha256,'a'.repeat(64));
  const bundle=await next.store.exportBundle(owner,g.id);assert.equal(bundle.checkpoints[0].id,branch.id);assert.equal(bundle.checkpoints[0].game.turns[0].reply,'完整已确认剧情');
  assert.equal(await next.store.get(owner+'-other',g.id),null);next.store.close();
});

test('another-device conflict preserves both versions; pull never overwrites phone game',async()=>{
  const f=fixture(),a=f.phone(),b=f.phone();let first=await a.store.create(owner,setup);await a.store.sync(owner,first.id);await b.store.pull(owner);
  first=await a.store.command(owner,first.id,{type:'update-world',summary:'云端来自另一台设备'},{expectedRevision:first.revision});await a.store.sync(owner,first.id);
  let local=await b.store.get(owner,first.id);local=await b.store.command(owner,local.id,{type:'update-world',summary:'手机离线新进度'},{expectedRevision:local.revision});
  await b.store.sync(owner,local.id);await b.store.pull(owner);assert.equal((await b.store.get(owner,local.id)).world.summary,'手机离线新进度');
  assert.equal(f.remote.get(local.id).bundle.game.world.summary,'云端来自另一台设备');assert.equal((await b.store.syncState(owner,local.id)).conflict,true);
  a.store.close();b.store.close();
});

test('full-owner fence prevents late remote restore or writes after account switch',async()=>{
  const f=fixture(),a=f.phone();const g=await a.store.create(owner,setup);await a.store.sync(owner,g.id);a.store.close();
  let current=true,release;const wait=new Promise(resolve=>release=resolve);const original=f.client.archiveSaves;
  f.client.archiveSaves=async params=>{const result=await original(params);await wait;return result;};
  const b=f.phone({isCurrent:()=>current});const pull=b.store.pull(owner);current=false;release();await pull;
  current=true;assert.equal(await b.store.get(owner,g.id),null);assert.equal(f.posts.length,1);b.store.close();
});

test('IDB compare-and-set prevents another page replacing frozen outbox',async()=>{
  const f=fixture(),p=f.phone();const g=await p.base.create(owner,setup),one={cloudVersion:'',ackedHash:'',pending:null,conflict:false};
  await p.base.compareSyncState(owner,g.id,null,one);
  await assert.rejects(p.base.compareSyncState(owner,g.id,null,{...one,conflict:true}),{code:'VN_SYNC_LOCAL_CONFLICT'});
  assert.deepEqual(await p.base.syncState(owner,g.id),one);p.store.close();
});
