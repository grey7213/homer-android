// Installed APK, actual bundled runtime, isolated local server and synthetic Homer account.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const out=path.resolve(__dirname,'../output/ui-r22/android'),adb='D:/Android/Sdk/platform-tools/adb.exe';
const native=(...args)=>execFileSync(adb,['-s','emulator-5556',...args]);
(async()=>{
 const ts=await(await fetch('http://127.0.0.1:18225/json/list')).json();const t=ts.find(t=>t.url.includes('/app/'));
 if(!t)throw Error('No app WebView');
 const ws=new WebSocket(t.webSocketDebuggerUrl),pending=new Map(),errors=[],generated=[],held=[],requests=[];let seq=0,cookie='',admin=true;
 function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
 const reply=(id,data,status=200)=>call('Fetch.fulfillRequest',{requestId:id,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(data)).toString('base64')});
 const messages=['车站相遇。','记住明天的约定。','明天一起出发。'].map((content,i)=>({id:'m'+i,role:i===1?'user':'assistant',content,created_at:1788700000000+i}));
 async function intercept({requestId,request}){
  let p=new URL(request.url).pathname.replace(/^\/module\/dialogue\//,'/');
  requests.push(p);
  if(p.endsWith('/account/profile'))return reply(requestId,{data:{id:'r22-android',name:'本机验收用户',is_admin:admin}});
  if(p.endsWith('/credits')||p.endsWith('/persona')){held.push(requestId);return;}
  if(p==='/api/homer/session')return reply(requestId,{data:{user:{id:'r22-android'},runtime:{backend_base_url:'https://patcher.villainy.top',bridge_base_url:'https://patcher.villainy.top'},launch:{app_id:'r22-card',conversation_id:'r22-chat',bridge_token:'local-fixture-not-a-credential',messages,card:{spec:'chara_card_v2',spec_version:'2.0',data:{name:'本机记忆验收',description:'合成角色',first_mes:messages[0].content,extensions:{}}},runtime_config:{}}}});
  if(p==='/api/homer/models')return reply(requestId,{data:{list:[{id:'test-model',name:'测试模型',enabled:true}],default_id:'test-model'}});
  if(p==='/api/homer/sync')return reply(requestId,{data:{messages}});
  if(p.includes('/generate')){generated.push(p);return reply(requestId,{error:'Generation disabled for test'},403);}
  if(p.startsWith('/api/homer/'))return reply(requestId,{data:{list:[]}});
  if(p.startsWith('/console/')||p.startsWith('/admin/api/')||p.startsWith('/go/'))return reply(requestId,{data:{list:[],apps:[],messages}});
  if(p==='/csrf-token'||p.startsWith('/api/')){
   const headers={'Content-Type':'application/json',Cookie:cookie};
   for(const [k,v] of Object.entries(request.headers))if(k.toLowerCase()==='x-csrf-token')headers[k]=v;
   let requestBody=['GET','HEAD'].includes(request.method)?undefined:request.postData;
   // CDP omits File bytes from multipart postData. Reconstitute this test's
   // synthetic card (never a real user upload) for the isolated runtime.
   if(p==='/api/characters/import'){
    const form=new FormData();form.append('avatar',new Blob([JSON.stringify({spec:'chara_card_v2',spec_version:'2.0',data:{name:'本机记忆验收',description:'合成角色',first_mes:messages[0].content,extensions:{homer_bridge:{app_id:'r22-card'}}}})],{type:'application/json'}),'homer-r22-card.json');form.append('file_type','json');form.append('user_name','本机验收用户');form.append('preserved_name','homer-r22-card');requestBody=form;delete headers['Content-Type'];
   }
   const res=await fetch('http://127.0.0.1:18911'+p+new URL(request.url).search,{method:request.method,headers,body:requestBody});
   const set=res.headers.getSetCookie();if(set.length)cookie=set.map(s=>s.split(';')[0]).join('; ');
   let body=Buffer.from(await res.arrayBuffer());
   if(p==='/api/settings/get'&&res.ok){const d=JSON.parse(body),s=JSON.parse(d.settings);s.firstRun=false;s.extension_settings??={};s.extension_settings.disabledExtensions=['third-party/js-slash-runner','third-party/ST-Prompt-Template','third-party/st-yuzi-phone'];d.settings=JSON.stringify(s);body=Buffer.from(JSON.stringify(d));}
   return call('Fetch.fulfillRequest',{requestId,responseCode:res.status,responseHeaders:[{name:'Content-Type',value:res.headers.get('content-type')||'application/json'}],body:body.toString('base64')});
  }
  return call('Fetch.continueRequest',{requestId});
 }
 ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.method==='Fetch.requestPaused')intercept(d.params).catch(e=>errors.push('intercept '+e.message));if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.text);const p=pending.get(d.id);if(p){pending.delete(d.id);d.error?p.reject(Error(d.error.message)):p.resolve(d.result);}};
 await new Promise(r=>ws.onopen=r);
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const wait=async expression=>{const end=Date.now()+45000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+expression);};
 const click=async (s,frame=false)=>{const point=await evaluate(`(()=>{const d=${frame?"document.querySelector('#dialogue-frame').contentDocument":"document"},e=d.querySelector(${JSON.stringify(s)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),f=${frame?"document.querySelector('#dialogue-frame').getBoundingClientRect()":"{x:0,y:0}"};return {x:r.x+r.width/2+f.x,y:r.y+r.height/2+f.y}})()`);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
 let script;
 try{
  await call('Runtime.enable');await call('Page.enable');
  const safe=await evaluate(`(()=>{const u=JSON.parse(localStorage.getItem('ai_xingyue_user')||'null');return window.HomerNative?.isDebugBuild()&&!localStorage.getItem('ai_xingyue_token')&&(!u||['r7-device-local','r16-settings-local','r22-android'].includes(u.id))})()`);if(!safe)throw Error('Refusing a real account');
  await call('Fetch.enable',{patterns:[{urlPattern:'*/api/*'},{urlPattern:'*/csrf-token*'},{urlPattern:'*/console/*'},{urlPattern:'*/go/*'}]});
  script=(await call('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r22-android',name:'本机验收用户'}));localStorage.setItem('ai_xingyue_shell_theme','dark');"})).identifier;
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/me.html'});
  await wait(`document.querySelector('a[aria-label="管理后台"]')?.offsetWidth>0`);if(held.length!==2)throw Error('Wallet/persona not held');
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'admin.png'),native('exec-out','screencap','-p'));
  for(const id of held.splice(0))await reply(id,{data:{}});
  admin=false;await call('Page.reload');await wait(`window.Alpine&&document.querySelector('[x-data]')&&Alpine.$data(document.querySelector('[x-data]')).profileRefreshing===false`);
  if(await evaluate(`!!document.querySelector('a[aria-label="管理后台"]').offsetWidth`))throw Error('Non-admin entry visible');for(const id of held.splice(0))await reply(id,{data:{}});
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/explore.html'});await wait(`document.querySelector('.home-search-box input')?.offsetWidth>0`);
  const checkColors=()=>evaluate(`(()=>{const e=document.querySelector('.home-search-box input');return getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(e.parentElement).backgroundColor==='rgb(41, 46, 53)'})()`);
  if(!await checkColors())throw Error('Resting search colors');fs.writeFileSync(path.join(out,'search-rest.png'),native('exec-out','screencap','-p'));
  const screenHeight=await evaluate('visualViewport.height');await click('.home-search-box input');await wait(`document.activeElement===document.querySelector('.home-search-box input')&&visualViewport.height<${screenHeight-100}`);await call('Input.insertText',{text:'故事'});if(!await checkColors())throw Error('Focus colors');native('shell','input','keyevent','4');await wait(`visualViewport.height>=${screenHeight-3}`);await evaluate(`document.querySelector('.home-search-box input').blur()`);if(!await checkColors())throw Error('Blur colors');
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/chat.html?app_id=r22-card&conversation_id=r22-chat'});
  await wait(`document.body?.classList.contains('is-ready')`);
  await click('[aria-label="打开对话设置"]',true);
  const start=Date.now();await click('#homer-open-memory-books',true);
  await wait(`document.querySelector('#dialogue-frame').contentDocument.querySelector('.stmb-popup[open] .homer-memory-layout')`);
  const memoryOpenMs=Date.now()-start;
  await wait(`document.querySelector('#dialogue-frame').contentDocument.querySelector('[data-memory-generate]')?.textContent==='生成记忆'`);
  if(await evaluate(`(()=>{const d=document.querySelector('#dialogue-frame').contentDocument;return [...d.querySelectorAll('.stmb-popup .popup-body,.stmb-popup .popup-content')].some(e=>['auto','scroll'].includes(getComputedStyle(e).overflowY))})()`))throw Error('Nested memory scroll');
  if(await evaluate(`!!document.querySelector('#homer-memory-entry')||!!document.querySelector('#dialogue-frame').contentDocument.querySelector('#homer-memory-entry')`))throw Error('Duplicate entry present');
  await click('.homer-memory-shortcuts button',true);await wait(`document.querySelector('#dialogue-frame').contentDocument.querySelector('.homer-memory-selection')?.textContent.includes('共 3 条')`);
  fs.writeFileSync(path.join(out,'memory.png'),native('exec-out','screencap','-p'));
  native('shell','input','keyevent','4');await wait(`!document.querySelector('#dialogue-frame').contentDocument.querySelector('.stmb-popup[open]')`);
  if(errors.length||generated.length)throw Error(JSON.stringify({errors,generated}));
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks:['APK admin with blocked wallet/persona','ordinary user hidden','dark search rest focus blur','real bundled memory one-click and real range','native Back'],memoryOpenMs,errors,generated},null,2));console.log('Installed R22 checks passed',memoryOpenMs);
 }catch(e){console.log(JSON.stringify({error:e.message,requests,errors,ui:await evaluate(`(()=>{const d=document.querySelector('#dialogue-frame')?.contentDocument;return {path:location.pathname,host:document.body.className,runtime:d?.documentElement?.className,gate:d?.querySelector('#homer-runtime-gate')?.textContent?.slice(0,800),memory:!!d?.querySelector('.stmb-popup[open]')}})()`).catch(()=>null)}));throw e;}finally{if(script)await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:script}).catch(()=>{});await call('Fetch.disable').catch(()=>{});ws.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
