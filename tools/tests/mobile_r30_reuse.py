"""Local APK browser acceptance: actual runtime, warm bind/revisit and isolation."""
import argparse
import json
import math
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

p = argparse.ArgumentParser()
p.add_argument('--credentials', type=Path, required=True)
p.add_argument('--output', type=Path, default=Path('output/mobile-r30/reuse'))
p.add_argument('--base', default='http://127.0.0.1:8191')
a = p.parse_args()
assert urlparse(a.base).hostname in ('localhost', '127.0.0.1')
credentials = json.loads(a.credentials.read_text(encoding='utf-8-sig'))
user = credentials.get('admin', credentials)
a.output.mkdir(parents=True, exist_ok=True)
results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, channel='chrome')
    for width, height in [(390, 844), (1440, 900)]:
        context = browser.new_context(viewport={'width': width, 'height': height})
        page = context.new_page()
        errors, failures, generations = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('response', lambda r: failures.append({'path': urlparse(r.url).path, 'status': r.status}) if r.status >= 400 else None)
        page.on('request', lambda r: generations.append(urlparse(r.url).path) if '/generate' in r.url and r.method == 'POST' else None)
        page.goto(a.base + '/app/login.html')
        page.wait_for_load_state('networkidle')
        page.locator('input[type=email]:visible').fill(user['email'])
        page.locator('input[type=password]:visible').fill(user['password'])
        page.locator('button[type=submit]:visible').click()
        page.wait_for_url(lambda u: 'login.html' not in u)
        history = lambda: page.evaluate("async()=>{const r=await fetch('/console/api/web/conversations');const j=await r.json();return ((j.data||j).list||[]).map(c=>c.id||c.conversation_id).sort()}")
        before = history()
        page.goto(a.base + '/admin.html')
        page.wait_for_load_state('networkidle')
        def tab(name):
            if width < 768:
                page.get_by_label('管理后台功能', exact=True).select_option(name)
            else:
                label = {'dialogue-preview': '会话工作区', 'global-presets': '全局预设'}[name]
                page.get_by_role('button', name=label, exact=True).first.click()
        tab('dialogue-preview')
        page.get_by_placeholder('输入名称或 ID').fill('R29 后台试聊验收')
        page.get_by_role('button', name='搜索', exact=True).click()
        select = page.locator('select[aria-label="测试角色"]')
        expect(select.locator('option')).not_to_have_count(1)
        cards = select.locator('option').evaluate_all('(nodes)=>nodes.map(n=>n.value).filter(Boolean)')
        assert len(cards) >= 2, 'Run R29 local fixtures first'
        frame = page.frame_locator('#admin-dialogue-frame')
        frame.locator('html').evaluate("()=>new Promise((resolve,reject)=>{const stop=setTimeout(()=>reject(new Error('core-ready timed out')),30000);const poll=()=>{if(performance.getEntriesByName('homer-prewarm-core-ready').length){clearTimeout(stop);resolve()}else setTimeout(poll,50)};poll()})")
        origin = frame.locator('html').evaluate('()=>performance.timeOrigin')
        page.evaluate("""()=>{
          const section=document.querySelector('.admin-dialogue');
          let pending=false;
          const start=event=>{if((event.type==='change'&&event.target.getAttribute('aria-label')==='管理后台功能'&&event.target.value==='dialogue-preview')||(event.type==='click'&&event.target.closest('button')?.textContent.trim()==='会话工作区')){pending=true;performance.mark('r30-tab-input')}};
          document.addEventListener('click',start,true);document.addEventListener('change',start,true);
          new MutationObserver(()=>{if(pending&&!section.classList.contains('is-parked')){pending=false;requestAnimationFrame(()=>requestAnimationFrame(()=>performance.mark('r30-tab-painted')))}}).observe(section,{attributes:true,attributeFilter:['class']});
        }""")
        samples, revisits = [], []
        for index in range(6):
            if index:
                page.get_by_role('button', name='切换角色', exact=True).click()
            select.select_option(cards[index % 2], force=True)
            # The read-only selected-card request is deliberately off the click path.
            page.wait_for_timeout(300)
            old_count = page.evaluate("performance.getEntriesByName('homer-admin-workspace-ready').length")
            page.get_by_role('button', name='重新开始' if index else '开始会话', exact=True).click()
            if index:
                page.get_by_role('dialog').get_by_role('button', name='重新开始', exact=True).click()
            page.wait_for_function("n=>performance.getEntriesByName('homer-admin-workspace-ready').length>n", arg=old_count, timeout=30000)
            samples.append(round(page.evaluate("performance.getEntriesByName('homer-admin-workspace-ready').at(-1).startTime-performance.getEntriesByName('homer-admin-workspace-click').at(-1).startTime")))
            expect(frame.locator('#send_textarea')).to_be_enabled()
            expect(frame.locator('#chat')).to_contain_text('后台独立测试对话')
            assert frame.locator('html').evaluate('()=>performance.timeOrigin') == origin
            assert frame.locator('html').evaluate('()=>performance.getEntriesByType("navigation").length') == 1
            assert 'homer_app_id=' + cards[index % 2] in frame.locator('html').evaluate('()=>location.href')
            frame.get_by_role('button', name='打开对话设置', exact=True).click()
            expect(frame.locator('#homer-admin-prompt')).to_be_visible()
            frame.get_by_role('button', name='关闭设置', exact=True).click()
            tab('global-presets')
            page.evaluate("performance.mark('r30-revisit-start')")
            tab('dialogue-preview')
            expect(frame.locator('#send_textarea')).to_be_visible()
            page.wait_for_function("performance.getEntriesByName('r30-tab-painted').length===performance.getEntriesByName('r30-tab-input').length")
            revisits.append(round(page.evaluate("performance.getEntriesByName('r30-tab-painted').at(-1).startTime-performance.getEntriesByName('r30-tab-input').at(-1).startTime")))
        page.screenshot(path=str(a.output / f'ready-{width}.png'))
        assert not errors, errors
        assert not failures, failures
        assert not generations, 'Opening/rebinding must not generate'
        assert history() == before, 'Preview must not create ordinary histories'
        marks = frame.locator('html').evaluate("()=>performance.getEntriesByType('mark').filter(e=>e.name.startsWith('homer-native')).map(e=>({name:e.name,ms:Math.round(e.startTime)}))")
        results.append({'viewport': [width,height], 'warm_bind_ms': samples, 'warm_bind_p95_ms': sorted(samples)[math.ceil(.95*len(samples))-1], 'revisit_input_to_paint_ms': revisits, 'native_cold_marks': marks, 'errors': errors, 'http_errors': failures, 'auto_generation_count':len(generations), 'same_frame_all_switches':True, 'normal_history_unchanged':True})
        context.close()
    browser.close()
(a.output/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
