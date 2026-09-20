"""Rendered regressions; isolated browser storage and synthetic APIs only."""
import functools, json, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/ux-r11'
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass

def run(browser,base,width,admin):
    ctx=browser.new_context(viewport={'width':width,'height':844},reduced_motion='reduce')
    user={'id':'r11-admin' if admin else 'r11-user','name':'测试账号','is_admin':admin}
    ctx.add_init_script("""localStorage.setItem('ai_xingyue_logged_in','1');
      localStorage.setItem('ai_xingyue_user',JSON.stringify(%s));
      window.HomerNative={isDebugBuild(){return true;}};""" % json.dumps(user))
    calls=[];errors=[]
    def route(r):
        u=urlparse(r.request.url);path=u.path
        if u.hostname not in ('127.0.0.1','localhost'): r.abort();return
        if path.startswith(('/console/','/admin/api/','/go/')):
            calls.append(path+'?'+u.query)
            data={'data':{}}
            if path.endswith('/account/profile'): data=user
            elif path=='/admin/api/whoami':
                if not admin:r.fulfill(status=403,json={'message':'权限不足'});return
                data={'data':user}
            elif path.endswith('/conversations'):data={'data':{'list':[{'id':'c1','app_id':'a','app_name':'测试角色','updated_at':1789700000000,'last_message':'<inner_flow>绝不能展示</inner_flow><maintext>你好，旅人。</maintext>'}]}}
            elif path.endswith('/search'):data={'data':{'apps':[],'featured_apps':[],'total':0}}
            elif '/social/' in path:data={'data':{},'path':path,'result':'success'}
            r.fulfill(json=data);return
        r.continue_()
    ctx.route('**/*',route);page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto(base+'/app/create.html',wait_until='networkidle')
        expect(page.locator('.editor-toolbar__primary')).to_be_visible()
        page.get_by_role('button',name='角色卡操作',exact=True).click()
        for sel in ['.editor-toolbar__primary','.editor-toolbar__identity','[aria-label="导入卡包"]']:
            box=page.locator(sel).bounding_box();assert box and box['x']>=0 and box['x']+box['width']<=width+1,(sel,box)
        with page.expect_file_chooser():page.locator('[aria-label="导入卡包"]').click()
        page.screenshot(path=str(OUT/f'creator-{width}-{admin}.png'))
        page.goto(base+'/app/histories.html',wait_until='networkidle')
        expect(page.locator('.history-row')).to_have_count(1)
        assert '绝不能展示' not in page.locator('main').inner_text()
        expect(page.locator('.history-row')).to_contain_text('你好，旅人。')
        main=page.locator('.history-row__main').bounding_box();more=page.locator('.history-more-btn').bounding_box()
        if width<760:assert abs(main['y']-more['y'])<50
        page.locator('input[type=search]').fill('不存在');expect(page.locator('.history-row')).to_have_count(0)
        page.locator('input[type=search]').fill('');page.screenshot(path=str(OUT/f'history-{width}-{admin}.png'))
        page.goto(base+'/app/me.html',wait_until='networkidle')
        management=page.get_by_role('link',name='管理后台',exact=True)
        (expect(management).to_be_visible() if admin else expect(management).not_to_be_visible())
        expect(page.get_by_role('link',name='完整账户',exact=True)).to_have_count(0)
        expect(page.get_by_role('navigation',name='我的社区内容')).to_be_visible()
        expect(page.locator('.profile-settings')).not_to_be_visible()
        local="""async()=>{const m=await import('/app/assets/js/community-local.js?v=20260917-r8');return m.canUseLocal();}"""
        assert page.evaluate(local)==admin
        if admin:
            page.evaluate("async()=>{const m=await import('/app/assets/js/community-local.js?v=20260917-r8');await m.enableLocal();}")
            # Local acceptance applies to community only, not the live account page.
            expect(page.locator('[data-local-acceptance]')).to_have_count(0)
            page.evaluate("async()=>{const m=await import('/app/assets/js/community-local.js?v=20260917-r8');m.disableLocal();dispatchEvent(new Event('homer:page-visible'));}")
            expect(page.locator('[data-local-acceptance]')).to_have_count(0)
        page.screenshot(path=str(OUT/f'me-{width}-{admin}.png'))
        page.get_by_role('link',name='编辑资料 ›',exact=True).click()
        expect(page.locator('.profile-settings')).to_be_visible()
        expect(page.get_by_role('navigation',name='我的社区内容')).not_to_be_visible()
        expect(page.get_by_role('button',name='保存资料',exact=True)).to_be_visible()
        page.goto(base+'/app/explore.html',wait_until='networkidle')
        page.evaluate("()=>{const p=Alpine.$data(document.querySelector('[x-data]'));p.searchKeyword='测试';return p.loadList(true);}")
        assert any('/search?' in c and 'q=' in c and 'zone=clean' in c for c in calls)
        message=page.evaluate("async()=>{const {social}=await import('/app/assets/js/community-controls.js?v=20260917-r8');try{await social('admin/config');return 'WRONG';}catch(e){return e.message;}}")
        assert '尚未部署' in message
        farm=page.evaluate("""async()=>{await import('/app/assets/js/farm.js?v=20260917-r8');const p=window.farmPage();
          p.applyState({account_balance:{points:1400},profile:{coins:1400,points:1400},plots:[]});
          if(p.coins!==1400||!p.unifiedBalance)return false;
          p.applyCredits({points:1350});if(p.coins!==1350)return false;
          p.applyState({account_balance:{points:1350},profile:{coins:250},plots:[]});let calls=0;
          await p.runAction('plant',1,()=>{calls++;return Promise.resolve({})},'成功');
          clearTimeout(p.toastTimer);return !p.unifiedBalance&&calls===0&&p.coins===1350;}""")
        assert farm
        page.goto(base+'/app/community-library.html?tab=preset&new=1',wait_until='networkidle')
        expect(page.get_by_text('从文件导入',exact=False).first).to_be_visible()
        for file_input in page.locator('input[type=file]').all():
            box=file_input.bounding_box();assert box and box['x']+box['width']<=width,(width,box)
        page.locator('input[type=file][accept=".json,application/json"]').set_input_files({'name':'本地测试预设.json','mimeType':'application/json','buffer':b'{"prompts":[{"name":"test","content":"fixture"}]}'})
        page.wait_for_function("Alpine.$data(document.querySelector('[x-data]')).form.name==='本地测试预设'")
        assert page.evaluate("Alpine.$data(document.querySelector('[x-data]')).parseStructuredEntries('preset').prompts.length")==1
        page.locator('input[type=file][accept=".json,application/json"]').set_input_files({'name':'错误.json','mimeType':'application/json','buffer':b'not-json'})
        page.wait_for_function("!Alpine.$data(document.querySelector('[x-data]')).importing")
        assert page.evaluate("Alpine.$data(document.querySelector('[x-data]')).parseStructuredEntries('preset').prompts.length")==1
        page.screenshot(path=str(OUT/f'library-import-{width}-{admin}.png'))
        page.goto(base+'/admin.html',wait_until='networkidle')
        if admin:
            page.evaluate("""()=>{const p=Alpine.$data(document.querySelector('[x-data]'));
              p.globalPresets={prompt:{active_id:'test',items:[{id:'test',name:'测试预设',prompts:Array.from({length:126},(_,i)=>({identifier:'p'+i,name:'条目'+i,content:'测试内容',enabled:true,user_toggleable:true,role:'system'}))}]},regex:{items:[]}};
              p.activeTab='global-presets';p.openGlobalPreset('prompt','test');}""")
            expect(page.locator('.ui-preset-entries>template+details')).to_be_visible()
            assert page.locator('.ui-preset-entries input').count()==0
            page.locator('.ui-preset-entries>details>summary').first.click()
            expect(page.locator('.ui-preset-entries input').first).to_be_visible()
            assert page.locator('.ui-preset-entries input').count()<20
            page.screenshot(path=str(OUT/f'admin-preset-{width}.png'))
            page.evaluate("()=>{const p=Alpine.$data(document.querySelector('[x-data]'));p.activeTab='site';p.siteForm=p.normalizeSiteForm({});}")
            page.evaluate("window.scrollTo({top:0,behavior:'instant'})")
            expect(page.locator('[aria-label="运营配置分类"]')).to_be_visible()
            assert '群聊页' not in page.locator('main').inner_text()
            page.screenshot(path=str(OUT/f'admin-config-{width}.png'))
        else:
            expect(page.get_by_text('当前账号不是管理员，无法访问后台',exact=True)).to_be_visible()
        assert not errors,errors
        return {'width':width,'admin':admin,'checks':['creator-actions','import-picker','safe-history-search','admin-only-entry','local-mode-isolation','pure-zone-search','stub-rejected'],'page_errors':errors}
    finally:ctx.close()

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            try:results=[run(browser,f'http://127.0.0.1:{server.server_port}',w,a) for w,a in [(360,False),(393,True),(1440,True)]]
            finally:browser.close()
        (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(results)
    finally:server.shutdown();server.server_close()
