"""Actual 1.1.11 media + actual client/IDB. Only transport/native picker is synthetic."""
import argparse
import json
import traceback
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(); parser.add_argument('--port', type=int, default=8794)
parser.add_argument('--small-pack', action='store_true')
args = parser.parse_args(); base = f'http://127.0.0.1:{args.port}'
output = Path(__file__).resolve().parents[2] / ('output/chatarchive-r359/browser-small-pack' if args.small_pack else 'output/chatarchive-r359/browser')
output.mkdir(parents=True, exist_ok=True)
cases, failures = [], []; phase = 'startup'

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='C:/Users/ROG/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
                                    headless=True, args=['--enable-unsafe-swiftshader'])
        for width, height in [(390, 844), (844, 390), (1440, 900)]:
            for theme in ['light', 'dark']:
                phase = f'{width}-{height}-{theme}'
                context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
                page = context.new_page(); page.set_default_timeout(30000)
                page.on('pageerror', lambda error: failures.append({'phase': phase, 'kind': 'script', 'message': str(error)}))
                page.on('console', lambda message: failures.append({'phase': phase, 'kind': 'console', 'message': message.text}) if message.type == 'error' else None)
                page.on('response', lambda response: failures.append({'phase': phase, 'kind': 'http', 'url': response.url, 'status': response.status}) if response.status >= 400 else None)
                page.on('requestfailed', lambda request: failures.append({'phase': phase, 'kind': 'network', 'url': request.url, 'message': request.failure}) if request.failure != 'net::ERR_ABORTED' else None)
                page.goto(base + f'/game-fixture?archive=1&theme={theme}&slot={phase}' + ('&pack=yuuka' if args.small_pack else ''))
                page.wait_for_function('window.gameFixtureReady'); page.wait_for_load_state('networkidle')
                page.screenshot(path=str(output / f'hall-{phase}.png'), full_page=True)
                page.get_by_role('button', name='新故事', exact=True).click()
                page.wait_for_function("document.querySelectorAll('[data-game-roles] button').length>0")
                assert page.evaluate("gameFixture.calls.length") == 0  # catalog local, no role API
                page.locator('[data-game-role-query]').fill('早濑优香'); page.get_by_role('button', name='查找', exact=True).click()
                page.get_by_role('button', name='早濑优香', exact=True).click()
                page.locator('[data-game-title]').fill('夏莱的来客')
                page.get_by_role('button', name='确认创建专用会话并开始故事', exact=True).click()
                page.wait_for_function("gameFixture.reader?.game?.characters[0]?.themeRoleId==='yuuka'")
                page.wait_for_function("gameFixture.reader?.spine?.renderState?.skeleton?.data?.animations.length>0")
                page.wait_for_load_state('networkidle')
                assert page.evaluate("gameFixture.calls.filter(call=>call.kind==='generation').length") == 0
                assert page.evaluate("gameFixture.calls.filter(call=>call.kind==='import-theme').length") == 1
                assert page.evaluate("gameFixture.calls.find(call=>call.kind==='import-theme').payload.data.character_book.entries.length") == 66
                assert page.evaluate("gameFixture.reader.game.turns.length") == 0
                assert page.locator('.background').evaluate('image=>image.naturalWidth>1000')
                assert page.locator('.ce-portrait-spine').count() == 1
                assert '夏莱办公室' in page.locator('.passage').inner_text()
                if phase == '390-844-light' and not args.small_pack:
                    decoded = page.evaluate("""async () => {
                      const catalog=await (await fetch('/app/assets/data/chatarchive-theme.json')).json();
                      const result={decoded:0,failures:[]};
                      for(const role of catalog.roles) for(const variant of role.variants){
                        try{
                          const [text, bytes]=await Promise.all([fetch(variant.atlas).then(r=>r.text()),fetch(variant.skeleton).then(r=>r.arrayBuffer())]);
                          const atlas=new window.spine.TextureAtlas(text);
                          const loader=new window.spine.SkeletonBinary(new window.spine.AtlasAttachmentLoader(atlas));
                          const data=loader.readSkeletonData(new Uint8Array(bytes));
                          if(data.animations.length!==variant.animations.length) throw Error('animation count mismatch');
                          result.decoded++;
                        }catch(error){result.failures.push({role:role.id,variant:variant.id,error:String(error)});}
                      }
                      return result;
                    }""")
                    (output / 'all-spine-decode.json').write_text(json.dumps(decoded, ensure_ascii=False, indent=2), encoding='utf-8')
                    assert decoded == {'decoded':225,'failures':[]}, decoded
                page.screenshot(path=str(output / f'stage-{phase}.png'))
                page.get_by_role('button', name='立绘 / 场景', exact=True).click()
                chosen_variant = page.evaluate("(()=>{const c=gameFixture.reader.resolveArchiveScene({},'').portrait.metadata.spine.skeleton_url; return [...document.querySelector('#reader').shadowRoot.querySelectorAll('select[aria-label=\"装束 / 差分\"] option')].find(o=>!c.includes('/'+o.value+'/')).value;})()")
                page.get_by_label('装束 / 差分', exact=True).select_option(chosen_variant)
                page.get_by_label('表情 / 动作（原资源编号）', exact=True).select_option(index=0)
                page.get_by_label('背景', exact=True).select_option('millennium/BG_MilleniumCampus' if args.small_pack else 'abydos/BG_AbydosCouncilRoom')
                page.get_by_label('背景音乐', exact=True).select_option(index=0 if args.small_pack else 2)
                page.keyboard.press('Escape')
                page.wait_for_function("gameFixture.reader.spine?.renderState && !gameFixture.reader.panel")
                page.wait_for_load_state('networkidle')
                page.wait_for_function("value=>gameFixture.reader.spine.currentSkeletonUrl.includes('/'+value+'/')", arg=chosen_variant)
                before = page.evaluate('gameFixture.reader.spine.renderState.state.tracks[0].trackTime')
                page.wait_for_timeout(180)
                assert page.evaluate('gameFixture.reader.spine.renderState.state.tracks[0].trackTime') > before
                assert page.evaluate("gameFixture.calls.filter(call=>call.kind==='generation').length") == 0
                page.screenshot(path=str(output / f'variant-{phase}.png'))
                page.get_by_role('button', name='私聊', exact=True).click()
                page.get_by_label('私聊消息', exact=True).fill('老师来看看你')
                page.get_by_role('button', name='发送', exact=True).click()
                page.wait_for_function("gameFixture.reader.game.turns.length===1 && !gameFixture.reader.gameSession.busy")
                assert page.evaluate("gameFixture.calls.filter(call=>call.kind==='generation').length") == 1
                # Local store re-open, NOT a native/cold-offline measurement.
                await_id = page.evaluate('gameFixture.reader.game.id')
                page.evaluate('gameFixture.reopen()')
                page.wait_for_function("gameFixture.reader?.game?.turns.length===1")
                assert page.evaluate('gameFixture.reader.game.id') == await_id
                assert page.evaluate("gameFixture.calls.filter(call=>call.kind==='import-theme').length") == 1
                assert page.evaluate("gameFixture.calls.filter(call=>call.kind==='generation').length") == 1
                page.wait_for_load_state('networkidle')
                cases.append({'viewport': [width, height], 'theme': theme, 'pass': True,
                              'checks': ['local-catalog', 'private-import', 'actual-worldbook', 'actual-Spine-decode',
                                         'actual-background', 'variant-and-expression', 'zero-passive-generation', 'private-thread', 'local-reopen']})
                context.close()
        browser.close()
except Exception as error:
    failures.append({'phase': phase, 'kind': 'assertion', 'message': str(error), 'trace': traceback.format_exc()})
finally:
    report = {'cases': cases, 'failures': failures, 'sourceVersion': '1.1.11', 'actualMedia': True, 'smallPackOnly': args.small_pack,
              'syntheticProviders': True, 'syntheticNativePicker': True, 'realDeviceTested': False, 'productionAccountUsed': False}
    (output / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    try:
        with urlopen(Request(base + '/__fixture_stop', data=b'{}', method='POST'), timeout=3) as response: response.read()
    except Exception: pass
if failures: raise SystemExit(1)
