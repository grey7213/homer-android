// Actual debug APK WebViews via ADB-forwarded CDP. No fabricated native bridge.
const fs = require('node:fs'), path = require('node:path');
const endpoint = process.env.HOMER_TEST_CDP || 'http://127.0.0.1:9335';
const out = process.env.HOMER_TEST_OUTPUT ? path.resolve(process.env.HOMER_TEST_OUTPUT) : path.resolve(__dirname, '../../output/mobile-r25/android');
fs.mkdirSync(out, {recursive:true});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function targets() { return (await (await fetch(endpoint + '/json')).json()).filter(t => t.type === 'page'); }
async function wait(fn, limit=30000) { const end=Date.now()+limit; while(Date.now()<end){const v=await fn();if(v)return v;await delay(100);}throw Error('Timed out waiting for native UI'); }
async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl), calls=new Map(); let seq=0;
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
  ws.onmessage=event=>{const m=JSON.parse(event.data), c=calls.get(m.id);if(!c)return;calls.delete(m.id);clearTimeout(c.timer);m.error?c.reject(Error(m.error.message)):c.resolve(m.result);};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{calls.delete(id);reject(Error(method+' timeout'));},20000);calls.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  return {call,evaluate,close:()=>ws.close(),target:t};
}
async function visible(suffix='') {return (await targets()).find(t=>JSON.parse(t.description||'{}').visible&&t.url.includes(suffix));}
async function navigate(client,url) {
 const point=await client.evaluate(`(()=>{const a=[...document.querySelectorAll('a[href]')].find(e=>e.href===${JSON.stringify(url)}&&e.getClientRects().length&&e.getBoundingClientRect().top>=0&&e.getBoundingClientRect().bottom<=innerHeight);if(!a)return null;const r=a.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
 if(point){await client.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await client.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
 else await client.evaluate(`location.assign(${JSON.stringify(url)})`);
 return connect(await wait(()=>visible(url.split('?')[0])));
}
(async()=>{
 const result={pages:[],failures:[]};let clients=[];
 try {
  let client=await connect(await visible());clients.push(client);
  if(client.target.url.includes('login.html')){
   const raw=JSON.parse(fs.readFileSync(process.env.HOMER_TEST_CREDENTIALS,'utf8').replace(/^\uFEFF/,'')),u=raw.admin||raw;
   await client.evaluate(`(()=>{const set=(sel,value)=>{const el=document.querySelector(sel);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};set('input[type=email]',${JSON.stringify(u.email)});set('input[type=password]',${JSON.stringify(u.password)});document.querySelector('button[type=submit]').click();})()`);
   await wait(async()=>{const t=await visible();return t&&!t.url.includes('login.html')?t:null;});
   client.close();client=await connect(await visible());clients.push(client);
  }
  const base=await client.evaluate('location.origin');
  for(const name of ['workshop','histories','me','community','explore','workshop','histories','me','community','explore','workshop']){
   const start=Date.now();client=await navigate(client,`${base}/app/${name}.html`);clients.push(client);
   // DevTools changes target.url before a new WebView commits its document.
   // about:blank is also complete and has no x-cloak; counting it as ready then
   // navigating away cancels the real page's deferred scripts in the test.
   await wait(()=>client.evaluate(`location.pathname==='/app/${name}.html'&&document.readyState==='complete'&&!!document.body?.innerText.trim()&&!document.querySelector('[x-cloak]')`));
   result.pages.push({name,ms:Date.now()-start,id:client.target.id});
  }
  const prepared=(await targets()).find(t=>t.url.includes('/app/chat.html'));
  if(!prepared)throw Error('Native prepared WebView was not retained');
  const warm=await connect(prepared);clients.push(warm);
  await wait(()=>warm.evaluate(`document.body.classList.contains('is-ready') || !!document.querySelector('#dialogue-frame')?.contentWindow?.performance.getEntriesByName('homer-prewarm-shared-ready').length`),60000);
  result.preparedKind=prepared.url.includes('prewarm=1')?'prewarm':'existing-chat';
  result.runtimeBootstrapMs=await warm.evaluate(`document.querySelector('#dialogue-frame').contentWindow.performance.getEntriesByName('homer-bootstrap-ready')[0]?.startTime || null`);
  const app=await client.evaluate(`(async()=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.importCard({spec:'chara_card_v2',spec_version:'2.0',data:{name:'Android R25 '+Date.now(),description:'本地验收，不调用付费生成',first_mes:'这是安装包中的实际会话。'}})).data})()`);
  const start=Date.now();client=await navigate(client,`${base}/app/chat.html?app_id=${encodeURIComponent(app.id)}`);clients.push(client);
  await wait(()=>client.evaluate(`document.body.classList.contains('is-ready') && new URL(location.href).searchParams.get('app_id') === ${JSON.stringify(app.id)} && (()=>{const c=document.querySelector('#dialogue-frame')?.contentWindow?.SillyTavern?.getContext();return c?.characters?.[c.characterId]?.data?.extensions?.homer_bridge?.app_id === ${JSON.stringify(app.id)}})()`),60000);
  result.chat={newMs:Date.now()-start,reusedPreparedView:client.target.id===prepared.id};
  if(!result.chat.reusedPreparedView)throw Error('New card discarded warmed WebView');
  const chatUrl=await client.evaluate('location.href'),chatTimeOrigin=await client.evaluate('performance.timeOrigin');
  result.chat.visibleGreeting=await client.evaluate(`document.querySelector('#dialogue-frame').contentDocument.querySelector('#chat').innerText.includes('这是安装包中的实际会话')`);
  let shot=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'chat.png'),Buffer.from(shot.data,'base64'));
  client=await navigate(client,base+'/app/histories.html');clients.push(client);
  await wait(()=>client.evaluate(`!!document.body && document.body.innerText.includes(${JSON.stringify(app.name)})`));
  result.chat.historyVisible=true;
  shot=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'history.png'),Buffer.from(shot.data,'base64'));
  const repeatStart=Date.now();client=await navigate(client,chatUrl);clients.push(client);
  await wait(()=>client.evaluate(`document.body.classList.contains('is-ready')`));
  result.chat.returnMs=Date.now()-repeatStart;result.chat.noReload=chatTimeOrigin===await client.evaluate('performance.timeOrigin');
  result.chat.marks=await client.evaluate(`document.querySelector('#dialogue-frame').contentWindow.performance.getEntriesByType('mark').map(x=>({name:x.name,ms:x.startTime}))`);
  result.chat.inputsEnabled=await client.evaluate(`!document.querySelector('#dialogue-frame').contentDocument.querySelector('#send_textarea').disabled`);
  result.chat.characterName=await client.evaluate(`document.querySelector('#dialogue-frame').contentWindow.SillyTavern.getContext().name2`);
  if(result.chat.characterName !== app.name)throw Error('Generation context still uses previous character name');
  const memoryStart=Date.now();
  await client.evaluate(`document.querySelector('#dialogue-frame').contentDocument.querySelector('#homer-open-memory-books').click()`);
  await wait(()=>client.evaluate(`!!document.querySelector('#dialogue-frame').contentDocument.querySelector('.homer-memory-home')?.getClientRects().length`));
  result.chat.memoryMs=Date.now()-memoryStart;
  result.chat.memoryConnected=await client.evaluate(`!document.querySelector('#dialogue-frame').contentDocument.querySelector('.stmb-popup').innerText.includes('当前会话还未连接')`);
  if(!result.chat.memoryConnected)throw Error('Memory failed to bind current conversation');
  shot=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'memory.png'),Buffer.from(shot.data,'base64'));
  await client.evaluate(`document.querySelector('#dialogue-frame').contentDocument.querySelector('[data-memory-close]')?.click()`);
  if(!result.chat.historyVisible||!result.chat.noReload||!result.chat.inputsEnabled||!result.chat.visibleGreeting)throw Error('Chat acceptance failed');
  client=await navigate(client,base+'/app/workshop.html');clients.push(client);
  client=await navigate(client,base+'/app/workshop-resource-editor.html?type=regex');clients.push(client);
  await wait(()=>client.evaluate(`!!document.querySelector('#resource-file')?.onchange`));
  await client.evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify({scriptName:'安装包测试',findRegex:'/猫/g',replaceString:'<b>小猫</b>'})],'安装包正则.json',{type:'application/json'}));const input=document.querySelector('#resource-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(()=>client.evaluate(`document.querySelector('#resource-status').textContent.includes('已导入')`));
  await client.evaluate(`document.querySelector('#regex-sample').value='猫和猫';document.querySelector('#regex-run').click()`);
  await wait(()=>client.evaluate(`document.querySelector('#regex-output').textContent==='<b>小猫</b>和<b>小猫</b>'`));
  result.regexNativeWorker=true;
  await client.evaluate(`document.documentElement.dataset.theme='dark';scrollTo(0,0)`);
  shot=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'regex-dark.png'),Buffer.from(shot.data,'base64'));
  await client.evaluate(`document.documentElement.dataset.theme='light';scrollTo(0,0)`);
  shot=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'regex-light.png'),Buffer.from(shot.data,'base64'));
  await client.evaluate(`document.querySelector('#resource-save').click()`);
  const saved=await wait(()=>visible('/app/workshop-resource.html'));
  client=await connect(saved);clients.push(client);
  await wait(()=>client.evaluate(`document.querySelector('#resource-list')?.innerText.includes('安装包正则')`));
  result.regexNativeSaved=true;
  console.log(JSON.stringify(result));
 }catch(error){result.failures.push(error.message);console.error(error.message);process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));for(const c of clients)c.close();}
})()
