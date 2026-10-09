"""Actual Chromium IndexedDB + observed workshop media + real archive HTTP/SQLite.
Identity, native catalog bridge and provider generation are explicitly synthetic.
"""
import json
import traceback
import uuid
from pathlib import Path
from urllib.request import urlopen, Request
from playwright.sync_api import sync_playwright

out=Path(__file__).resolve().parents[2]/'output/chatarchive-r361/browser';out.mkdir(parents=True,exist_ok=True)
cases=[];failures=[];run_id=uuid.uuid4().hex[:12]
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='C:/Users/ROG/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',args=['--enable-unsafe-swiftshader'])
        for width,height in [(390,844),(844,390),(1440,900)]:
            for theme in ['light','dark']:
                slot=f'r361-{run_id}-{width}-{height}-{theme}'
                context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce')
                page=context.new_page();page.set_default_timeout(20000)
                page.on('pageerror',lambda error:failures.append({'type':'script','message':str(error)}))
                page.on('console',lambda msg:failures.append({'type':'console','message':msg.text}) if msg.type=='error' else None)
                page.on('response',lambda res:failures.append({'type':'http','path':res.url.split('?',1)[0],'status':res.status}) if res.status>=400 else None)
                page.goto(f'http://127.0.0.1:8801/r361-fixture?theme={theme}&slot={slot}')
                page.wait_for_function('window.gameFixtureReady');page.wait_for_load_state('networkidle')
                page.get_by_role('button',name='新故事',exact=True).click()
                page.locator('[data-game-role-source]').select_option('workshop')
                page.wait_for_function("document.querySelectorAll('[data-game-roles] button').length===1")
                name=page.locator('[data-game-roles] button').inner_text().strip()
                page.get_by_role('button',name=name,exact=True).click();page.get_by_role('button',name='开始相遇',exact=True).click()
                page.wait_for_function('gameFixture.reader?.spine?.renderState?.skeleton?.data?.animations.length>0')
                page.wait_for_load_state('networkidle')
                assert page.evaluate('gameFixture.reader.spine.renderState.skeleton.data.animations.length')==39
                page.wait_for_function("gameFixture.reader.background.naturalWidth>0&&!gameFixture.reader.background.hidden&&gameFixture.reader.background.src.endsWith('/archive-room.svg')")
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length")==0
                page.screenshot(path=str(out/f'workshop-stage-{slot}.png'))
                game=page.evaluate('gameFixture.reader.game')
                page.get_by_role('button',name='私聊',exact=True).click();page.get_by_label('私聊消息',exact=True).fill('一次合成行动')
                page.get_by_role('button',name='发送',exact=True).click();page.wait_for_function('gameFixture.reader.game.turns.length===1&&!gameFixture.reader.gameSession.busy')
                page.evaluate("async()=>{await gameFixture.store.checkpoint(gameFixture.owner,gameFixture.reader.game.id,'工坊分支');await gameFixture.store.sync(gameFixture.owner,gameFixture.reader.game.id);}")
                saved=page.evaluate('gameFixture.reader.game');assert saved['characters'][0]['mediaRef']['sha256']=='3092b83304b64e7367274adb5379598e1b21f61daf93599d06ab1f97819033f2'
                page.screenshot(path=str(out/f'workshop-talk-{slot}.png'))
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                # New browser context = fresh app-origin data, no previous IDB or
                # media catalog. Same authenticated synthetic owner restores all.
                context.close()
                fresh=browser.new_context(viewport={'width':width,'height':height});page=fresh.new_page()
                page.goto(f'http://127.0.0.1:8801/r361-fixture?missing=1&theme={theme}&slot={slot}')
                page.wait_for_function('window.gameFixtureReady');page.wait_for_load_state('networkidle')
                restored=page.evaluate("async()=>await gameFixture.store.get(gameFixture.owner,"+json.dumps(game['id'])+")")
                assert restored==saved
                checkpoints=page.evaluate("async()=>await gameFixture.store.exportBundle(gameFixture.owner,"+json.dumps(game['id'])+")")
                assert len(checkpoints['checkpoints'])==1 and checkpoints['checkpoints'][0]['game']['turns'][0]['reply']==saved['turns'][0]['reply']
                page.get_by_role('button',name='重新下载人物',exact=True).wait_for()
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation'||c.kind==='create-conversation'||c.kind==='import-theme').length")==0
                page.screenshot(path=str(out/f'restored-no-media-{slot}.png'));fresh.close()
                cases.append({'viewport':[width,height],'theme':theme,'completeGameAndBranchRestore':True,'actualWorkshopAnimations':39,'noRecoveryGenerationOrConversationCreation':True})
        browser.close()
    try:
        urlopen('http://127.0.0.1:8801/console/api/web/archive/saves')
        raise AssertionError('unauthenticated GET succeeded')
    except Exception as error:
        assert getattr(error,'code',None)==401,error
except Exception:
    failures.append({'type':'assertion','trace':traceback.format_exc()})
finally:
    report={'cases':cases,'failures':failures,'nativeAndroidTest':False,'syntheticIdentityAndProvider':True,'playerDataUsed':False}
    (out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False))
if failures:raise SystemExit(1)
