// Native WebView acceptance. No mock bridge, no paid model generation.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {wait,connect,visible,navigate,delay}=require('./webview-cdp.cjs');
const out=path.resolve('output/mobile-r26/android');fs.mkdirSync(out,{recursive:true});
const adb=process.env.HOMER_TEST_ADB||'D:/Android/Sdk/platform-tools/adb.exe';
(async()=>{const result={settings:[],failures:[]},clients=[];let c,prefs;
try{
 c=await connect(await visible());clients.push(c);const base=await c.evaluate('location.origin');
 const go=async url=>{result.stage='navigate:'+url.split('?')[0];c=await navigate(c,base+url);clients.push(c);await wait(()=>c.evaluate(`location.pathname===${JSON.stringify(url.split('?')[0])}&&document.readyState==='complete'&&!!document.body?.children.length&&!document.querySelector('[x-cloak]')`));};
 const run=expression=>c.evaluate(`(async()=>{const w=window.document.querySelector('#dialogue-frame').contentWindow;const document=w.document;return (${expression});})()`);
 const click=selector=>run(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const shot=name=>fs.writeFileSync(path.join(out,name+'.png'),execFileSync(adb,['-s','emulator-5554','exec-out','screencap','-p'],{maxBuffer:10*1024*1024}));
 const close=()=>run(`(()=>{const d=[...document.querySelectorAll('dialog[open]')].at(-1);if(d?.dispatchEvent(new w.Event('cancel',{cancelable:true})))d.close();})()`);
 const chatReady=id=>wait(()=>c.evaluate(`document.body.classList.contains('is-ready')&&(()=>{const c=document.querySelector('#dialogue-frame')?.contentWindow?.SillyTavern?.getContext();return c?.characters?.[c.characterId]?.data?.extensions?.homer_bridge?.app_id===${JSON.stringify(id)}})()`),60000);
 result.stage='read-preferences';prefs=await c.evaluate(`(async()=>{const r=await import('/app/assets/js/recommendations.js');const {getCachedUser}=await import('/app/assets/js/app-core.js?v=20260917-r8');return r.readPreferences(getCachedUser());})()`);
 // Use real authorized catalog candidates, not fabricated feed data.
 await go('/app/explore.html');
 const candidate=await wait(()=>c.evaluate(`(()=>{const p=window.Alpine?.$data(document.querySelector('[x-data]'));if(!p||p.loading)return null;const card=p._candidateCards.find(c=>c.tags?.length);return card?{id:card.id,tags:[...card.tags]}:null;})()`));
 const exploreId=c.target.id;
 result.stage='tag';const tag=candidate.tags[0];
 await go('/app/character.html?id='+encodeURIComponent(candidate.id));
 const selector='[data-feedback-tag='+JSON.stringify(tag)+']';
 await wait(()=>c.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`));
 const point=await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
 await delay(150);
 await c.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await delay(550);await c.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await wait(()=>c.evaluate("!!document.querySelector('.tag-feedback-menu[open]')"));shot('tag-long-press');
 await c.evaluate("document.querySelector('[data-feedback-action=block]').click()");
 await go('/app/explore.html');
 assert.equal(c.target.id,exploreId,'Explore should retain its WebView');
 await wait(()=>c.evaluate(`(()=>{const p=window.Alpine.$data(document.querySelector('[x-data]'));return !p.cards.some(x=>x.tags.includes(${JSON.stringify(tag)}))&&!p.featuredPool.some(x=>x.tags.includes(${JSON.stringify(tag)}));})()`));
 result.tagBlockOnRetainedExplore=true;
 await c.evaluate(`(async()=>{const r=await import('/app/assets/js/recommendations.js');const {getCachedUser}=await import('/app/assets/js/app-core.js?v=20260917-r8');r.writePreferences(getCachedUser(),${JSON.stringify(prefs)});})()`);
 await wait(()=>c.evaluate(`window.Alpine.$data(document.querySelector('[x-data]')).cards.some(x=>x.id===${JSON.stringify(candidate.id)})`));result.tagUndoWithoutReload=true;
 result.stage='import-settings-card';const app=await c.evaluate(`(async()=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.importCard({spec:'chara_card_v2',spec_version:'2.0',data:{name:'R26 原生设置验收',first_mes:'这是一条可搜索的真实消息。'}})).data})()`);
 await go('/app/chat.html?app_id='+encodeURIComponent(app.id));
 await chatReady(app.id);
 for(const theme of ['light','dark']){
  await run(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.toggleAttribute('data-homer-dark',${theme==='dark'});localStorage.setItem('ai_xingyue_shell_theme',${JSON.stringify(theme)});})()`);
  await click('.homer-header-button:last-child');
  await wait(()=>run(`document.querySelector('#homer-right-drawer').classList.contains('is-open')&&document.querySelectorAll('#homer-right-drawer .homer-control-card').length===5&&[...document.querySelectorAll('#homer-right-drawer .homer-control-card')].every(e=>w.getComputedStyle(e).visibility==='visible')`),1000);
  await delay(500);assert(await run(`document.querySelector('#homer-right-drawer').classList.contains('is-open')`));shot('menu-'+theme);await click('#homer-right-drawer header button');
  for(const [key,selector] of [['model','#homer-open-model-settings'],['preset','#homer-open-preset-settings'],['memory','#homer-open-memory-books'],['mod','#homer-open-mods'],['appearance','[data-control=appearance]']]){
   result.stage='settings:'+theme+':'+key;const start=Date.now();await click(selector);await wait(()=>run(`!!document.querySelector('dialog[open].homer-settings-page')?.getClientRects().length`));
   const timing=Date.now()-start;
   assert(await run(`(()=>{const e=document.querySelector('dialog[open].homer-settings-page');return !!e.querySelector('h2')?.innerText && e.scrollWidth<=e.clientWidth+1})()`),key+' layout');
   if(key==='memory'){assert(await run(`!document.querySelector('dialog[open]').innerText.includes('当前会话还未连接')`));result['memoryMs-'+theme]=timing;}
   if(key==='model'){
    const original=await run(`document.querySelector('#homer-model-dialog input[type=number]').value`);
    await run(`(()=>{const e=document.querySelector('#homer-model-dialog input[type=number]');e.value='0.65';e.dispatchEvent(new w.Event('input',{bubbles:true}));})()`);
    await click('#homer-model-dialog .homer-settings-page__save');
    await wait(()=>run(`!document.querySelector('#homer-model-dialog').open`));await click(selector);
    assert.equal(await run(`document.querySelector('#homer-model-dialog input[type=number]').value`),'0.65');
    await run(`(()=>{const e=document.querySelector('#homer-model-dialog input[type=number]');e.value=${JSON.stringify(original)};e.dispatchEvent(new w.Event('input',{bubbles:true}));})()`);
    await click('#homer-model-dialog .homer-settings-page__save');await wait(()=>run(`!document.querySelector('#homer-model-dialog').open`));await click(selector);
    await click('#homer-model-select');await wait(()=>run(`!!document.querySelector('.homer-option-picker[open]')`));shot('model-picker-'+theme);await close();
    result.modelSaveRestore=true;
   }
   await delay(150);shot(key+'-'+theme);
   const current=await c.evaluate('location.href');execFileSync(adb,['-s','emulator-5554','shell','input','keyevent','4']);
   await wait(()=>run(`!document.querySelector('dialog[open].homer-settings-page')`));assert.equal(await c.evaluate('location.href'),current);
   result.settings.push(theme+':'+key);
  }
 }
 // Search/statistics preserve the live message list and return to it.
 for(const kind of ['search','stats']){
  await run(`(async()=>{const {openChatTool}=await w.eval("import('/assets/js/chat-tools.js')");openChatTool(${JSON.stringify(kind)},{container:document.querySelector('#chat'),selector:'.mes',isUser:e=>e.getAttribute('is_user')==='true',title:'验收对话'});})()`);
  if(kind==='search'){
   await run(`(()=>{const i=document.querySelector('#homer-chat-tool input');i.value='可搜索';i.dispatchEvent(new w.Event('input'));})()`);
   assert(await run(`document.querySelector('#homer-chat-tool [role=status]').textContent.includes('1 条')`));
  }
  shot(kind);await close();result.settings.push(kind);
 }
 const encoded=fs.readFileSync('D:/网站/案例1/Image_1790181493425_437.png').toString('base64');
 const card=await c.evaluate(`(async()=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.importCard({card_file:'data:image/png;base64,'+${JSON.stringify(encoded)},filename:'case1.png'})).data})()`);
 await go('/app/chat.html?app_id='+encodeURIComponent(card.id));
 await chatReady(card.id);
 const rendered=()=>run(`document.querySelectorAll('#chat iframe[id^=TH-message]').length===1&&!([...document.querySelectorAll('#chat pre')].some(e=>e.getClientRects().length))`);
 await wait(rendered,30000);await delay(400);shot('case1');
 result.case1Rendered=true;
 const caseUrl=await c.evaluate('location.pathname+location.search');
 await go('/app/histories.html');await wait(()=>c.evaluate(`document.body.innerText.includes(${JSON.stringify(card.name)})`));
 await go(caseUrl);await wait(rendered);result.case1HistoryReopens=true;
 const fixture='    ```html\n<html><body>\n<div>标题</div>\n\n    <div>正文</div>\n</body></html>\n    ```';
 const ordinary=await run(`(async()=>{const s=await w.eval("import('./script.js')");const d=new DOMParser().parseFromString(s.messageFormatting(${JSON.stringify(fixture)},s.name2,false,false,-1),'text/html');return d.querySelectorAll('pre').length===1&&d.querySelector('pre').textContent.includes('</body>')&&!d.body.querySelector('div');})()`);
 assert(ordinary);result.indentedHtmlFixed=true;
 await run(`(()=>{[...document.querySelectorAll('link[rel=stylesheet]')].filter(l=>/slash-runner.*index.css/i.test(l.href)).forEach(l=>l.disabled=true);const p=document.createElement('pre');p.id='r26-ordinary';p.textContent='const ordinary=1;';document.querySelector('#chat .mes_text').append(p);})()`);
 assert(await run(`!!document.querySelector('#r26-ordinary').getClientRects().length&&!([...document.querySelectorAll('#chat pre:not(#r26-ordinary)')].some(e=>e.getClientRects().length))`));
 await run(`(()=>{document.querySelector('#r26-ordinary').remove();[...document.querySelectorAll('link[rel=stylesheet]')].filter(l=>/slash-runner.*index.css/i.test(l.href)).forEach(l=>l.disabled=false);})()`);
 result.missingHelperCssSafe=true;
 console.log(JSON.stringify(result));
}catch(error){result.failures.push(error.message);console.error(result.stage,error.stack);process.exitCode=1;}
finally{
 if(prefs&&c)try{await c.evaluate(`(async()=>{const r=await import('/app/assets/js/recommendations.js');const {getCachedUser}=await import('/app/assets/js/app-core.js?v=20260917-r8');r.writePreferences(getCachedUser(),${JSON.stringify(prefs)});})()`);}catch{}
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));for(const client of clients)client.close();
}})();
