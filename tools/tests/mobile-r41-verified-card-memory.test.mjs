import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCardTransportCache, clearCardTransportMemory, CARD_TRANSPORT_MAX_ROWS, CARD_TRANSPORT_MAX_BYTES,
    CARD_TRANSPORT_TTL_MS } from '../../sillytavern-runtime/public/scripts/homer-card-transport-cache.mjs';
import { createCardTransport } from '../../sillytavern-runtime/public/scripts/homer-card-transport.mjs';
import { cardTransportIDB } from './helpers/card-transport-idb.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const turn = () => new Promise(resolve => setImmediate(resolve));
test.beforeEach(() => clearCardTransportMemory());
const card = () => ({ spec: 'chara_card_v2', data: { name: 'Synthetic complete source', description: 'text 😀\ud800',
    character_book: { entries: [{ keys: ['fixture'], content: 'complete world', unknown: [true, null] }] },
    extensions: { regex_scripts: [{ findRegex: '/fixture/g', replaceString: '<div>full source</div>' }],
        tavern_helper: { scripts: [{ content: 'synthetic complete script' }] } } }, future: { unknown: [1, 'intact'] } });

function fixture() {
    const indexedDB = cardTransportIDB(), databaseName = 'synthetic-private-memory'; let clock = 100;
    const create = () => createCardTransportCache({ indexedDB, databaseName, now: () => clock });
    const cache = create();
    return { indexedDB, databaseName, cache, create, tick(amount = 1) { clock += amount; },
        rows: (store = 'entries') => indexedDB.dump(databaseName, store),
        get clock() { return clock; },
        write: (id = 'card', value = card(), owner = 'owner-a', kind = 'session-card', instance = cache) => instance.write(owner, kind, id, digest(value), value),
        read: (id = 'card', options, owner = 'owner-a', kind = 'session-card', instance = cache) => instance.read(owner, kind, id, options),
        hot: (id = 'card', options, owner = 'owner-a', kind = 'session-card', instance = cache) =>
            instance.read(owner, kind, id, { allowVerifiedMemory: true, ...options }),
        alter(store, change) { const row = indexedDB.dump(databaseName, store)[0]; change(row); indexedDB.seed(databaseName, store, row.key, row); },
    };
}

async function withDigestCounter(action) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let count = 0, pendingGate;
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: {
            async digest(_algorithm, bytes) {
                count++;
                if (pendingGate) { const gate = pendingGate; pendingGate = null; gate.reached(); await gate.promise; }
                return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
            },
        } } });
        await action({ get count() { return count; }, hold() {
            let reached, release;
            const reachedPromise = new Promise(resolve => { reached = resolve; });
            const promise = new Promise(resolve => { release = resolve; });
            pendingGate = { reached, promise };
            return { reached: reachedPromise, release };
        } });
    } finally {
        if (original) Object.defineProperty(globalThis, 'crypto', original);
        else delete globalThis.crypto;
    }
}

test('a captured, fully SHA-verified committed write supplies a private memo without repeating the read digest', async () => {
    await withDigestCounter(async meter => {
        const h = fixture(), input = card(); const work = h.write('card', input); input.data.name = 'caller changed'; await work;
        assert.equal(meter.count, 1);
        h.indexedDB.trace.length = 0;
        const first = await h.hot(); assert.deepEqual(first.payload, card()); assert.equal(meter.count, 1);
        first.payload.data.name = 'returned object changed'; first.payload.data.character_book.entries[0].content = 'changed';
        assert.deepEqual((await h.hot()).payload, card()); assert.equal(meter.count, 1);
        assert.deepEqual(h.indexedDB.trace, [], 'actual memory hits do not open/read/write IndexedDB');
        assert.equal(first.requiresOnlineConfirmation, true);
    });
});

