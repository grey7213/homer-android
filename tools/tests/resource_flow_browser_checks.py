"""Isolated click journeys with shipping assets; never uses a live account.

Synthetic SQLite-backed workshop routes exercise cancel/delete/search. Farm
and comments intentionally model committed, stale, and failed responses.
"""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import copy
import importlib.util
import json
import mimetypes
import os
from pathlib import Path
import sqlite3
import sys
import threading
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/resource-flow-20261011'
SOURCE = Path(os.environ.get('HOMER_WORKSHOP_SOURCE',
    str(ROOT / 'tools/tests/fixtures/r366/community_workshop.py')))
sys.path.insert(0, str(ROOT / 'tools'))
from export_resource_flow_server import transform_workshop

spec = importlib.util.spec_from_file_location('card_version_workshop', SOURCE.with_name('card_version_workshop.py'))
versions = importlib.util.module_from_spec(spec); spec.loader.exec_module(versions)
sys.modules['card_version_workshop'] = versions
workshop = {'__name__': 'isolated_workshop_browser'}
exec(compile(transform_workshop(SOURCE.read_text(encoding='utf-8-sig')), str(SOURCE), 'exec'), workshop)
db = sqlite3.connect(':memory:', check_same_thread=False); db.row_factory = sqlite3.Row
lock = threading.RLock()
db.executescript('create table local_apps(id text primary key); create table conversations(id text primary key);')
versions.ensure_card_version_schema(db, lock); workshop['ensure_community_schema'](db, lock)
store = workshop['CommunityStore'](db, lock)
USER = {'id': 'qa-resource-owner', 'name': '隔离资源验收', 'is_admin': True}
FARM = {'account_balance': {'points': 500}, 'profile': {'points': 500, 'coins': 500, 'xp': 0, 'energy': 5, 'streak_days': 60},
    'plots': [{'plot_no': 1, 'crop_kind': 'code_carrot', 'unlocked': True, 'planted_at': 1, 'ready_at': 2, 'ready': True}], 'daily_reward': {'claimed': False, 'points': 10}}
