"""Reachable secondary screens, theme and error states; intercepted synthetic APIs."""
import functools,json,threading
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'output/delivery-r13'
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def copyfile(self,source,output):
        try:super().copyfile(source,output)
        except (ConnectionResetError,ConnectionAbortedError,BrokenPipeError):pass
def run(browser,base,width):
    ctx=browser.new_context(viewport={'width':width,'height':844},reduced_motion='reduce')
    ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'delivery-test',name:'验收作者'}));")
    errors=[];failures=[];calls=[];fail_profile=False
    def route(r):
        p=urlparse(r.request.url)
        if p.hostname!='127.0.0.1':return r.fulfill(status=204)
        if p.path.startswith(('/console/','/admin/api/','/go/')):
            calls.append(p.path)
            if p.path.endswith('/account/profile'):
                return r.fulfill(status=503 if fail_profile else 200,json={'message':'暂时无法连接','id':'delivery-test','name':'验收作者','is_admin':True})
            if p.path.endswith('/my-apps'):return r.fulfill(json={'data':{'list':[]}})
            if '/farm/' in p.path:return r.fulfill(status=503,json={'message':'农场暂时无法连接，请稍后重试'})
            return r.fulfill(json={'data':{'list':[],'apps':[],'items':[],'total':0},'points':1200})
        r.continue_()
    ctx.route('**/*',route);p=ctx.new_page();p.on('pageerror',lambda e:errors.append(str(e)))
    p.on('requestfailed',lambda r:failures.append(urlparse(r.url).path))
    records=[]
    pages=['me.html','me.html?panel=settings','me.html?panel=profile','me.html?panel=persona','workshop.html','my-apps.html','community-library.html?tab=preset','rewards.html','farm.html','data-merge.html','favorites.html','histories.html']
    for i,route_name in enumerate(pages):
        p.goto(base+'/app/'+route_name,wait_until='networkidle')
        p.wait_for_function("!document.querySelector('[x-cloak]')")
        assert not p.evaluate('document.documentElement.scrollWidth>innerWidth+1'),route_name
        p.screenshot(path=str(OUT/f'{i:02}-{width}.png'),full_page=True)
        records.append({'page':route_name,'horizontalOverflow':False})
        if route_name=='workshop.html':
            geometry=p.locator('.ws-navitem__ico').first.evaluate('e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})')
            assert geometry=={'width':44,'height':44},geometry
        if route_name=='me.html?panel=settings':
            expect(p.locator('.profile-settings-routes')).to_be_visible()
            expect(p.locator('.profile-wallet-card')).not_to_be_visible()
            expect(p.locator('[data-app-bottom-nav]')).not_to_be_visible()
            p.evaluate("document.documentElement.dataset.theme='dark'")
            expect(p.locator('.profile-settings')).to_have_css('background-color','rgb(32, 34, 39)')
            p.screenshot(path=str(OUT/f'settings-dark-{width}.png'),full_page=True)
            p.evaluate("delete document.documentElement.dataset.theme")
        if route_name=='community-library.html?tab=preset':
            p.get_by_role('button',name='＋ 发布作品',exact=True).click()
            expect(p.get_by_role('dialog')).to_be_visible()
            if width<620:
                box=p.get_by_role('dialog').bounding_box()
                assert box['x']==0 and box['width']==width and abs(box['height']-844)<2,box
            p.screenshot(path=str(OUT/f'library-editor-{width}.png'),full_page=True)
            p.get_by_role('button',name='关闭',exact=True).click()
            expect(p.get_by_role('dialog')).not_to_be_visible()
        if route_name=='rewards.html':
            expect(p.get_by_role('button',name='兑换卡密',exact=True)).to_be_disabled()
        if route_name=='data-merge.html':
            expect(p.locator('#mergeSelection')).not_to_be_visible()
            p.locator('#fileInput').set_input_files({'name':'世界书.json','mimeType':'application/json','buffer':json.dumps({'entries':{'0':{'comment':'本机测试','content':'仅测试','key':['测试']}}}).encode()})
            expect(p.locator('#mergeSelection')).to_be_visible()
            expect(p.locator('#exportBtn')).to_be_enabled()
            p.locator('#selectNone').click()
            expect(p.locator('#exportBtn')).to_be_disabled()
            p.locator('#selectAll').click()
            with p.expect_download():p.locator('#exportBtn').click()
    fail_profile=True
    p.goto(base+'/app/my-apps.html',wait_until='networkidle')
    expect(p.locator('.ref-library-error')).to_be_visible()
    expect(p.get_by_text('还没有自己创建的角色',exact=True)).not_to_be_visible()
    fail_profile=False
    p.get_by_role('button',name='重试',exact=True).click()
    expect(p.locator('.ref-library-error')).not_to_be_visible()
    assert not errors,errors
    assert not failures,failures
    ctx.close();return {'width':width,'screens':records,'errors':errors,'requestFailures':failures,'errorRetry':True}
if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            b=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            try:results=[run(b,f'http://127.0.0.1:{server.server_port}',w) for w in (360,393,1440)]
            finally:b.close()
        (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(results,ensure_ascii=False))
    finally:server.shutdown();server.server_close()
