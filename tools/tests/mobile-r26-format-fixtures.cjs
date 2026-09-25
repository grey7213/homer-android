const {targets,connect}=require('./webview-cdp.cjs');
(async()=>{const c=await connect((await targets()).find(t=>t.url.includes('/app/chat.html')));try{
 const samples=[
  '```html\n<!doctype html><html><body>\n<div>标题</div>\n\n    <div>正文</div>\n</body></html>\n```',
  '    ```html\n<!doctype html><html><body>\n<div>标题</div>\n\n    <div>正文</div>\n</body></html>\n    ```',
  '```html\n<html><body><div>标题</div>\n<script>const example="```";</script>\n<div>正文</div></body></html>\n```'
 ];
 console.log(JSON.stringify(await c.evaluate(`(async()=>{const w=document.querySelector('#dialogue-frame').contentWindow;const s=await w.eval("import('./script.js')");return ${JSON.stringify(samples)}.map(raw=>{const html=s.messageFormatting(raw,s.name2,false,false,-1);const doc=new DOMParser().parseFromString(html,'text/html');return {pre:doc.querySelectorAll('pre').length,full:[...doc.querySelectorAll('pre')].some(p=>p.textContent.includes('<body>')&&p.textContent.includes('</body>')),outside:doc.body.querySelector('div')?.outerHTML?.slice(0,100)};});})()`)));
 }finally{c.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});
