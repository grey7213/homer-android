const fs=require('node:fs'),vm=require('node:vm'),{stripTypeScriptTypes}=require('node:module');
const {visible,connect}=require('./webview-cdp.cjs');
const base='.web-cache/tree/sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template/';
(async()=>{const c=await connect(await visible());try{
 const helpers=stripTypeScriptTypes(fs.readFileSync(base+'src/utils/prompts.ts','utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export ',''));
 const scope={module:{exports:{}},exports:{}};vm.runInNewContext(fs.readFileSync(base+'src/3rdparty/ejs.js','utf8'),scope);
 const data=await c.evaluate(`(async()=>{const w=document.querySelector('#dialogue-frame').contentWindow;const s=await w.eval("import('./script.js')"),ext=await w.eval("import('./scripts/extensions.js')");const raw=s.messageFormatting('系统加载中...',s.name2,false,false,0);return {codeBlocks:ext.extension_settings.EjsTemplate?.code_blocks_enabled,raw,processed:w.eval(${JSON.stringify('(html)=>{'+helpers+';return unescapeHtmlEntities(escapeReasoningBlocks(escapePreContent(html),{options:{openDelimiter:"&lt;",closeDelimiter:"&gt;"}}));}')})(raw)}})()`);
 console.log({codeBlocks:data.codeBlocks,rawLength:data.raw.length,processedLength:data.processed.length});
 for(const key of ['raw','processed']){
  try{scope.module.exports.compile(data[key],{openDelimiter:'&lt;',closeDelimiter:'&gt;',async:true,client:true});console.log(key+': compiled')}catch(e){console.log(key+': '+e.message);try{require('../../.web-cache/tree/sillytavern-runtime/node_modules/acorn').parse('async function f(){'+e.src+'}',{ecmaVersion:'latest'})}catch(syntax){const at=syntax.pos-19;console.log({at,context:e.src?.slice(Math.max(0,at-130),at+130)})}}
 }
}finally{c.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
