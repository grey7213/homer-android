import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The required Python Playwright installation failed TLS on both available
// indexes. Use the bundled Playwright, not a downloaded or different harness.
const require = createRequire(import.meta.url);
const root = new URL('../../output/chatarchive-browser/', import.meta.url);
const base = 'http://127.0.0.1:8789';
const evidence = [], failures = [];
const transport = [];
const deliberateCancellations = [], teardown = new WeakMap();
const startedAt = new Date().toISOString();
let browser, runError;
let phase = 'startup';
function markTeardown(page, reason) { teardown.get(page)?.(reason); }
async function fresh(viewport={width:390,height:844}) {
  const context = await browser.newContext({ viewport, reducedMotion:'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const requests = new WeakMap(), unfinished = new Set();
  teardown.set(page, reason=>{for(const item of unfinished)item.teardown=reason;});
  page.on('request', r=>{ const item={id:transport.length,phase,document:page.url(),url:r.url(),kind:r.resourceType(),started:Date.now()};requests.set(r,item);transport.push(item);unfinished.add(item); });
  page.on('requestfinished', r=>{ const item=requests.get(r);if(item){item.finished=Date.now();unfinished.delete(item);} });
  page.on('pageerror', e=>failures.push({kind:'script',text:e.message}));
  page.on('console', m=>{if(m.type()==='error')failures.push({kind:'console',text:m.text()})});
  page.on('requestfailed', r=>{ const start=requests.get(r);unfinished.delete(start);
    const detail={kind:'network',phase,url:r.url(),resourceType:r.resourceType(),text:r.failure()?.errorText,start,failedAt:Date.now(),now:page.url()};
    // Only the exact synthetic media GET still owned by a deliberate fixture
    // reload/exit may cancel. Live-screen failures and every other URL fail QA.
    if (start?.teardown && r.url()===base+'/synthetic/image.png' && r.resourceType()==='fetch' && detail.text==='net::ERR_ABORTED') deliberateCancellations.push(detail);
    else failures.push(detail);
  });
  // Reject external transports without intercepting loopback fetch streams.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:8789(?:\/|$))/, route=>route.abort());
  return {context,page};
}
async function waitReader(page) { await page.waitForFunction(()=>window.fixtureReady===true);
  await page.waitForFunction(()=>fixture.reader.portrait.getAttribute('src')?.startsWith('blob:'));
  // Blob assignment may precede Chromium's requestfinished event. Settle the
  // current transport before a test reload/owner navigation tears it down.
  await page.waitForLoadState('networkidle');
}
async function ready(page,query='') { markTeardown(page,'explicit fixture navigation');await page.goto(base+'/fixture'+query);await waitReader(page); }
async function reloadReader(page) {markTeardown(page,'explicit fixture reload');await page.reload();await waitReader(page);}
async function closeFixture(context,page) {markTeardown(page,'explicit fixture context close');await context.close();}
const click = (page,name)=>page.getByRole('button',{name,exact:true}).click();
try {
  await mkdir(root, { recursive: true });
  const { chromium } = require('C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1007-641-0_26.1007.641.0_x64__3k8sg7r9htsxt/dependencies/node/node_modules/playwright');
  browser = await chromium.launch({ executablePath: 'C:/Users/ROG/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
  for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1440,height:900}]) {
    for(const theme of ['light','dark']) {
      phase = `layout-${viewport.width}-${theme}`;
      const {context,page}=await fresh(viewport);
      await ready(page,'?theme='+theme+'&conversation='+viewport.width+'-'+theme);
      await page.evaluate(()=>{fixture.reader.settings.typewriter=false;fixture.reader.show({instant:true})});
      assert.match(await page.locator('.passage').innerText(),/清晨/);
      await click(page,'下一段');
      assert.match(await page.locator('.passage').innerText(),/挥了挥手/);
      await click(page,'下一段');
      await click(page,'已读到末尾');
      assert.equal(await page.evaluate(()=>fixture.calls.length),0);
      await click(page,'菜单');
      await page.getByRole('button',{name:/^阅读设置/}).click();
      await page.getByRole('slider',{name:'文字大小',exact:true}).fill('22');
      const bounds=await page.locator('.sheet').boundingBox();
      assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1);
      await page.screenshot({path:new URL(`reader-${viewport.width}-${theme}.png`,root).pathname.replace(/^\/([A-Z]:)/,'$1')});
      await page.keyboard.press('Escape');
      await page.evaluate(()=>fixture.reader.saveQueue);
      await reloadReader(page);
      assert.equal(await page.evaluate(()=>fixture.reader.settings.fontSize),22);
      assert.equal(await page.evaluate(()=>fixture.reader.index),2);
      await click(page,'私聊');
      assert.equal(await page.locator('.talk-row').count(),1);
      await page.evaluate(()=>fixture.reader.setBusy(true));
      await click(page,'停止生成');
      assert.deepEqual(await page.evaluate(()=>fixture.calls.map(c=>c.kind)),['stop']);
      await page.evaluate(()=>fixture.reader.setBusy(false));
      await page.screenshot({path:new URL(`talk-${viewport.width}-${theme}.png`,root).pathname.replace(/^\/([A-Z]:)/,'$1')});
      evidence.push({viewport,theme,pass:true});await closeFixture(context,page);
    }
  }
  {
    phase = 'choice';
    const {context,page}=await fresh();await ready(page,'?choices=1');
    await page.evaluate(()=>{fixture.reader.settings.typewriter=false;fixture.reader.show({instant:true})});
    assert.equal(await page.locator('.choices button').count(),2);
    await page.getByRole('button',{name:'一起散步',exact:true}).dblclick();
    await page.waitForTimeout(120);
    assert.deepEqual(await page.evaluate(()=>fixture.calls.map(c=>c.kind)),['submit']);
    await page.evaluate(()=>fixture.reader.saveQueue);
    await reloadReader(page);
    await page.evaluate(()=>fixture.reader.show({instant:true}));
    assert.equal(await page.getByRole('button',{name:'一起散步',exact:true}).isDisabled(),true);
    await ready(page,'?choices=1&owner=second-synthetic-owner');
    await page.evaluate(()=>fixture.reader.show({instant:true}));
    assert.equal(await page.getByRole('button',{name:'一起散步',exact:true}).isEnabled(),true);
    evidence.push({case:'choice-once-and-owner-isolation',pass:true});await closeFixture(context,page);
  }
  {
    phase = 'checkpoint';
    const {context,page}=await fresh();await ready(page,'?conversation=complete-story');
    await click(page,'菜单');await page.getByRole('button',{name:/^完整剧情存档/}).click();
    await page.getByLabel('存档名称',{exact:true}).fill('合成完整剧情');await click(page,'保存完整剧情');
    await page.getByRole('status').filter({hasText:'完整剧情已保存到本机'}).waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(()=>fixture.update([{id:'later-message',name:'合成角色',mes:'存档之后的剧情，必须完整保存在自动备份中。',swipes:['原候选','第二候选'],swipe_id:1,extra:{fixtureNumber:3}}]));
    await click(page,'菜单');await page.getByRole('button',{name:/^完整剧情存档/}).click();
    page.once('dialog',dialog=>dialog.accept());await click(page,'恢复');
    await page.locator('.status').filter({hasText:'完整剧情已恢复'}).waitFor();
    assert.match(await page.evaluate(()=>fixture.reader.messageInput[0].mes),/清晨/);
    const backups=await page.evaluate(async()=>{const rows=await fixture.stories.list(fixture.scope);const backup=rows.find(r=>r.name==='合成自动备份');return (await fixture.stories.get(fixture.scope,backup.id)).messages});
    assert.match(backups[0].mes,/存档之后/);assert.deepEqual(backups[0].swipes,['原候选','第二候选']);assert.equal(backups[0].extra.fixtureNumber,3);
    markTeardown(page,'deliberate test offline transition');await context.setOffline(true);
    assert.equal(await page.evaluate(async()=>(await fixture.stories.list(fixture.scope)).length),2);
    assert.equal(await page.evaluate(async()=>(await fixture.stories.list({...fixture.scope,owner:'different-owner'})).length),0);
    await context.setOffline(false);evidence.push({case:'full-checkpoint-real-indexeddb-backup-restore-offline-and-scope',pass:true});await closeFixture(context,page);
  }
  {
    phase = 'stop';
    const {context,page}=await fresh();await ready(page,'?conversation=actual-pending-stop');
    await page.evaluate(()=>{fixture.reader.actions.continue=()=>{fixture.calls.push({kind:'continue'});fixture.reader.setBusy(true);return new Promise(resolve=>{fixture.finishGeneration=resolve})};fixture.reader.actions.stop=()=>{fixture.calls.push({kind:'stop'});fixture.reader.setBusy(false);fixture.finishGeneration(true);return true}});
    await click(page,'生成下一回');await click(page,'停止生成');
    assert.deepEqual(await page.evaluate(()=>fixture.calls.map(c=>c.kind)),['continue','stop']);
    evidence.push({case:'stop-during-pending-generation',pass:true});await closeFixture(context,page);
  }
  {
    phase = 'CG-ui';
    const {context,page}=await fresh();await ready(page,'?conversation=cg-ui');
    await click(page,'菜单');await page.getByRole('button',{name:/^画面收藏/}).click();
    await click(page,'生成当前剧情 CG');await page.getByLabel('画面描述',{exact:true}).fill('合成剧情 UI 验收');
    await click(page,'确认生成');await page.locator('.status').filter({hasText:'CG 已生成并缓存到本机，可离线查看'}).waitFor();
    assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.kind==='cg').length),1);
    await page.keyboard.press('Escape');
    await click(page,'菜单');await page.getByRole('button',{name:/^画面收藏/}).click();
    assert.equal(await page.getByRole('button',{name:'删除收藏',exact:true}).count(),1);
    await click(page,'删除收藏');await page.getByRole('button',{name:'删除收藏',exact:true}).waitFor({state:'detached'});
    assert.equal(await page.evaluate(async()=>(await fixture.services.listCG()).length),0);
    evidence.push({case:'CG-ui-single-request-durable-feedback-and-delete',pass:true});await closeFixture(context,page);
  }
  {
    phase = 'voice-ui';
    const {context,page}=await fresh();await ready(page,'?conversation=voice-ui');
    await page.evaluate(()=>{fixture.reader.settings.typewriter=false;fixture.reader.show({instant:true})});
    await click(page,'菜单');await page.getByRole('button',{name:/^阅读设置/}).click();
    await page.getByLabel('逐段语音朗读',{exact:true}).check();await page.getByLabel('静音',{exact:true}).uncheck();
    await page.keyboard.press('Escape');await page.waitForFunction(()=>fixture.reader.audio?.readyState>=2);
    assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.kind==='tts').length),1);
    await click(page,'私聊');assert.equal(await page.evaluate(()=>fixture.reader.audio===null),true);
    evidence.push({case:'voice-ui-loopback-PCM-playback-and-private-view-stop',pass:true});await closeFixture(context,page);
  }
  {
    phase = 'native-host-visibility';
    const {context,page}=await fresh();await ready(page,'?conversation=host-visibility');
    const state=await page.evaluate(async()=>{
      const r=fixture.reader;
      r.settings.typewriter=false;r.show({instant:true});r.advance();
      const cursor=fixture.anchorFor(r.timeline[r.index]),index=r.index;
      r.persist();r.setHostVisible(false);await r.saveQueue;
      const saved=await r.store.load(fixture.scope);
      const hidden={current:r.current(),active:r.presentationActive(),auto:r.settings.autoAdvance,
        audio:r.audio===null,sceneCancelled:r.sceneAbort?.signal.aborted,index:r.index,
        savedSame:saved?.cursor?.segmentIndex===cursor.segmentIndex&&saved?.cursor?.fingerprint===cursor.fingerprint
          &&saved?.cursor?.messageId===cursor.messageId};
      r.setHostVisible(true);
      return {hidden,visible:{current:r.current(),active:r.presentationActive(),index:r.index,
        auto:r.settings.autoAdvance,audio:r.audio===null,calls:fixture.calls.length},index};
    });
    assert.equal(state.hidden.current,true,'Hidden presentation must not invalidate queued durable saves');
    assert.equal(state.hidden.active,false);assert.equal(state.hidden.auto,false);
    assert.equal(state.hidden.audio,true);assert.equal(state.hidden.sceneCancelled,true);
    assert.equal(state.hidden.savedSame,true);assert.equal(state.hidden.index,state.index);
    assert.equal(state.visible.active,true);assert.equal(state.visible.index,state.index);
    assert.equal(state.visible.auto,false);assert.equal(state.visible.audio,true);assert.equal(state.visible.calls,0);
    evidence.push({case:'native-visibility-reader-method-preserves-real-indexeddb-and-never-auto-resumes',pass:true});
    await closeFixture(context,page);
  }
  {
    phase = 'CG-offline';
    const {context,page}=await fresh();await ready(page,'?conversation=cg-case');
    const result=await page.evaluate(async()=>{
      const source=fixture.anchorFor(fixture.reader.timeline[0]);
      const cg=await fixture.services.generateCG({prompt:'纯合成画面验收',source});
      return {offline:cg.offline,persisted:cg.persisted,id:cg.id};
    });
    assert.equal(result.offline,true);assert.equal(result.persisted,true);
    await reloadReader(page);
    markTeardown(page,'deliberate test offline transition');await context.setOffline(true);
    assert.equal(await page.evaluate(async()=>{const rows=await fixture.services.listCG();return rows.length===1&&rows[0].offline&&rows[0].url.startsWith('blob:')}),true);
    await page.evaluate(async()=>{await fixture.services.deleteCG((await fixture.services.listCG())[0].id)});
    assert.equal(await page.evaluate(async()=>(await fixture.services.listCG()).length),0);
    assert.equal(await page.evaluate(async()=>{const asset=await fixture.reader.assetCache.resolve({kind:'portrait',url:'/synthetic/image.png'});return asset.offline&&asset.persisted&&asset.url.startsWith('blob:')}),true);
    await context.setOffline(false);
    const perf=await page.evaluate(()=>{const data=fixture.large();const times=[];for(let i=0;i<4;i++){const t=performance.now();fixture.reader.update(data);times.push(performance.now()-t)}return {times,count:fixture.reader.timeline.length,source:data.length}});
    assert.equal(perf.source,1101);assert.ok(perf.count>1101);
    markTeardown(page,'explicit reader destroy');await page.evaluate(()=>fixture.destroy());
    assert.equal(await page.locator('#reader').count(),0);
    evidence.push({case:'real-indexeddb-offline-media-and-large-timeline',...perf,pass:true});await closeFixture(context,page);
  }
} catch (failure) {
  runError = failure;
  failures.push({kind:'harness',phase,name:failure?.name||'Error',text:String(failure?.message||failure)});
} finally {
  try { await browser?.close(); }
  catch (failure) { failures.push({kind:'cleanup',phase,name:failure?.name||'Error',text:String(failure?.message||failure)}); }
  await fetch(base+'/__fixture_stop',{method:'POST'}).catch(()=>{});
  // Always replace the previous run, including launch/assertion/network failures.
  // Writing after browser cleanup also includes late requestfailed diagnostics.
  const pass = !runError && failures.length===0;
  const result = {startedAt,completedAt:new Date().toISOString(),pass,cases:evidence.length,evidence,failures,deliberateCancellations,
    mediaRequests:transport.filter(r=>r.url.includes('/synthetic/image.png')),
    visualBaseline:'No original-app pixel baseline; screenshots establish only rebuilt layout bounds.',
    productionServices:'Not called; loopback synthetic transport only.'};
  await writeFile(new URL('results.json',root),JSON.stringify(result,null,2));
  process.stdout.write(JSON.stringify({cases:result.cases,failures,deliberateCancellations:deliberateCancellations.length,pass})+'\n');
  if (!pass) process.exitCode = 1;
}
