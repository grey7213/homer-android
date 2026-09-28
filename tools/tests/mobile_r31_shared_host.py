"""Browser contract test of the Android persistent-host navigation protocol.

Uses APK assets and the local disposable backend. Not an Android device test.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

p = argparse.ArgumentParser()
p.add_argument('--credentials', type=Path, required=True)
p.add_argument('--base', default='http://127.0.0.1:8191')
p.add_argument('--output', type=Path, default=Path('output/mobile-r31/shared-host'))
a = p.parse_args()
assert urlparse(a.base).hostname in ('127.0.0.1', 'localhost')
data = json.loads(a.credentials.read_text(encoding='utf-8-sig'))
user = data.get('admin', data)
a.output.mkdir(parents=True, exist_ok=True)
report = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, channel='chrome')
    for width, height in [(390, 844), (1440, 900)]:
        context = browser.new_context(viewport={'width': width, 'height': height})
        context.add_init_script('performance.setResourceTimingBufferSize(5000)')
        context.add_init_script("""window.addEventListener('message',e=>{
          if(e.source===document.querySelector('#dialogue-frame')?.contentWindow && e.data?.type==='ready')
            requestAnimationFrame(()=>requestAnimationFrame(()=>performance.mark('test-ready-painted')));
        })""")
        page = context.new_page()
        errors, failures, generations = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('response', lambda r: failures.append({'path': urlparse(r.url).path, 'status': r.status}) if r.status >= 400 else None)
        page.on('request', lambda r: generations.append(r.url) if '/generate' in r.url and r.method == 'POST' else None)
        page.goto(a.base + '/app/login.html')
        page.wait_for_load_state('networkidle')
        page.locator('input[type=email]:visible').fill(user['email'])
        page.locator('input[type=password]:visible').fill(user['password'])
        page.locator('button[type=submit]:visible').click()
        page.wait_for_url(lambda u: 'login.html' not in u)
        fixture = page.evaluate("""async () => {
          const {api}=await import('/assets/js/api.js');
          const {api:app}=await import('/app/assets/js/app-core.js');
          const r=await api.admin.apps({q:'R29 后台试聊验收',source:'all',page:1,page_size:30,lightweight:1});
          const card=(r.data||r).list[0];
          if(!card) throw Error('Run R29 fixtures first');
          const s=await app.dialogueSession(card.id,'',{launchOnly:true});
          return {app:card.id,conversation:(s.data||s).launch.conversation_id};
        }""")
        page.goto(a.base + '/app/chat.html?prewarm=1', wait_until='domcontentloaded')
        frame = page.frame_locator('#dialogue-frame')
        def navigate(query):
            return page.evaluate("""query => {
              performance.mark('test-navigation-click');
              return !window.dispatchEvent(new CustomEvent('homer:navigate-conversation',
                {cancelable:true,detail:{url:location.origin+'/app/chat.html?'+new URLSearchParams(query)}}));
            }""", query)
        normal = {'app_id': str(fixture['app']), 'conversation_id': fixture['conversation']}
        assert navigate(normal)
        expect(frame.locator('#send_textarea')).to_be_visible(timeout=90000)
        page.wait_for_function("document.body.classList.contains('is-ready')")
        expect(frame.locator('#chat')).to_contain_text('后台独立测试对话')
        page.wait_for_function("performance.getEntriesByName('test-ready-painted').length>0")
        cold_ms = round(page.evaluate("performance.getEntriesByName('test-ready-painted')[0].startTime-performance.getEntriesByName('test-navigation-click')[0].startTime"))
        origin = frame.locator('html').evaluate('()=>performance.timeOrigin')
        history_js = "async()=>{const r=await(await fetch('/console/api/web/conversations')).json();return(r.data||r).list.map(c=>c.id||c.conversation_id).sort()}"
        before = page.evaluate(history_js)
        frame.locator('#send_textarea').fill('R31 ordinary unsent draft')
        assert navigate({'app_id': str(fixture['app']), 'admin_preview': '1'})
        page.wait_for_function("performance.getEntriesByName('homer-admin-workspace-ready').length===1", timeout=30000)
        expect(frame.locator('html')).to_have_class(__import__('re').compile(r'.*homer-admin-preview.*'))
        expect(frame.locator('#send_textarea')).to_have_value('')
        admin_id = page.evaluate("new URL(location.href).searchParams.get('conversation_id')")
        assert admin_id and admin_id != fixture['conversation']
        elapsed = page.evaluate("performance.getEntriesByName('homer-admin-workspace-ready').at(-1).startTime-performance.getEntriesByName('test-navigation-click').at(-1).startTime")
        marks = frame.locator('html').evaluate("()=>performance.getEntriesByType('mark').filter(e=>/^homer-(admin-bind|bootstrap|session|card)/.test(e.name)).map(e=>({name:e.name,ms:Math.round(e.startTime)}))")
        requests = frame.locator('html').evaluate("()=>performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/')).slice(-35).map(e=>({path:new URL(e.name).pathname,start:Math.round(e.startTime),ms:Math.round(e.duration)}))")
        frame.get_by_role('button', name='打开对话设置', exact=True).click()
        expect(frame.locator('#homer-admin-prompt')).to_be_visible()
        expect(frame.locator('#homer-admin-worldbook')).to_be_visible()
        frame.get_by_role('button', name='关闭设置', exact=True).click()
        frame.locator('#send_textarea').fill('R31 private preview draft')
        # Same-card revisit must not discard messages/settings or boot again.
        assert navigate({'app_id': str(fixture['app']), 'admin_preview': '1'})
        expect(frame.locator('#send_textarea')).to_have_value('R31 private preview draft')
        assert navigate(normal)
        page.wait_for_function("!new URL(location.href).searchParams.has('admin_preview') && document.body.classList.contains('is-ready')")
        expect(frame.locator('html')).not_to_have_class(__import__('re').compile(r'.*homer-admin-preview.*'))
        expect(frame.locator('#send_textarea')).to_have_value('R31 ordinary unsent draft')
        assert frame.locator('html').evaluate('()=>performance.timeOrigin') == origin
        assert frame.locator('html').evaluate('()=>performance.getEntriesByType("navigation").length') == 1
        assert page.evaluate(history_js) == before
        assert not page.evaluate("id=>Object.keys(localStorage).some(k=>k.includes(id))", admin_id)
        # A denied preview must not turn into a normal-session create fallback.
        page.route('**/api/homer/admin-preview?*', lambda route: route.fulfill(status=403, content_type='application/json', body='{"error":"R31 test denied"}'))
        assert navigate({'app_id': str(fixture['app']), 'admin_preview': '1'})
        expect(page.locator('#preview-network-detail')).to_contain_text('R31 test denied', timeout=10000)
        page.unroute('**/api/homer/admin-preview?*')
        page.locator('#preview-network-retry').click()
        page.wait_for_function("performance.getEntriesByName('homer-admin-workspace-ready').length===2", timeout=30000)
        expect(frame.locator('#send_textarea')).to_be_enabled()
        assert page.evaluate(history_js) == before
        assert frame.locator('html').evaluate('()=>performance.timeOrigin') == origin
        assert not generations
        assert not errors, errors
        assert failures and all(x['status']==403 and x['path'].endswith('/api/homer/admin-preview') for x in failures), failures
        page.screenshot(path=str(a.output / f'shared-{width}.png'))
        report.append({'viewport':[width,height], 'cold_normal_input_to_paint_ms':cold_ms, 'warm_admin_bind_ms':round(elapsed), 'same_runtime':True,
                       'ordinary_draft_restored':True, 'preview_not_cached':True, 'history_unchanged':True,
                       'auto_generations':0, 'script_errors':errors, 'expected_denials':failures, 'denied_preview_retry_same_host':True})
        report[-1].update(marks=marks,requests=requests)
        context.close()
    browser.close()
(a.output / 'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
