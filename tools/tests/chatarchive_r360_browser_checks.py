"""R360 actual old media + real local client. Provider/native bridge are synthetic.

Never a real-device or original 1.2.6 equivalence claim; never opens player data.
"""
import argparse
import json
import traceback
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8797)
parser.add_argument('--quick', action='store_true')
args = parser.parse_args()
output = Path(__file__).resolve().parents[2] / 'output/chatarchive-r360/browser'
output.mkdir(parents=True, exist_ok=True)
cases, failures = [], []
phase = 'start'
viewports = [(390, 844)] if args.quick else [(390, 844), (844, 390), (1440, 900)]

def record(kind, **values):
    failures.append({'phase': phase, 'kind': kind, **values})

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path='C:/Users/ROG/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
            headless=True, args=['--enable-unsafe-swiftshader'])
        for width, height in viewports:
            for theme in (['light'] if args.quick else ['light', 'dark']):
                phase = f'{width}-{height}-{theme}'
                context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
                page = context.new_page()
                page.set_default_timeout(45000)
                page.on('pageerror', lambda error: record('script', message=str(error)))
                page.on('console', lambda msg: record('console', message=msg.text) if msg.type == 'error' else None)
                page.on('response', lambda res: record('http', url=res.url, status=res.status) if res.status >= 400 else None)
                page.on('requestfailed', lambda req: record('network', url=req.url, message=req.failure) if req.failure != 'net::ERR_ABORTED' else None)
                page.goto(f'http://127.0.0.1:{args.port}/game-fixture?archive=1&automatic=1&theme={theme}&slot={phase}')
                page.wait_for_function('window.gameFixtureReady')
                page.get_by_role('button', name='新故事', exact=True).click()
                page.wait_for_function("document.querySelectorAll('[data-game-roles] button').length>0")
                assert page.evaluate('gameFixture.calls.length') == 0
                page.locator('[data-game-role-query]').fill('早濑优香')
                page.get_by_role('button', name='查找', exact=True).click()
                page.get_by_role('button', name='早濑优香', exact=True).click()
                assert not page.locator('[data-game-setup-fields]').evaluate('node=>node.open')
                page.screenshot(path=str(output / f'choose-{phase}.png'), full_page=True)
                page.get_by_role('button', name='开始相遇', exact=True).click()
                page.wait_for_function("gameFixture.reader?.game?.characters[0]?.themeRoleId==='yuuka'")
                page.wait_for_function('gameFixture.reader?.spine?.renderState?.skeleton?.data?.animations.length>0')
                page.wait_for_load_state('networkidle')
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='synthetic-picker').length") == 0
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='synthetic-media-prepare').length") == 1
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='import-theme').length") == 1
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length") == 0
                assert page.locator('.background').evaluate('node=>node.naturalWidth>1000')
                game_id = page.evaluate('gameFixture.reader.game.id')

                for name in ['生盐诺亚', '天童爱丽丝']:
                    page.get_by_role('link', name='返回剧场大厅', exact=True).click()
                    page.wait_for_function('!gameFixture.reader')
                    page.get_by_role('button', name='管理人物', exact=True).click()
                    page.locator('[data-game-role-query]').fill(name)
                    page.get_by_role('button', name='查找', exact=True).click()
                    page.get_by_role('button', name=name, exact=True).click()
                    page.get_by_role('button', name='加入故事', exact=True).click()
                    page.wait_for_function('gameFixture.reader?.spine?.renderState?.skeleton?.data?.animations.length>0')
                    page.wait_for_load_state('networkidle')
                page.wait_for_function("document.querySelector('#reader').shadowRoot.querySelectorAll('.archive-supporting-actor canvas').length===2")
                page.screenshot(path=str(output / f'ensemble-debug-{phase}.png'))
                (output / f'ensemble-debug-{phase}.json').write_text(json.dumps(page.evaluate("({primary:!!gameFixture.reader.spine?.renderState,canvases:[...document.querySelector('#reader').shadowRoot.querySelectorAll('canvas')].map(n=>({parent:n.parentNode.className,rect:n.getBoundingClientRect().toJSON()})),cast:gameFixture.reader.resolveArchiveScene({},'').cast.map(a=>a.id)})"), ensure_ascii=False, indent=2), encoding='utf-8')
                assert page.locator('canvas.ce-portrait-spine').count() == 3
                assert page.locator('#reader').get_attribute('data-archive-game-fullscreen') == 'true'
                stage_rect = page.locator('#reader').bounding_box()
                assert stage_rect['y'] == 0 and stage_rect['height'] <= height + 1, stage_rect
                for label in ['私聊', '回看', '菜单', '输入', '推进剧情', '撤回']:
                    rect = page.get_by_role('button', name=label, exact=True).bounding_box()
                    assert rect and rect['y'] >= 0 and rect['y'] + rect['height'] <= height + 1, (label, rect)
                assert page.evaluate('gameFixture.reader.game.id') == game_id
                assert page.evaluate('gameFixture.reader.game.characters.length') == 3
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length") == 0
                assert page.get_by_role('button', name='场景', exact=True).count() == 0
                page.screenshot(path=str(output / f'ensemble-{phase}.png'))

                page.get_by_role('button', name='私聊', exact=True).click()
                page.wait_for_function("gameFixture.reader.mode==='talk' && gameFixture.reader.game.active.channel==='talk'")
                assert page.locator('.archive-supporting-actor').count() == 0
                page.get_by_label('私聊消息', exact=True).fill('一起去海边')
                page.get_by_role('button', name='发送', exact=True).click()
                page.wait_for_function('gameFixture.reader.game.events.length===1 && !gameFixture.reader.gameSession.busy')
                assert page.get_by_role('button', name='前往约会剧情 →', exact=True).count() == 1
                page.screenshot(path=str(output / f'momotalk-{phase}.png'))
                if width > height and height <= 540:
                    contacts = page.locator('.momo-contacts').bounding_box()
                    composer = page.get_by_label('私聊消息', exact=True).bounding_box()
                    assert contacts and composer and composer['x'] >= contacts['x'] + contacts['width'] - 1
                    assert composer['y'] + composer['height'] <= height + 1, composer
                page.get_by_role('button', name='前往约会剧情 →', exact=True).click()
                page.wait_for_function("gameFixture.reader.game.active.eventId && gameFixture.reader.mode==='stage'")
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length") == 1
                assert page.locator('.archive-supporting-actor').count() == 0
                page.get_by_role('button', name='推进剧情', exact=True).click()
                page.wait_for_function('gameFixture.reader.game.turns.length===2 && !gameFixture.reader.gameSession.busy')
                page.get_by_role('button', name='撤回', exact=True).click()
                page.get_by_role('button', name='备份并撤回', exact=True).click()
                page.wait_for_function('gameFixture.reader.game.turns.length===1 && !gameFixture.reader.panel')
                assert page.evaluate('gameFixture.reader.game.events[0].status') == 'active'
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length") == 2
                assert page.evaluate('async()=> (await gameFixture.store.listCheckpoints(gameFixture.owner,gameFixture.reader.game.id)).length') == 1
                page.get_by_role('button', name='推进剧情', exact=True).click()
                page.wait_for_function('gameFixture.reader.game.turns.length===2 && !gameFixture.reader.gameSession.busy')
                page.get_by_role('button', name='约会', exact=True).click()
                page.get_by_role('button', name='结束', exact=True).click()
                page.get_by_role('button', name='确认结束并返回私聊', exact=True).click()
                page.wait_for_function("gameFixture.reader.game.events[0].status==='completed' && gameFixture.reader.mode==='talk'")
                assert page.locator('.momo-invitation').count() == 1
                assert page.get_by_role('button', name='这段约会已经结束', exact=True).is_disabled()
                page.evaluate('gameFixture.reopen()')
                page.wait_for_function("gameFixture.reader?.game?.events[0]?.status==='completed'")
                assert page.evaluate('gameFixture.reader.game.id') == game_id
                assert page.evaluate('gameFixture.reader.game.turns.length') == 2
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length") == 3
                assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='import-theme').length") == 3
                page.wait_for_load_state('networkidle')
                page.screenshot(path=str(output / f'reopened-{phase}.png'))
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                if width > height and height <= 540:
                    # Reduced visual height approximates a landscape keyboard;
                    # this does not claim actual Android IME verification.
                    page.set_viewport_size({'width': width, 'height': 240})
                    for control in [page.get_by_label('私聊消息', exact=True),
                                    page.get_by_role('button', name='发送', exact=True)]:
                        rect = control.bounding_box()
                        assert rect and rect['y'] >= 0 and rect['y'] + rect['height'] <= 241, rect
                    page.screenshot(path=str(output / f'momotalk-short-{phase}.png'))
                    page.get_by_role('button', name='剧情', exact=True).click()
                    page.wait_for_function("gameFixture.reader.mode==='stage'")
                    page.get_by_role('button', name='输入', exact=True).click()
                    field = page.get_by_label('内容', exact=True)
                    field.fill('横屏输入验收；不会发送')
                    field.scroll_into_view_if_needed()
                    rect = field.bounding_box()
                    assert rect and rect['y'] >= 0 and rect['y'] + rect['height'] <= 241, rect
                    page.screenshot(path=str(output / f'composer-short-{phase}.png'))
                    # Native landscape IME was observed to leave only 151px.
                    # A bounded textarea rect alone misses clipping by the
                    # scroll body / footer, so check its visible area too.
                    page.set_viewport_size({'width': width, 'height': 151})
                    assert page.evaluate("""(()=>{
                        const p=gameFixture.reader.panel,
                              r=p.body.querySelector('textarea').getBoundingClientRect(),
                              b=p.body.getBoundingClientRect(),
                              f=p.sheet.querySelector('footer').getBoundingClientRect();
                        return r.height>=44 && r.y>=b.y && r.bottom<=b.bottom+1
                            && r.bottom<=f.top+1 && f.bottom<=innerHeight+1;
                    })()""")
                    page.screenshot(path=str(output / f'composer-ime-sized-{phase}.png'))
                    page.keyboard.press('Escape')
                    page.wait_for_function('!gameFixture.reader.panel')
                    assert page.evaluate("gameFixture.calls.filter(c=>c.kind==='generation').length") == 3
                    page.set_viewport_size({'width': width, 'height': height})
                cases.append({'viewport': [width, height], 'theme': theme, 'pass': True,
                              'checks': ['zero-form-onboarding', 'automatic-resources', 'three-actual-Spine-actors',
                                         'MomoTalk', 'invitation-to-event-to-private', 'atomic-withdraw-backup',
                                         'local-reopen', 'no-director-editor', 'zero-passive-generation',
                                         'fullscreen-stage-controls', 'landscape-private-layout']})
                context.close()
        browser.close()
except Exception as error:
    record('assertion', message=str(error), trace=traceback.format_exc())
finally:
    report = {'cases': cases, 'failures': failures, 'actualMediaSource': '1.1.11',
              'syntheticNativeAndProviders': True, 'realDeviceTested': False,
              'original126EquivalenceVerified': False, 'playerAccountUsed': False}
    (output / ('quick-results.json' if args.quick else 'results.json')).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    try:
        with urlopen(Request(f'http://127.0.0.1:{args.port}/__fixture_stop',data=b'{}',method='POST'),timeout=3) as response:
            response.read()
    except Exception:
        pass
if failures:
    raise SystemExit(1)