test('default reads always verify full IDB; a new instance shares only explicit verified memory opt-in', async () => {
    await withDigestCounter(async meter => {
        const h = fixture(); await h.write(); const fresh = h.create(), before = meter.count;
        const initial = await h.read('card', undefined, 'owner-a', 'session-card', fresh);
        assert.equal(meter.count, before + 1); initial.payload.future.unknown[0] = 999;
        h.indexedDB.trace.length = 0;
        const subsequent = await h.hot('card', undefined, 'owner-a', 'session-card', fresh);
        assert.deepEqual(subsequent.payload, card()); assert.equal(meter.count, before + 1);
        assert.deepEqual(h.indexedDB.trace, []);
        await h.read('card', undefined, 'owner-a', 'session-card', fresh);
        assert.equal(meter.count, before + 2);
    });
});

test('memory never aliases owner, kind or ID; changing stable source statistics stays outside this layer', async () => {
    await withDigestCounter(async meter => {
        const h = fixture(); await h.write(); await h.write('card', { name: 'Other owner' }, 'owner-b');
        const stable = { name: 'Stable', avatar: 'fixture.png', data: { name: 'Stable' } };
        await h.write('card', stable, 'owner-a', 'character-content-v2');
        assert.equal((await h.hot()).payload.data.name, card().data.name);
        assert.equal((await h.hot('card', undefined, 'owner-b')).payload.name, 'Other owner');
        assert.deepEqual((await h.hot('card', undefined, 'owner-a', 'character-content-v2')).payload, stable);
        assert.equal(await h.read('other'), null);
        const old = { ...stable, chat_size: 1, date_last_chat: 100 };
        await h.write('legacy', old, 'owner-a', 'character-mirror');
        let before = meter.count; await h.hot('legacy', undefined, 'owner-a', 'character-mirror');
        await h.hot('legacy', undefined, 'owner-a', 'character-mirror'); assert.equal(meter.count, before + 2);
        await h.write('stat-shaped', old, 'owner-a', 'character-content-v2');
        before = meter.count; await h.hot('stat-shaped', undefined, 'owner-a', 'character-content-v2');
        await h.hot('stat-shaped', undefined, 'owner-a', 'character-content-v2'); assert.equal(meter.count, before + 2);
        for (const value of ['token', 'session', 'messages', 'bridge_token']) {
            const body = { ...card(), [value]: 'synthetic only' };
            await assert.rejects(h.cache.write('owner-a', 'session-card', value, digest(body), body), TypeError);
        }
    });
});

test('same metadata and revision cannot hide any full-source modification, including object field order', async () => {
    await withDigestCounter(async meter => {
        for (const change of [row => { row.payload.data.character_book.entries[0].content = 'changed world'; },
            row => { row.payload.data.extensions.regex_scripts[0].replaceString = '<div>changed source</div>'; },
            row => { row.payload.future.unknown[1] = 'changed unknown'; },
            row => { row.payload = { future: row.payload.future, data: row.payload.data, spec: row.payload.spec }; }]) {
            const h = fixture(); await h.write(); const before = meter.count; h.alter('entries', change);
            assert.equal(await h.read(), null); assert.equal(meter.count, before + 1);
            await turn(); await turn();
        }
    });
});

test('external replacement, clear and orphan-body metadata never restore or overwrite an old memory source', async () => {
    await withDigestCounter(async meter => {
        const h = fixture(); await h.write(); const external = h.create(), next = card(); next.future.unknown[1] = 'external new revision';
        await h.write('card', next, 'owner-a', 'session-card', external);
        let before = meter.count;
        assert.deepEqual((await h.read()).payload, next); assert.equal(meter.count, before + 1);
        assert.equal(h.rows()[0].revision, digest(next));
        h.indexedDB.trace.length = 0; assert.deepEqual((await h.read()).payload, next);
        assert.ok(!h.indexedDB.trace.some(row => row.operation === 'put'));
        await external.remove('owner-a', 'session-card', 'card'); assert.equal(await h.read(), null);
        await h.write(); h.indexedDB.database(h.databaseName).stores.get('entries').rows.clear();
        assert.equal(await h.read(), null);
        await h.write(); await external.clearOwner('owner-a'); assert.equal(await h.read(), null);
    });
});

