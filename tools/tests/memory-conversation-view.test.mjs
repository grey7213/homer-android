import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationMemoryView} from '../../sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/homerMemoryView.js';

function fixture(){
    let scope={owner:'a',chat:'A'},builds=0,opens=0,released=0,delay;
    const api=createConversationMemoryView({capture:()=>scope,current:s=>s===scope,
        build:async(s,current)=>{builds++;if(delay)await delay;return {scope:s,open:()=>{assert.ok(current());opens++;}};},
        release:()=>released++});
    return {api,get builds(){return builds;},get opens(){return opens;},get released(){return released;},
        switch(){scope={owner:'a',chat:'B'};},hold(){delay=new Promise(resolve=>{this.resume=resolve;});}};
}
test('prepared first open and 20 reopens use exactly one real view',async()=>{const f=fixture();await f.api.prepare();for(let i=0;i<20;i++)await f.api.open();assert.equal(f.builds,1);assert.equal(f.opens,20);});
test('concurrent preparation is single flight',async()=>{const f=fixture();await Promise.all([f.api.prepare(),f.api.prepare(),f.api.open()]);assert.equal(f.builds,1);assert.equal(f.opens,1);});
test('scope change retires the old view and rebinds one fresh instance',async()=>{const f=fixture();await f.api.open();f.switch();await f.api.open();assert.equal(f.builds,2);assert.equal(f.released,1);assert.equal(f.opens,2);});
test('a cancelled first opening never displays a late modal',async()=>{const f=fixture();f.hold();const c=new AbortController();const work=f.api.open({signal:c.signal});await Promise.resolve();c.abort();f.resume();await work;assert.equal(f.opens,0);await f.api.open();assert.equal(f.opens,1);assert.equal(f.builds,1);});
test('old work cannot display after account/scope invalidation, including ABA',async()=>{const f=fixture();f.hold();const work=f.api.open();await Promise.resolve();f.api.invalidate();f.resume();await work;assert.equal(f.opens,0);assert.equal(f.released,1);await f.api.open();assert.equal(f.builds,2);});
test('failed construction is visible and can be retried',async()=>{let broken=true;const api=createConversationMemoryView({capture:()=>true,current:()=>true,release:()=>{},build:()=>{if(broken)throw Error('synthetic');return {open:()=>42};}});await assert.rejects(api.open(),/synthetic/);broken=false;assert.equal(await api.open(),42);});
