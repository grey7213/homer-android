"""Real rendered candidate + IndexedDB; synthetic providers, no user account."""
import argparse
import json
import traceback
import re
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8793)
args = parser.parse_args()
base = f'http://127.0.0.1:{args.port}'
output = Path(__file__).resolve().parents[2] / 'output/chatarchive-r358-browser'
output.mkdir(parents=True, exist_ok=True)
failures, cases = [], []
phase = 'startup'
def click(page, name):
    page.get_by_role('button', name=name, exact=True).click()
def idle(page):
    page.wait_for_function('gameFixture.reader && !gameFixture.reader.gameSession.busy && !gameFixture.reader.actionPending')
def send(page, value):
    if page.evaluate("gameFixture.reader.mode==='talk'"):
        page.get_by_label('私聊消息', exact=True).fill(value)
    else:
        click(page, '输入')
        page.get_by_label('内容', exact=True).fill(value)
    click(page, '发送')
    idle(page)
def assert_fit(page, selector, width, height):
    box = page.locator(selector).bounding_box()
    assert box and box['width'] > 0 and box['height'] > 0, (selector, box)
    assert box['x'] >= -1 and box['y'] >= -1 and box['x']+box['width'] <= width+1 and box['y']+box['height'] <= height+1, (selector, box)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='C:/Users/ROG/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless=True)
        for width, height in [(390,844),(844,390),(1440,900)]:
            for theme in ['light','dark']:
                phase=f'{width}-{theme}'
                context=browser.new_context(viewport={'width':width,'height':height}, reduced_motion='reduce')
                page=context.new_page()
                page.set_default_timeout(12000)
                page.on('pageerror',lambda error:failures.append({'phase':phase,'kind':'script','message':str(error)}))
                page.on('console',lambda msg:failures.append({'phase':phase,'kind':'console','message':msg.text}) if msg.type=='error' else None)
                page.on('requestfailed',lambda req:failures.append({'phase':phase,'kind':'network','url':req.url,'message':req.failure}))
                page.on('response',lambda res:failures.append({'phase':phase,'kind':'http','url':res.url,'status':res.status}) if res.status>=400 else None)
                page.goto(f'{base}/game-fixture?theme={theme}&slot={phase}')
                page.wait_for_function('window.gameFixtureReady')
                page.wait_for_load_state('networkidle')
                page.screenshot(path=str(output/f'hall-{phase}.png'),full_page=True)
                assert page.locator('[data-game-list] .vn-library-card').count()==0
                click(page,'新故事')
                page.get_by_role('button',name='合成角色甲',exact=True).click()
                page.locator('[data-game-title]').fill('海风中的相遇')
                page.locator('[data-game-player]').fill('验收玩家')
                page.locator('[data-game-scene]').fill('放学后的教室')
                page.locator('[data-game-summary]').fill('全部为合成模型，不读取正式账号。')
                click(page,'确认创建专用会话并开始故事')
                page.wait_for_function('gameFixture.reader?.gameSession?.state')
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='create-conversation').length")==1
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length")==0
                assert '历史哨兵' not in page.locator('.passage').inner_text()
                page.get_by_role('link',name='返回剧场大厅',exact=True).click()
                page.get_by_role('button',name='管理人物',exact=True).wait_for()
                click(page,'管理人物')
                click(page,'合成角色乙')
                click(page,'确认创建专用人物会话并加入故事')
                page.wait_for_function('gameFixture.reader?.game.characters.length===2')
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='create-conversation').length")==2
                click(page,'故事群')
                page.get_by_label('故事群消息',exact=True).wait_for()
                send(page,'大家一起商量今天的计划吧')
                assert page.locator('.talk-row').count()==3
                assert page.evaluate('gameFixture.reader.game.turns.at(-1).channel')=='group'
                assert page.locator('.private-thread').get_by_text('合成角色甲',exact=True).count()==1
                assert page.locator('.private-thread').get_by_text('合成角色乙',exact=True).count()==1
                assert page.get_by_role('button',name='打开故事群',exact=True).locator('strong').evaluate("el=>el.scrollWidth<=el.clientWidth+1")
                page.screenshot(path=str(output/f'group-{phase}.png'))
                click(page,'打开故事群')
                idle(page)
                assert page.locator('.talk-row').count()==3
                page.get_by_role('button',name='私聊 合成角色甲',exact=True).click()
                page.wait_for_function("gameFixture.reader.game.active.characterId==='synthetic-role-a' && gameFixture.reader.game.active.channel==='talk'")
                assert page.locator('.talk-row').count()==0
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='create-conversation').length")==2
                page.get_by_label('私聊消息',exact=True).wait_for()
                send(page,'你好，一起去海边吗')
                assert page.locator('.talk-row').count()==2
                assert page.locator('.momo-invitation').count()==1
                assert page.evaluate('gameFixture.reader.game.events[0].status')=='planned'
                assert '[约会邀请:' not in page.locator('.private-thread').inner_text()
                assert_fit(page,'.talk-compose',width,height)
                page.wait_for_load_state('networkidle')
                page.screenshot(path=str(output/f'messages-{phase}.png'))
                n=page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length")
                click(page,'前往约会剧情 →')
                page.wait_for_function("gameFixture.reader.game.active.eventId!==''")
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length")==n
                assert page.locator('.momo-room').count()==0
                send(page,'沿着海岸走')
                page.evaluate('''() => {const r=gameFixture.reader;r.index=r.timeline.length-1;r.show({instant:true});}''')
                click(page,'继续散步')
                idle(page)
                assert page.evaluate('gameFixture.reader.game.turns.at(-1).userText')=='我们继续散步吧'
                assert page.evaluate('gameFixture.reader.game.turns.at(-1).eventId')==page.evaluate('gameFixture.reader.game.events[0].id')
                assert_fit(page,'.text-panel',width,height)
                assert page.locator('.text-panel').evaluate("el=>getComputedStyle(el).borderTopWidth")=='0px'
                page.wait_for_load_state('networkidle')
                page.screenshot(path=str(output/f'stage-{phase}.png'))
                click(page,'约会')
                click(page,'结束')
                click(page,'确认结束并返回私聊')
                page.wait_for_function("gameFixture.reader.game.events[0].status==='completed'")
                assert page.evaluate('gameFixture.reader.game.active.channel')=='talk'
                assert page.locator('.talk-row').count()==2
                assert page.get_by_role('button',name='这段约会已经结束',exact=True).is_disabled()
                click(page,'菜单')
                click(page,'故事档案与记忆')
                page.get_by_role('button',name='记入长期经历',exact=True).first.click()
                page.wait_for_function('gameFixture.reader.game.memories.length===1')
                click(page,'关闭')
                click(page,'剧情')
                page.wait_for_function("gameFixture.reader.game.active.channel==='stage' && gameFixture.reader.mode==='stage' && !gameFixture.reader.gameSession.busy")
                send(page,'返回舞台')
                assert '已结束约会：海边散步' in page.evaluate('gameFixture.prompts.at(-1)')
                click(page,'菜单')
                click(page,'游戏存档')
                page.get_by_label('存档名称',exact=True).fill('约会之后')
                click(page,'保存游戏存档')
                page.get_by_text('游戏档案已保存到本机。',exact=True).wait_for()
                click(page,'关闭')
                count=page.evaluate('gameFixture.reader.game.turns.length')
                send(page,'分支未来的行动')
                click(page,'菜单')
                click(page,'游戏存档')
                click(page,'恢复')
                click(page,'备份并恢复')
                page.wait_for_function('(n)=>gameFixture.reader.game.turns.length===n',arg=count)
                assert not page.evaluate("gameFixture.reader.game.turns.some(t=>t.userText==='分支未来的行动')")
                await_count=page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length")
                context.set_offline(True)
                page.evaluate('gameFixture.reopen()')
                page.wait_for_function('(n)=>gameFixture.reader.game.turns.length===n',arg=count)
                assert page.evaluate('gameFixture.reader.game.events[0].status')=='completed'
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length")==await_count
                context.set_offline(False)
                click(page,'档案')
                assert_fit(page,'.sheet',width,height)
                page.screenshot(path=str(output/f'archive-{phase}.png'))
                click(page,'关闭')
                if width==390 and theme=='light':
                    page.evaluate("gameFixture.mode('hold')")
                    click(page,'输入')
                    page.get_by_label('内容',exact=True).fill('停止用例')
                    click(page,'发送')
                    page.wait_for_function('gameFixture.reader.gameSession.busy')
                    click(page,'停止生成')
                    idle(page)
                    assert page.evaluate('gameFixture.reader.game.turns.at(-1).status')=='interrupted'
                    page.evaluate("gameFixture.mode('guard')")
                    send(page,'拒绝用例')
                    assert '本次请求已阻止' in page.locator('.status').inner_text()
                    page.evaluate("gameFixture.mode('normal')")
                    click(page,'菜单')
                    click(page,'画面收藏与CG')
                    click(page,'生成当前剧情 CG')
                    click(page,'确认生成')
                    page.get_by_role('dialog',name=re.compile(r'^剧情 CG')).wait_for()
                    assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='cg').length")==1
                    click(page,'关闭')
                    click(page,'菜单')
                    click(page,'朗读当前台词')
                    page.wait_for_function("gameFixture.calls.filter(c=>c.kind==='tts').length===1")
                    page.wait_for_function('gameFixture.reader.audio && gameFixture.reader.audio.readyState>=2')
                    page.wait_for_load_state('networkidle')
                    page.evaluate('gameFixture.reader.stopAudio()')
                cases.append({'viewport':[width,height],'theme':theme,'pass':True,'scenarios':['new-game','add-member','group-speakers','private-isolation','private-invitation','explicit-date-entry','choice','date-return','memory','checkpoint-backup','offline-reopen','layout']})
                page.wait_for_load_state('networkidle')
                context.close()
        browser.close()
except Exception as error:
    failures.append({'phase':phase,'kind':'assertion','message':str(error),'trace':traceback.format_exc()})
finally:
    report={'cases':cases,'failures':failures,'syntheticProviders':True,'productionAccountUsed':False,'realDeviceTested':False,
            'offlineAssetFixture':'Current assets cached for one test run to represent APK-bundled files; not proof of browser cold-offline or native device startup.'}
    (output/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
    # Stop only this explicitly started loopback fixture; Windows shell wrappers
    # otherwise leave a child Python server behind after with_server finishes.
    try:
        with urlopen(Request(base+'/__fixture_stop',data=b'{}',method='POST'),timeout=3) as res: res.read()
    except Exception: pass
if failures: raise SystemExit(1)
