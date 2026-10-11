"""Real editor journeys against private, deliberately delayed/failed services.

No real account, external API, publication, or uploaded media is used.
"""
import json
import base64
import argparse
import mimetypes
import zipfile
from pathlib import Path
import threading
from urllib.parse import urlparse
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect
import repair_ui_browser_checks as assets

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/repair-20261011/compose'
USER = assets.USER
STATE = {'bootstrap_status': 503, 'mute': False, 'post_status': 503}
GATE = threading.Event()
ACK = threading.Event()
REQUESTS = []
PACKAGED = None
PHOTO = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cZ8kAAAAASUVORK5CYII=')
POST = {'id': 'qa-confirmed', 'is_owner': True, 'user_id': USER['id'], 'author': '隔离验收', 'title': '验收标题',
        'content': '合成正文', 'images': [], 'video': '', 'tags': [], 'status': 'published', 'version': 1}


class Handler(assets.Handler):
    def do_POST(self):
        if urlparse(self.path).path == '/console/api/web/my-apps/upload-cover':
            body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or '{}')
            REQUESTS.append({'method':'POST','path':'qa-image-upload','body':body})
            return self.send({'code':0,'data':{'url':'/qa-photo.png'}})
        self.social('POST')
    def do_GET(self):
        if urlparse(self.path).path == '/qa-photo.png': return self.send(PHOTO,mime='image/png')
        if urlparse(self.path).path.startswith('/console/api/web/social/'):
            return self.social('GET')
        if PACKAGED:
            path=urlparse(self.path).path
            asset='assets/client/web/'+path.lstrip('/')
            if path.startswith('/module/dialogue/'):
                asset='assets/client/runtime/'+path.removeprefix('/module/dialogue/')
            if asset in PACKAGED.namelist():
                mime={'.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.html':'text/html'}.get(Path(path).suffix,mimetypes.guess_type(path)[0] or 'application/octet-stream')
                return self.send(PACKAGED.read(asset),mime=mime)
        return super().do_GET()
    def social(self, method):
        path = urlparse(self.path).path.removeprefix('/console/api/web/social/')
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}') if method == 'POST' else None
        REQUESTS.append({'method': method, 'path': path, 'body': body})
        if path == 'bootstrap':
            GATE.wait(20)
            if STATE['bootstrap_status'] == 503:
                return self.send({'message': '合成权限服务暂不可用'}, code=503)
            return self.send({'code': 0, 'data': {'available': True, 'consented': True, 'local': False,
                'categories': {}, 'media': True, 'sanctions': [{'kind': 'mute'}] if STATE['mute'] else []}})
        if path == 'topics': return self.send({'code': 0, 'data': {'list': ['交流闲聊', '创作交流']}})
        if path == 'preflight': return self.send({'code': 0, 'data': {'status': 'allowed'}})
        if path == 'posts' and method == 'POST':
            ACK.wait(20)
            if STATE['post_status'] == 503: return self.send({'message': '合成发布失败，内容未保存'}, code=503)
            return self.send({'code': 0, 'data': POST})
        if path == 'posts/qa-confirmed': return self.send({'code': 0, 'data': POST})
        if path == 'posts/qa-confirmed/comments': return self.send({'code': 0, 'data': {'list': [], 'page': 1, 'pages': 1, 'has_more': False}})
        if path == 'preferences': return self.send({'code': 0, 'data': {}})
        return self.send({'message': 'Unmapped private community route ' + path}, code=404)


