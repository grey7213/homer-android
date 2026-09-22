const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const storage=new Map();global.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};global.window={dispatchEvent(){}};
 const code=fs.readFileSync(require('node:path').join(__dirname,'../frontend/app/assets/js/recommendations.js'),'utf8');
 const r=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const u={id:'synthetic-a'},other={id:'synthetic-b'},items=[{id:'1',tags:['日常']},{id:'2',tags:['奇幻']},{id:'3',tags:['血腥']}];
 assert.deepEqual(r.recommend(u,items),items);r.recordInterest(u,'card',items[1],'view');assert.equal(storage.size,1);assert.equal(r.recommend(u,items)[0].id,'2');
 assert(r.writePreferences(u,{enabled:true,interests:['奇幻'],hiddenTags:['血腥'],signals:[]}));
 assert.deepEqual(r.recommend(u,items).map(x=>x.id),['2','1']);assert.deepEqual(r.recommend(other,items),items);
 r.recordInterest(u,'card',items[0],'view',1000);r.recordInterest(u,'card',items[0],'view',2000);assert.equal(r.readPreferences(u).signals.length,1);
 r.recordInterest(u,'card',items[0],'save',2000);r.recordInterest(u,'card',items[0],'unsave',3000);assert.equal(r.readPreferences(u).signals.length,1);
 const p=r.readPreferences(u);r.writePreferences(u,{...p,enabled:false});assert.deepEqual(r.recommend(u,items),items);r.recordInterest(u,'card',items[1],'view');assert.equal(r.readPreferences(u).signals.length,1);
 r.writePreferences(u,{...p,signals:[]});assert.equal(r.readPreferences(u).signals.length,0);
 assert.equal(r.writePreferences(null,p),false);assert.deepEqual(items.map(x=>x.id),['1','2','3']);
 storage.set('homer.preferences.v1.synthetic-b','broken');assert.equal(r.readPreferences(other).enabled,true);
 const out=r.rankRecommendations(Array.from({length:12},(_,i)=>({id:String(i),tags:i%2?['奇幻']:['日常']})),{...p,hiddenTags:[]});assert.equal(new Set(out.map(x=>x.id)).size,12);
 console.log('Recommendation checks passed: zero-input learning, account isolation, excludes, dedup, undo, reset, explicit opt-out, immutable candidates, corrupt storage, diversity.');
})().catch(e=>{console.error(e);process.exitCode=1;});
