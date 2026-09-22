// Actual Android persistent-page navigation, with its existing real login.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const pkg=process.env.HOMER_ACCEPTANCE_PACKAGE || 'org.nebula.horizon.composeai.uireview';
const base=(process.env.HOMER_ACCEPTANCE_BASE || 'http://172.24.5.154:8080').replace(/\/$/,'');
const device=process.env.HOMER_ACCEPTANCE_DEVICE || 'emulator-5554';
const adb=(...args)=>execFileSync('D:/Android/Sdk/platform-tools/adb.exe',['-s',device,...args],{encoding:'utf8'}).trim();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let ws,seq=0,stage='start';const pending=new Map();
async function connect(path){
 ws?.close();let target;
 for(let i=0;i<70&&!target;i++){
  let pid='';try{pid=adb('shell','pidof',pkg);}catch{}if(pid)adb('forward','tcp:18225','localabstract:webview_devtools_remote_'+pid);
  try{target=(await(await fetch('http://127.0.0.1:18225/json/list')).json()).find(t=>t.url.startsWith(base+path));}catch{}
  if(!target)await pause(200);
 }
 if(!target)throw Error('Missing expected Android page '+path);
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
}
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},20000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(Error(m.error.message)):resolve(m.result)});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || 'Device evaluation failed');return r.result?.value;};
async function wait(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(150);}throw Error('State did not become ready: '+expression);}
async function touch(selector){const pt=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[pt]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
(async()=>{
 try{
  await connect('/app/');
  stage='open history';
  // A web location assignment invokes Android's navigation override (unlike Page.navigate).
  await evaluate(`setTimeout(()=>location.assign('/app/histories.html'),0);true`);await connect('/app/histories.html');
  await wait(`document.readyState==='complete'&&document.querySelector('.history-row__main')?.offsetWidth>0`);
  await pause(250);
  adb('shell','am','force-stop',pkg);adb('shell','am','start','-n',pkg+'/org.nebula.horizon.composeai.ctf.HomerActivity');
  stage='restore history';
  await connect('/app/histories.html');await wait(`document.querySelector('.history-row__main')?.offsetWidth>0`);
  await connect('/app/chat.html?prewarm=1');
  stage='prepare empty engine';
  await wait(`!!document.querySelector('#dialogue-frame')?.contentWindow.HomerMemoryBooks`);
  await evaluate(`document.querySelector('#dialogue-frame').contentWindow.__r24NativePrepared=true`);
  const state=await evaluate(`(()=>{const w=document.querySelector('#dialogue-frame').contentWindow;return {messages:w.SillyTavern.getContext().chat.length,hasCharacter:w.SillyTavern.getContext().characterId!=null,hasLaunch:w.performance.getEntriesByName('homer-bootstrap-start').length>0,marks:w.performance.getEntriesByType('mark').map(m=>({name:m.name,ms:Math.round(m.startTime)}))}})()`);
  if(state.hasCharacter||state.hasLaunch)throw Error('Preparation opened a card');
  await connect('/app/histories.html');const clicked=Date.now();await touch('.history-row__main');
  stage='bind history';
  await connect('/app/chat.html');
  await wait(`document.querySelector('#preview-settings')?.offsetWidth>0 || document.body.classList.contains('is-ready')`);
  const opened=await evaluate(`(async()=>{
   const start=performance.now(),f=document.querySelector('#dialogue-frame'),w=f.contentWindow,d=w.document;
   return new Promise((resolve,reject)=>{
    const observer=new MutationObserver(()=>{const home=d.querySelector('.stmb-popup[open] .homer-memory-home');if(home?.offsetWidth){clearTimeout(timer);observer.disconnect();resolve({openMs:Math.round(performance.now()-start),retained:w.__r24NativePrepared===true,messages:d.querySelectorAll('#chat .mes').length})}});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('Memory unavailable'))},10000);
    observer.observe(d,{subtree:true,attributes:true,childList:true});
    if(document.body.classList.contains('is-ready'))d.querySelector('#homer-open-memory-books').click();
    else {document.querySelector('#preview-settings').click();document.querySelector('[data-runtime-section=memory]').click();}
   });
  })()`);
  if(!opened.retained||!opened.messages)throw Error('Memory did not retain the prepared real runtime');
  const marks=await evaluate(`(()=>{const w=document.querySelector('#dialogue-frame')?.contentWindow;return w?.performance.getEntriesByType('mark').map(m=>({name:m.name,ms:Math.round(m.startTime)}))||[]})()`);
  const result={preparedWithoutCard:state,historyTouchToMemoryMs:Date.now()-clicked,memory:opened,marks};
  fs.mkdirSync('output/connectivity-r24',{recursive:true});fs.writeFileSync('output/connectivity-r24/native-prepared.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{ws?.close()}
})().catch(e=>{console.error(stage+': '+e.message);process.exitCode=1});
