import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {sessionVM} from './helpers/bridge-session-vm.mjs';
const source=await readFile(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
const owner='unit-session-owner',app='unit-card',conversation='unit-conversation',key=JSON.stringify([owner,app,conversation]);
const payload=()=>({user:{id:owner},launch:{app_id:app,conversation_id:conversation,card:{name:'Synthetic'},messages:[],storage:{protocol:2,complete:true,version:'a'.repeat(32),message_count:0}}});
test('phone archive without an outbox row opens even after preparation registered an ACK stamp',async()=>{
 const s=sessionVM(source,{localSessions:{read:async()=>payload()},requestJson:()=>{throw Error('Must not need network');}});
 s.storageAckStamp(key);
 const result=await s.fetchSession(app,conversation);
 assert.equal(result.launch.local_session,true);
 const ticket=s.sessionReadFences.get(result);
 assert.equal(ticket.stamp,s.storageAckStamp(key));assert.equal(ticket.version,0);
});
test('an ACK racing the archive read triggers one fresh phone read, not cloud replacement',async()=>{
 let reads=0,s;
 s=sessionVM(source,{localSessions:{read:async()=>{if(++reads===1)s.storageAckStamp(key).version++;return payload();}},requestJson:()=>{throw Error('Must not need network');}});
 const result=await s.fetchSession(app,conversation);
 assert.equal(reads,2);assert.equal(result.launch.local_session,true);
 assert.equal(s.sessionReadFences.get(result).version,1);
});
test('repeated ACK changes remain a visible failure rather than accepting an unfenced archive',async()=>{
 let reads=0,s;
 s=sessionVM(source,{localSessions:{read:async()=>{reads++;s.storageAckStamp(key).version++;return payload();}}});
 await assert.rejects(s.fetchSession(app,conversation),{code:'HOMER_STALE_STORAGE_READ'});
 assert.equal(reads,2);
});
test('archive belongs to the current account, never a newly logged-in owner',async()=>{
 const s=sessionVM(source,{localSessions:{read:async()=>{s.storageAccountEpoch++;return payload();}}});
 await assert.rejects(s.fetchSession(app,conversation),/会话账号已切换/);
});