test('expired memory retains the original default miss and explicit current-online-confirmation candidate labels', async () => {
    await withDigestCounter(async meter => {
        const h = fixture(); await h.write(); const before = meter.count; h.tick(CARD_TRANSPORT_TTL_MS);
        assert.equal(await h.read(), null);
        const row = await h.read('card', { allowExpiredCandidate: true });
        assert.deepEqual(row.payload, card()); assert.equal(row.requiresOnlineConfirmation, true);
        assert.equal(row.owner, 'owner-a'); assert.equal(row.kind, 'session-card'); assert.equal(row.id, 'card');
        // A default expired miss may release this disposable memory copy. It
        // does not delete intact IDB bytes or alter the candidate contract.
        assert.ok(meter.count <= before + 1);
        const api = createCardTransport({ storage: h.cache, now: () => h.clock }); let requests = 0;
        const run = request => api.session('/synthetic-session', { owner: 'owner-a', appId: 'card', conversationId: 'chat',
            validate() {}, isCurrent: () => true, request });
        await assert.rejects(run(async () => { requests++; throw Error('Synthetic 401'); }), /401/);
        assert.equal(requests, 1);
        const value = await run(async () => { requests++; return { user: { id: 'owner-a' }, launch: {
            app_id: 'card', conversation_id: 'chat', bridge_token: 'synthetic-only',
            card_transport: { version: 1, sha256: digest(card()) }, messages: [{ content: 'fresh messages' }] } }; });
        assert.deepEqual(value.launch.card, card()); assert.equal(value.launch.messages[0].content, 'fresh messages');
        assert.equal(requests, 2);
    });
});

test('corrupt metadata bytes and future times cannot create memory verification evidence', async () => {
    await withDigestCounter(async meter => {
        for (const change of [meta => { meta.bytes = -1; }, meta => { meta.expiresAt++; meta.lastStoredAt++; },
            meta => { meta.entryId = 'changed'; }, meta => { meta.owner = 'other'; }]) {
            const h = fixture(); await h.write(); h.alter('metadata', change); assert.equal(await h.read(), null);
        }
        const h = fixture(); await h.write(); const fresh = h.create(); h.alter('metadata', meta => { meta.bytes = 1; });
        const before = meter.count;
        // Preserve the existing durable read behavior, but a false byte count
        // cannot admit a memo which under-reports its real memory footprint.
        assert.ok(await h.read('card', undefined, 'owner-a', 'session-card', fresh));
        assert.ok(await h.read('card', undefined, 'owner-a', 'session-card', fresh));
        assert.equal(meter.count, before + 2);
    });
});

test('a transaction abort never admits captured write bytes, and failed writes cannot replace valid durable source', async () => {
    await withDigestCounter(async meter => {
        const h = fixture(), gate = h.indexedDB.holdNextCommit('readwrite');
        const writing = h.write(); const tx = await gate.reached; tx.abort(); gate.release();
        await assert.rejects(writing, /aborted/); assert.equal(await h.read(), null);
        await h.write(); const changed = card(); changed.data.description = 'failed change'; h.indexedDB.failNextPut = true;
        await assert.rejects(h.write('card', changed), /quota/);
        const before = meter.count; assert.deepEqual((await h.read()).payload, card()); assert.equal(meter.count, before + 1);
    });
});

test('clear during an in-flight read cannot repopulate memory after the clear or restore IDB data', async () => {
    await withDigestCounter(async meter => {
        const h = fixture(); await h.write(); const fresh = h.create(), gate = meter.hold();
        const reading = h.read('card', undefined, 'owner-a', 'session-card', fresh); await gate.reached;
        await fresh.clearOwner('owner-a'); gate.release(); await reading;
        assert.equal(await h.read('card', undefined, 'owner-a', 'session-card', fresh), null);
        assert.equal(h.rows().length, 0);
    });
});

test('an in-flight old snapshot never overwrites the newer IDB version or its verified memory', async () => {
    await withDigestCounter(async meter => {
        const h = fixture(); await h.write(); const fresh = h.create(), gate = meter.hold();
        const reading = h.read('card', undefined, 'owner-a', 'session-card', fresh); await gate.reached;
        const next = card(); next.data.description = 'new external version'; await h.write('card', next);
        gate.release(); await reading;
        assert.deepEqual((await h.read('card', undefined, 'owner-a', 'session-card', fresh)).payload, next);
        assert.equal(h.rows()[0].revision, digest(next));
    });
});

