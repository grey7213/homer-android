// Focused installed cached-shell verification. Never use a real signed-in account.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const adb='D:/Android/Sdk/platform-tools/adb.exe',serial='emulator-5556',out=path.resolve(__dirname,'../output/ui-r21/android');
const native=(...args)=>execFileSync(adb,['-s',serial,...args]);
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:18224/json/list')).json();
 const t=targets.find(t=>t.url.includes('/app/'));if(!t)throw Error('No app document');
 const ws=new WebSocket(t.webSocketDebuggerUrl),pending=new Map(),errors=[],writes=[];let seq=0;
 function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
 ws.addEventListener('message',async e=>{const d=JSON.parse(e.data);if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text);
  if(d.method==='Fetch.requestPaused'){const {requestId,request}=d.params;if(request.method!=='GET')writes.push(new URL(request.url).pathname);const data=new URL(request.url).pathname.endsWith('/account/profile')?{id:'r16-settings-local',name:'本机界面验收',is_admin:true}:{data:{apps:[],list:[],total:0},models:[]};await call('Fetch.fulfillRequest',{requestId,responseCode:request.method==='GET'?200:403,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(data)).toString('base64')}).catch(e=>{if(!/Invalid InterceptionId/.test(e.message))throw e;});}
  const p=pending.get(d.id);if(p){clearTimeout(p.timer);pending.delete(d.id);d.error?p.reject(Error(d.error.message)):p.resolve(d.result);}
 });
 await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const wait=async expression=>{for(let i=0;i<100;i++){try{if(await evaluate(expression))return;}catch(e){if(!/context.*destroyed|Cannot find context/i.test(e.message))throw e;}await new Promise(r=>setTimeout(r,100));}throw Error('Not ready: '+expression);};
 const click=async s=>{const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
 let script;
 try{
  await call('Runtime.enable');errors.length=0;await call('Page.enable');
  const safe=await evaluate(`(()=>{const u=JSON.parse(localStorage.getItem('ai_xingyue_user')||'null');return !localStorage.getItem('ai_xingyue_token')&&(!u||['r7-device-local','r16-settings-local'].includes(u.id))&&window.HomerNative.isDebugBuild()})()`);
  if(!safe)throw Error('Refusing real account or release app');
  await call('Fetch.enable',{patterns:[{urlPattern:'*/console/*'},{urlPattern:'*/admin/api/*'},{urlPattern:'*/go/*'}]});
  // Do not load the real dialogue service: this scenario explicitly tests its cached-shell path.
  script=(await call('Page.addScriptToEvaluateOnNewDocument',{source:`if(location.pathname==='/app/chat.html'){const original=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');Object.defineProperty(HTMLIFrameElement.prototype,'src',{...original,set(value){original.set.call(this,this.id==='dialogue-frame'?'about:blank':value)}});}`})).identifier;
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/chat.html?app_id=r16-settings-local&conversation_id=r16-settings-local'});
  await wait(`document.documentElement?.dataset.homerShellReady==='true'&&document.querySelector('#preview-settings')?.offsetWidth`);
  await click('#preview-settings');await new Promise(r=>setTimeout(r,350));
  const panel=await evaluate(`(()=>{const e=document.querySelector('#preview-settings-drawer'),s=getComputedStyle(e);return {rect:e.getBoundingClientRect().toJSON(),display:s.display,visibility:s.visibility,transform:s.transform,body:document.body.className,center:e.dataset.controlCenter,styleLoaded:[...document.styleSheets].map(s=>s.href)}})()`);console.log(JSON.stringify(panel));
  if(panel.rect.top<0||panel.rect.top>=await evaluate('innerHeight')||panel.rect.width<100||panel.visibility==='hidden')throw Error('Control center not visible');
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'control-center.png'),native('exec-out','screencap','-p'));
  await click('#preview-model-settings');await wait(`document.querySelector('#preview-model-dialog').open`);
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>setTimeout(r,350));
  if(!await evaluate(`document.querySelector('#preview-model-dialog').open`))throw Error('Model closed before painting');
  fs.writeFileSync(path.join(out,'model.png'),native('exec-out','screencap','-p'));
  await click('#preview-model-dialog summary[aria-label="调整温度"]');
  const before=await evaluate('visualViewport.height');
  const point=await evaluate(`(()=>{const r=document.querySelector('#preview-model-dialog input[type=number]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await wait(`visualViewport.height<${before-100}`);
  const bounds=await evaluate(`(()=>{const r=document.querySelector('#preview-model-save').getBoundingClientRect();return {height:visualViewport.height,top:r.top,bottom:r.bottom}})()`);
  if(bounds.top<0||bounds.bottom>bounds.height)throw Error('Save is obscured');
  fs.writeFileSync(path.join(out,'model-keyboard.png'),native('exec-out','screencap','-p'));
  native('shell','input','keyevent','4');await wait(`visualViewport.height>${before-3}`);native('shell','input','keyevent','4');await wait(`!document.querySelector('#preview-model-dialog').open`);
  await click('#preview-settings');
  const memoryStart=Date.now();await click('[data-runtime-section=memory]');await wait(`document.querySelector('#homer-memory-entry')?.open`);const memoryEntryMs=Date.now()-memoryStart;
  const entryBounds=await evaluate(`(()=>{const r=document.querySelector('.memory-entry-next').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:visualViewport.height}})()`);if(entryBounds.bottom>entryBounds.height+2)throw Error('Memory action off screen');
  fs.writeFileSync(path.join(out,'memory-cold-entry.png'),native('exec-out','screencap','-p'));native('shell','input','keyevent','4');await wait(`!document.querySelector('#homer-memory-entry')`);
  await evaluate(`localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r16-settings-local',name:'本机界面验收'}));`);
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/me.html?panel=preferences'});
  await wait(`document.querySelector('.preference-switch')?.offsetWidth>100`);
  await new Promise(r=>setTimeout(r,600));
  await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  fs.writeFileSync(path.join(out,'preferences.png'),native('exec-out','screencap','-p'));
  await click('.preference-settings .xy-btn-ghost');await wait(`document.querySelector('.homer-action-dialog')?.open`);
  await new Promise(r=>setTimeout(r,350));
  await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  fs.writeFileSync(path.join(out,'confirmation.png'),native('exec-out','screencap','-p'));
  native('shell','input','keyevent','4');await wait(`!document.querySelector('.homer-action-dialog')`);
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/me.html?panel=settings'});
  await wait(`document.querySelector('.profile-settings-routes [data-shell-action=theme]')?.offsetWidth`);
  if(await evaluate(`document.documentElement.dataset.theme!=='dark'`))await click('.profile-settings-routes [data-shell-action=theme]');
  await wait(`document.documentElement.dataset.theme==='dark'&&localStorage.getItem('ai_xingyue_shell_theme')==='dark'`);
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/community.html?acceptance=local'});
  await wait(`document.querySelector('dialog[open] input[type=checkbox]')||document.querySelector('.c-post')`);
  if(await evaluate(`!!document.querySelector('dialog[open] input[type=checkbox]')`)){
   await click('dialog[open] input[type=checkbox]');await click('.community-dialog-body>button');
  }
  await wait(`document.querySelector('.c-post')?.offsetWidth`);
  if(!await evaluate(`document.documentElement.dataset.theme==='dark'`))throw Error('Community did not retain dark theme');
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/community-compose.html'});
  await wait(`document.querySelector('select')?.offsetWidth`);await click('select');
  await wait(`document.querySelector('.homer-option-picker')?.open`);await new Promise(r=>setTimeout(r,600));
  fs.writeFileSync(path.join(out,'actual-community-picker.png'),native('exec-out','screencap','-p'));
  native('shell','input','keyevent','4');await wait(`!document.querySelector('.homer-option-picker')`);
  if(!await evaluate(`location.pathname==='/app/community-compose.html'`))throw Error('Back left the compose page');
  await click('select');await click('.homer-option-picker__option:nth-child(2)');
  await wait(`document.querySelector('select').value==='角色故事'`);
  const composeHeight=await evaluate('visualViewport.height');await click('.c-body-input');await call('Input.insertText',{text:'这次创作的灵感来自一场雨。'});await wait(`visualViewport.height<${composeHeight-100}`);
  const toolBounds=await evaluate(`(()=>{const r=document.querySelector('.c-editor-tools').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:visualViewport.height}})()`);if(toolBounds.top<0||toolBounds.bottom>toolBounds.height+2)throw Error('Compose tools obscured by keyboard');
  fs.writeFileSync(path.join(out,'compose-keyboard-dark.png'),native('exec-out','screencap','-p'));native('shell','input','keyevent','4');await wait(`visualViewport.height>=${composeHeight-3}`);
  await call('Page.navigate',{url:'https://patcher.villainy.top/app/explore.html'});
  await wait(`document.querySelector('[data-open-notifications]')||document.querySelector('input')`);
  await evaluate(`import('/app/assets/js/notifications.js?v=20260917-r8').then(m=>{void m.openCurrentNotifications()})`);
  await wait(`document.querySelector('.homer-announcements')?.textContent.includes('暂无公告')`);
  const noticeBounds=await evaluate(`(()=>{const r=document.querySelector('.homer-announcements').getBoundingClientRect();return {width:r.width,height:r.height,w:innerWidth,h:innerHeight}})()`);
  if(noticeBounds.width>=noticeBounds.w||noticeBounds.height>=noticeBounds.h)throw Error('Announcement must be a popup');
  fs.writeFileSync(path.join(out,'announcement-popup.png'),native('exec-out','screencap','-p'));
  native('shell','input','keyevent','4');await wait(`!document.querySelector('.homer-announcements')`);
  if(!await evaluate(`location.pathname==='/app/explore.html'`))throw Error('Notice Back left explore');
  if(errors.length||writes.length)throw Error(JSON.stringify({errors,writes}));
  const searchHeight=await evaluate('visualViewport.height');await click('.home-search-box input');await wait(`document.activeElement===document.querySelector('.home-search-box input')`);await wait(`visualViewport.height<${searchHeight-100}`);await call('Input.insertText',{text:'搜索测试'});await wait(`document.querySelector('.home-search-box input').value.includes('搜索测试')`);
  const searchColors=await evaluate(`(()=>{const e=document.querySelector('.home-search-box input'),s=getComputedStyle(e),p=getComputedStyle(e.parentElement);return {fg:s.color,fill:s.webkitTextFillColor,bg:s.backgroundColor,wrapper:p.backgroundColor}})()`);if(searchColors.wrapper==='rgb(255, 255, 255)'||searchColors.bg===searchColors.fg)throw Error('Dark input colors failed');fs.writeFileSync(path.join(out,'search-keyboard-dark.png'),native('exec-out','screencap','-p'));native('shell','input','keyevent','4');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks:['shell initialized','model keyboard save bounds','native Back cancels','cold memory entry usable','preferences and dark theme','compose picker Back and selection','compose keyboard','announcement popup Back','dark search keyboard colors'],bounds,entryBounds,memoryEntryMs,noticeBounds,searchColors,errors,writes},null,2));console.log('Installed settings checks passed');
 }finally{if(script)await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:script}).catch(()=>{});await call('Fetch.disable').catch(()=>{});ws.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
