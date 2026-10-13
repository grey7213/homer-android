import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../frontend/app/assets/js/community-feed.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export function socialPage()','function socialPage()');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture({local=false}={}) {
  const reads=[],calls=[],events=new Map(),uploads=[],state={owner:'A',mode:local,local:local,uploadResult:{url:'https://qa.invalid/photo.png'},init:{id:'video-1',chunk_size:4},final:{url:'https://qa.invalid/movie.mp4'}};
  class Reader{readAsDataURL(file){const gate=deferred();reads.push({gate,file});gate.promise.then(value=>{this.result=value;this.onload();},error=>this.onerror(error));}}
  const scope={JSON,URL,clientId:()=> 'draft-id',location:{origin:'https://qa.invalid',protocol:'https:'},
    window:{addEventListener:(k,fn)=>events.set(k,fn)},getCachedUser:()=>({id:state.owner}),routeLocally:()=>state.mode,localEnabled:()=>state.local,
    FileReader:Reader,renderCommunityText(){},openCommunityUser(){},api:{uploadCover:async(body,name)=>{calls.push(['image',body,name]);const gate=deferred();uploads.push(gate);return gate.promise;}},
    addLocalMedia:async()=>{const gate=deferred();uploads.push(gate);return gate.promise;},
    social:async(path,method,body)=>{calls.push([path,method,body]);if(path==='media/init')return state.init;if(path==='media/finalize')return state.final;return {};},
  };
  vm.createContext(scope);vm.runInContext(source,scope);const page=scope.window.socialPage();page.user={id:'A'};page.localMode=local;page.mediaAvailable=true;page.notify=()=>{};page.detail={id:'post-1'};page.commentClientId='comment-1';
  const image={type:'image/png',size:3,name:'qa.png'},video={type:'video/mp4',size:8,slice:(a,b)=>({a,b})};
  return{state,page,reads,calls,uploads,emit:()=>events.get('homer-account-cleared')(),image:()=>({target:{files:[image],value:'qa'}}),video:()=>({target:{files:[video],value:'qa'}})};
}
test('image read after account switch cannot send any network upload',async()=>{
  const f=fixture(),pending=f.page.uploadImages(f.image());f.state.owner='B';f.reads[0].gate.resolve('data:image/png;base64,AQID');await pending;
  assert.equal(f.calls.length,0);assert.equal(f.page.draft.images.length,0);assert.equal(f.page.uploading,false);
});
test('late uploaded image cannot attach to a new draft or finish its busy state',async()=>{
  const f=fixture(),pending=f.page.uploadImages(f.image());f.reads[0].gate.resolve('data:image/png;base64,AQID');await tick();assert.equal(f.calls.length,1);
  f.page.draft={...f.page.draft,images:[]};f.page.mediaUploadTicket={};f.uploads[0].resolve({url:'https://qa.invalid/late.png'});await pending;
  assert.equal(f.page.draft.images.length,0);assert.equal(f.page.uploading,true);
});
test('logout/login ABA and local/live changes fence pending local media',async()=>{
  for(const change of [f=>{f.emit();f.state.owner='A';},f=>{f.state.mode=false;f.state.local=false;f.page.localMode=false;}]){
    const f=fixture({local:true}),pending=f.page.uploadImages(f.image());change(f);f.uploads[0].resolve('blob:private-old');await pending;
    assert.equal(f.page.draft.images.length,0);assert.equal(f.calls.length,0);assert.equal(f.page.uploading,false);
  }
});
test('late comment image cannot attach to another post or reply identity',async()=>{
  const f=fixture(),pending=f.page.uploadImages(f.image(),true);f.reads[0].gate.resolve('data:image/png;base64,AQID');await tick();
  f.page.detail={id:'post-2'};f.page.commentClientId='comment-2';f.page.commentImages=[];f.uploads[0].resolve({url:'https://qa.invalid/old.png'});await pending;
  assert.equal(f.page.commentImages.length,0);assert.equal(f.page.uploading,false);
});
test('valid image appends once; missing URL is failure, not a bogus /undefined image',async()=>{
  for(const payload of [{url:'https://qa.invalid/photo.png'},{}]){
    const f=fixture(),pending=f.page.uploadImages(f.image());f.reads[0].gate.resolve('data:image/png;base64,AQID');await tick();f.uploads[0].resolve(payload);await pending;
    assert.equal(f.page.draft.images.length,payload.url?1:0);assert.equal(f.page.uploading,false);
    if(!payload.url)assert.match(f.page.editorError,/可用地址/);
  }
});
test('video scope change during file read stops chunks and finalize',async()=>{
  const f=fixture(),pending=f.page.uploadVideo(f.video());await tick();assert.equal(f.reads.length,1);f.emit();f.reads[0].gate.resolve('data:video/mp4;base64,AQID');await pending;
  assert.deepEqual(f.calls.map(c=>c[0]),['media/init']);assert.equal(f.page.draft.video,'');assert.equal(f.page.uploading,false);
});
test('invalid video parameters fail visibly instead of an endless chunk loop',async()=>{
  for(const size of [0,-1,1.5,undefined]){const f=fixture();f.state.init.chunk_size=size;await f.page.uploadVideo(f.video());assert.match(f.page.editorError,/有效/);assert.equal(f.reads.length,0);assert.equal(f.page.uploading,false);}
});
test('successful video consumes actual chunks then one finalized URL',async()=>{
  const f=fixture(),pending=f.page.uploadVideo(f.video());await tick();f.reads[0].gate.resolve('data:video/mp4;base64,AQID');await tick();f.reads[1].gate.resolve('data:video/mp4;base64,BAUG');await pending;
  assert.deepEqual(f.calls.map(c=>c[0]),['media/init','media/chunk','media/chunk','media/finalize']);assert.equal(f.page.draft.video,f.state.final.url);assert.equal(f.page.uploading,false);
});