test('in-memory LRU is independently bounded to eight sources and actual complete 32MiB UTF8 bytes', async () => {
    await withDigestCounter(async meter => {
        const h = fixture();
        for (let i = 0; i < CARD_TRANSPORT_MAX_ROWS; i++) { h.tick(); await h.write(String(i)); }
        // Touching only memory cannot renew durable last-stored age. A new
        // external cache write evicts the durable oldest and causes a miss.
        await h.read('0'); const external = h.create(); h.tick(); await h.write('new', card(), 'owner-a', 'session-card', external);
        assert.equal(await h.read('0'), null);
        const large = { name: 'Synthetic UTF8 source', description: '字'.repeat(3 * 1024 * 1024) };
        for (let i = 0; i < 4; i++) { h.tick(); await h.write('big-' + i, large); }
        assert.equal(await h.read('big-0'), null);
        assert.ok(h.rows('metadata').reduce((sum, row) => sum + row.bytes, 0) <= CARD_TRANSPORT_MAX_BYTES);
        const before = meter.count; assert.ok(await h.hot('big-3')); assert.equal(meter.count, before);
        assert.equal(await h.write('oversize', { name: 'Synthetic oversize', description: 'x'.repeat(CARD_TRANSPORT_MAX_BYTES) }), false);
        assert.equal(await h.read('oversize'), null);
    });
});

test('legacy WebViews without structuredClone retain clone isolation on verified cold admission', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    const h = fixture(); await h.write(); const fresh = h.create();
    // The IDB double needs structuredClone itself; only replace it while the
    // actual admission helper runs, using a throwing clone implementation.
    let calls = 0;
    const fallback = value => JSON.parse(JSON.stringify(value));
    try {
        Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value(value) {
            calls++; if (value?.spec === 'chara_card_v2') throw Error('Synthetic unavailable clone'); return fallback(value);
        } });
        const first = await h.read('card', undefined, 'owner-a', 'session-card', fresh);
        first.payload.future.unknown[0] = 100;
        assert.deepEqual((await h.hot('card', undefined, 'owner-a', 'session-card', fresh)).payload, card()); assert.ok(calls > 0);
    } finally { Object.defineProperty(globalThis, 'structuredClone', original); }
});

test('database name and IndexedDB factory identity isolate otherwise identical scopes', async () => {
    await withDigestCounter(async meter => {
        const h=fixture(), otherDb=createCardTransportCache({indexedDB:h.indexedDB,databaseName:'other-database',now:()=>100});
        await h.write(); const other={name:'Different database'};
        await otherDb.write('owner-a','session-card','card',digest(other),other);
        const otherFactory=fixture(), third={name:'Different factory'}; await otherFactory.write('card',third);
        const before=meter.count; h.indexedDB.trace.length=0; otherFactory.indexedDB.trace.length=0;
        assert.deepEqual((await h.hot()).payload,card());
        assert.deepEqual((await otherDb.read('owner-a','session-card','card',{allowVerifiedMemory:true})).payload,other);
        assert.deepEqual((await otherFactory.hot()).payload,third);
        assert.equal(meter.count,before); assert.deepEqual(h.indexedDB.trace,[]); assert.deepEqual(otherFactory.indexedDB.trace,[]);
    });
});

test('unrelated simultaneous session and mirror writes both admit verified memory', async () => {
    await withDigestCounter(async meter => {
        const h=fixture(), gate=meter.hold();
        const first=h.write(); await gate.reached;
        const mirror={name:'Synthetic mirror',avatar:'fixture.png',data:{name:'Synthetic mirror'},json_data:'complete synthetic data'};
        await h.write('fixture.png',mirror,'owner-a','character-content-v2');
        gate.release(); await first;
        const before=meter.count; h.indexedDB.trace.length=0;
        assert.deepEqual((await h.hot()).payload,card());
        assert.deepEqual((await h.hot('fixture.png',undefined,'owner-a','character-content-v2')).payload,mirror);
        assert.equal(meter.count,before); assert.deepEqual(h.indexedDB.trace,[]);
    });
});

