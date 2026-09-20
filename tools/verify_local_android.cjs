// Installed APK + real PC APIs. No Fetch interception or synthetic account.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const base=process.env.HOMER_ACCEPTANCE_BASE||'http://172.24.5.154:8080', endpoint='http://127.0.0.1:18225';
const out=path.resolve(__dirname,process.env.HOMER_ACCEPTANCE_OUT||'../output/local-acceptance');
const native=(...args)=>execFileSync('D:/Android/Sdk/platform-tools/adb.exe',['-s','emulator-5556',...args]);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let ws, seq=0;const pending=new Map(), requests=new Map(), failures=[];
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function connect(){
 const list=await(await fetch(endpoint+'/json/list')).json();
 const target=list.find(t=>t.url.startsWith(base));if(!target)throw Error('No local app WebView');
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Network.requestWillBeSent'){const u=new URL(m.params.request.url);requests.set(m.params.requestId,u.origin+u.pathname);}else if(m.method==='Network.loadingFailed'&&m.params.errorText!=='net::ERR_ABORTED')failures.push({url:requests.get(m.params.requestId),error:m.params.errorText});});
 await call('Network.enable');
}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||'Evaluation failed');return r.result.value;}
async function wait(expression,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await evaluate(expression))return;}catch{}await pause(150);}throw Error('Timed out: '+expression);}
async function navigate(route){await call('Page.navigate',{url:base+route});await wait(`location.pathname===${JSON.stringify(new URL(route,base).pathname)}&&document.readyState!=='loading'`);}
async function click(selector,frame=false){const rect=await evaluate(`(()=>{const d=${frame?"document.querySelector('#dialogue-frame').contentDocument":"document"},e=d.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');const r=e.getBoundingClientRect(),f=${frame?"document.querySelector('#dialogue-frame').getBoundingClientRect()":"{x:0,y:0}"};return {x:r.x+r.width/2+f.x,y:r.y+r.height/2+f.y}})()`);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[rect]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
(async()=>{
 fs.mkdirSync(out,{recursive:true});await connect();
 const results={};
 try{
  if(process.env.HOMER_ACCEPTANCE_CURRENT_CHAT==='1'){
   await wait(`document.body.classList.contains('is-ready')&&!!document.querySelector('#dialogue-frame').contentWindow.HomerMemoryBooks`,45000);
   await click('[aria-label="打开对话设置"]',true);const start=Date.now();await click('#homer-open-memory-books',true);
   await wait(`document.querySelector('#dialogue-frame').contentDocument.querySelector('.homer-memory-home')?.offsetWidth>0`);
   results.memoryHome=true;results.readyMenuOpenMs=Date.now()-start;
   results.messageCount=await evaluate(`document.querySelector('#dialogue-frame').contentDocument.querySelectorAll('#chat .mes').length`);
   fs.writeFileSync(path.join(out,'android-memory.png'),native('exec-out','screencap','-p'));
   fs.writeFileSync(path.join(out,'memory-ready.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));return;
  }
  await evaluate("(async()=>{const {api,clearAuth}=await import('/assets/js/api.js');await api.logout();clearAuth()})()");
  for(let i=0;i<2;i++){
   await navigate('/app/login.html?next=%2Fapp%2Fme.html');
   await wait(`document.querySelector('input[x-model="loginForm.email"]')?.offsetWidth>0`);
   for(const [field,value] of [['email',process.env.HOMER_ACCEPTANCE_EMAIL],['password',process.env.HOMER_ACCEPTANCE_PASSWORD]]){
    if(!value)throw Error('Missing credential environment');
    await evaluate(`(()=>{const e=document.querySelector('input[x-model="loginForm.${field}"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
   }
   await click('form button[type="submit"]');
   await wait(`location.pathname==='/app/me.html'&&document.querySelector('a[aria-label="管理后台"]')?.offsetWidth>0`);
   if(i===0)await evaluate("(async()=>{const {api,clearAuth}=await import('/assets/js/api.js');await api.logout();clearAuth()})()");
  }
  results.loginLogoutRelogin=true;
  results.serverAdmin=await evaluate("fetch('/admin/api/whoami').then(r=>r.ok)");if(!results.serverAdmin)throw Error('Server denied admin');
  fs.writeFileSync(path.join(out,'android-admin.png'),native('exec-out','screencap','-p'));
  await navigate('/admin.html');await wait(`document.body.innerText.includes('管理')`);
  if(process.env.HOMER_ACCEPTANCE_LOGIN_ONLY==='1'){
   results.adminPage=true;results.networkFailures=failures;
   fs.writeFileSync(path.join(out,'android.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));return;
  }
  if(process.env.HOMER_ACCEPTANCE_R23==='1'){
   await navigate('/app/me.html');await wait(`document.querySelector('.profile-relations a')?.offsetWidth>0`);
   await click('.profile-relations a');await wait(`location.pathname==='/app/community-relations.html'&&(document.querySelector('.community-check input')||document.querySelector('.c-relation-search input')?.offsetWidth>0)`);
   if(await evaluate(`!!document.querySelector('.community-check input')`)){
    await evaluate(`document.querySelector('.community-check input').scrollIntoView({block:'center'})`);await click('.community-check input');
    await evaluate(`(()=>{const b=[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='同意并进入');b.dataset.r23Accept='true';b.scrollIntoView({block:'center'})})()`);await click('[data-r23-accept]');
   }
   await wait(`document.querySelector('.c-relation-search input')?.offsetWidth>0&&!Alpine.$data(document.querySelector('[x-data]')).loading`);
   await click('.c-relation-tabs button:nth-child(2)');await wait(`(()=>{const s=Alpine.$data(document.querySelector('[x-data]'));return s.relationTab==='followers'&&s.relationLoadedKey==='followers|'&&!s.loading&&typeof s.relationCounts.followers==='number'})()`);
   results.relations=await evaluate(`(()=>{const s=Alpine.$data(document.querySelector('[x-data]'));return {tab:s.relationTab,error:s.error,counts:{following:Number(s.relationCounts.following),followers:Number(s.relationCounts.followers)},rows:s.relationItems.length,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
   if(results.relations.error||results.relations.overflow)throw Error('Relations layout/API failed');
   fs.writeFileSync(path.join(out,'android-relations.png'),native('exec-out','screencap','-p'));
   await click('.c-relation-header [aria-label="返回"]');await wait(`location.pathname==='/app/me.html'`);
   fs.writeFileSync(path.join(out,'relations.json'),JSON.stringify(results,null,2));
   if(process.env.HOMER_ACCEPTANCE_RELATIONS_ONLY==='1'){console.log(JSON.stringify(results));return;}
  }
  await navigate('/app/histories.html');await wait(`Alpine.$data(document.querySelector('[x-data]')).loading===false`);
  const href=await evaluate(`document.querySelector('.history-row__main')?.getAttribute('href')`);
  results.hasHistory=!!href;
  if(href){
   await navigate(href);const start=Date.now();await wait("document.body.classList.contains('is-ready')",45000);results.chatReadyMs=Date.now()-start;
   await click('[aria-label="打开对话设置"]',true);const open=Date.now();await click('#homer-open-memory-books',true);
   await wait(`document.querySelector('#dialogue-frame').contentDocument.querySelector('.stmb-popup[open]')`);results.memoryOpenMs=Date.now()-open;
   results.messageCount=await evaluate(`document.querySelector('#dialogue-frame').contentDocument.querySelectorAll('#chat .mes').length`);
   fs.writeFileSync(path.join(out,'android-memory.png'),native('exec-out','screencap','-p'));
   if(process.env.HOMER_ACCEPTANCE_R23==='1'){
    await wait(`document.querySelector('#dialogue-frame').contentDocument.querySelector('.homer-memory-home')?.offsetWidth>0`);
    results.memoryHome=true;
    results.memoryDisconnected=await evaluate(`document.querySelector('#dialogue-frame').contentDocument.querySelector('.stmb-popup').innerText.includes('当前会话还未连接')`);
    if(results.memoryDisconnected)throw Error('Disconnected placeholder returned');
   }
  }
  results.networkFailures=failures;
  if(failures.length)throw Error('Installed client has failed network requests; inspect sanitized paths');
  fs.writeFileSync(path.join(out,'android.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }finally{ws?.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
