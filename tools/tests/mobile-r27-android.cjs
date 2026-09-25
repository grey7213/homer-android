// Cover an in-place upgrade with a real legacy greeting, not a clean install.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {wait,connect,visible,navigate,targets,delay}=require('./webview-cdp.cjs');
const out=path.resolve('output/mobile-r27/android');fs.mkdirSync(out,{recursive:true});
const stateFile=path.join(out,'fixture.json'),adb='D:/Android/Sdk/platform-tools/adb.exe';
(async()=>{let c;const clients=[];try{
 c=await connect(await visible());clients.push(c);const base=await c.evaluate('location.origin');
 const go=async url=>{c=await navigate(c,base+url);clients.push(c);await wait(()=>c.evaluate(`location.pathname===${JSON.stringify(url.split('?')[0])}&&document.readyState==='complete'&&!!document.body?.children.length&&!document.querySelector('[x-cloak]')`),60000)};
 const run=expression=>c.evaluate(`(async()=>{const w=document.querySelector('#dialogue-frame')?.contentWindow;return (${expression})})()`);
 const shot=name=>fs.writeFileSync(path.join(out,name+'.png'),execFileSync(adb,['-s','emulator-5554','exec-out','screencap','-p']));
 let fixture;
 if(process.argv.includes('--seed-old')||process.argv.includes('--prepare-legacy')){
  const file=fs.readFileSync('D:/网站/案例1/Image_1790181493425_437.png').toString('base64');
  fixture=await c.evaluate(`(async()=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');const app=(await api.importCard({card_file:'data:image/png;base64,'+${JSON.stringify(file)},filename:'case1.png'})).data;const conv=(await api.startConversation({app_id:app.id})).data;const card=(await api.appDetails(app.id)).data;const old=card.regex_scripts[0].replace;await api.editMessage(conv.messages[0].id,old);return {app:app.id,conversation:conv.conversation_id,message:conv.messages[0].id,oldLength:old.length}})()`);
  fs.writeFileSync(stateFile,JSON.stringify(fixture,null,2));
  if(process.argv.includes('--prepare-legacy')){console.log('Prepared isolated legacy fixture without modifying any existing user conversation');return;}
 }else fixture=JSON.parse(fs.readFileSync(stateFile));
 await go('/app/chat.html?app_id='+fixture.app+'&conversation_id='+fixture.conversation);
 await wait(()=>c.evaluate(`document.body.classList.contains('is-ready')&&document.querySelector('#dialogue-frame')?.contentWindow?.SillyTavern?.getContext()?.chat?.length>0`),90000);
 await wait(()=>run(`w.document.querySelectorAll('#chat iframe[id^=TH-message]').length>0`),30000);
 const probe=()=>run(`(()=>{const d=w.document,ctx=w.SillyTavern.getContext();return {sourceVisible:[...d.querySelectorAll('#chat pre')].filter(e=>e.getClientRects().length).length,sourceLength:ctx.chat[0].mes.length,swipes:ctx.chat[0].swipes.map(s=>s.length),nav:!!d.querySelector('.homer-opening-nav'),innerSource:[...d.querySelectorAll('#chat iframe')].some(f=>f.contentDocument?.body?.innerText.includes('<div class=')),conversation:new URL(location.href).searchParams.get('conversation_id')}})()`);
 if(process.argv.includes('--seed-old')){
  await delay(300);const before=await probe();shot('before-upgrade');console.log(JSON.stringify(before));assert(before.sourceVisible>0,'Must reproduce the phone source block on the actual old APK');return;
 }
 await wait(()=>run(`w.document.querySelector('#chat iframe[id^=TH-message]')?.contentDocument?.body?.innerText.includes('必备前置插件')`),30000);
 await wait(()=>run(`(()=>{const f=w.document.querySelector('#chat iframe[id^=TH-message]');return f.clientHeight>500&&Math.abs(f.clientHeight-f.contentDocument.body.getBoundingClientRect().height)<5})()`),15000);
 await wait(async()=>!(await probe()).sourceVisible,10000);
 const after=await probe();assert.equal(after.sourceLength,10);assert(after.nav&&!after.innerSource);assert.equal(after.conversation,fixture.conversation);await run(`w.document.querySelector('#chat').scrollTop=0`);await delay(200);shot('after-upgrade');
 const visit=await c.evaluate(`(async()=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');const r=(await api.conversations()).data;return r.list.filter(x=>x.id===${JSON.stringify(fixture.conversation)}).length})()`);assert.equal(visit,1);
 await run(`w.document.querySelector('.homer-opening-nav [aria-label="下一个开场"]').click()`);
 await wait(()=>run(`w.document.querySelector('#chat iframe[id^=TH-message]')?.contentDocument?.querySelector('iframe')?.contentDocument?.body?.innerText.includes('开始游戏')`),30000);
 assert.equal((await probe()).sourceVisible,0);
 await run(`(()=>{const d=w.document.querySelector('#chat iframe[id^=TH-message]').contentDocument.querySelector('iframe').contentDocument;[...d.querySelectorAll('button')].find(e=>e.textContent.includes('开始游戏')).click()})()`);
 await wait(()=>run(`(()=>{const f=w.document.querySelector('#chat iframe[id^=TH-message]')?.contentDocument?.querySelector('iframe'),d=f?.contentDocument;if(!d?.body?.innerText.includes('选择你的身份'))return false;const heading=[...d.querySelectorAll('h1,h2,h3')].find(e=>e.textContent.includes('选择你的身份'));if(!heading?.getClientRects().length)return false;for(let e=heading;e;e=e.parentElement){const s=f.contentWindow.getComputedStyle(e);if(Number(s.opacity)<.99||s.visibility!=='visible')return false;}return d.getAnimations().every(a=>a.playState!=='running'||a.effect.getComputedTiming().iterations===Infinity)})()`),15000);await delay(200);shot('interactive');
 await go('/app/workshop.html');await wait(()=>c.evaluate("!!document.querySelector('.ws-quicknav')?.getClientRects().length"));
 const labels=await c.evaluate("[...document.querySelectorAll('.ws-quicknav .ws-navitem')].map(e=>({text:e.querySelector('strong').innerText.trim(),small:e.querySelectorAll('small').length,height:e.querySelector('strong').getBoundingClientRect().height,line:parseFloat(getComputedStyle(e.querySelector('strong')).lineHeight)}))");
 assert(labels.every(x=>x.small===0&&x.height<=x.line+1));assert(labels.some(x=>x.text==='界面模板'));shot('workshop');
 await c.evaluate("document.querySelector('.ws-quicknav a[href*=ui_template]').click()");c=await connect(await wait(()=>visible('/app/workshop-resource.html')));clients.push(c);
 await wait(()=>c.evaluate("document.querySelector('#resource-title')?.textContent==='界面模板'"));shot('template-list');
 await go('/app/histories.html');await wait(()=>c.evaluate(`!!document.querySelector('a[href*=${JSON.stringify(fixture.conversation)}]')`));
 await c.evaluate(`document.querySelector('a[href*=${JSON.stringify(fixture.conversation)}]').click()`);c=await connect(await wait(()=>visible('/app/chat.html')));clients.push(c);
 await wait(()=>run(`w?.document.querySelector('.homer-opening-nav')&&w.SillyTavern.getContext().chat.length`),60000);
 if(await run(`w.SillyTavern.getContext().chat[0].swipe_id>0`))await run(`w.document.querySelector('.homer-opening-nav [aria-label="上一个开场"]').click()`);
 await wait(()=>run(`(()=>{const f=w.document.querySelector('#chat iframe[id^=TH-message]');return f?.contentDocument?.body?.innerText.includes('必备前置插件')&&f.clientHeight>500&&Math.abs(f.clientHeight-f.contentDocument.body.getBoundingClientRect().height)<5})()`));assert.equal((await probe()).sourceVisible,0);await run(`w.document.querySelector('#chat').scrollTop=0`);await delay(200);shot('history-reopen');
 const start=Date.now();await run(`w.document.querySelector('#homer-open-memory-books').click()`);await wait(()=>run(`!!w.document.querySelector('dialog[open].homer-settings-page')`));
 const memoryMs=Date.now()-start;assert(!await run(`w.document.querySelector('dialog[open]').innerText.includes('当前会话还未连接')`));
 await run(`w.document.querySelector('dialog[open] .homer-settings-page__back').click()`);
 const result={upgrade:after,historyPreserved:true,historyReopened:true,interactive:true,workshop:labels,memoryMs};fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{clients.forEach(x=>x.close())}})().catch(e=>{console.error(e.message);process.exitCode=1});
