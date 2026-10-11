// Independent browser contract journey: real editor DOM, extracted shipping
// runtime methods and actual sender. All API data and identities are synthetic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Install Playwright in the workspace, or explicitly supply an existing
// module directory. Never pin a contributor's desktop-app installation.
const { chromium } = require(process.env.HOMER_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'output/repair-20261011/admin-workspace-browser');
const runtimeFile = path.join(root, 'sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js');
const senderFile = path.join(root, 'sillytavern-runtime/public/scripts/openai.js');
const runtime = await readFile(runtimeFile, 'utf8'), sender = await readFile(senderFile, 'utf8');
function section(source, begin, end) {
  const first = source.indexOf(begin), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `shipping boundary ${begin}`);
  return source.slice(first, last);
}
const settingsListener = section(runtime,
  '    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, async data => {',
  "    window.addEventListener('homer-generation-diagnostic'");
const sourceDigests = Object.fromEntries([['runtime',runtime],['sender',sender]].map(([name,value])=>[name,createHash('sha256').update(value).digest('hex')]));
const fixtureScript = `
import { adminWorkspace } from '/scripts/extensions/homer-bridge/admin-workspace.js';
import { apiText } from '/assets/js/api-transport.js';
import { setOfficialDisplayRules } from '/scripts/homer-official-regex.mjs';
import { attachHomerGenerationIntent } from '/scripts/homer-generation-intent.mjs';
import { EventEmitter } from '/lib/eventemitter.js';
const eventSource = new EventEmitter();
const event_types = {CHAT_COMPLETION_SETTINGS_READY:'fixture-settings'};
let session = {user:{id:'synthetic-owner',is_admin:true}}, currentOwner='synthetic-owner', storageAccountEpoch=1;
let launch={admin_preview:true,bridge_token:'synthetic-owner-only-token',app_id:'synthetic-card',conversation_id:'synthetic-preview'};
let loadingLaunch=false,generationBusy=false,rollbackBusy=false,generating=false,conversationRecoveryBlocked=false;
let officialRegexState={count:0,errors:[]};
const notices=[];
const isGenerating=()=>generating;
const reconcileStorageAccount=()=>currentOwner;
const conversationModelSettings=()=>({model_id:'synthetic-model'});
const showHostNotice=(message,kind)=>{notices.push({message,kind});};
const setDrawerOpen=()=>document.querySelector('#homer-right-drawer').hidden=false;
const getRequestHeaders=()=>({'Content-Type':'application/json','X-Fixture-Owner':currentOwner,'X-Fixture-Bridge':launch?.bridge_token||''});
const context={characterId:0,characters:[{data:{extensions:{homer_bridge:{app_id:'synthetic-card'}}}}],
  chatId:'Homer-synthetic-preview',chatMetadata:{homer_bridge:{user_id:'synthetic-owner',app_id:'synthetic-card',conversation_id:'synthetic-preview',runtime:'dialogue'}}};
const getContext=()=>context;
${section(runtime,'function unwrap(', 'function runtimeGate(')}
${section(runtime,'async function requestJson(', 'function queryString(')}
${section(runtime,'let adminConversationDraft =', 'const MODULE_ID =')}
${section(runtime,'function hasCanonicalConversationScope(', 'function captureConversationRecovery(')}
${section(runtime,'function openHostRequestedSettings(', 'async function receiveHostCommand(')}
// Only the admin branch of regex refresh is exercised. Ordinary card regex
// resolution and its stores are not replaced or claimed as covered here.
async function refreshOfficialRegex(modelId=''){ if(!launch?.admin_preview)throw Error('Not an admin fixture'); await refreshAdminConfiguration(modelId); }
async function refreshBridgeToken(){throw Error('Fixture never acquires tokens');}
const oai_settings={custom_include_body:''},homerGameGenerationGuardFactory=null;
const getChatCompletionModel=()=> 'synthetic-model';
const beginDiagnostic=()=>({}); const finishDiagnostic=()=>{};
const requireAvailableModel=()=>{};
// Prompt assembly is a synthetic boundary; the actual sender, settings event,
// request-local body merge and browser fetch below are shipping code.
async function createGenerationParameters(_settings,model,_type,messages){return {generate_data:{model,messages,custom_include_headers:'X-Homer-Module: dialogue-module'},stream:false};}
const yaml={parse:JSON.parse}; const generationFailure=()=>Error('Synthetic request failed');
const observeDiagnostic=(diagnostic,_data,text)=>diagnostic.output_chars=text.length;
const checkQuotaError=()=>{},checkModerationError=()=>{},parseChatCompletionLogprobs=()=>{},saveLogprobsForActiveMessage=()=>{};
const delay=async()=>{},toastr={error:showHostNotice};
${settingsListener}
${section(sender,'async function sendOpenAIRequest(', 'export function getStreamingReply(')}
for(const button of document.querySelectorAll('[data-open-admin]')) button.addEventListener('click',()=>void openHostRequestedSettings(button.dataset.openAdmin));
window.adminFixture={
  get draft(){return structuredClone(adminConversationDraft);}, get config(){return structuredClone(adminConversationConfig);},
  get notices(){return structuredClone(notices);}, get scope(){return {owner:currentOwner,epoch:storageAccountEpoch,launch:structuredClone(launch)};},
  change(flags={}){if('owner'in flags)currentOwner=flags.owner;if('epoch'in flags)storageAccountEpoch=flags.epoch;
    if('admin'in flags)session.user.is_admin=flags.admin;if('busy'in flags)generationBusy=generating=flags.busy;
    if('preview'in flags)launch.admin_preview=flags.preview;if('token'in flags)launch.bridge_token=flags.token;
    if(flags.replaceLaunch)launch={...launch};},
  open:openHostRequestedSettings,
  generate:type=>sendOpenAIRequest(type,[{role:'assistant',content:'Synthetic prior paragraph'}]),
}; window.adminFixtureReady=true;
`;
const html = `<!doctype html><html class="homer-admin-preview"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated administrator workspace verification</title>
<style>html,body{margin:0;height:100%;font:14px system-ui;background:#f4f5f7;color:#20242b;--site-text:#20242b;--site-text-soft:#667085;--site-panel:#fff;--site-panel-soft:#f4f5f7;--site-border:#d5d9e0}#fixture-controls{padding:12px;display:flex;gap:8px;flex-wrap:wrap}#fixture-controls button{padding:10px;border:1px solid #ccc;border-radius:8px}#homer-right-drawer{height:calc(100dvh - 76px);width:min(440px,100%);box-sizing:border-box;position:absolute;right:0;bottom:0}</style>
<nav id="fixture-controls"><button data-open-admin="admin-prompt">打开预设</button><button data-open-admin="admin-worldbook">打开世界书</button><button data-open-admin="admin-regex">打开正则</button></nav>
<aside hidden id="homer-right-drawer" class="homer-admin-settings"></aside><script type="module" src="/fixture-runtime.js"></script></html>`;
const seed = {
  prompt:{id:'synthetic-preset',name:'合成预设',enabled:true,blocks:[{id:'synthetic-prompt-row',name:'合成预设条目',content:'Default prompt',enabled:true,role:'system',order:0}]},
  worldbook:[{id:'synthetic-world-row',name:'合成世界条目',content:'Default world',enabled:true,role:'system',keys:[],secondary_keys:[],constant:true,order:0,position:'system',depth:0,probability:100}],
  regex:{id:'synthetic-regex',name:'合成正则',enabled:true,scripts:[{id:'synthetic-rule',scriptName:'合成规则',findRegex:'/synthetic/g',replaceString:'Default replacement',placement:[2],markdownOnly:true,disabled:false}]},
  library:{prompt:{items:[]},regex:{items:[]}},
};
const apiCalls=[], failures=[], journeys=[];
let holdResponse=null, holdNext=false;
async function waitHeldResponse(){
  const deadline=Date.now()+8000;
  while(!holdResponse&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(holdResponse,'the actual configuration request reached its controlled response boundary');
}
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture.invalid'),p=url.pathname;
  function send(value,status=200,mime='application/json'){const body=typeof value==='string'?value:JSON.stringify(value);res.writeHead(status,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(body);}
  try{
    if(p==='/fixture')return send(html,200,'text/html');
    if(p==='/fixture-runtime.js')return send(fixtureScript,200,'text/javascript');
    if(req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      apiCalls.push({path:p,owner:req.headers['x-fixture-owner'],body});
      if(p==='/api/homer/admin-configuration'){
        assert.equal(req.headers['x-fixture-bridge'],'synthetic-owner-only-token');
        const config={...structuredClone(seed),...body.draft};config.display_regex={scripts:config.regex?.enabled?config.regex.scripts.filter(rule=>!rule.disabled):[]};
        if(holdNext){holdNext=false;holdResponse=()=>send({data:config});return;}
        return send({data:config});
      }
      if(p==='/api/backends/chat-completions/generate')return send({choices:[{message:{content:'Synthetic generated reply; no external model contacted'}}]});
      throw Error('Unexpected mutating fixture path '+p);
    }
    const base=p.startsWith('/assets/')?path.join(root,'.web-cache/tree/frontend'):path.join(root,'sillytavern-runtime/public');
    const resolved=path.resolve(base,'.'+p);assert.ok(resolved.startsWith(base+path.sep));
    const body=await readFile(resolved);res.writeHead(200,{'Content-Type':p.endsWith('.css')?'text/css':'text/javascript','Cache-Control':'no-store'});res.end(body);
  }catch(error){failures.push({kind:'fixture-server',message:error.message});send({error:'Isolated fixture failure'},500);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  await mkdir(output,{recursive:true});
  browser=await chromium.launch({executablePath:'C:/Users/ROG/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',headless:true});
  for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
    const context=await browser.newContext({viewport}),page=await context.newPage();page.setDefaultTimeout(8000);
    page.on('pageerror',error=>failures.push({kind:'script',viewport,message:error.message}));
    page.on('console',message=>{if(message.type()==='error')failures.push({kind:'console',viewport,message:message.text()});});
    page.on('requestfailed',request=>failures.push({kind:'network',viewport,url:request.url(),message:request.failure()?.errorText}));
    page.on('response',response=>{if(response.status()>=400)failures.push({kind:'http',viewport,url:response.url(),status:response.status()});});
    await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
    await page.goto(base+'/fixture');await page.waitForFunction(()=>window.adminFixtureReady);
    const edits={prompt:'Edited synthetic prompt',worldbook:'Edited synthetic world',regex:'Edited replacement'};
    for(const [kind,label]of [['prompt','预设'],['worldbook','世界书'],['regex','正则']]){
      await page.getByRole('button',{name:'打开'+label,exact:true}).click();
      await page.getByRole('heading',{name:label,exact:true}).waitFor();
      await page.locator('.haw-entry summary').first().click();
      await page.getByLabel(kind==='regex'?'替换内容':'内容',{exact:true}).fill(edits[kind]);
      await page.getByRole('button',{name:'应用到本次会话',exact:true}).click();
      await page.getByRole('status').filter({hasText:'已应用于本次会话，下一轮生成生效'}).waitFor();
      const draft=await page.evaluate(()=>adminFixture.draft);
      assert.equal(kind==='prompt'?draft.prompt.blocks[0].content:kind==='worldbook'?draft.worldbook[0].content:draft.regex.scripts[0].replaceString,edits[kind]);
      const bounds=await page.locator('.haw-editor').boundingBox();assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1);
      await page.screenshot({path:path.join(output,`${viewport.width}-${kind}.png`)});
      await page.getByRole('button',{name:'‹ 返回',exact:true}).click();
      journeys.push({viewport,kind,result:'real DOM open/edit/apply passed'});
    }
    await page.evaluate(()=>adminFixture.generate('continue'));
    const post=apiCalls.filter(call=>call.path.endsWith('/generate')).at(-1).body;
    const included=JSON.parse(post.custom_include_body);
    assert.equal(included.homer_generation_type,'continue');assert.deepEqual(included.homer_preview,await page.evaluate(()=>adminFixture.draft));
    assert.equal(included.homer_preview.prompt.blocks[0].content,edits.prompt);
    assert.equal(included.homer_preview.worldbook[0].content,edits.worldbook);
    assert.equal(included.homer_preview.regex.scripts[0].replaceString,edits.regex);
    await page.evaluate(()=>adminFixture.generate('normal'));
    assert.equal(JSON.parse(apiCalls.filter(call=>call.path.endsWith('/generate')).at(-1).body.custom_include_body).homer_generation_type,'normal');
    journeys.push({viewport,kind:'actual sender',result:'request includes all three drafts and real continue/normal intent; no global save'});
    for(const flags of [{admin:false},{busy:true},{preview:false},{token:''}]){
      await page.reload();await page.waitForFunction(()=>window.adminFixtureReady);await page.evaluate(flags=>adminFixture.change(flags),flags);
      const before=apiCalls.length;await page.evaluate(()=>adminFixture.open('admin-worldbook'));
      assert.equal(await page.locator('.haw-editor').count(),0);assert.equal(apiCalls.length,before);
      journeys.push({viewport,kind:'deny',flags,result:'no editor and no configuration POST'});
    }
    await page.reload();await page.waitForFunction(()=>window.adminFixtureReady);
    holdNext=true;const before=apiCalls.length;await page.getByRole('button',{name:'打开世界书',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#homer-right-drawer').hidden===false);
    await waitHeldResponse();
    await page.evaluate(()=>adminFixture.change({owner:'synthetic-new-owner',epoch:2}));holdResponse();holdResponse=null;
    await page.waitForLoadState('networkidle');assert.equal(apiCalls.length,before+1);assert.equal(await page.locator('.haw-editor').count(),0);
    journeys.push({viewport,kind:'late open owner drift',result:'actual route discarded editor after pending response'});
    // A stale already-open editor must not apply even if the DOM is retained.
    await page.reload();await page.waitForFunction(()=>window.adminFixtureReady);
    await page.getByRole('button',{name:'打开世界书',exact:true}).click();await page.locator('.haw-entry summary').click();
    await page.getByLabel('内容',{exact:true}).fill('Must never apply after owner drift');
    await page.evaluate(()=>adminFixture.change({owner:'synthetic-new-owner',epoch:2}));
    const beforeApply=apiCalls.length;await page.getByRole('button',{name:'应用到本次会话',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.haw-editor')?.classList.contains('is-saving'));
    const driftState=await page.evaluate(()=>({draft:adminFixture.draft,status:document.querySelector('.haw-status').textContent}));
    const denied=apiCalls.length===beforeApply&&Object.keys(driftState.draft).length===0;
    journeys.push({viewport,kind:'open-editor owner drift',result:denied?'denied':'FAIL: stale editor applied',status:driftState.status,configurationPosts:apiCalls.length-beforeApply});
    if(!denied)failures.push({kind:'product',viewport,code:'ADMIN_STALE_EDITOR_APPLY',detail:driftState.status});
    for(const [name,change]of [
      ['same-owner account ABA',async()=>{await page.evaluate(()=>adminFixture.change({owner:'synthetic-other-owner',epoch:2}));await page.evaluate(()=>adminFixture.change({owner:'synthetic-owner',epoch:3}));}],
      ['ordinary user after opening',async()=>page.evaluate(()=>adminFixture.change({admin:false}))],
      ['busy after opening',async()=>page.evaluate(()=>adminFixture.change({busy:true}))],
      ['same-ID preview replacement',async()=>page.evaluate(()=>adminFixture.change({replaceLaunch:true}))],
    ]){
      await page.reload();await page.waitForFunction(()=>window.adminFixtureReady);
      await page.getByRole('button',{name:'打开世界书',exact:true}).click();await page.locator('.haw-entry summary').click();
      await page.getByLabel('内容',{exact:true}).fill('Must not apply '+name);await change();
      const callsBefore=apiCalls.length;await page.getByRole('button',{name:'应用到本次会话',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('.haw-editor')?.classList.contains('is-saving'));
      const result=await page.evaluate(()=>({draft:adminFixture.draft,status:document.querySelector('.haw-status').textContent}));
      const blocked=apiCalls.length===callsBefore&&Object.keys(result.draft).length===0;
      journeys.push({viewport,kind:name,result:blocked?'denied':'FAIL: stale apply',configurationPosts:apiCalls.length-callsBefore,status:result.status});
      if(!blocked)failures.push({kind:'product',viewport,code:'ADMIN_STALE_APPLY',scenario:name});
    }
    for(const [name,change]of [
      ['late apply owner drift',async()=>page.evaluate(()=>adminFixture.change({owner:'synthetic-other-owner',epoch:2}))],
      ['late apply same-owner ABA',async()=>{await page.evaluate(()=>adminFixture.change({owner:'synthetic-other-owner',epoch:2}));await page.evaluate(()=>adminFixture.change({owner:'synthetic-owner',epoch:3}));}],
      ['late apply privilege revoked',async()=>page.evaluate(()=>adminFixture.change({admin:false}))],
      ['late apply generation began',async()=>page.evaluate(()=>adminFixture.change({busy:true}))],
      ['late apply preview replacement',async()=>page.evaluate(()=>adminFixture.change({replaceLaunch:true}))],
    ]){
      await page.reload();await page.waitForFunction(()=>window.adminFixtureReady);
      await page.getByRole('button',{name:'打开世界书',exact:true}).click();await page.locator('.haw-entry summary').click();
      await page.getByLabel('内容',{exact:true}).fill('Late response must not apply '+name);
      const configBefore=await page.evaluate(()=>JSON.stringify(adminFixture.config));
      holdNext=true;await page.getByRole('button',{name:'应用到本次会话',exact:true}).click();
      await waitHeldResponse();await change();holdResponse();holdResponse=null;
      await page.waitForFunction(()=>!document.querySelector('.haw-editor')?.classList.contains('is-saving'));
      const result=await page.evaluate(()=>({draft:adminFixture.draft,status:document.querySelector('.haw-status').textContent,config:JSON.stringify(adminFixture.config)}));
      const blocked=Object.keys(result.draft).length===0&&result.config===configBefore;
      journeys.push({viewport,kind:name,result:blocked?'late response denied without config/draft mutation':'FAIL: late response wrote state',status:result.status});
      if(!blocked)failures.push({kind:'product',viewport,code:'ADMIN_LATE_APPLY',scenario:name});
    }
    await context.close();
  }
}catch(error){failures.push({kind:'assertion',message:error.stack});}
finally{if(holdResponse)holdResponse();await browser?.close();await new Promise(resolve=>server.close(resolve));}
const report={sourceDigests,journeys,failures,
  coverage:'Shipping adminWorkspace UI and CSS; extracted actual runtime refresh/request/editor apply/open/canonical scope/settings event; shipping EventEmitter, API transport, regex state and actual sendOpenAIRequest/intent/fetch. Synthetic model parameter assembly, config service and model response. No production login, real generation, cryptographic bridge verification, global save, full runtime boot or Android claim.',
  globalWrites:apiCalls.filter(call=>call.path.includes('/admin-presets/')).length,configurationPosts:apiCalls.filter(call=>call.path.endsWith('/admin-configuration')).length,generationPosts:apiCalls.filter(call=>call.path.endsWith('/generate')).length};
await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(failures.length)process.exitCode=1;
