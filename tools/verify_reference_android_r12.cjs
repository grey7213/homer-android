// Inspect bundled creator in the installed debug WebView; never save a card.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:18223/json/list')).json();
 const target=targets.find(t=>t.url.startsWith('https://'));
 if(!target)throw Error('Expected debug app WebView');
 const socket=new WebSocket(target.webSocketDebuggerUrl),pending=new Map(),errors=[];let seq=0;
 socket.addEventListener('message',event=>{
  const data=JSON.parse(event.data);
  if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.text);
  const item=pending.get(data.id);if(item){clearTimeout(item.timer);pending.delete(data.id);data.error?item.reject(Error(data.error.message)):item.resolve(data.result);}
 });
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
 async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}
 try{
  await call('Runtime.enable');await call('Page.enable');
  if(!await evaluate('window.HomerNative?.isDebugBuild()===true'))throw Error('Expected debug build');
  await call('Page.navigate',{url:new URL('/app/create.html',target.url).href});
  for(let n=0;n<100;n++){try{if(await evaluate("!!document.querySelector('.creator-core__name input')&&!!window.Alpine&&!!document.querySelector('.creator-core__name')?.offsetWidth"))break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const result=await evaluate("(()=>({viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},metrics:Object.fromEntries(['.editor-toolbar','.creator-core__portrait','.creator-core__name','.creator-core__writing','.editor-toolbar__primary'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [s,{x:r.x,y:r.y,width:r.width,height:r.height}]}))}))()");
  for(const selector of ['.editor-toolbar','.editor-toolbar__primary']){const box=result.metrics[selector];if(box.y<0||box.y+box.height>result.viewport.height+1)throw Error('Clipped '+selector);}
  const out=path.resolve(__dirname,'../output/ui-models-r12');
  fs.writeFileSync(path.join(out,'creator-android-r12.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  const point=await evaluate("(()=>{const r=document.querySelector('.creator-core__name input').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  let keyboard;
  for(let n=0;n<30;n++){
   keyboard=await evaluate("(()=>{const r=document.querySelector('.editor-toolbar__primary').getBoundingClientRect();return {height:visualViewport.height,saveTop:r.top,saveBottom:r.bottom,focused:document.activeElement===document.querySelector('.creator-core__name input')}})()");
   if(keyboard.height<result.viewport.height-80)break;
   await new Promise(r=>setTimeout(r,100));
  }
  result.keyboard=keyboard;
  result.keyboard.available=keyboard.height<result.viewport.height-80;
  try{
   if(result.keyboard.available){
    if(!keyboard.focused||keyboard.saveBottom>keyboard.height+1||keyboard.saveTop<0)throw Error('Save action obscured by keyboard');
    fs.writeFileSync(path.join(out,'creator-android-keyboard-r12.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
   }else result.keyboard.limitation='Emulator IME reports visible but has zero-height window; native keyboard occlusion unverified';
  }finally{execFileSync('C:/Users/ROG/AppData/Local/Android/Sdk/platform-tools/adb.exe',['-s','127.0.0.1:16384','shell','input','keyevent','4']);}
  result.errors=errors;if(errors.length)throw Error(errors.join(';'));
  fs.writeFileSync(path.join(out,'creator-android-r12.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{socket.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