test('a late older same-key write cannot replace the newer verified memory source', async () => {
    await withDigestCounter(async meter => {
        const h=fixture(), gate=meter.hold(), old=card(), newer=card(); newer.future.unknown[1]='newer source';
        const delayed=h.write('card',old); await gate.reached; await h.write('card',newer);
        gate.release(); await delayed;
        const before=meter.count; h.indexedDB.trace.length=0;
        assert.deepEqual((await h.hot()).payload,newer); assert.equal(meter.count,before); assert.deepEqual(h.indexedDB.trace,[]);
        // Durable writes retain their original ordering contract; the memory
        // candidate is still usable only if the online server confirms SHA.
        assert.equal(h.rows()[0].revision,digest(old));
    });
});

test('explicit clear fences a late write, while owner-only clearing preserves other owners and durable source', async () => {
    await withDigestCounter(async meter => {
        const h=fixture(); await h.write(); await h.write('card',{name:'Other owner'},'owner-b');
        clearCardTransportMemory('owner-a'); let before=meter.count;
        h.indexedDB.trace.length=0; assert.equal((await h.hot('card',undefined,'owner-b')).payload.name,'Other owner');
        assert.equal(meter.count,before); assert.deepEqual(h.indexedDB.trace,[]);
        assert.deepEqual((await h.hot()).payload,card()); assert.equal(meter.count,before+1);
        const gate=meter.hold(), delayed=h.write('late'); await gate.reached;
        clearCardTransportMemory(); gate.release(); await delayed;
        before=meter.count; h.indexedDB.trace.length=0;
        assert.deepEqual((await h.hot('late')).payload,card()); assert.equal(meter.count,before+1);
        assert.equal(h.indexedDB.trace.filter(row=>row.operation==='get').length,2);
        assert.equal(h.rows().length,3);
    });
});

test('global LRU budget spans factories and databases, not eight entries for each cache instance', async () => {
    await withDigestCounter(async meter => {
        const fixtures=[];
        for(let i=0;i<CARD_TRANSPORT_MAX_ROWS+1;i++){const h=fixture(); await h.write(); fixtures.push(h);}
        let before=meter.count; fixtures.at(-1).indexedDB.trace.length=0;
        assert.ok(await fixtures.at(-1).hot()); assert.equal(meter.count,before); assert.deepEqual(fixtures.at(-1).indexedDB.trace,[]);
        before=meter.count; assert.ok(await fixtures[0].hot()); assert.equal(meter.count,before+1);
        assert.equal(fixtures[0].rows().length,1,'memory eviction does not erase durable source in another database');
    });
});

test('clear during cloning or revision callback never resurrects an invalidated memory entry', async () => {
    await withDigestCounter(async meter => {
        const h=fixture(); await h.write(); const before=meter.count;
        assert.equal(await h.hot('card',{onRevision(){clearCardTransportMemory();}}),null);
        assert.equal(meter.count,before); assert.deepEqual((await h.hot()).payload,card()); assert.equal(meter.count,before+1);
        const original=Object.getOwnPropertyDescriptor(globalThis,'structuredClone'); let cleared=false;
        try {
            Object.defineProperty(globalThis,'structuredClone',{configurable:true,value(value){
                if(!cleared && value?.spec==='chara_card_v2'){cleared=true;clearCardTransportMemory();}
                return original.value(value);
            }});
            assert.equal(await h.hot(),null,'a clone interrupted by clear cannot return that invalidated L1 result'); assert.ok(cleared);
        } finally {Object.defineProperty(globalThis,'structuredClone',original);}
        const after=meter.count; assert.deepEqual((await h.hot()).payload,card()); assert.equal(meter.count,after+1,'late verification cannot admit after clear');
    });
});

const onlineSession = (source=card(),overrides={}) => ({user:{id:'owner-a'},launch:{app_id:'card',conversation_id:'chat',
    bridge_token:'synthetic-only',card_transport:{version:1,sha256:digest(source)},messages:[{content:'fresh synthetic message'}],...overrides}});
const sessionOptions = request => ({owner:'owner-a',appId:'card',conversationId:'chat',isCurrent:()=>true,validate(){},request});

