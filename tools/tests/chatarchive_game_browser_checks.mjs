import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1007-641-0_26.1007.641.0_x64__3k8sg7r9htsxt/dependencies/node/node_modules/playwright');
const output = new URL('../../output/chatarchive-game-browser/', import.meta.url);
const base = 'http://127.0.0.1:8789', evidence = [], failures = [], transport = [];
let browser, phase = 'start', error;
const path = file => new URL(file, output).pathname.replace(/^\/([A-Z]:)/, '$1');
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
async function waitIdle(page) { await page.waitForFunction(() => gameFixture.reader && !gameFixture.reader.gameSession.busy && !gameFixture.reader.actionPending); }
async function send(page, text) { await click(page, '输入'); await page.getByRole('textbox').filter({visible:true}).last().fill(text);
  await click(page, '发送'); await waitIdle(page); }
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ executablePath:'C:/Users/ROG/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless:true });
  for (const viewport of [{width:390,height:844},{width:844,height:390},{width:1440,height:900}]) {
    for (const theme of ['light','dark']) {
      phase = `${viewport.width}-${theme}`;
      const context = await browser.newContext({viewport,reducedMotion:'reduce'}), page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => failures.push({phase,kind:'script',message:e.message}));
      page.on('console', m => { if(m.type()==='error') failures.push({phase,kind:'console',message:m.text()}); });
      page.on('requestfailed', r => failures.push({phase,kind:'network',url:r.url(),message:r.failure()?.errorText}));
      page.on('response', r => { transport.push({phase,url:r.url(),status:r.status()}); if(r.status()>=400) failures.push({phase,kind:'http',url:r.url(),status:r.status()}); });
      await page.route(/^https?:\/\/(?!127\.0\.0\.1:8789(?:\/|$))/, route=>route.abort());
      await page.goto(base+`/game-fixture?theme=${theme}&slot=${phase}`); await page.waitForFunction(()=>window.gameFixtureReady);
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('[data-game-list] .vn-library-card').count(),0);
      await click(page,'开始新故事'); await page.getByRole('button',{name:'合成角色甲',exact:true}).click();
      await page.locator('[data-game-title]').fill('合成海边故事'); await page.locator('[data-game-player]').fill('验收玩家');
      await page.locator('[data-game-scene]').fill('清晨海边'); await page.locator('[data-game-summary]').fill('与角色见面，所有输出由合成宿主提供。');
      await click(page,'确认创建专用会话并开始故事');
      await page.waitForFunction(()=>gameFixture.reader?.gameSession?.state);
      assert.equal(await page.evaluate(()=>gameFixture.calls.filter(c=>c.kind==='create-conversation').length),1);
      assert.equal(await page.evaluate(()=>gameFixture.calls.filter(c=>c.kind==='generation').length),0);
      assert.equal(await page.locator('.passage').innerText().then(t=>t.includes('历史哨兵')),false);
      await click(page,'私聊'); await send(page,'你好，一起去海边吗');
      assert.equal(await page.locator('.talk-row').count(),2);
      await click(page,'档案'); await click(page,'记入长期经历');
      await page.waitForFunction(()=>gameFixture.reader.game.memories.length===1);
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.memories.length),1); await click(page,'关闭');
      await click(page,'约会'); await page.getByLabel('约会主题').fill('海边散步'); await page.getByLabel('地点与场景').fill('傍晚海岸');
      await click(page,'保存约会计划'); await click(page,'开始约会');
      await page.waitForFunction(()=>gameFixture.reader.game.events[0].status==='active'&&!gameFixture.reader.panel);
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.events[0].status),'active');
      await send(page,'沿着海岸走');
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.turns.at(-1).eventId),await page.evaluate(()=>gameFixture.reader.game.events[0].id));
      await page.evaluate(()=>{const r=gameFixture.reader;r.index=r.timeline.length-1;r.show({instant:true});});
      await click(page,'继续散步'); await waitIdle(page);
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.turns.at(-1).userText),'我们继续散步吧');
      await click(page,'约会'); await click(page,'结束'); await click(page,'确认结束并返回私聊');
      await page.waitForFunction(()=>gameFixture.reader.game.events[0].status==='completed');
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.events[0].status),'completed');
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.active.channel),'talk');
      assert.equal(await page.locator('.talk-row').count(),2);
      await click(page,'剧情'); await send(page,'返回舞台');
      assert.match(await page.evaluate(()=>gameFixture.prompts.at(-1)),/海边散步/);
      assert.match(await page.evaluate(()=>gameFixture.prompts.at(-1)),/你好，一起去海边吗/);
      await click(page,'场景'); await page.getByLabel('场景',{exact:true}).fill('夜晚港口'); await click(page,'保存到本游戏');
      await page.waitForFunction(()=>gameFixture.reader.game.world.scene==='夜晚港口');
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.world.scene),'夜晚港口');
      await click(page,'菜单'); await click(page,'游戏存档'); await page.getByLabel('存档名称',{exact:true}).fill('结束约会后');
      await click(page,'保存游戏存档'); await page.getByText('游戏档案已保存到本机。',{exact:true}).waitFor(); await click(page,'关闭');
      const count = await page.evaluate(()=>gameFixture.reader.game.turns.length);
      await send(page,'未来不应留在恢复后的分支');
      await click(page,'菜单'); await click(page,'游戏存档'); await click(page,'恢复'); await click(page,'备份并恢复');
      await page.waitForFunction(n=>gameFixture.reader.game.turns.length===n,count);
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.turns.some(t=>t.userText==='未来不应留在恢复后的分支')),false);
      await page.evaluate(()=>gameFixture.reopen());
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.turns.length),count);
      assert.equal(await page.evaluate(()=>gameFixture.reader.game.world.scene),'夜晚港口');
      await click(page,'档案'); const bounds=await page.locator('.sheet').boundingBox();
      assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1);
      await page.screenshot({path:path(`game-archive-${phase}.png`)}); await click(page,'关闭');
      await page.screenshot({path:path(`game-stage-${phase}.png`)});
      const colors=await page.evaluate(()=>({html:document.documentElement.dataset.theme,body:document.body.dataset.theme,
        panel:getComputedStyle(gameFixture.reader.shadow.querySelector('.text-panel')).backgroundColor,
        text:getComputedStyle(gameFixture.reader.shadow.querySelector('.text-panel')).color}));
      assert.equal(colors.html,theme);
      if(theme==='dark') { assert.notEqual(colors.panel,'rgb(255, 255, 255)'); assert.notEqual(colors.text,'rgb(28, 28, 30)'); }
      if(viewport.width===390&&theme==='light') {
        await page.evaluate(()=>gameFixture.mode('hold')); await click(page,'输入'); await page.getByRole('textbox').filter({visible:true}).last().fill('停止用例');
        await click(page,'发送'); await page.waitForFunction(()=>gameFixture.reader.gameSession.busy&&gameFixture.calls.at(-1).kind==='generation');
        await click(page,'停止生成'); await waitIdle(page);
        assert.equal(await page.evaluate(()=>gameFixture.reader.game.turns.at(-1).status),'interrupted');
        await page.evaluate(()=>gameFixture.mode('fail')); await send(page,'失败用例');
        assert.equal(await page.evaluate(()=>gameFixture.reader.game.turns.at(-1).status),'uncertain');
        await page.evaluate(()=>gameFixture.mode('guard')); await send(page,'阻止发送用例');
        assert.match(await page.locator('.status').innerText(),/本次请求已阻止/);
        assert.doesNotMatch(await page.locator('.status').innerText(),/操作未完成，请检查联网状态/);
      }
      evidence.push({phase,viewport,theme,colors,pass:true,scenarios:['fresh-game-no-history','dedicated-conversation-once','private-thread','memory-context','date-lifecycle','choice-generation','world-state','checkpoint-backup-restore','reopen-local']});
      await page.waitForLoadState('networkidle'); await context.close();
    }
  }
} catch(cause) { error = {phase,message:cause.message,stack:cause.stack}; }
finally { await browser?.close(); await mkdir(output,{recursive:true}); await writeFile(new URL('results.json',output),JSON.stringify({evidence,failures,transport,error,syntheticProviders:true,productionProviderTested:false},null,2)); }
console.log(JSON.stringify({passed:evidence.length,failures,error}));
if(error||failures.length)process.exitCode=1;
