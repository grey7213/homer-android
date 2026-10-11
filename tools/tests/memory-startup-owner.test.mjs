import assert from 'node:assert/strict';
import {test} from 'node:test';
import {installLocalRuntime} from '../../sillytavern-runtime/public/scripts/homer-local-runtime.mjs';
function fixture(){
 let owner='synthetic-owner',release;
 const gate=new Promise(r=>release=r),events=new Map(),target={location:{origin:'https://unit.invalid'},fetch:async()=>new Response('{}'),addEventListener:(k,f)=>events.set(k,f)};
 installLocalRuntime({target,owner:()=>owner,isEmbedded:true,storage:{read:async()=>{await gate;return {data:{version:'fixture'}};},update:async()=>null}});
 return {target,events,release,changeOwner:v=>owner=v,read:()=>target.fetch('/api/settings/get',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})};
}
test('same-owner profile refresh cannot strand the runtime settings read',async()=>{
 const f=fixture(),reading=f.read();await new Promise(r=>setImmediate(r));
 f.events.get('storage')({key:'ai_xingyue_user',oldValue:'old-display',newValue:'new-display'});f.release();
 assert.equal((await reading).status,200);
});
for(const [name,change,event] of [
 ['different account',true,{key:'ai_xingyue_user'}],
 ['logout/relogin',false,{key:'ai_xingyue_logged_in',oldValue:'0',newValue:'1'}],
 ['storage clear',false,{key:null}],
 ['explicit account clear',false,null],
])test(name+' still fences the old read',async()=>{
 const f=fixture(),reading=f.read();await new Promise(r=>setImmediate(r));
 if(change)f.changeOwner('different-owner');
 f.events.get(event?'storage':'homer-account-cleared')(event);f.release();
 await assert.rejects(reading,/账号已切换/);
});
