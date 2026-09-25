"""Local acceptance checks. Credentials are read from a file, never printed."""
import argparse
import json
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:8082')
parser.add_argument('--credentials', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
credentials = json.loads(args.credentials.read_text(encoding='utf-8-sig'))
user = credentials.get('admin', credentials)
result = {'viewports': [], 'errors': [], 'httpErrors': [], 'failedRequests': []}
stamp = str(int(time.time()))
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    for width, height in [(390, 844), (1440, 900)]:
        context = browser.new_context(viewport={'width': width, 'height': height})
        page = context.new_page()
        page.on('pageerror', lambda error: result['errors'].append(str(error)))
        page.on('response', lambda response: result['httpErrors'].append({'path': urlparse(response.url).path, 'status': response.status}) if response.status >= 400 else None)
        page.on('requestfailed', lambda request: result['failedRequests'].append({'path': urlparse(request.url).path, 'failure': request.failure}))
        page.add_init_script("window.longTasks=[];new PerformanceObserver(l=>window.longTasks.push(...l.getEntries().map(x=>({start:x.startTime,duration:x.duration})))).observe({type:'longtask',buffered:true});window.chatEvents=[];window.addEventListener('message',e=>{if(e.data?.channel==='homer:dialogue-host:v1')window.chatEvents.push({type:e.data.type,ms:performance.now()})})")
        page.goto(args.base + '/app/login.html'); page.wait_for_load_state('networkidle')
        page.locator('input[type=email]:visible').fill(user.get('email', user.get('account', '')))
        page.locator('input[type=password]:visible').fill(user['password'])
        page.locator('button[type=submit]:visible').click()
        page.wait_for_url(lambda url: 'login.html' not in url, timeout=20000)
        run = {'width': width, 'pages': [], 'resources': []}
        catalog = page.evaluate("""async()=>{const {fillModelSelect}=await import('/assets/js/model-catalog.js');const select=document.createElement('select');fillModelSelect(select,[{id:'a',model:'provider-raw-name',display_name:'轻语',group_id:'daily',group_name:'日常'},{id:'b',model:'provider-raw-name',display_name:'星河',group_id:'write',group_name:'创作'},{id:'c',model:'provider-raw-name',display_name:'皓月',group_id:'pro',group_name:'高级'}]);return {text:select.textContent,groups:[...select.children].map(x=>x.label),ids:[...select.options].map(x=>x.value)}}""")
        assert catalog['groups'] == ['日常', '创作', '高级']
        assert catalog['text'] == '轻语星河皓月' and catalog['ids'] == ['a', 'b', 'c']
        run['modelAliasesAndGroups'] = True
        for path in ['workshop', 'explore', 'histories', 'me', 'community']:
            page.goto(args.base + '/app/' + path + '.html'); page.wait_for_load_state('networkidle')
            metrics = page.evaluate('({load:performance.getEntriesByType("navigation")[0].loadEventEnd,dcl:performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd,longTasks:window.longTasks,overflow:document.documentElement.scrollWidth>innerWidth+1})')
            assert not metrics['overflow'], (path, width, 'horizontal overflow')
            assert page.locator('script[src*="tailwindcss-browser"]').count() == 0
            run['pages'].append({'path': path, **metrics})
            if path == 'workshop': page.screenshot(path=str(args.output / f'workshop-{width}.png'), full_page=True)
        # Independent resource pages, real file input and persistence.
        for kind, payload in [('regex', {'scriptName': '替换测试', 'findRegex': '/猫/g', 'replaceString': '<b>小猫</b>'}), ('preset', {'prompts': [{'identifier': 'main', 'name': '主体', 'content': '系统提示'}], 'prompt_order': []}), ('mod', {'entries': {'0': {'uid': 0, 'key': ['城市'], 'content': '这是测试世界', 'comment': '城市'}}})]:
            page.goto(args.base + '/app/workshop-resource-editor.html?type=' + kind); page.wait_for_load_state('networkidle')
            page.locator('#resource-file').set_input_files({'name': f'验收-{kind}-{width}-{stamp}.json', 'mimeType': 'application/json', 'buffer': json.dumps(payload, ensure_ascii=False).encode()})
            page.get_by_text('已导入。点击保存后生效。', exact=True).wait_for()
            if kind == 'regex':
                page.locator('#regex-sample').fill('猫和猫')
                page.locator('#regex-run').click()
                page.wait_for_function("document.querySelector('#regex-output').textContent === '<b>小猫</b>和<b>小猫</b>'")
                expect(page.frame_locator('#regex-frame').locator('b')).to_have_count(2)
                page.screenshot(path=str(args.output / f'regex-preview-{width}.png'), full_page=True)
            page.locator('#resource-save').click()
            page.wait_for_url('**/workshop-resource.html?type=' + ('ui_template' if kind == 'regex' else kind), timeout=15000)
            page.wait_for_load_state('networkidle')
            name = f'验收-{kind}-{width}-{stamp}'
            page.get_by_role('link', name=name).click()
            page.wait_for_load_state('networkidle')
            assert page.locator('input[name=name]').input_value() == name
            assert page.locator('#resource-version-fields').is_visible()
            run['resources'].append({'type': kind, 'savedAndReopened': True})
        if width == 390:
            card = {'spec': 'chara_card_v2', 'spec_version': '2.0', 'data': {'name': 'R25导入验收-' + stamp, 'description': '本地验收角色，不调用生成', 'first_mes': '这是导入角色的第一条消息。', 'mes_example': '', 'personality': '', 'scenario': '', 'creator_notes': '', 'extensions': {}}}
            page.goto(args.base + '/app/create.html'); page.wait_for_load_state('networkidle')
            page.locator('input[x-ref=importInput]').set_input_files({'name': '验收角色.json', 'mimeType': 'application/json', 'buffer': json.dumps(card, ensure_ascii=False).encode()})
            page.wait_for_url('**/create.html?id=*', timeout=20000)
            app_id = parse_qs(urlparse(page.url).query)['id'][0]
            page.goto(args.base + '/app/chat.html?app_id=' + app_id)
            page.wait_for_function("document.body.classList.contains('is-ready')", timeout=90000)
            run['chat'] = {'url': urlparse(page.url).path + '?' + urlparse(page.url).query, 'readyMs': page.evaluate('performance.now()'), 'events': page.evaluate('window.chatEvents'), 'longTasks': page.evaluate('window.longTasks')}
            runtime = next(f for f in page.frames if '/module/dialogue' in f.url)
            run['chat']['marks'] = runtime.evaluate('performance.getEntriesByType("mark").map(x=>({name:x.name,start:x.startTime}))')
            wrong_base = runtime.evaluate("performance.getEntriesByType('resource').filter(x=>/^\\/(css|lib|webfonts)\\//.test(new URL(x.name).pathname)).map(x=>new URL(x.name).pathname)")
            assert not wrong_base, ('runtime preload scanner requested wrong-root assets', wrong_base)
            assert '这是导入角色的第一条消息' in runtime.locator('#chat').inner_text()
            page.screenshot(path=str(args.output / 'imported-chat.png'))
            conversation = parse_qs(urlparse(page.url).query)['conversation_id'][0]
            page.goto(args.base + '/app/histories.html'); page.wait_for_load_state('networkidle')
            history_text = page.locator('body').inner_text()
            assert card['data']['name'] in history_text, 'new imported conversation missing from history'
            run['chat']['historyVisible'] = True
            history = page.evaluate("async()=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.conversations()).data.list}")
            assert sum(str(x['app_id']) == app_id for x in history) == 1, 'duplicate conversations'
            blocked_history = []
            def block_history(route):
                blocked_history.append(route.request.url)
                route.abort()
            page.route('**/console/api/web/conversations**', block_history)
            page.reload(); page.wait_for_load_state('networkidle')
            assert card['data']['name'] in page.locator('body').inner_text(), 'cached history disappeared on network failure'
            assert blocked_history, 'offline test did not intercept any history request'
            page.unroute('**/console/api/web/conversations**')
            run['chat']['historyAvailableOffline'] = True
            page.goto(args.base + '/app/chat.html?app_id=' + app_id + '&conversation_id=' + conversation)
            page.wait_for_function("document.body.classList.contains('is-ready')", timeout=90000)
            run['chat']['reopenMs'] = page.evaluate('performance.now()')
        result['viewports'].append(run)
        (args.output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        context.close()
    browser.close()
assert not result['errors'], result['errors']
assert not [r for r in result['httpErrors'] if r['path'] != '/media-cache/profile/default-avatar.png'], result['httpErrors']
print(json.dumps(result, ensure_ascii=False))
