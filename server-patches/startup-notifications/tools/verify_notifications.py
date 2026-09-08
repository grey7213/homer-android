"""Real notification routes + real frontend, isolated DB; never contacts production."""
import functools
import json
import os
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
import ai_fengyue_local_server as server
from notifications_extension import mutate_notification

ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = Path(os.environ.get('HOMER_TEST_WEB_ROOT', str(ROOT/'frontend')))
OUT = ROOT/'output'/'notifications-20260905'/'browser'

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass

def check(browser, base, store, width, height):
    with store.lock:
        store.conn.execute('DELETE FROM startup_notifications'); store.conn.commit()
    mutate_notification(store, 'POST', '', {'title':'测试通知','content':'正文\n<img src=x onerror=alert(1)>','enabled':True})
    context=browser.new_context(viewport={'width':width,'height':height})
    context.add_init_script("""localStorage.setItem('ai_xingyue_logged_in','1');
      localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'notice-user',name:'测试用户'}));
      window.noticeVisit='visit-1';window.HomerNative={getAppVisitId(){return window.noticeVisit;}};""")
    page=context.new_page(); errors=[]; failed=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
    page.on('requestfailed',lambda r:failed.append(urlparse(r.url).path))
    def route(r):
        path=urlparse(r.request.url).path
        if 'notifications' in path and path.startswith(('/admin/api/','/console/api/')):
            user={'id':'test-admin','email':'admin@example.test','name':'test','is_admin':1}
            handler=SimpleNamespace(store=store,command=r.request.method,headers={},
                authenticated_user=lambda:user,authenticated_token_user=lambda:user)
            body=json.loads(r.request.post_data) if r.request.post_data else None
            result=server.Handler.route(handler,path,'',body)
            r.fulfill(status=int(result.get('status',200)),json=result)
        elif path == '/console/api/account/profile':
            r.fulfill(json={'id':'notice-user','name':'测试用户'})
        elif path.startswith(('/console/','/admin/api/','/go/')):
            r.fulfill(json={'data':{},'points':0})
        elif urlparse(r.request.url).netloc != urlparse(base).netloc:
            r.fulfill(status=204)
        else:r.continue_()
    page.route('**/*',route)
    page.goto(base+'/app/explore.html',wait_until='networkidle')
    modal=page.locator('dialog.homer-notice')
    try: modal.wait_for(state='visible', timeout=8000)
    except Exception:
        print('notice diagnostics', errors, failed, page.url,
              page.evaluate("({installed:window.__homerNoticesInstalled,visibility:document.visibilityState,keys:Object.keys(localStorage).filter(k=>k.startsWith('homer.notice.'))})"))
        raise
    assert modal.locator('img,script').count()==0
    assert '<img src=x onerror=alert(1)>' in modal.inner_text()
    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
    page.screenshot(path=str(OUT/f'popup-{width}.png'),full_page=True)
    modal.get_by_role('button',name='我知道了').click()
    page.reload(wait_until='networkidle')
    assert page.locator('dialog.homer-notice').count()==0
    page.evaluate("noticeVisit='visit-2';dispatchEvent(new Event('homer:app-enter'))")
    page.get_by_role('button',name='今日不再弹出').click()
    page.locator('dialog.homer-notice').wait_for(state='detached')
    page.evaluate("noticeVisit='visit-3';dispatchEvent(new Event('homer:app-enter'))")
    page.wait_for_load_state('networkidle')
    assert page.locator('dialog.homer-notice').count()==0
    page.reload(wait_until='networkidle')
    assert page.locator('dialog.homer-notice').count()==0
    # Advance the device clock to tomorrow without changing saved suppression.
    page.evaluate("""() => {const NativeDate=Date; const tomorrow=Date.now()+86400000;
      window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[tomorrow]));}
      static now(){return tomorrow;}}; noticeVisit='visit-4';dispatchEvent(new Event('homer:app-enter'));}""")
    page.get_by_role('button',name='我知道了').click()
    page.goto(base+'/admin.html',wait_until='networkidle')
    if width < 768: page.locator('.xy-admin-mobilebar select').select_option('notifications')
    else: page.get_by_role('button',name='通知管理',exact=True).first.click()
    panel=page.locator('section[aria-label="通知管理"]')
    panel.get_by_role('button',name='创建通知',exact=True).click()
    panel.get_by_label('通知标题',exact=True).fill('后台新通知')
    panel.get_by_label('通知正文',exact=True).fill('发布内容')
    panel.get_by_role('button',name='保存通知',exact=True).click()
    item=panel.locator('article').filter(has_text='后台新通知')
    item.wait_for()
    item.get_by_role('button',name='编辑',exact=True).click()
    panel.get_by_label('通知标题',exact=True).fill('后台编辑通知')
    panel.get_by_label('启用通知',exact=True).uncheck()
    panel.get_by_role('button',name='保存通知',exact=True).click()
    item=panel.locator('article').filter(has_text='后台编辑通知')
    item.get_by_text('已停用',exact=True).wait_for()
    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
    page.screenshot(path=str(OUT/f'admin-{width}.png'),full_page=True)
    page.once('dialog',lambda d:d.accept())
    item.get_by_role('button',name='删除',exact=True).click()
    item.wait_for(state='detached')
    assert not errors,errors
    assert not failed,failed
    context.close()
    return {'viewport':[width,height],'passed':True,'console_errors':errors,'failed_requests':failed}

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    http=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(WEB_ROOT)))
    threading.Thread(target=http.serve_forever,daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='notice-browser-') as directory, sync_playwright() as p:
            store=server.Store(Path(directory)/'test.sqlite3')
            browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            try: results=[check(browser,f'http://127.0.0.1:{http.server_port}',store,w,h) for w,h in [(1440,900),(390,844)]]
            finally: browser.close();store.conn.close()
        (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(results,ensure_ascii=False))
    finally:http.shutdown();http.server_close()

if __name__=='__main__':main()
