// Real installed debug WebView/native navigation; only synthetic account and local community data.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const adb='D:/Android/Sdk/platform-tools/adb.exe',serial='127.0.0.1:16384',uid='r7-device-local';
const out=path.resolve(__dirname,'../output/community-r7/android');
const native=(...args)=>execFileSync(adb,['-s',serial,...args]);
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:18223/json/list')).json();
 const target=targets.find(t=>t.url.includes('/app/login.html'));if(!target)throw Error('Expected signed-out .uireview login page');
 const socket=new WebSocket(target.webSocketDebuggerUrl),pending=new Map(),errors=[],writes=[];let seq=0,scoped=false;
 socket.addEventListener('message',async event=>{
  const data=JSON.parse(event.data);
  if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text);
  if(data.method==='Fetch.requestPaused'){
   const {requestId,request}=data.params,u=new URL(request.url);let code=200,body={data:{apps:[],list:[],total:0},points:100};
   if(request.method!=='GET'){writes.push(u.pathname);code=403;body={message:'Device test forbids remote writes'};}
   else if(u.pathname.endsWith('/account/profile'))body={id:uid,name:'设备验收作者',is_admin:true};
   else if(u.pathname.includes('/social/')){code=404;body={message:'社区服务未部署（验收场景）'};}
   await call('Fetch.fulfillRequest',{requestId,responseCode:code,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')}).catch(e=>{if(!/Invalid InterceptionId|closed/i.test(e.message))errors.push(e.message);});
  }
  const waiter=pending.get(data.id);if(waiter){pending.delete(data.id);clearTimeout(waiter.timer);data.error?waiter.reject(Error(data.error.message)):waiter.resolve(data.result);}
 });
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
 async function evaluate(expression,gesture=false){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:gesture});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
 async function ready(expression){for(let n=0;n<120;n++){try{if(await evaluate(`Boolean(${expression})`))return;}catch(e){if(!/context.*destroyed|Cannot find context|Alpine is not defined/i.test(e.message))throw e;}await new Promise(r=>setTimeout(r,100));}throw Error('UI wait timed out: '+expression);}
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`,true);
 const clickText=text=>evaluate(`[...document.querySelectorAll('button')].find(b=>b.offsetWidth&&b.textContent.trim()===${JSON.stringify(text)}).click()`,true);
 const fill=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 async function tap(selector){const r=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[r]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
 fs.mkdirSync(out,{recursive:true});const capture=name=>fs.writeFileSync(path.join(out,name+'.png'),native('exec-out','screencap','-p'));
 const screen=name=>ready(`location.pathname.endsWith('/${name}.html')&&document.querySelector('.c-page')&&document.querySelector('[data-local-acceptance]')&&Alpine.$data(document.querySelector('[x-data]')).ready`);
 try{
  await call('Runtime.enable');await call('Page.enable');
  if(!await evaluate("!localStorage.getItem('ai_xingyue_user')&&!localStorage.getItem('ai_xingyue_token')"))throw Error('Refusing to change a signed-in account');
  if(!await evaluate('window.HomerNative.isDebugBuild()===true'))throw Error('Native debug capability missing');
  await call('Fetch.enable',{patterns:[{urlPattern:'*/console/*'},{urlPattern:'*/admin/api/*'},{urlPattern:'*/go/*'}]});
  await evaluate(`localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'${uid}',name:'设备验收作者'}));window.HomerNative.setAccountScope('${uid}')`);scoped=true;
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/community.html?acceptance=local'});
  await ready("document.querySelector('.community-dialog[open] input[type=checkbox]')");await click('.community-dialog[open] input[type=checkbox]');await clickText('同意并进入');await screen('community');capture('home');
  await click('[aria-label="搜索社区"]');await screen('community-search');await fill('[aria-label="搜索关键词"]','示例');await clickText('搜索');await ready("document.querySelector('.c-post')");capture('search');
  native('shell','input','keyevent','4');await screen('community');
  await click('.c-post-copy a');await screen('community-post');
  if(!await evaluate("!document.querySelector('dialog[open]')&&!document.querySelector('[data-app-bottom-nav]')&&!document.querySelector('[aria-label=评论内容]').disabled"))throw Error('Detail is not independent/enabled');
  const closedHeight=await evaluate('visualViewport.height');
  await tap('[aria-label="评论内容"]');await new Promise(r=>setTimeout(r,700));
  const keyboard=native('shell','dumpsys','input_method').toString();if(!/mInputShown=true|isInputViewShown=true/.test(keyboard))throw Error('Keyboard not shown');
  const geometry=await evaluate("(()=>{const r=document.querySelector('.c-reply-dock').getBoundingClientRect(),v=visualViewport;return {bottom:r.bottom,viewport:v.height+v.offsetTop,width:r.width,screen:innerWidth}})()");
  if(geometry.bottom>geometry.viewport+2||geometry.width>geometry.screen+1)throw Error('Reply dock behind keyboard '+JSON.stringify(geometry));
  geometry.keyboardReducedViewport=geometry.viewport<closedHeight-100;
  capture('keyboard');
  if(!geometry.keyboardReducedViewport)process.stdout.write('LIMITATION: emulator IME reports open without reducing the viewport; keyboard obstruction cannot be certified on this device.\n');
  await fill('[aria-label="评论内容"]','Android 独立页面评论');await clickText('发送');await ready("document.querySelector('.c-comment')?.textContent.includes('Android 独立页面评论')");
  native('shell','input','keyevent','4');await screen('community-post');capture('detail');native('shell','input','keyevent','4');await screen('community');
  await click('[aria-label="发布帖子"]');await screen('community-compose');await fill('[aria-label="帖子标题"]','Android 独立页面作品');await fill('[aria-label="帖子正文"]','通过原生 WebView 验证草稿、发布和返回。');
  await ready("Alpine.$data(document.querySelector('[x-data]')).draftSaved");native('shell','input','keyevent','4');await screen('community');
  await click('[aria-label="发布帖子"]');await screen('community-compose');if(!await evaluate("document.querySelector('[aria-label=帖子标题]').value==='Android 独立页面作品'"))throw Error('Draft lost on native Back');capture('compose');
  await click('input[type=file]');await new Promise(r=>setTimeout(r,700));
  const activity=native('shell','dumpsys','activity','activities').toString().split('\n').filter(l=>/ResumedActivity/.test(l)).join('\n');if(!/documentsui|PickActivity|PhotoPicker/i.test(activity))throw Error('System media chooser did not open');
  native('shell','input','keyevent','4');await screen('community-compose');await clickText('发布');await screen('community-post');await ready("document.querySelector('.c-detail h2')?.textContent==='Android 独立页面作品'");capture('published');
  native('shell','input','keyevent','4');await screen('community');await clickText('我的动态');await screen('community-activity');capture('activity');
  await click('a[href="/app/favorites.html?tab=community"]');await screen('favorites');capture('saved');native('shell','input','keyevent','4');await screen('community-activity');native('shell','input','keyevent','4');await screen('community');
  await click('[aria-label="社区消息"]');await screen('community-messages');if(!await evaluate("![...document.querySelectorAll('.c-messages button')].some(b=>b.textContent==='更多消息'&&b.offsetWidth)"))throw Error('Empty messages shows more button');capture('messages');native('shell','input','keyevent','4');await screen('community');
  await clickText('验收选项');await clickText('本机社区管理');await ready("document.querySelector('.community-admin [data-tab=rules]')");capture('admin');
  if(errors.length||writes.length)throw Error(JSON.stringify({errors,writes}));
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({package:'org.nebula.horizon.composeai.uireview',checks:['native debug marker','local disclosure','standalone search/post/compose/activity/saved/messages','native Back','input dock bounds','draft restored','publish','comment','system media chooser cancellation','local admin'],keyboard:geometry,limitations:geometry.keyboardReducedViewport?[]:['Emulator IME has no visible keyboard; real phone keyboard obstruction still needs verification'],errors,remoteWrites:writes},null,2));process.stdout.write('R7 installed Android checks passed\n');
 }finally{
  if(scoped){await evaluate(`(async()=>{for(const key of Object.keys(localStorage)){if(key==='ai_xingyue_logged_in'||key==='ai_xingyue_user'||key==='homer.community.acceptance.v1.${uid}'||(key.startsWith('homer.page-cache.')&&key.endsWith('.${uid}')))localStorage.removeItem(key);}await new Promise(resolve=>{const r=indexedDB.open('homer-community-acceptance');r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('accounts')){db.close();resolve();return;}const tx=db.transaction('accounts','readwrite');tx.objectStore('accounts').delete('${uid}');tx.oncomplete=()=>{db.close();resolve()};};r.onerror=resolve;});window.HomerNative.setAccountScope('');})()`);await call('Page.navigate',{url:'https://patcher.villainy.top/app/login.html'});}
  await call('Fetch.disable').catch(()=>{});socket.close();
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
