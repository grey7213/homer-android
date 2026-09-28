// Mechanical mirror of src/utils/prompts.ts into the checked-in vendor bundle.
// No dependency upgrade or full unrelated vendor rebuild. Refuse other baselines.
const fs=require('node:fs'),path=require('node:path');
const file=path.resolve(__dirname,'../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template/dist/index.js');
const before=String.raw`function Af(e){return e.replace(/\\/g,"\\\\").replace(/`+'`'+String.raw`/g,"\\`+'`'+String.raw`").replace(/\$\{/g,"\\${'${'}")}`;
const after=before.slice(0,-1)+String.raw`.replace(/%/g,"\\x25")}`;
let source=fs.readFileSync(file,'utf8');
if(!source.includes(after)){
 if(source.split(before).length!==2)throw Error('Unexpected prompt-template compiled baseline');
 source=source.replace(before,after);
}
const old=String.raw`v=!1===D.code_blocks_enabled?function(e){const t=(new DOMParser).parseFromString(e,"text/html"),i=Array.from(t.querySelectorAll("pre"));for(const e of i){const t=Af(e.outerHTML),i="&lt;% __append(`+'`'+String.raw`".concat(t,"`+'`'+String.raw`) %&gt;");e.outerHTML=i}return t.body.innerHTML}(n):n;`;
const replacement='const homerLiteralCode=!1===D.code_blocks_enabled?HomerProtectPre(n):null;v=homerLiteralCode?homerLiteralCode.content:n;';
if(!source.includes(replacement)){
 if(source.split(old).length!==2)throw Error('Unexpected pre-block compiled baseline');
 source=source.replace(old,replacement);
 const restoreAt='const o={escaper:u,options:'; // Guard the precise render site below.
 if(!source.includes(replacement+restoreAt))throw Error('Unexpected render options');
 const start=source.indexOf(replacement),end=source.indexOf('decorator:"@@render_after"',start);
 const section=source.slice(start,end),marker=section.lastIndexOf('const ');
 if(marker<0)throw Error('Missing render-after boundary');
 const position=start+marker;
 source=source.slice(0,position)+'m=homerLiteralCode?homerLiteralCode.restore(m):m;'+source.slice(position);
 source='import { protectPreContent as HomerProtectPre } from "../../../../homer-ejs-pre.mjs";\n'+source;
}
fs.writeFileSync(file,source);
console.log('Synchronized bounded vendor escape/pre-block changes with source.');
