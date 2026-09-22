// Native process restart and restored conversation, with real APIs and APK assets.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const adb=(...args)=>execFileSync('D:/Android/Sdk/platform-tools/adb.exe',['-s','emulator-5556',...args],{encoding:'utf8'}).trim();
const pkg='org.nebula.horizon.composeai.uireview';
(async()=>{
 adb('shell','am','force-stop',pkg);const started=Date.now();
 adb('shell','am','start','-n',pkg+'/org.nebula.horizon.composeai.ctf.HomerActivity');
 let target;
 for(let i=0;i<40&&!target;i++){
  await pause(250);const pid=adb('shell','pidof',pkg);if(!pid)continue;
  adb('forward','tcp:18225','localabstract:webview_devtools_remote_'+pid);
  try{target=(await(await fetch('http://127.0.0.1:18225/json/list')).json()).find(t=>t.url.startsWith('http://192.168.1.129:8080/app/chat.html'));}catch{}
 }
 if(!target)throw Error('Native launch did not restore a conversation');
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let seq=0;const pending=new Map(),requests=new Map(),failures=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}else if(m.method==='Network.requestWillBeSent')requests.set(m.params.requestId,new URL(m.params.request.url).pathname);else if(m.method==='Network.loadingFailed'&&m.params.errorText!=='net::ERR_ABORTED')failures.push({path:requests.get(m.params.requestId),error:m.params.errorText});});
 const call=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Device evaluation failed');return r.result?.value;};
 try{
  await call('Network.enable');let ready=false;
  for(let i=0;i<60&&!ready;i++){ready=await evaluate(`document.body.classList.contains('is-ready')&&!!document.querySelector('#dialogue-frame')?.contentWindow.HomerMemoryBooks`);if(!ready)await pause(250);}
  if(!ready)throw Error('Restored runtime still blocked after 15 seconds');
  const result={nativeColdToInteractiveMs:Date.now()-started};
  result.memory=await evaluate(`(async()=>{
   const w=document.querySelector('#dialogue-frame').contentWindow,d=w.document,start=w.performance.now();
   return await new Promise((resolve,reject)=>{
    const o=new w.MutationObserver(()=>{const home=d.querySelector('.stmb-popup[open] .homer-memory-home');if(home?.offsetWidth){o.disconnect();clearTimeout(timer);resolve({openMs:Math.round(w.performance.now()-start),messageCount:d.querySelectorAll('#chat .mes').length});}});
    const timer=setTimeout(()=>{o.disconnect();reject(Error('memory not ready'));},2000);
    o.observe(d.body,{childList:true,subtree:true,attributes:true});d.querySelector('#homer-open-memory-books').click();
   });
  })()`);
  result.networkFailures=failures;
  if(failures.length||!result.memory.messageCount)throw Error('Runtime failed requests or lost actual messages');
  fs.mkdirSync('output/connectivity-r24',{recursive:true});
  fs.writeFileSync('output/connectivity-r24/cold.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{ws.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
