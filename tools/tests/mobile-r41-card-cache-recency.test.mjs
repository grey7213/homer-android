import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCardTransportCache, clearCardTransportMemory, CARD_TRANSPORT_TTL_MS,
    CARD_TRANSPORT_MAX_ROWS, CARD_TRANSPORT_MAX_BYTES } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';
import { createCardTransport } from '../../sillytavern-runtime/public/scripts/homer-card-transport.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const turn = () => new Promise(resolve => setImmediate(resolve));
test.beforeEach(() => clearCardTransportMemory());
test.afterEach(() => clearCardTransportMemory());
function fixture() {
    const indexedDB=cardTransportIDB(),databaseName='synthetic-recency';let clock=100;
    const cache=createCardTransportCache({indexedDB,databaseName,now:()=>clock});
    const payload=id=>({name:'Synthetic '+id,data:{name:'Synthetic '+id},unknown:{complete:true}});
    const write=async(id,value=payload(id))=>cache.write('owner','session-card',id,hash(value),value);
    const read=id=>cache.read('owner','session-card',id,{allowVerifiedMemory:true,allowExpiredCandidate:true});
    const touch=(id,row,options)=>cache.touch('owner','session-card',id,row,options);
    const metadata=()=>indexedDB.dump(databaseName,'metadata');
    return {indexedDB,databaseName,cache,payload,write,read,touch,metadata,
        tick(amount=1){clock+=amount;},get clock(){return clock;}};
}
async function fill(h) {for(let i=0;i<CARD_TRANSPORT_MAX_ROWS;i++){h.tick();await h.write(String(i));}}

test('fresh confirmed frequent old source survives insertion without increasing eight-row or byte limits', async()=>{
    const h=fixture();await fill(h);const oldMeta=h.metadata().find(row=>row.id==='0');
    const row=await h.read('0');h.tick(100);h.indexedDB.trace.length=0;
    assert.equal(h.touch('0',row,{isCurrent:()=>true}),true);
    assert.deepEqual(h.indexedDB.trace,[],'touch itself has no synchronous IDB or full source IO');
    // Insert before deferred touch flush: pending verified recency participates
    // in pruning, without delaying the foreground write or extending TTL.
    h.tick();await h.write('new');
    assert.ok(await h.read('0'));assert.equal(await h.read('1'),null);
    const records=h.metadata();assert.equal(records.length,CARD_TRANSPORT_MAX_ROWS);
    assert.ok(records.reduce((sum,value)=>sum+value.bytes,0)<=CARD_TRANSPORT_MAX_BYTES);
    const kept=records.find(value=>value.id==='0');
    assert.equal(kept.expiresAt,oldMeta.expiresAt);assert.equal(kept.lastStoredAt,oldMeta.lastStoredAt);
});

test('confirmed uses coalesce into one metadata-only durable update, and TTL/default reads remain unchanged', async()=>{
    const h=fixture();await h.write('a');const baseline=h.metadata()[0],row=await h.read('a');
    h.tick(10);h.indexedDB.trace.length=0;assert.equal(h.touch('a',row),true);
    h.tick(10);assert.equal(h.touch('a',row),true);h.tick(10);assert.equal(h.touch('a',row),true);
    assert.deepEqual(h.indexedDB.trace,[]);await wait(140);await turn();
    const updated=h.metadata()[0];assert.equal(updated.lastUsedAt,h.clock);
    assert.equal(updated.expiresAt,baseline.expiresAt);assert.equal(updated.lastStoredAt,baseline.lastStoredAt);
    const tx=h.indexedDB.trace.filter(value=>value.event==='transaction');assert.equal(tx.length,1);
    assert.deepEqual(tx[0].stores,['metadata']);
    assert.deepEqual(h.indexedDB.trace.filter(value=>value.operation).map(value=>[value.store,value.operation]),[['metadata','get'],['metadata','put']]);
    h.tick(CARD_TRANSPORT_TTL_MS);assert.equal(await h.cache.read('owner','session-card','a'),null);
    assert.ok(await h.read('a'),'age is still only an online revalidation candidate');
});

test('default source reads, metadata hints and copied/fabricated tickets cannot record a successful online use', async()=>{
    const h=fixture();await h.write('a');const row=await h.read('a'),baseline=h.metadata()[0];h.tick(50);
    assert.equal(h.touch('a',{...row}),false);assert.equal(h.touch('other',row),false);
    assert.equal(h.touch('a',row,{isCurrent:()=>false}),false);
    await h.cache.read('owner','session-card','a');await wait(140);
    assert.deepEqual(h.metadata()[0],baseline);
});