test('transport memory restoration still performs exactly one current authenticated request and uses fresh messages', async () => {
    await withDigestCounter(async meter => {
        const h=fixture(); await h.write(); h.alter('entries',row=>{row.payload.future.unknown[0]=777;});
        const api=createCardTransport({storage:h.cache,now:()=>h.clock}); let calls=0;
        const before=meter.count; h.indexedDB.trace.length=0;
        const value=await api.session('/synthetic-session',sessionOptions(async path=>{
            calls++; assert.equal(new URL(path,'http://fixture').searchParams.get('card_sha256'),digest(card())); return onlineSession();
        }));
        assert.equal(calls,1); assert.deepEqual(value.launch.card,card());
        assert.equal(value.launch.messages[0].content,'fresh synthetic message');
        assert.equal(meter.count,before); assert.deepEqual(h.indexedDB.trace,[]);
        assert.equal(await h.read(),null,'ordinary storage read still detects independently tampered body');
    });
});

test('HTTP/authentication and account epoch failures cannot restore memory or trigger cache retries', async () => {
    await withDigestCounter(async meter => {
        const h=fixture(); await h.write(); const api=createCardTransport({storage:h.cache,now:()=>h.clock});
        const before=meter.count; h.indexedDB.trace.length=0;
        for(const status of [401,403,404,500]){
            let calls=0;
            await assert.rejects(api.session('/synthetic-session',sessionOptions(async()=>{calls++;throw Error('Synthetic '+status);})),new RegExp(String(status)));
            assert.equal(calls,1);
        }
        let current=true, calls=0;
        await assert.rejects(api.session('/synthetic-session',{...sessionOptions(async()=>{calls++;current=false;return onlineSession();}),isCurrent:()=>current}),/账号或会话/);
        assert.equal(calls,1); assert.equal(meter.count,before); assert.deepEqual(h.indexedDB.trace,[]);
        let epoch=0; const captured=epoch;
        await assert.rejects(api.session('/synthetic-session',{...sessionOptions(async()=>{epoch++;epoch++;return onlineSession();}),isCurrent:()=>epoch===captured}),/账号或会话/);
        await assert.rejects(api.session('/synthetic-session',sessionOptions(async()=>({...onlineSession(),user:{id:'owner-b'}}))),/账号或角色/);
    });
});

test('new server revision replaces full source and mirror stats always come from fresh authenticated response', async () => {
    await withDigestCounter(async meter => {
        const h=fixture(); await h.write(); const api=createCardTransport({storage:h.cache,now:()=>h.clock});
        const changed=card(); changed.data.character_book.entries[0].content='new server world'; let calls=0;
        const value=await api.session('/synthetic-session',sessionOptions(async()=>{calls++;return onlineSession(changed,{card:changed});}));
        assert.equal(calls,1); assert.deepEqual(value.launch.card,changed);
        await turn(); await turn(); assert.deepEqual((await h.hot()).payload,changed);
        const mirror={name:'Synthetic mirror',avatar:'fixture.png',data:{name:'Synthetic mirror'},json_data:'complete source',unknown:{all:true}};
        await h.write('fixture.png',mirror,'owner-a','character-content-v2');
        h.indexedDB.trace.length=0; const before=meter.count;
        const result=await api.character('fixture.png',{owner:'owner-a',isCurrent:()=>true,headers:{},fetcher:async(_path,options)=>{
            const request=JSON.parse(options.body); assert.equal(request.card_sha256,digest(mirror));
            return {ok:true,status:200,json:async()=>({homer_character_transport:{version:2,sha256:digest(mirror),not_modified:true},fresh_stats:{chat_size:999,date_last_chat:12345}})};
        }});
        assert.deepEqual(await result.json(),{...mirror,chat_size:999,date_last_chat:12345});
        assert.equal(meter.count,before); assert.deepEqual(h.indexedDB.trace,[]);
        for(const status of [401,403,404,500]){
            let n=0; const response=await api.character('fixture.png',{owner:'owner-a',isCurrent:()=>true,headers:{},fetcher:async()=>{n++;return {ok:false,status};}});
            assert.equal(response.status,status); assert.equal(n,1);
        }
    });
});
