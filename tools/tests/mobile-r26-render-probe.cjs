const {targets,connect}=require('./webview-cdp.cjs');
(async()=>{const c=await connect((await targets()).find(t=>t.url.includes('/app/chat.html')));try{
 console.log(await c.evaluate(`(async()=>{const w=document.querySelector('#dialogue-frame').contentWindow;
 const script=await w.eval("import('./script.js')"), {power_user}=await w.eval("import('./scripts/power-user.js')");
 const oldFix=power_user.auto_fix_generated_markdown,oldEncode=power_user.encode_tags;const results=[];
 try{for(const fix of [false,true])for(const encode of [false,true]){
 power_user.auto_fix_generated_markdown=fix;power_user.encode_tags=encode;
 const html=script.messageFormatting('LOADING...',script.name2,false,false,0);
 const doc=new DOMParser().parseFromString(html,'text/html');
 results.push({fix,encode,pre:doc.querySelectorAll('pre').length,bodyInCode:[...doc.querySelectorAll('pre')].map(p=>({length:p.textContent.length,body:p.textContent.includes('<body>'),end:p.textContent.includes('</body>'),start:p.textContent.slice(0,70)})),outside:doc.body.textContent.length});
 }}finally{power_user.auto_fix_generated_markdown=oldFix;power_user.encode_tags=oldEncode;}
 return {settings:{fix:oldFix,encode:oldEncode},results};})()`));
 }finally{c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});
