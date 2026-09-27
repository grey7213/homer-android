"""Actual APK extension regression. Local disposable runtime only; no generation."""
import argparse
import json
import zipfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

p = argparse.ArgumentParser()
p.add_argument('--credentials', type=Path, required=True)
p.add_argument('--output', type=Path, default=Path('output/mobile-r31/extensions'))
p.add_argument('--baseline-apk', type=Path)
a = p.parse_args()
user = json.loads(a.credentials.read_text(encoding='utf-8-sig'))
user = user.get('admin', user)
a.output.mkdir(parents=True, exist_ok=True)
report = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, channel='chrome')
    for width, height in [(390, 844), (1440, 900)]:
        context = browser.new_context(viewport={'width': width, 'height': height})
        if a.baseline_apk:
            with zipfile.ZipFile(a.baseline_apk) as apk:
                prefix = 'assets/client/runtime/scripts/extensions/third-party/ST-Prompt-Template/dist/'
                baseline = {n[len(prefix):]: apk.read(n) for n in apk.namelist() if n.startswith(prefix)}
            assert baseline, 'Baseline extension assets not found'
            def baseline_route(route):
                name = urlparse(route.request.url).path.split('/ST-Prompt-Template/dist/', 1)[1]
                if name in baseline:
                    route.fulfill(body=baseline[name], content_type='text/javascript' if name.endswith('.js') else 'application/octet-stream')
                else:
                    route.continue_()
            context.route('**/ST-Prompt-Template/dist/**', baseline_route)
        page = context.new_page()
        errors, failures = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('response', lambda r: failures.append({'path': urlparse(r.url).path, 'status': r.status}) if r.status >= 400 else None)
        page.goto('http://127.0.0.1:8191/app/login.html')
        page.wait_for_load_state('networkidle')
        page.locator('input[type=email]:visible').fill(user['email'])
        page.locator('input[type=password]:visible').fill(user['password'])
        page.locator('button[type=submit]:visible').click()
        page.wait_for_url(lambda u: 'login.html' not in u)
        page.goto('http://127.0.0.1:8191/admin.html')
        page.wait_for_load_state('networkidle')
        if width < 768:
            page.get_by_label('管理后台功能', exact=True).select_option('dialogue-preview')
        else:
            page.get_by_role('button', name='会话工作区', exact=True).first.click()
        page.get_by_placeholder('输入名称或 ID').fill('R29 后台试聊验收')
        page.get_by_role('button', name='搜索', exact=True).click()
        expect(page.locator('select[aria-label="测试角色"] option')).not_to_have_count(1)
        page.get_by_role('button', name='开始会话', exact=True).click()
        frame = page.frame_locator('#admin-dialogue-frame')
        expect(frame.locator('#chat')).to_contain_text('后台独立测试对话', timeout=30000)
        root = frame.locator('html')
        expect(root).to_have_class(__import__('re').compile('.*homer-runtime-ready.*'))
        keyboard = root.evaluate("""async()=>{
          const k=await import('./scripts/keyboard.js');
          const tick=()=>new Promise(r=>setTimeout(r,0));
          const parent=document.createElement('div'),child=document.createElement('div');
          parent.id='r31-keyboard';child.className='menu_button';child.tabIndex=3;
          parent.append(child);document.body.append(parent);await tick();
          const initial=child.tabIndex;parent.classList.add('disabled');await tick();
          const disabled=!child.hasAttribute('tabindex');parent.classList.remove('disabled');await tick();
          const restored=child.tabIndex;
          const custom=document.createElement('div');custom.className='r31-custom';parent.append(custom);
          k.registerInteractableType('.r31-custom');await tick();
          let clicks=0;custom.onclick=()=>clicks++;
          custom.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
          const registered=custom.tabIndex===0;parent.remove();
          return {initial,disabled,restored,registered,clicks};
        }""")
        assert keyboard == {'initial': 3, 'disabled': True, 'restored': 3, 'registered': True, 'clicks': 1}, keyboard
        # Template evaluation stays eagerly available; only its large editor is lazy.
        assert root.evaluate("async()=>await EjsTemplate.evalTemplate('R31=<%= 1 + 1 %>',{})") == 'R31=2'
        before = root.evaluate("()=>performance.getEntriesByType('resource').filter(x=>x.name.includes('prompt-code-editor')).length")
        if not a.baseline_apk:
            assert before == 0, 'Editor loaded before any edit action'
        features = root.evaluate('()=>EjsTemplate.getFeatures()')
        try:
            root.evaluate("""()=>{
              EjsTemplate.setFeatures({enabled:true,code_editor:true});
              const list=document.querySelector('#world_popup_entries_list');
              const row=document.createElement('div');row.id='r31-world-entry';
              row.innerHTML='<div><div><i class="fa-circle-chevron-down"></i></div></div><button class="editor_maximize" data-for="world_entry_content_r31">Edit</button><textarea id="world_entry_content_r31">R31 original</textarea>';
              list.append(row);row.querySelector('i').click();
            }""")
            clone = frame.locator('#r31-world-entry button:not(.editor_maximize)')
            expect(clone).to_have_count(1, timeout=10000)
            clone.evaluate('(node)=>node.click()')
            expect(frame.locator('#editor-container .monaco-editor')).to_be_visible(timeout=30000)
            expect(frame.locator('#editor-container .view-lines')).to_contain_text('R31 original')
            frame.locator('#editor-container .view-lines').click(position={'x': 40, 'y': 8})
            page.keyboard.press('Control+a')
            page.keyboard.type('R31 edited')
            expect(frame.locator('#editor-container .view-lines')).to_contain_text('R31 edited')
            page.screenshot(path=str(a.output / f'editor-{width}.png'))
            frame.locator('dialog[open] .popup-button-ok').click()
            expect(frame.locator('#editor-container')).to_have_count(0)
            expect(frame.locator('#world_entry_content_r31')).to_have_value('R31 edited')
            print(f'{width}: editor typed and saved', flush=True)
            clone.evaluate('(node)=>node.click()')
            expect(frame.locator('#editor-container .monaco-editor')).to_be_visible()
            expect(frame.locator('#editor-container .view-lines')).to_contain_text('R31 edited')
            print(f'{width}: editor reopened', flush=True)
            save = frame.locator('dialog[open] .popup-button-ok')
            assert save.evaluate('(n)=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}'), 'Save is covered'
            rect = save.bounding_box()
            page.mouse.click(rect['x'] + rect['width']/2, rect['y'] + rect['height']/2)
            expect(frame.locator('#editor-container')).to_have_count(0)
        finally:
            root.evaluate('(features)=>{EjsTemplate.setFeatures(features);document.querySelector("#r31-world-entry")?.remove()}', features)
        assert not errors, errors
        assert not failures, failures
        report.append({'viewport': [width,height], 'keyboard': keyboard, 'template_evaluation': True, 'editor_open_save_reopen': True, 'baseline_template': bool(a.baseline_apk), 'errors': errors, 'http': failures})
        context.close()
    browser.close()
(a.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('PASS: two viewports, dynamic keyboard controls, real template evaluation, lazy editor open/save/reopen, no JS/HTTP failures')
