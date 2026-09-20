// Read-only Android WebView health; excludes message text, credentials and URLs.
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:18225/json/list')).json();
 for(const target of targets){
  if(!target.url.startsWith('http://192.168.1.129:8080'))continue;
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  const result=new Promise(r=>ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id===1){r(m.result?.result?.value||m.error);ws.close();}}));
  ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{returnByValue:true,expression:`(()=>{const f=document.querySelector('#dialogue-frame'),d=f?.contentDocument;return {path:location.pathname,ready:document.readyState,body:document.body.className,frameReady:d?.readyState,frameBody:d?.body?.className,messages:d?.querySelectorAll('#chat .mes').length,settings:!!d?.querySelector('[aria-label="打开对话设置"]'),memory:!!d?.querySelector('#homer-open-memory-books'),app:!!d?.defaultView?.HomerMemoryBooks,visible:document.visibilityState,relationCounts:window.Alpine&&document.querySelector('[x-data]')?Alpine.$data(document.querySelector('[x-data]')).relationCounts:null}})()`}}));
  console.log(JSON.stringify(await result));
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
