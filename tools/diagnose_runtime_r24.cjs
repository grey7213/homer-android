// Real installed WebView, read-only API/navigation probe. Never prints chat text or query strings.
const endpoint='http://127.0.0.1:18225';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const list=await(await fetch(endpoint+'/json/list')).json();
 const target=list.find(t=>t.url.startsWith('http://192.168.1.129:8080'));
 if(!target)throw Error('Missing local WebView');
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let seq=0;const pending=new Map(),urls=new Map();
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}else if(m.method==='Network.requestWillBeSent'){urls.set(m.params.requestId,new URL(m.params.request.url).pathname);}else if(m.method==='Network.loadingFailed')console.log(JSON.stringify({failed:urls.get(m.params.requestId),error:m.params.errorText}));});
 const call=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
 await call('Network.enable');
 try{
  if(process.argv.includes('--navigate')){
   await call('Page.navigate',{url:'http://192.168.1.129:8080/app/histories.html'});
   let href;for(let i=0;i<100&&!href;i++){await pause(200);href=await evaluate(`document.querySelector('.history-row__main')?.getAttribute('href')`);}
   if(!href)throw Error('No real history');
   await call('Page.navigate',{url:new URL(href,'http://192.168.1.129:8080').href});
  }
  if(process.argv.includes('--memory')) {
   console.log(JSON.stringify(await evaluate(`(async()=>{
    const w=document.querySelector('#dialogue-frame').contentWindow,d=w.document;
    d.querySelector('.stmb-popup[open]')?.close();
    const start=w.performance.now();
    return await new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>{o.disconnect();reject(Error('Memory did not open'));},5000);
     const o=new w.MutationObserver(()=>{const home=d.querySelector('.stmb-popup[open] .homer-memory-home');if(home?.offsetWidth){o.disconnect();clearTimeout(timer);resolve({memoryPaintMs:Math.round(w.performance.now()-start),realMessages:d.querySelectorAll('#chat .mes').length});}});
     o.observe(d.body,{childList:true,subtree:true,attributes:true});
     d.querySelector('#homer-open-memory-books').click();
    });
   })()`)));return;
  }
  if(process.argv.includes('--assets')) {
   console.log(JSON.stringify(await evaluate(`(async()=>{
    const w=document.querySelector('#dialogue-frame').contentWindow;
    const check=async cache=>{const r=await w.fetch('/module/dialogue/scripts/extensions.js',{cache});const text=await r.text();return {cache,packaged:r.headers.get('x-homer-client-asset'),newLoader:text.includes('loadExtensionAsset'),marks:text.includes('homer-extension-start:')};};
    return {cached:await check('default'),reload:await check('reload'),serviceWorker:!!w.navigator.serviceWorker?.controller,loaded:w.performance.getEntriesByType('resource').filter(r=>r.name.endsWith('/scripts/extensions.js')).map(r=>({path:new URL(r.name).pathname,transfer:r.transferSize,encoded:r.encodedBodySize}))};
   })()`)));return;
  }
  if(process.argv.includes('--extensions')) {
   console.log(JSON.stringify(await evaluate(`document.querySelector('#dialogue-frame').contentWindow.performance.getEntriesByType('mark').filter(m=>m.name.startsWith('homer-extension')).map(m=>({name:m.name,ms:Math.round(m.startTime)}))`)));return;
  }
  for(let i=0;i<(process.argv.includes('--navigate')?12:1);i++){
   await pause(2000);
   console.log(JSON.stringify(await evaluate(`(()=>{const d=document.querySelector('#dialogue-frame')?.contentDocument,w=d?.defaultView,marks=w?.performance.getEntriesByType('mark')||[];return {ready:document.body.classList.contains('is-ready'),state:d?.readyState,memory:!!w?.HomerMemoryBooks,messages:d?.querySelectorAll('#chat .mes').length,pending:marks.filter(m=>m.name.startsWith('homer-extension-start:')&&!marks.some(r=>r.name===m.name.replace('-start:', '-ready:'))).map(m=>m.name),marks:marks.filter(m=>!m.name.startsWith('homer-extension')).map(m=>({name:m.name,ms:Math.round(m.startTime)})),slow:w?.performance.getEntriesByType('resource').filter(r=>r.duration>500).sort((a,b)=>b.duration-a.duration).slice(0,5).map(r=>({path:new URL(r.name).pathname,ms:Math.round(r.duration),start:Math.round(r.startTime)}))}})()`)));
  }
 }finally{ws.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
