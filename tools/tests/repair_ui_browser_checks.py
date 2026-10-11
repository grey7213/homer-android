"""Shipping APK interface assets with private data and explicitly isolated APIs."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import threading
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/repair-20261011/ui'
USER = {'id': 'qa-ui-private', 'name': '隔离界面验收', 'is_admin': False}
SEARCHES = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, value, mime='application/json', code=200):
        data = json.dumps(value, ensure_ascii=False).encode() if mime == 'application/json' else value
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass
    def do_GET(self):
        url = urlparse(self.path); path = url.path
        if path == '/console/api/account/profile': return self.send({'data': USER})
        if path == '/console/api/public/site-settings': return self.send({'data': {'community_enabled': True}})
        if path == '/console/api/user/point': return self.send({'data': {'points': 123}})
        if path == '/console/api/web/home-stats': return self.send({'data': {}})
        if path in ('/console/api/web/notifications', '/console/api/public/notifications'): return self.send({'data': {'list': []}})
        if path == '/go/api/explore/search':
            SEARCHES.append(parse_qs(url.query))
            return self.send({'data': {'total': 24, 'apps': [{'id': f'qa-ui-{i}', 'display_id': str(7000+i), 'name': f'隔离卡 {i}',
                'description': '用于测试滚动、搜索与卡片展示，不含真实用户内容', 'tags': ['剧情', '奇幻', '验收']} for i in range(24)]}})
        if '/api/' in path: return self.send({'message': 'Missing isolated fixture route ' + path}, code=404)
        base = (ROOT / ('sillytavern-runtime/public' if path.startswith('/scripts/') else 'frontend')).resolve()
        target = (base / path.lstrip('/')).resolve()
        if not target.is_relative_to(base) or not target.is_file(): return self.send({'message': 'Missing asset ' + path}, code=404)
        mime = 'text/javascript' if target.suffix in ('.js', '.mjs') else mimetypes.guess_type(target)[0] or 'application/octet-stream'
        self.send(target.read_bytes(), mime)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 8815), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel='chrome')
            try:
                for width, height in [(390, 844), (1440, 900)]:
                    for theme in ['light', 'dark']:
                        context = browser.new_context(viewport={'width': width, 'height': height})
                        context.add_init_script("if(window===top){localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',"+json.dumps(json.dumps(USER, ensure_ascii=False))+");localStorage.setItem('ai_xingyue_shell_theme',"+json.dumps(theme)+");}")
                        page = context.new_page(); errors = []; failed = []; dialogs = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.on('response', lambda r: failed.append([r.status, urlparse(r.url).path]) if r.status >= 400 else None)
                        page.on('dialog', lambda d: (dialogs.append(d.type), d.dismiss()))
                        page.goto('http://127.0.0.1:8815/app/explore.html')
                        try: page.wait_for_selector('.char-card')
                        except Exception:
                            (OUT / 'failure.json').write_text(json.dumps({'url': page.url, 'errors': errors, 'http': failed, 'searches': SEARCHES, 'body': page.locator('body').inner_text()}, ensure_ascii=False, indent=2), encoding='utf-8')
                            page.screenshot(path=str(OUT / 'failure.png'), full_page=True)
                            raise
                        assert page.evaluate('document.documentElement.dataset.theme') == theme
                        # Do not replace the real explorer; exercise its search and
                        # restore at positions where the old sticky header overlapped.
                        geometry = []
                        for scroll in [0, 36, 60, 96]:
                            page.evaluate('(y)=>scrollTo(0,y)', scroll)
                            page.wait_for_function('(y)=>Math.abs(scrollY-y)<2', arg=scroll)
                            bounds = page.evaluate("""()=>{const h=document.querySelector('.app-topbar').getBoundingClientRect(),s=document.querySelector('.home-search-box input').getBoundingClientRect();return {scroll:scrollY,headerBottom:h.bottom,searchTop:s.top,searchBottom:s.bottom,overlap:h.bottom>s.top,position:getComputedStyle(document.querySelector('.app-topbar')).position}}""")
                            assert not bounds['overlap'], bounds
                            geometry.append(bounds)
                        page.evaluate('scrollTo(0,0)')
                        search = page.locator('.home-search-box input'); search.fill('隔离验收'); search.press('Enter')
                        page.wait_for_function("!Alpine.$data(document.querySelector('[x-data]')).loading")
                        assert SEARCHES[-1]['q'] == ['隔离验收'] and SEARCHES[-1]['zone'] == ['clean']
                        page.screenshot(path=str(OUT / f'explore-{theme}-{width}.png'))
                        page.goto('http://127.0.0.1:8815/app/workshop-resource-editor.html?type=ui_template')
                        source = page.get_by_role('textbox', name='资源源内容', exact=True)
                        page.locator('#resource-source summary').click()
                        page.locator('input[name=name]').fill('未发布的验收草稿')
                        page.locator('#regex-sample').fill('test')
                        source.fill(json.dumps({'regex_scripts': [{'findRegex': 'test', 'replaceString': '<b>有效预览</b>'}]}))
                        page.locator('#regex-run').click()
                        page.wait_for_function("document.querySelector('#regex-status').textContent.includes('已按顺序')")
                        assert page.locator('#regex-output').inner_text() == '<b>有效预览</b>'
                        assert page.locator('.resource-preview-grid').is_visible()
                        source.fill(json.dumps({'regex_scripts': [{'findRegex': '[', 'replaceString': 'bad'}]}))
                        page.locator('#regex-run').click()
                        page.wait_for_function("document.querySelector('#regex-status').textContent.includes('第 1 条规则无法预览')")
                        assert page.locator('#regex-output').inner_text() == ''
                        assert page.locator('#regex-frame').get_attribute('srcdoc') == ''
                        assert not page.locator('.resource-preview-grid').is_visible()
                        page.evaluate('scrollTo(0,0)')
                        page.screenshot(path=str(OUT / f'regex-error-{theme}-{width}.png'), full_page=True)
                        source.fill(json.dumps({'regex_scripts': [{'findRegex': 'test', 'replaceString': '修正后成功'}]}))
                        page.locator('#regex-run').click()
                        page.wait_for_function("document.querySelector('#regex-output').textContent==='修正后成功'")
                        # Real document navigation commits the current draft and
                        # no longer opens the English browser before-unload UI.
                        page.goto('http://127.0.0.1:8815/app/explore.html')
                        page.goto('http://127.0.0.1:8815/app/workshop-resource-editor.html?type=ui_template')
                        page.wait_for_function("document.querySelector('input[name=name]').value==='未发布的验收草稿'")
                        page.locator('#resource-source summary').click()
                        assert json.loads(source.input_value())['regex_scripts'][0]['replaceString'] == '修正后成功'
                        # A storage quota failure must keep the actual loss gate;
                        # it must not claim that a draft was committed.
                        page.evaluate("()=>{Storage.prototype.setItem=function(){throw new DOMException('synthetic quota','QuotaExceededError')};return true;}")
                        source.fill(json.dumps({'regex_scripts': [{'findRegex': 'still local'}]}))
                        page.wait_for_function("document.querySelector('#resource-status').textContent.includes('草稿未能保存')")
                        page.locator('#resource-back').click()
                        confirm = page.locator('dialog.homer-action-dialog')
                        confirm.wait_for(state='visible')
                        assert '继续离开会丢失' in confirm.inner_text()
                        confirm.get_by_role('button', name='取消', exact=True).click()
                        assert 'still local' in source.input_value()
                        assert not dialogs, dialogs
                        assert not errors, errors
                        assert not failed, failed
                        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
                        results.append({'viewport': [width, height], 'theme': theme, 'search_geometry': geometry,
                            'search_pure_zone_preserved': True, 'regex_invalid_clear_and_repair': True,
                            'draft_navigation_restore_without_default_prompt': True, 'quota_failure_cancel_preserves_editor': True,
                            'page_errors': errors, 'http_errors': failed})
                        context.close()
            finally: browser.close()
    finally: server.shutdown(); server.server_close()
    (OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