test('logout/clear and changed scope discard queued confirmed touches without resurrecting metadata', async()=>{
    for(const action of ['clear','guard','delete','owner-clear']){
        const h=fixture();await h.write('a');const row=await h.read('a'),baseline=h.metadata()[0];let current=true;h.tick(30);
        h.touch('a',row,{isCurrent:()=>current});
        if(action==='clear')clearCardTransportMemory();
        if(action==='guard')current=false;
        if(action==='delete')await h.cache.remove('owner','session-card','a');
        if(action==='owner-clear')await h.cache.clearOwner('owner');
        await wait(140);
        if(['delete','owner-clear'].includes(action))assert.equal(h.metadata().length,0);
        else assert.deepEqual(h.metadata()[0],baseline);
        clearCardTransportMemory();
    }
});

test('queued old-version touch never overwrites a replacement or restores deleted metadata', async()=>{
    const h=fixture();await h.write('a');const row=await h.read('a');h.tick(40);h.touch('a',row);
    h.tick(20);const changed=h.payload('changed');await h.write('a',changed);const replacement=h.metadata()[0];
    await wait(140);assert.deepEqual(h.metadata()[0],replacement);assert.deepEqual((await h.read('a')).payload,changed);
    const foreign=factory=>createCardTransportCache({indexedDB:factory,databaseName:h.databaseName,now:()=>h.clock});
    const freshRow=await h.read('a');h.tick(20);h.touch('a',freshRow);
    // Another instance changes the current marker; a delayed flush must not
    // recreate the old marker or move its source's verified-use time forward.
    await foreign(h.indexedDB).remove('owner','session-card','a');await wait(140);assert.equal(h.metadata().length,0);
});

test('clear aborts an in-flight metadata touch transaction before a late commit', async()=>{
    const h=fixture();await h.write('a');const row=await h.read('a'),baseline=h.metadata()[0],gate=h.indexedDB.holdNextCommit('readwrite');
    h.tick(30);h.touch('a',row);await gate.reached;clearCardTransportMemory();gate.release();await turn();await turn();
    assert.deepEqual(h.metadata()[0],baseline);assert.ok(h.indexedDB.trace.some(value=>value.event==='transaction-abort'));
});

test('global coalesced queue is bounded and does not pin more than the existing eight-source capacity', async()=>{
    const all=[];
    for(let i=0;i<CARD_TRANSPORT_MAX_ROWS+3;i++){
        const h=fixture();await h.write('a');const row=await h.read('a');h.tick(30);h.indexedDB.trace.length=0;h.touch('a',row);all.push(h);
    }
    await wait(1050);await turn();
    assert.equal(all.filter(h=>h.metadata()[0].lastUsedAt===h.clock).length,CARD_TRANSPORT_MAX_ROWS);
    assert.ok(all.every(h=>h.indexedDB.trace.every(value=>!value.store||value.store==='metadata')));
});

test('transport confirms use only after authenticated SHA-matched success, never after HTTP/scope/revision failures', async()=>{
    const h=fixture();await h.write('a');const initial=h.metadata()[0],api=createCardTransport({storage:h.cache,now:()=>h.clock});h.tick(30);
    const reply=()=>({user:{id:'owner'},launch:{app_id:'a',conversation_id:'chat',bridge_token:'synthetic-only',card_transport:{version:1,sha256:hash(h.payload('a'))}}});
    const run=request=>api.session('/synthetic-session',{owner:'owner',appId:'a',conversationId:'chat',request,validate(){},isCurrent:()=>true});
    await assert.rejects(run(async()=>{throw Error('Synthetic 401');}),/401/);await wait(140);assert.deepEqual(h.metadata()[0],initial);
    await assert.rejects(run(async()=>({...reply(),user:{id:'other'}})),/账号或角色/);await wait(140);assert.deepEqual(h.metadata()[0],initial);
    h.indexedDB.trace.length=0;assert.deepEqual((await run(async()=>reply())).launch.card,h.payload('a'));assert.deepEqual(h.indexedDB.trace,[]);
    await wait(140);assert.equal(h.metadata()[0].lastUsedAt,h.clock);
});

test('legacy metadata without lastUsedAt stays compatible; future recency cannot prevent oldest-source eviction', async()=>{
    const h=fixture();await fill(h);const rows=h.metadata();
    for(const row of rows){delete row.lastUsedAt;if(row.id==='0')row.lastUsedAt=h.clock+10000;h.indexedDB.seed(h.databaseName,'metadata',row.key,row);}
    assert.ok(await h.cache.read('owner','session-card','2',{allowExpiredCandidate:true}));
    h.tick();await h.write('new');assert.equal(await h.read('0'),null);assert.equal(h.metadata().length,CARD_TRANSPORT_MAX_ROWS);
});
