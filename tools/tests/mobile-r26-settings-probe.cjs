const fs=require('node:fs'),path=require('node:path');const {targets,connect,delay}=require('./webview-cdp.cjs');
const out=path.resolve('output/mobile-r26/before');fs.mkdirSync(out,{recursive:true});
(async()=>{const c=await connect((await targets()).find(t=>t.url.includes('/app/chat.html')));try{
 const run=expression=>c.evaluate(`(()=>{const w=window.document.querySelector('#dialogue-frame').contentWindow;const document=w.document;return (${expression});})()`);
 for(const [key,selector] of [['model','#homer-open-model-settings'],['preset','#homer-open-preset-settings'],['memory','#homer-open-memory-books'],['mod','#homer-open-mods'],['appearance','[data-control="appearance"]']]){
 await run(`document.querySelector(${JSON.stringify(selector)}).click()`);await delay(600);
 const shot=await c.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,key+'.png'),Buffer.from(shot.data,'base64'));
 console.log(key,await run(`[...document.querySelectorAll('dialog[open]')].map(d=>({id:d.id,text:d.innerText.slice(0,450)}))`));
 await run(`(()=>{for(const d of document.querySelectorAll('dialog[open]')){if(d.dispatchEvent(new w.Event('cancel',{cancelable:true})))d.close();}document.querySelector('#homer-preset-panel').hidden=true;})()`);
 }
 }finally{c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});
