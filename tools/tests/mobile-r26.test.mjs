import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {protectFrontendFences} from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-html-fences.mjs';
import {greetingSwipes,restoreRenderedGreetings,canReplayGreetingRules} from '../../.web-cache/tree/sillytavern-runtime/public/scripts/homer-greeting-swipes.mjs';
import {normalizeResource,canonicalResourceType} from '../../.web-cache/tree/frontend/app/assets/js/workshop-import.mjs';
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
globalThis.window=new EventTarget();
const source=await readFile(new URL('../../.web-cache/tree/frontend/app/assets/js/recommendations.js',import.meta.url),'utf8');
const rec=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const user={id:'test-a'},other={id:'test-b'};

test('legacy identification never evaluates stateful macros',()=>{
 assert(canReplayGreetingRules('START',[{replaceString:'<body>{{char}} {{user}} {{match}}</body>'}]));
 for(const macro of ['{{setvar::x::1}}','{{random::a::b}}','{{time}}','{{getvar::x}}'])assert(!canReplayGreetingRules('START',[{replaceString:macro}]));
 assert(!canReplayGreetingRules('{{incvar::x}}',[]));
});

test('legacy full-document greetings restore source once, preserving edited swipes and order',()=>{
 const card={data:{first_mes:'START',alternate_greetings:['NEXT']}};
 const first='```\n<html><body><div>START</div></body></html>\n```';
 const next='```html\n<body>NEXT game</body>\n```';
 const render=s=>s==='START'?first:s==='NEXT'?next:s;
 assert.deepEqual(restoreRenderedGreetings(card,[first,'my edited candidate',next],first,render),
  {content:'START',swipes:['START','my edited candidate','NEXT']});
 assert.deepEqual(restoreRenderedGreetings(card,[],first+' edited',render),{content:first+' edited',swipes:[]});
 assert.deepEqual(restoreRenderedGreetings(card,['START','NEXT'],'START',()=>{throw Error('raw messages must not run regex during projection')}),{content:'START',swipes:['START','NEXT']});
 const once=restoreRenderedGreetings(card,[first],first,render);assert.deepEqual(restoreRenderedGreetings(card,once.swipes,once.content,render),once);
 assert.deepEqual(restoreRenderedGreetings(card,[first],first,()=>first),{content:first,swipes:[first]},'ambiguous originals are not guessed');
 assert.deepEqual(restoreRenderedGreetings({data:{first_mes:first}},[first],first,s=>s),{content:first,swipes:[first]},'authored HTML stays authored HTML');
});
test('tag actions are exclusive, persistent and account isolated; partial writes preserve lists',()=>{
 assert(rec.setTagFeedback(user,'奇幻','like'));assert.equal(rec.tagFeedback(user,'奇幻'),'like');
 assert(rec.setTagFeedback(user,'奇幻','dislike'));assert.deepEqual(rec.readPreferences(user).interests,[]);
 assert.equal(rec.tagFeedback(user,'奇幻'),'dislike');assert.equal(rec.tagFeedback(other,'奇幻'),'none');
 rec.writePreferences(user,{enabled:false});assert.deepEqual(rec.readPreferences(user).dislikedTags,['奇幻']);
 assert(rec.setTagFeedback(user,'奇幻','block'));assert.deepEqual(rec.readPreferences(user).dislikedTags,[]);
 assert(rec.setTagFeedback(user,'奇幻','none'));assert.equal(rec.tagFeedback(user,'奇幻'),'none');
});
test('explicit positive/negative feedback changes ranking; blocked tags excluded even with learning off',()=>{
 const items=[{id:'a',tags:['不喜欢']},{id:'b',tags:['普通']},{id:'c',tags:['喜欢']},{id:'d',tags:['屏蔽'],pinned:true}];
 const p={enabled:true,interests:['喜欢'],dislikedTags:['不喜欢'],hiddenTags:['屏蔽'],signals:[]};
 assert.deepEqual(rec.rankRecommendations(items,p).map(x=>x.id),['c','b','a']);
 assert.deepEqual(rec.rankRecommendations(items,{...p,enabled:false}).map(x=>x.id),['a','b','c']);
 assert.equal(items.length,4);
});
test('block matching is exact normalized tag matching, not substring or case bypass',()=>{
 assert.deepEqual(rec.filterRecommendations([{id:1,tags:['ＦＯＯ']},{id:2,tags:['foo']},{id:3,tags:['foobar']}],{hiddenTags:['foo']}).map(x=>x.id),[3]);
});
test('storage failure returns false and does not claim success',()=>{
 const set=localStorage.setItem;localStorage.setItem=()=>{throw Error('quota')};
 assert.equal(rec.setTagFeedback(other,'test','block'),false);localStorage.setItem=set;
});
test('complete indented HTML fences remain one escaped block, ordinary code stays untouched',()=>{
 const html='<html><body>\n<div>标题</div>\n\n    <div>正文 & 内容</div>\n</body></html>';
 const p=protectFrontendFences('前文\n    ```html\n'+html+'\n    ```\n后文');
 assert(!p.markdown.includes('<body>'));const result=p.restore('<p>'+p.markdown.trim()+'</p>');
 assert(result.includes('&lt;body&gt;'));assert(result.includes('&amp; 内容'));assert.equal((result.match(/<pre>/g)||[]).length,1);
 const plain='```js\nconst a=1;\n```';assert.equal(protectFrontendFences(plain).markdown,plain);
 assert.equal(protectFrontendFences('```html\n<body>incomplete\n```').markdown,'```html\n<body>incomplete\n```');
});
test('UI template and regex import share normalization and canonical type; old HTML remains lossless',()=>{
 const input={findRegex:'/猫/g',replaceString:'<b>猫</b>',placement:[2],markdownOnly:true};
 assert.equal(canonicalResourceType('regex'),'ui_template');assert.deepEqual(normalizeResource('regex',input),normalizeResource('ui_template',input));
 assert.equal(normalizeResource('ui_template','<html><body>旧模板</body></html>'),'<html><body>旧模板</body></html>');
});
test('alternate openings survive a cloud-only greeting and repeated hydration',()=>{
 const card={data:{first_mes:'LOADING...',alternate_greetings:['系统加载中...','',null,'LOADING...']}};
 const first=greetingSwipes(card,[],'LOADING...');assert.deepEqual(first,['LOADING...','系统加载中...']);
 assert.deepEqual(greetingSwipes(card,first),first);
 const saved=['LOADING...','模型生成的旧候选'];assert.deepEqual(greetingSwipes(card,saved),[...saved,'系统加载中...']);assert.equal(saved.length,2);
 assert.deepEqual(greetingSwipes(card,['用户编辑的开场']),['用户编辑的开场']);
 assert.deepEqual(greetingSwipes({data:{first_mes:'另一张卡',alternate_greetings:['其他']}},first),first);
});
test('switching an existing opening releases the host generation lock on success and failure',async()=>{
 const bridge=await readFile(new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',import.meta.url),'utf8');
 const start=bridge.indexOf("        if (action === 'swipe-left' || action === 'swipe-right') {");
 const end=bridge.indexOf("        if (['continue', 'regenerate', 'next'].includes(action))",start);
 for(const fail of [false,true]){
  const notices=[];const scope={generationBusy:false,dialogueEventLogMuted:0,document:{body:{classList:{add(){},remove(){}}}},queueMessageMenuRender(){},truncateAfterMessage:async()=>true,resolveMessageMenuTarget:v=>v,logDialogueEvent:async()=>{},scheduleSync(){},scheduleHostStateNotify(){notices.push(scope.generationBusy)}};
  scope.getContext=()=>({swipe:{right:async()=>{scope.scheduleHostStateNotify();if(fail)throw Error('test failure');}}});
  vm.runInNewContext('async function run(action,resolved){'+bridge.slice(start,end)+'}',scope);
  if(fail)await assert.rejects(scope.run('swipe-right',{}),/test failure/);else await scope.run('swipe-right',{});
  assert.deepEqual(notices,[true,false]);assert.equal(scope.generationBusy,false);assert.equal(scope.dialogueEventLogMuted,0);
 }
});
test('disabled EJS code blocks keep bundled template delimiters literal, not executable',async()=>{
 const base=new URL('../../.web-cache/tree/sillytavern-runtime/public/scripts/extensions/third-party/ST-Prompt-Template/',import.meta.url);
 const prompts=await readFile(new URL('src/utils/prompts.ts',base),'utf8');
 const start=prompts.indexOf('function escapeForTemplateLiteral('),end=prompts.indexOf('\n}',start)+2;
 const scope={};vm.runInNewContext(prompts.slice(start,end).replace('(str: string)','(str)'),scope);
 const ejsScope={module:{exports:{}},exports:{}};vm.runInNewContext(await readFile(new URL('src/3rdparty/ejs.js',base),'utf8'),ejsScope);
 const raw='<pre><code>const tmpl="&lt;%= value %&gt;"; const close="%&gt;"; const pct="100%"; ` ${literal} \\n</code></pre>';
 const protectedBlock='&lt;% __append(`'+scope.escapeForTemplateLiteral(raw)+'`) %&gt;';
 assert.equal(ejsScope.module.exports.render(protectedBlock,{}, {openDelimiter:'&lt;',closeDelimiter:'&gt;'}),raw);
 const dist=await readFile(new URL('dist/index.js',base),'utf8');
 // The minifier may rename its symbols on every rebuild. Locate the actual
 // four replace-call escape helper by structure, then verify the complete
 // source/bundle behavior, including the EJS delimiter scanner round trip.
 const helperPattern=String.raw`function\s+[\w$]+\(([\w$]+)\)\{return\s+(\1(?:\.replace\(\/(?:\\.|[^/\\\r\n])+\/[gimuys]*,(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\)){4})\}`;
 const candidates=[...dist.matchAll(new RegExp(helperPattern,'g'))].filter(match=>match[2].includes('.replace(/%/g,'));
 assert.equal(candidates.length,1,'Exactly one bundled literal escape helper must match the audited replace-chain structure');
 const match=candidates[0],compiled=vm.runInNewContext('('+match[1]+')=>'+match[2]);
 for(const input of [raw,'','100% <%= prompt %> ${doNotExecute} ` \\','多行\n%> <% &lt;% &gt; 😀']){
  assert.equal(compiled(input),scope.escapeForTemplateLiteral(input));
  const bundledBlock='&lt;% __append(`'+compiled(input)+'`) %&gt;';
  assert.equal(ejsScope.module.exports.render(bundledBlock,{}, {openDelimiter:'&lt;',closeDelimiter:'&gt;'}),input);
 }
});
