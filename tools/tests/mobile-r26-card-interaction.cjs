const fs=require('node:fs'),assert=require('node:assert/strict');const{targets,connect,wait,delay}=require('./webview-cdp.cjs');
(async()=>{const c=await connect((await targets()).find(t=>t.url.includes('/app/chat.html')));try{
 const run=expression=>c.evaluate(`(async()=>{const w=window.document.querySelector('#dialogue-frame').contentWindow;return (${expression});})()`);
 const original=await run(`(()=>{const m=w.SillyTavern.getContext().chat[0];return {index:m.swipe_id||0,count:m.swipes?.length||0};})()`);
 assert(original.count>1,'Need the case card with an existing alternate opening; never generate a new swipe');
 if(original.index===1){await run(`w.document.querySelector('.homer-opening-nav button[aria-label="上一个开场"]').click()`);await wait(()=>run(`w.SillyTavern.getContext().chat[0].swipe_id===0`));}
 await wait(()=>run(`!!w.document.querySelector('.homer-opening-nav button[aria-label="下一个开场"]:not(:disabled)')`));
 await run(`w.document.querySelector('.homer-opening-nav button[aria-label="下一个开场"]').click()`);
 await wait(()=>run(`w.SillyTavern.getContext().chat[0].swipe_id===1&&w.document.querySelectorAll('#chat iframe[id^=TH-message]').length===1`),30000);
 await wait(()=>run(`(()=>{const f=w.document.querySelector('#chat iframe[id^=TH-message]')?.contentDocument?.querySelector('iframe');return f?.contentDocument?.body?.innerText.includes('开始游戏')})()`),30000);
 const rendered=await run(`(()=>{const d=w.document;const frame=d.querySelector('#chat iframe[id^=TH-message]');const inner=frame.contentDocument.querySelector('iframe').contentDocument;return {index:w.SillyTavern.getContext().chat[0].swipe_id,visibleSource:[...d.querySelectorAll('#chat pre')].some(e=>e.getClientRects().length),frameHeight:frame.clientHeight,errors:[...d.querySelectorAll('.toast-error')].filter(e=>e.getClientRects().length).length,buttons:[...inner.querySelectorAll('button')].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent.trim().slice(0,50),id:e.id})).slice(0,20)};})()`);
 assert(!rendered.visibleSource&&rendered.frameHeight>0&&rendered.errors===0);console.log(JSON.stringify(rendered));
 const shot=await c.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('output/mobile-r26/android/case1-alternate.png',Buffer.from(shot.data,'base64'));
 fs.writeFileSync('output/mobile-r26/android/case1-alternate.json',JSON.stringify(rendered,null,2));
 await run(`(()=>{const d=w.document.querySelector('#chat iframe[id^=TH-message]').contentDocument.querySelector('iframe').contentDocument;[...d.querySelectorAll('button')].find(e=>e.textContent.includes('开始游戏')).click()})()`);
 await wait(()=>run(`!w.document.querySelector('#chat iframe[id^=TH-message]').contentDocument.querySelector('iframe').contentDocument.body.innerText.includes('开始游戏')`));
 const interactive=await c.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('output/mobile-r26/android/case1-interactive.png',Buffer.from(interactive.data,'base64'));
 await wait(()=>run(`!!w.document.querySelector('.homer-opening-nav button[aria-label="上一个开场"]:not(:disabled)')`));
 await run(`w.document.querySelector('.homer-opening-nav button[aria-label="上一个开场"]').click()`);
}finally{c.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
