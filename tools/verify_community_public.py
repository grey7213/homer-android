"""Browser acceptance for the public community entry with an ordinary user."""
import functools
import json
import sqlite3
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server-extensions'))
from community_feed import ensure_feed_schema, handle_feed_route

OUT = ROOT / 'output' / 'community-r8-public'


class Server(SimpleHTTPRequestHandler):
    conn = None
    lock = None

    def log_message(self, *args):
        pass

    def api(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith(('/console/', '/admin/api/')):
            return False
        user = {'id': self.headers.get('X-Test-User', 'ordinary'), 'name': '本地测试作者'}
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
        result = handle_feed_route(self.command, parsed.path, parse_qs(parsed.query), body, {
            'conn': self.conn,
            'lock': self.lock,
            'user': user,
            'is_admin': False,
            'resolve_cards': lambda ids, current: {'1234': {'id': 'fixture-card', 'name': '黎明之契（测试）', 'visible': True}},
        })
        if result is None:
            result = user if parsed.path.endswith('/account/profile') else {'data': {'list': []}}
        payload = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(result.get('__http__', 200))
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        return True

    def do_GET(self):
        if not self.api():
            super().do_GET()

    def do_POST(self):
        self.api()

    def do_PATCH(self):
        self.api()

    def do_DELETE(self):
        self.api()


def exercise(browser, base, width, height):
    context = browser.new_context(
        viewport={'width': width, 'height': height},
        extra_http_headers={'X-Test-User': f'ordinary-{width}'},
        reduced_motion='reduce',
    )
    context.add_init_script("""
      localStorage.setItem('ai_xingyue_logged_in','1');
      localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'ordinary',name:'普通测试用户',is_admin:false}));
      window.HomerNative={isDebugBuild(){return true},setAccountScope(){},notifyShellReady(){}};
    """)
    page = context.new_page()
    errors, failed = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    page.on('requestfailed', lambda request: failed.append(request.url))

    page.goto(base + '/app/', wait_until='networkidle')
    page.wait_for_url('**/app/community.html')
    expect(page.locator('[data-app-bottom-nav] a')).to_have_count(5)
    expect(page.locator('[data-community-nav]')).to_be_visible()
    expect(page.locator('[data-local-acceptance]')).to_have_count(0)

    consent = page.get_by_role('dialog', name='进入社区前，请阅读')
    expect(consent).to_be_visible()
    expect(consent.get_by_role('button', name='同意并进入')).to_be_disabled()
    consent.get_by_role('checkbox').check()
    consent.get_by_role('button', name='同意并进入').click()
    expect(page.get_by_role('button', name='发布帖子', exact=True)).to_be_visible()

    page.get_by_role('button', name='发布帖子', exact=True).click()
    page.wait_for_url('**/app/community-compose.html')
    page.get_by_role('textbox', name='帖子标题').fill(f'普通用户公开社区 {width}')
    page.get_by_role('textbox', name='帖子正文').fill('这条内容通过真实社区路由写入内存数据库。ID：1234')
    page.get_by_role('button', name='发布', exact=True).click()
    page.wait_for_url('**/app/community-post.html?id=*')
    expect(page.locator('.c-detail h2')).to_have_text(f'普通用户公开社区 {width}')
    expect(page.get_by_role('link', name='黎明之契（测试）')).to_have_attribute('href', '/app/character.html?id=fixture-card')
    assert 'acceptance=local' not in page.url
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
    page.screenshot(path=str(OUT / f'public-{width}.png'), full_page=True)
    assert not errors, errors
    assert not failed, failed
    context.close()
    return {'viewport': [width, height], 'ordinary_user': True, 'default_home': 'community', 'errors': errors, 'request_failures': failed}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    Server.conn = sqlite3.connect(':memory:', check_same_thread=False)
    Server.lock = threading.RLock()
    ensure_feed_schema(Server.conn, Server.lock)
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Server, directory=str(ROOT / 'frontend')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            try:
                base = f'http://127.0.0.1:{server.server_port}'
                results = [exercise(browser, base, width, height) for width, height in ((390, 844), (360, 800), (1440, 900))]
                (OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps(results, ensure_ascii=False))
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
