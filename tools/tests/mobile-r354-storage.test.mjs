import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChatOutbox } from '../../sillytavern-runtime/public/scripts/homer-chat-outbox.mjs';
import { transactionIDB } from './helpers/transaction-idb.mjs';
import { sessionVM } from './helpers/bridge-session-vm.mjs';
const source=fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
const v=n=>n.repeat(32), scope=JSON.stringify(['unit-session-owner','card','conv']);
const snap=(text='full',version=v('a'),id=scope)=>{const [,app_id,conversation_id]=JSON.parse(id);return {scope:id,storageVersion:version,body:JSON.stringify({app_id,conversation_id,title:'Test',messages:[{mes:text,extra:{}}]})};};
const ack=(version=v('a'),text='full')=>({messages:[{id:'fixture-id',role:'assistant',content:text,created_at:1}],storage:{protocol:2,complete:true,version,message_count:1}});
const setup=()=>{const indexedDB=transactionIDB();return {indexedDB,outbox:createChatOutbox({indexedDB,databaseName:'storage-v2'})};};
const payload=(storage=ack().storage)=>({user:{id:'unit-session-owner'},launch:{app_id:'card',conversation_id:'conv',card:{},bridge_token:true,storage,messages:storage.unchanged?[]:ack().messages}});
test('complete read caches acknowledged history without a pending upload',async()=>{
 const {outbox}=setup();assert.equal(await outbox.rememberRemote(snap(),ack(),await outbox.fence(scope)),true);
 const saved=await outbox.read(scope);assert.equal(saved.pending,false);assert.equal(saved.cloudVersion,v('a'));assert.equal((await outbox.pending('unit-session-owner')).length,0);
});
test('pending edit survives read cache and factory restart',async()=>{
 const {outbox,indexedDB}=setup();const fence=await outbox.fence(scope);await outbox.prepare(snap('edited'));
 assert.equal(await outbox.rememberRemote(snap(),ack(),fence),false);await outbox.close();
 const restarted=createChatOutbox({indexedDB,databaseName:'storage-v2'});assert.equal((await restarted.read(scope)).payload.messages[0].mes,'edited');assert.equal((await restarted.read(scope)).pending,true);
});
test('older ACK rebases newer edits without clearing them across successive writes',async()=>{
 const {outbox}=setup(),one=await outbox.prepare(snap('one')),two=await outbox.prepare(snap('two'));
 assert.equal((await outbox.cloudACK(one,ack(v('b'),'one'))).applied,false);
 const current=await outbox.read(scope);assert.equal(current.pending,true);assert.equal(current.baseVersion,v('b'));assert.equal(current.commitId,two.commitId);
 two.baseVersion=current.baseVersion;const three=await outbox.prepare(snap('three'));
 await outbox.cloudACK(two,ack(v('c'),'two'));const newest=await outbox.read(scope);
 assert.equal(newest.baseVersion,v('c'));assert.equal(newest.commitId,three.commitId);assert.equal(newest.pending,true);
});
test('duplicate older ACK cannot regress a rebased edit',async()=>{
 const {outbox}=setup(),one=await outbox.prepare(snap('one'));await outbox.prepare(snap('two'));
 await outbox.cloudACK(one,ack(v('b'),'one'));await outbox.cloudACK(one,ack(v('a'),'one'));
 assert.equal((await outbox.read(scope)).baseVersion,v('b'));
});
test('legacy pending bytes never acquire a fictitious current base',async()=>{
 const {outbox}=setup();await outbox.prepare(snap('legacy',''));await outbox.prepare(snap('edited',v('b')));
 assert.equal((await outbox.read(scope)).baseVersion,undefined);assert.equal((await outbox.read(scope)).pending,true);
});
test('fork completion cannot clear a newer edit',async()=>{
 const {outbox}=setup(),old=await outbox.prepare(snap('one'));await outbox.prepare(snap('two'));
 assert.equal(await outbox.markForked(old,'new-conv'),false);assert.equal((await outbox.read(scope)).pending,true);
});
test('conditional read reuses metadata after matching server version',async()=>{
 const {outbox}=setup();await outbox.rememberRemote(snap(),ack(),await outbox.fence(scope));
 const vm=sessionVM(source,{chatOutbox:outbox});const response=payload({...ack().storage,unchanged:true});
 await vm.preferLocalSession(response,'card','conv',await outbox.fence(scope));
 assert.equal(response.launch.local_chat[0].mes,'full');assert.equal(response.launch.local_chat[0].extra.homer_message_id,'fixture-id');assert.equal(response.launch.messages[0].content,'full');
});
test('evicted conditional cache fails instead of becoming empty history',async()=>{
 const {outbox}=setup(),vm=sessionVM(source,{chatOutbox:outbox});
 await assert.rejects(vm.preferLocalSession(payload({...ack().storage,unchanged:true}),'card','conv',await outbox.fence(scope)),{code:'HOMER_STALE_STORAGE_READ'});
});
test('partial response is rejected before rendering or resaving',async()=>{
 const {outbox}=setup(),vm=sessionVM(source,{chatOutbox:outbox});
 await assert.rejects(vm.preferLocalSession(payload({...ack().storage,message_count:5}),'card','conv',await outbox.fence(scope)),/不完整/);
});
test('stale pending progress is preserved and flagged',async()=>{
 const {outbox}=setup();await outbox.prepare(snap('local',v('b')));
 const vm=sessionVM(source,{chatOutbox:outbox}),response=payload();await vm.preferLocalSession(response,'card','conv',await outbox.fence(scope));
 assert.equal(response.launch.storage_conflict,true);assert.equal(response.launch.local_chat[0].mes,'local');
});
test('late local ACK with different version preserves the phone history without waiting for another cloud read',async()=>{
 const {outbox}=setup(),fence=await outbox.fence(scope);const committed=await outbox.prepare(snap('new'));await outbox.cloudACK(committed,ack(v('b'),'new'));
 const vm=sessionVM(source,{chatOutbox:outbox}),response=payload();await vm.preferLocalSession(response,'card','conv',fence);
 assert.equal(response.launch.local_chat[0].mes,'new');assert.equal(response.launch.messages[0].content,'new');
 assert.equal(response.launch.local_pending,false);assert.equal(response.launch.storage.version,v('b'));
});
test('scope isolation and canonical contract shape',async()=>{
 const {outbox}=setup();await outbox.prepare(snap());assert.equal((await outbox.pending('another-user')).length,0);
 const schema=JSON.parse(fs.readFileSync(new URL('../../contracts/chat-storage-v2.schema.json',import.meta.url),'utf8'));
 for(const key of schema.required)assert.ok(key in ack().storage);assert.match(ack().storage.version,new RegExp(schema.properties.version.pattern));
});
test('partial versioned ACK never clears durable pending bytes',async()=>{
 const {outbox}=setup(),one=await outbox.prepare(snap());const response=ack();response.storage.message_count=5;
 await assert.rejects(outbox.cloudACK(one,response),/Incomplete/);assert.equal((await outbox.read(scope)).pending,true);
});
test('acknowledged complete phone histories are never evicted at the former 24-row limit',async()=>{
 const {outbox,indexedDB}=setup();
 for(let i=0;i<28;i++){
  const id=JSON.stringify(['unit-session-owner','card',`retained-${i}`]);
  await outbox.rememberRemote(snap(`complete-${i}`,v('a'),id),ack(v('a'),`complete-${i}`),await outbox.fence(id));
 }
 await outbox.close();const restarted=createChatOutbox({indexedDB,databaseName:'storage-v2'});
 for(let i=0;i<28;i++){
  const id=JSON.stringify(['unit-session-owner','card',`retained-${i}`]),saved=await restarted.read(id);
  assert.equal(saved.payload.messages[0].mes,`complete-${i}`);assert.equal(saved.pending,false);
 }
 assert.equal((await restarted.pending('unit-session-owner')).length,0);
});
test('cloud ACK retains a phone history exceeding the former 32 MiB byte budget',async()=>{
 const {outbox,indexedDB}=setup(),text='字'.repeat(Math.ceil((32*1024*1024+1)/3));
 const committed=await outbox.prepare(snap(text));assert.ok(committed.bytes>32*1024*1024);
 await outbox.cloudACK(committed,ack(v('b')));await outbox.close();
 const restarted=createChatOutbox({indexedDB,databaseName:'storage-v2'}),saved=await restarted.read(scope);
 assert.equal(saved.payload.messages[0].mes,text);assert.equal(saved.pending,false);
});
test('verified token rebase changes only base/cloud version and never acknowledges phone edits',async()=>{
 const {outbox,indexedDB}=setup(),snapshot=snap('offline progress');snapshot.committed=await outbox.prepare(snapshot);
 const before=indexedDB.dump('storage-v2')[0];assert.equal(await outbox.rebasePending(snapshot,v('b')),true);
 const after=indexedDB.dump('storage-v2')[0],changed={...before,baseVersion:v('b'),cloudVersion:v('b')};
 assert.deepEqual(after,changed);assert.equal(after.pending,1);assert.equal(after.body,before.body);
 assert.equal((await outbox.read(scope)).commitId,snapshot.committed.commitId);
});
test('rebase cannot replace a newer edit or an independently rebased version',async()=>{
 const {outbox}=setup(),old=snap('old');old.committed=await outbox.prepare(old);
 const newest=snap('new');newest.committed=await outbox.prepare(newest);
 assert.equal(await outbox.rebasePending(old,v('b')),false);
 assert.equal(await outbox.rebasePending(newest,v('b')),true);
 assert.equal(await outbox.rebasePending(newest,v('c')),false);
 const saved=await outbox.read(scope);assert.equal(saved.payload.messages[0].mes,'new');assert.equal(saved.baseVersion,v('b'));assert.equal(saved.pending,true);
});
test('rebase refuses scope, account, lineage, body and commit impersonation',async()=>{
 const {outbox}=setup(),snapshot=snap();snapshot.committed=await outbox.prepare(snapshot);
 for(const changed of [{owner:'other-owner'},{scope:JSON.stringify(['other-owner','card','conv'])},
  {app_id:'other-card'},{conversation_id:'other-conv'},{lineage:'other-lineage'},{revision:999},
  {body:JSON.stringify({app_id:'card',conversation_id:'conv',messages:[]})},{commitId:'other-commit'},
  {kind:'extension-settings'},{pending:false}]){
  assert.equal(await outbox.rebasePending({...snapshot,committed:{...snapshot.committed,...changed}},v('b')),false);
 }
 assert.equal((await outbox.read(scope)).baseVersion,v('a'));assert.equal((await outbox.read(scope)).pending,true);
 await assert.rejects(outbox.rebasePending(snapshot,'not-a-cloud-token'),TypeError);
});
test('legacy versionless pending progress may explicitly rebase and remains durable after restart',async()=>{
 const {outbox,indexedDB}=setup(),snapshot=snap('legacy','');snapshot.committed=await outbox.prepare(snapshot);
 assert.equal(await outbox.rebasePending(snapshot,v('b')),true);await outbox.close();
 const restarted=createChatOutbox({indexedDB,databaseName:'storage-v2'}),saved=await restarted.read(scope);
 assert.equal(saved.payload.messages[0].mes,'legacy');assert.equal(saved.baseVersion,v('b'));assert.equal(saved.pending,true);
});
test('a persisted pre-v2 row without lineage rebases only its original exact commit',async()=>{
 const {outbox,indexedDB}=setup(),snapshot=snap('pre-v2','');await outbox.prepare(snapshot);
 const db=await new Promise(resolve=>{const request=indexedDB.open('storage-v2',1);request.onsuccess=()=>resolve(request.result);});
 await new Promise((resolve,reject)=>{
  const tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots');
  tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  const request=store.get([...JSON.parse(scope),'chat']);request.onsuccess=()=>{
   const row=request.result;delete row.lineage;delete row.baseVersion;delete row.cloudVersion;store.put(row);
  };
 });
 snapshot.committed=await outbox.read(scope);assert.equal(snapshot.committed.lineage,undefined);
 assert.equal(await outbox.rebasePending(snapshot,v('b')),true);
 assert.equal((await outbox.read(scope)).pending,true);assert.equal((await outbox.read(scope)).payload.messages[0].mes,'pre-v2');
 assert.equal(await outbox.rebasePending(snapshot,v('c')),false);
});
test('rebase returns only after the durable transaction and never changes an ACKed row',async()=>{
 const {outbox,indexedDB}=setup(),snapshot=snap();snapshot.committed=await outbox.prepare(snapshot);
 const gate=indexedDB.holdNextCommit();let settled=false;
 const pending=outbox.rebasePending(snapshot,v('b')).then(result=>{settled=true;return result;});
 await gate.reached;assert.equal(settled,false);gate.release();assert.equal(await pending,true);
 const current=await outbox.read(scope);await outbox.cloudACK(current,ack(v('c')));
 assert.equal(await outbox.rebasePending({...snapshot,committed:await outbox.read(scope)},v('d')),false);
 assert.equal((await outbox.read(scope)).cloudVersion,v('c'));
});
test('stale ACK for a rebased exact commit cannot clear pending or regress versions',async()=>{
 const {outbox}=setup(),snapshot=snap('local');snapshot.committed=await outbox.prepare(snapshot);
 assert.equal(await outbox.rebasePending(snapshot,v('c')),true);
 assert.equal((await outbox.cloudACK(snapshot.committed,ack(v('b'),'local'))).applied,false);
 const current=await outbox.read(scope);assert.equal(current.pending,true);assert.equal(current.baseVersion,v('c'));assert.equal(current.cloudVersion,v('c'));
 assert.equal((await outbox.cloudACK(current,ack(v('d'),'local'))).applied,true);
 assert.equal((await outbox.read(scope)).pending,false);
});
test('failed rebase transaction preserves phone bytes and its former upload base',async()=>{
 const {outbox,indexedDB}=setup(),snapshot=snap('retain me');snapshot.committed=await outbox.prepare(snapshot);
 indexedDB.failNextPut=true;await assert.rejects(outbox.rebasePending(snapshot,v('b')),/quota/i);
 const saved=await outbox.read(scope);assert.equal(saved.payload.messages[0].mes,'retain me');assert.equal(saved.baseVersion,v('a'));assert.equal(saved.pending,true);
});
