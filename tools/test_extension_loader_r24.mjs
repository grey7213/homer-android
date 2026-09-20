import assert from 'node:assert/strict';
import { loadExtensionAsset } from '../sillytavern-runtime/public/scripts/extension-asset-loader.js';
function fixture() {
 const elements=new Map();let appended=0;
 const document={getElementById:id=>elements.get(id),createElement:()=>{
  const e=new EventTarget();e.dataset={};e.remove=()=>elements.delete(e.id);return e;
 }};
 document.head=document.body={appendChild:e=>{appended++;elements.set(e.id,e);}};
 return {document,elements,count:()=>appended};
}
for(const kind of ['script','style']){
 const f=fixture(),args={document:f.document,id:'extension-'+kind,url:'/test.js',kind};
 const first=loadExtensionAsset(args),second=loadExtensionAsset(args);
 assert.equal(first,second);assert.equal(f.count(),1);
 f.elements.get(args.id).dispatchEvent(new Event('load'));
 await Promise.all([first,second,loadExtensionAsset(args)]);assert.equal(f.count(),1);
 const failed=loadExtensionAsset({...args,id:'retry'});
 f.elements.get('retry').dispatchEvent(new Event('error'));await assert.rejects(failed);
 const retry=loadExtensionAsset({...args,id:'retry'});
 assert.equal(f.count(),3);f.elements.get('retry').dispatchEvent(new Event('load'));await retry;
}
console.log('PASS: concurrent/repeated/failed-retry script and style loads');