def main():
    global OUT,PACKAGED
    parser=argparse.ArgumentParser();parser.add_argument('--apk',type=Path);parser.add_argument('--output',type=Path);args=parser.parse_args()
    if args.output:OUT=args.output
    if args.apk:PACKAGED=zipfile.ZipFile(args.apk)
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 8816), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            try:
                for width, height in [(390, 844), (1440, 900)]:
                    for theme in ['light', 'dark']:
                        STATE.update(bootstrap_status=503, mute=False, post_status=503)
                        GATE.clear(); ACK.set(); REQUESTS.clear()
                        context = browser.new_context(viewport={'width': width, 'height': height})
                        context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).hostname == '127.0.0.1' else route.abort())
                        seed = {'savedAt': 0, 'value': {'draft': {'title': '本机草稿', 'content': '离线也能继续编辑',
                                'topic': '交流闲聊', 'images': [], 'video': '', 'tags': [], 'client_id': 'qa-durable-id'}}}
                        context.add_init_script("""if(window===top){
                          localStorage.setItem('ai_xingyue_logged_in','1');
                          localStorage.setItem('ai_xingyue_user',%s);
                          localStorage.setItem('ai_xingyue_shell_theme',%s);
                          const k='homer.page-cache.v1.social-draft.%s',v=%s;
                          v.savedAt=Date.now();if(!localStorage.getItem(k))localStorage.setItem(k,JSON.stringify(v));
                        }""" % (json.dumps(json.dumps(USER, ensure_ascii=False)), json.dumps(theme), USER['id'], json.dumps(seed, ensure_ascii=False)))
                        page = context.new_page(); errors = []; failed = []
                        page.on('pageerror', lambda e: errors.append(str(e)))
                        page.on('response', lambda r: failed.append([r.status, urlparse(r.url).path]) if r.status >= 400 else None)
                        page.goto('http://127.0.0.1:8816/app/community-compose.html', wait_until='domcontentloaded')
                        editor = page.get_by_role('textbox', name='帖子正文', exact=True)
                        editor.wait_for(timeout=10000)
                        assert not GATE.is_set(), 'Editor must paint before the permission service returns'
                        assert editor.input_value() == '离线也能继续编辑'
                        # The genuine button changes its accessible label to
                        # 发布中 while submitting; keep the same control targeted.
                        publish = page.locator('.c-header .c-primary')
                        expect(publish).to_be_disabled()
                        editor.fill('权限检查前已写入的新文字')
                        page.wait_for_function("JSON.parse(localStorage.getItem('homer.page-cache.v1.social-draft.'+JSON.parse(localStorage.getItem('ai_xingyue_user')).id)).value.draft.content==='权限检查前已写入的新文字'")
                        page.evaluate("Alpine.$data(document.querySelector('[x-data]')).publish()")
                        assert not [r for r in REQUESTS if r['method'] == 'POST']
                        GATE.set()
                        page.wait_for_function("!Alpine.$data(document.querySelector('[x-data]')).gateLoading")
                        assert editor.is_visible() and editor.input_value() == '权限检查前已写入的新文字'
                        assert page.locator('.c-compose-gate').is_visible()
                        colors = page.evaluate("({text:getComputedStyle(document.querySelector('.c-error')).color,background:getComputedStyle(document.body).backgroundColor})")
                        def luminance(css):
                            values = [float(v.strip())/255 for v in css[css.index('(')+1:css.index(')')].split(',')[:3]]
                            values = [v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in values]
                            return sum(v*w for v,w in zip(values,[.2126,.7152,.0722]))
                        foreground,background=luminance(colors['text']),luminance(colors['background'])
                        contrast=(max(foreground,background)+.05)/(min(foreground,background)+.05)
                        assert contrast >= 4.5, (theme, colors, contrast)
                        page.screenshot(path=str(OUT / f'offline-{theme}-{width}.png'), full_page=True)
                        page.reload(wait_until='domcontentloaded'); editor.wait_for()
                        assert editor.input_value() == '权限检查前已写入的新文字'
                        page.wait_for_function("!Alpine.$data(document.querySelector('[x-data]')).gateLoading")
                        STATE['bootstrap_status'] = 200
                        page.get_by_role('button', name='重试验证', exact=True).click()
                        expect(publish).to_be_enabled()
                        STATE['mute'] = True
                        publish.click()
                        page.wait_for_function("Alpine.$data(document.querySelector('[x-data]')).muted")
                        assert not [r for r in REQUESTS if r['path'] == 'posts' and r['method'] == 'POST']
                        assert editor.input_value() == '权限检查前已写入的新文字'
                        STATE['mute'] = False
                        page.evaluate("Alpine.$data(document.querySelector('[x-data]')).enter(true)")
                        expect(publish).to_be_enabled()
                        # The actual image input, FileReader, API and private
                        # HTTP response append and persist a real PNG reference.
                        page.locator('input[type=file][accept="image/png,image/jpeg,image/webp"]').set_input_files({'name':'qa.png','mimeType':'image/png','buffer':PHOTO})
                        page.wait_for_function("Alpine.$data(document.querySelector('[x-data]')).draft.images.length===1&&!Alpine.$data(document.querySelector('[x-data]')).uploading")
                        assert len([r for r in REQUESTS if r['path']=='qa-image-upload'])==1
                        assert page.evaluate("JSON.parse(localStorage.getItem('homer.page-cache.v1.social-draft.'+JSON.parse(localStorage.getItem('ai_xingyue_user')).id)).value.draft.images.length") == 1
                        publish.click()
                        page.wait_for_function("document.querySelector('.c-error').textContent.includes('合成发布失败')")
                        assert editor.input_value() == '权限检查前已写入的新文字'
                        writes = [r for r in REQUESTS if r['path'] == 'posts' and r['method'] == 'POST']
                        assert len(writes) == 1 and writes[0]['body']['client_id'] == 'qa-durable-id'
                        STATE['post_status'] = 200; ACK.clear()
                        publish.click()
                        page.wait_for_function("Alpine.$data(document.querySelector('[x-data]')).publishing")
                        expect(editor).to_be_disabled(); expect(publish).to_be_disabled()
                        expect(page.get_by_role('button',name='移除图片',exact=True)).to_be_disabled()
                        assert page.evaluate("JSON.parse(localStorage.getItem('homer.page-cache.v1.social-draft.'+JSON.parse(localStorage.getItem('ai_xingyue_user')).id)).value.draft.content") == '权限检查前已写入的新文字'
                        ACK.set(); page.wait_for_url('**/community-post.html?id=qa-confirmed')
                        assert page.evaluate("JSON.parse(localStorage.getItem('homer.page-cache.v1.social-draft.'+JSON.parse(localStorage.getItem('ai_xingyue_user')).id)).value.draft") is None
                        page.goto('http://127.0.0.1:8816/app/community-compose.html'); editor.wait_for()
                        assert editor.input_value() == ''
                        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
                        assert not errors, errors
                        expected = {'/console/api/web/social/bootstrap', '/console/api/web/social/posts'}
                        assert all(code == 503 and path in expected for code, path in failed), failed
                        results.append({'viewport': [width, height], 'theme': theme, 'draft_before_authorization': True,
                            'network_failure_not_blocking_editor': True, 'retry_preserves_input': True, 'fresh_mute_blocks_write': True,
                            'failed_publish_preserves_identity': True, 'confirmed_ack_clears_only_after_commit': True,
                            'error_contrast':round(contrast,2),
                            'real_file_upload_and_draft_image_preserved':True,
                            'script_errors': errors, 'expected_failures': failed})
                        context.close()
            finally: browser.close()
    finally:
        GATE.set(); ACK.set(); server.shutdown(); server.server_close()
        if PACKAGED:PACKAGED.close()
    (OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS: 4 real compose journeys, phone drafts before permission responses, failure/retry/mute/publish ACK; no script errors.')


if __name__ == '__main__': main()
