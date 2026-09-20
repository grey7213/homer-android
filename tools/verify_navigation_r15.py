"""Cross-page navigation and category styles, synthetic account, no remote writes."""
import functools,json,threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
from verify_ui_r14 import ROOT,Quiet
OUT=ROOT/'output/ui-r15'

def run(browser,base,width,height):
    ctx=browser.new_context(viewport={'width':width,'height':height})
    ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'nav-test',name:'测试用户'}));window.HomerNative={isDebugBuild(){return true},setAccountScope(){},getAppVisitId(){return 'r15'},getAppVersion(){return '1.15.2'},notifyShellReady(){}};")
    errors=[];bad=[]
    def route(r):
        url=urlparse(r.request.url)
        if url.netloc!=urlparse(base).netloc:return r.fulfill(status=204)
        if url.path.startswith(('/console/','/go/','/admin/api/')):
            if url.path.endswith('/account/profile'):return r.fulfill(json={'id':'nav-test','name':'测试用户','is_admin':True})
            if '/social/' in url.path:return r.fulfill(status=404,json={'message':'未部署'})
            return r.fulfill(json={'data':{'list':[],'apps':[],'total':0}})
        r.continue_()
    ctx.route('**/*',route)
    p=ctx.new_page();p.on('pageerror',lambda e:errors.append(str(e)));p.on('requestfailed',lambda r:bad.append(r.url))
    results={}
    for theme in ['light','dark']:
        baseline=None
        for name in ['explore','community','workshop','histories','me']:
            p.goto(base+f'/app/{name}.html'+('?acceptance=local' if name=='community' else ''),wait_until='networkidle')
            if name=='community':
                gate=p.get_by_role('dialog',name='进入社区前，请阅读')
                if gate.is_visible():
                    gate.get_by_role('checkbox').check();gate.get_by_role('button',name='同意并进入').click()
            p.evaluate('(t)=>document.documentElement.setAttribute("data-theme",t)',theme)
            nav=p.locator('#homer-main-navigation');expect(nav.locator('a')).to_have_count(5)
            expect(nav.locator('[aria-current=page]')).to_have_count(1)
            # Desktop visibility remains the app's existing responsive behavior.
            data=nav.evaluate('''e=>{const s=getComputedStyle(e),a=e.querySelector('a'),c=getComputedStyle(a),v=getComputedStyle(a.querySelector('svg'));return {bg:s.backgroundColor,padding:s.padding,border:s.borderTop,font:c.font,gap:c.gap,height:c.height,color:c.color,icon:v.width,active:getComputedStyle(e.querySelector('.is-active')).color}}''')
            # Compare inactive text color rather than the first (sometimes active) item.
            data['color']=nav.locator('a:not(.is-active)').first.evaluate('e=>getComputedStyle(e).color')
            data['font']=nav.locator('a:not(.is-active)').first.evaluate('e=>getComputedStyle(e).font')
            if baseline is None:baseline=data
            assert data==baseline,(theme,name,baseline,data)
            if width<768:
                expect(nav).to_be_visible();box=nav.bounding_box()
                assert abs(box['width']-width)<2 and box['height']<=65,(name,box)
                nav.screenshot(path=str(OUT/f'nav-{name}-{theme}-{width}.png'))
            if name=='community':
                p.locator('.c-channel-strip button').first.wait_for()
                selected=p.locator('.c-channel-strip button[aria-pressed=true]').first
                assert selected.evaluate('e=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
                assert selected.locator('.c-channel-icon').evaluate('e=>getComputedStyle(e).borderRadius')=='12px'
                p.screenshot(path=str(OUT/f'community-{theme}-{width}.png'))
        results[theme]=baseline
    assert not errors,errors
    assert not bad,bad
    ctx.close();return {'viewport':[width,height],'styles':results,'errors':errors}

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    with sync_playwright() as p:
        b=p.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
        try:r=[run(b,f'http://127.0.0.1:{server.server_port}',w,h) for w,h in [(360,800),(393,852),(1440,900)]]
        finally:b.close();server.shutdown()
    (OUT/'navigation.json').write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf-8');print(r)
