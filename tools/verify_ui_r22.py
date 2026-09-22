"""Regression checks against real UI modules; synthetic account responses only."""
import functools, json, threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from verify_community_r7 import Quiet, ROOT
from verify_chat_runtime import contrast

OUT = ROOT / 'output/ui-r22'

def run(browser, base, width, height):
    ctx = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
    ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_shell_theme','dark');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r22-user',name:'权限验收',is_admin:true}));")
    page = ctx.new_page(); errors = []; held = []; state = {'admin': True, 'fail': False}
    page.on('pageerror', lambda e: errors.append(str(e)))
    def route(r):
        path = urlparse(r.request.url).path
        if urlparse(r.request.url).netloc != urlparse(base).netloc: return r.fulfill(status=204)
        if path.startswith(('/console/', '/admin/api/', '/go/')):
            if path.endswith(('/credits', '/persona')):
                held.append(r); return
            if path.endswith('/account/profile'):
                return r.fulfill(status=503 if state['fail'] else 200, json={'data': {'id': 'r22-user', 'name': '权限验收', 'is_admin': state['admin']}})
            return r.fulfill(json={'data': {'list': [], 'apps': []}})
        r.continue_()
    ctx.route('**/*', route)
    try:
        page.goto(base+'/app/me.html', wait_until='domcontentloaded')
        admin = page.get_by_role('link', name='管理后台', exact=True)
        expect(admin).to_be_visible(timeout=3000)
        assert len(held) == 2, len(held)
        page.screenshot(path=str(OUT/f'admin-with-wallet-pending-{width}.png'))
        for r in held: r.fulfill(json={'data': {}})
        held.clear()
        state['admin'] = False
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function("Alpine.$data(document.querySelector('[x-data]')).profileRefreshing===false")
        expect(admin).not_to_be_visible()
        for r in held: r.fulfill(json={'data': {}})
        held.clear(); state['fail'] = True
        page.reload(wait_until='domcontentloaded')
        retry = page.get_by_role('button').filter(has_text='账户权限暂未确认')
        expect(retry).to_be_visible(); expect(admin).not_to_be_visible()
        state.update(admin=True, fail=False)
        retry.click(); expect(admin).to_be_visible()
        for r in held: r.fulfill(json={'data': {}})
        held.clear()
        page.goto(base+'/app/explore.html', wait_until='networkidle')
        search = page.locator('.home-search-box input')
        colors=[]
        for action in ['rest','focus','blur']:
            if action=='focus': search.fill('故事')
            if action=='blur': search.blur()
            value=search.evaluate("e=>({inner:getComputedStyle(e).backgroundColor,outer:getComputedStyle(e.parentElement).backgroundColor,fill:getComputedStyle(document.documentElement).getPropertyValue('--app-fill').trim()})")
            assert value['inner']=='rgba(0, 0, 0, 0)',value
            assert value['outer']=='rgb(41, 46, 53)',value
            contrast(page,'.home-search-box input'); colors.append(value)
            page.screenshot(path=str(OUT/f'search-{action}-{width}.png'))
        assert not errors,errors
        return {'viewport':[width,height], 'adminWhileWalletAndPersonaPending':True,'nonAdminHidden':True,'failedProfileRetry':True,'searchStates':colors,'errors':errors}
    finally: ctx.close()

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
            try: results=[run(browser,f'http://127.0.0.1:{server.server_port}',w,h) for w,h in [(390,844),(1440,900)]]
            finally: browser.close()
        (OUT/'ui-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
        print(results)
    finally: server.shutdown()