state = {'farm': copy.deepcopy(FARM), 'comments': [], 'comment_fail': False, 'harvest_fail': False, 'harvests': [], 'posts': []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, value, code=200, mime='application/json'):
        data = json.dumps(value, ensure_ascii=False).encode() if mime == 'application/json' else value
        self.send_response(code); self.send_header('Content-Type', mime); self.send_header('Content-Length', str(len(data))); self.send_header('Cache-Control', 'no-store'); self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass
    def do_GET(self): self.route('GET')
    def do_POST(self): self.route('POST')
    def route(self, method):
        url = urlparse(self.path); path = url.path
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}') if method == 'POST' else {}
        if path.startswith('/console/api/web/community/'):
            result = workshop['handle_community_route'](method, path.lstrip('/'), parse_qs(url.query), body,
                {'conn': db, 'lock': lock, 'user': USER, 'is_admin': True})
            if result is None: return self.send({'message': 'unimplemented fixture route'}, 404)
            return self.send(result, result.get('__http__', 200))
        if path == '/console/api/account/profile': return self.send({'data': USER})
        if path == '/console/api/public/site-settings': return self.send({'data': {'community_enabled': True}})
        if path == '/console/api/web/farm/state': return self.send({'data': state['farm']})
        if path == '/console/api/web/farm/friends': return self.send({'data': {'list': []}})
        if path == '/console/api/web/rewards': return self.send({'data': {'daily': {'claimed': False, 'points': 10}}})
        # Deliberately stale ancillary credits: cannot replace final farm snapshot.
        if path in ('/console/api/user/credits', '/console/api/user/point'): return self.send({'data': {'points': 500}})
        if path == '/console/api/web/farm/plots/1/harvest' and method == 'POST':
            state['harvests'].append(self.headers.get('Idempotency-Key'))
            if state['harvest_fail']: return self.send({'message': '隔离收获失败'}, 503)
            state['farm'] = {**copy.deepcopy(FARM), 'account_balance': {'points': 600}, 'profile': {**FARM['profile'], 'points': 600, 'coins': 600, 'xp': 10},
                'plots': [{'plot_no': 1, 'unlocked': True, 'crop_kind': None}], 'daily_reward': {'claimed': True, 'points': 10}}
            return self.send({'data': {'state': state['farm'], 'points_added': 90, 'daily_reward': {'claimed': True, 'points': 10}}})
        if path == '/console/api/web/social/bootstrap': return self.send({'data': {'available': True, 'consented': True, 'categories': {}, 'sanctions': [], 'media': True}})
        if path.startswith('/console/api/web/social/posts/'):
            suffix = path.split('/social/posts/', 1)[1]
            post_id = suffix.split('/')[0]
            if suffix.endswith('/comments'):
                if method == 'POST':
                    state['posts'].append(body)
                    if state['comment_fail']: return self.send({'message': '隔离评论失败'}, 503)
                    state['comments'].append({'id': len(state['comments']) + 1, 'author': 'QA', 'content': body['content'], 'created_at': 1, 'like_count': 0, 'is_owner': True})
                    return self.send({'data': {'id': len(state['comments']), 'status': 'published'}})
                return self.send({'data': {'list': state['comments'], 'page': 1, 'pages': 1, 'snapshot': 1, 'has_more': False}})
            return self.send({'data': {'id': post_id, 'author': 'QA 作者', 'user_id': 'qa-author', 'title': '隔离帖子', 'content': '合成内容，不含用户数据',
                'images': [], 'topic': '验收', 'created_at': 1, 'status': 'published', 'comment_count': len(state['comments']), 'like_count': 0, 'is_owner': False}})
        if path in ('/console/api/web/notifications','/console/api/public/notifications'): return self.send({'data': {'list': []}})
        if '/api/' in path: return self.send({'message': 'missing isolated fixture route: ' + path}, 404)
        base = (ROOT / 'sillytavern-runtime/public').resolve() if path.startswith('/scripts/') else (ROOT / 'frontend').resolve()
        target = (base / path.lstrip('/')).resolve()
        if not target.is_relative_to(base) or not target.is_file(): return self.send({'message': 'missing asset ' + path}, 404)
        mime = mimetypes.guess_type(target)[0] or 'application/octet-stream'
        if target.suffix in ('.js', '.mjs'): mime = 'text/javascript'
        return self.send(target.read_bytes(), mime=mime)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 8814), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel='chrome')
            try:
                for width, height in [(390, 844), (1440, 900)]:
                    context = browser.new_context(viewport={'width': width, 'height': height}, accept_downloads=True)
                    context.add_init_script("try{localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user'," + json.dumps(json.dumps(USER, ensure_ascii=False)) + ");}catch{}")
                    page = context.new_page(); errors = []; unexpected = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.on('response', lambda response: unexpected.append([response.status, urlparse(response.url).path]) if response.status >= 400 else None)
                    for kind in ('preset', 'ui_template'):
                        content = {'prompts': [{'identifier': 'qa', 'content': '原生内容', 'enabled': False}], 'prompt_order': []} if kind == 'preset' else {'regex_scripts': [{'scriptName': 'QA rule', 'findRegex': 'QA', 'replaceString': '<b>验收</b>', 'placement': [2], 'disabled': False}]}
                        work = store.create_work(USER['id'], USER['name'], {'work_type': kind, 'name': f'QA-{kind}-{width}', 'content': content})
                        page.goto(f'http://127.0.0.1:8814/app/workshop-resource-editor.html?type={kind}&id={work["id"]}')
                        page.wait_for_function("document.querySelector('#resource-delete')?.hidden===false&&document.querySelector('#resource-status').textContent==='' ")
                        with page.expect_download() as download_info: page.get_by_role('button', name='导出文件', exact=True).click()
                        download = download_info.value
                        exported = Path(download.path()).read_text(encoding='utf-8')
                        assert json.loads(exported) == content
                        # Actual file is accepted by the real importer without content loss.
                        imported = page.evaluate("async({kind,text})=>{const {readResourceFile}=await import('/app/assets/js/workshop-import.mjs');return await readResourceFile(kind,new File([text],'QA.json',{type:'application/json'}));}", {'kind': kind, 'text': exported})
                        assert imported == content
                        page.get_by_role('button', name='删除资源', exact=True).click(); page.get_by_role('button', name='取消', exact=True).click()
                        assert store.get_work(work['id'])['status'] == 'published'
                        page.get_by_role('button', name='删除资源', exact=True).click(); page.get_by_role('button', name='确认', exact=True).click()
                        page.wait_for_url('**/workshop-resource.html?type=' + kind)
                        page.locator('input[name=q]').fill('QA-' + kind); page.get_by_role('button',name='搜索',exact=True).click()
                        page.wait_for_function("document.querySelector('#resource-status').textContent.includes('没有找到')")
                        assert page.locator('.resource-item').count() == 0
                    state['farm'] = copy.deepcopy(FARM); state['harvest_fail'] = False
                    page.goto('http://127.0.0.1:8814/app/farm.html')
                    page.wait_for_selector('.farm-plot-badge:visible')
                    page.locator('.farm-plot').first.click(); page.get_by_role('button', name='收获作物', exact=True).click()
                    page.wait_for_function("document.querySelector('.farm-wallet-link b').textContent==='600'")
                    assert page.locator('.farm-plot-badge:visible').count() == 0
                    page.get_by_role('button', name='刷新农场', exact=True).click()
                    page.wait_for_function("document.querySelector('.farm-wallet-link b').textContent==='600'&&!Alpine.$data(document.querySelector('[x-data]')).loading")
                    assert page.locator('.farm-daily-track').inner_text() == '今日积分已领取'
                    state['farm'] = copy.deepcopy(FARM); state['harvest_fail'] = True
                    page.reload(); page.wait_for_selector('.farm-plot-badge:visible'); page.locator('.farm-plot').first.click()
                    page.get_by_role('button', name='收获作物', exact=True).click(); page.wait_for_selector('.farm-error:visible')
                    assert '隔离收获失败' in page.locator('.farm-error:visible').inner_text()
                    assert page.locator('.farm-wallet-link b').inner_text() == '500'
                    failed_key = state['harvests'][-1]
                    state['harvest_fail'] = False; page.get_by_role('button', name='收获作物', exact=True).click()
                    page.wait_for_function("document.querySelector('.farm-wallet-link b').textContent==='600'")
                    assert state['harvests'][-1] == failed_key
                    page.goto('http://127.0.0.1:8814/app/community-post.html?id=qa-post-a')
                    reply = page.get_by_role('textbox', name='评论内容', exact=True); reply.wait_for(); reply.fill('尚未提交的评论草稿')
                    original_id = page.evaluate("Alpine.$data(document.querySelector('[x-data]')).commentClientId")
                    page.evaluate("window.dispatchEvent(new CustomEvent('homer-native-visibility',{detail:{visible:false}}))")
                    page.goto('http://127.0.0.1:8814/app/community-post.html?id=qa-post-b'); reply.wait_for(); assert reply.input_value() == ''
                    page.goto('http://127.0.0.1:8814/app/community-post.html?id=qa-post-a'); reply.wait_for(); assert reply.input_value() == '尚未提交的评论草稿'
                    assert page.evaluate("Alpine.$data(document.querySelector('[x-data]')).commentClientId") == original_id
                    state['comment_fail'] = True; page.get_by_role('button', name='发送', exact=True).click()
                    page.wait_for_function("Alpine.$data(document.querySelector('[x-data]')).commentError==='隔离评论失败'")
                    assert reply.input_value() == '尚未提交的评论草稿'
                    page.reload(); reply.wait_for(); assert reply.input_value() == '尚未提交的评论草稿'
                    state['comment_fail'] = False; page.get_by_role('button', name='发送', exact=True).click()
                    page.wait_for_function("Alpine.$data(document.querySelector('[x-data]')).commentDraft===''")
                    assert state['posts'][-1]['client_id'] == original_id
                    page.reload(); reply.wait_for(); assert reply.input_value() == ''
                    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
                    assert not errors, errors
                    allowed = {'/console/api/web/farm/plots/1/harvest', '/console/api/web/social/posts/qa-post-a/comments'}
                    assert all(path in allowed and code == 503 for code, path in unexpected), unexpected
                    page.screenshot(path=str(OUT / f'comment-{width}.png'), full_page=True)
                    results.append({'viewport': [width, height], 'cancel_delete_search': True, 'actual_importable_exports': True, 'harvest_balance_plots_final': True,
                        'failed_harvest_retry_same_key': True, 'comment_leave_return_retry_success': True, 'script_errors': errors, 'expected_error_responses': unexpected})
                    context.close()
            finally: browser.close()
    finally: server.shutdown(); server.server_close(); db.close()
    (OUT / 'browser-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
