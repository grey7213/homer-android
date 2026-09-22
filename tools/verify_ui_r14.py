"""Measured creator geometry and workflow; only synthetic, intercepted APIs."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/ui-r14'
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass

def run(browser,base,width,height):
    ctx=browser.new_context(viewport={'width':width,'height':height},device_scale_factor=2.75 if width==393 else 1,reduced_motion='reduce')
    ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'reference-test',name:'测试作者'}));")
    errors=[];failed=[];writes=[]
    def route(r):
        path=urlparse(r.request.url).path
        if path.startswith(('/console/','/go/','/admin/api/')):
            if r.request.method!='GET':writes.append(path)
            if path.endswith('/account/profile'):r.fulfill(json={'id':'reference-test','name':'测试作者','is_admin':False})
            elif path=='/console/api/web/my-apps':r.fulfill(json={'data':{'list':[{'id':'ref-1','name':'合成测试角色','summary':'这是列表摘要','tags':['奇幻'],'is_public':True},{'id':'ref-2','name':'私人角色','summary':'只给自己看的角色','tags':['日常'],'is_public':False}]}})
            elif path=='/admin/api/whoami':r.fulfill(status=403,json={'message':'权限不足'})
            else:r.fulfill(json={'data':{'list':[],'apps':[]}})
            return
        r.continue_()
    ctx.route('**/*',route)
    p=ctx.new_page();p.on('pageerror',lambda e:errors.append(str(e)));p.on('requestfailed',lambda r:failed.append(urlparse(r.url).path))
    try:
        p.goto(base+'/app/create.html',wait_until='networkidle')
        expect(p.get_by_role('region',name='角色展示设置')).to_be_visible()
        nav=p.get_by_role('navigation',name='角色卡编辑分区')
        expect(nav).to_be_visible()
        expect(nav.get_by_role('button')).to_have_count(5)
        expect(p.locator('.creator-core')).to_have_count(0)
        p.get_by_role('textbox',name='角色名字',exact=True).fill('合成测试角色')
        nav.get_by_role('button',name='角色设定',exact=True).click()
        p.get_by_role('textbox',name='角色设定',exact=True).fill('切换分区后保留设定')
        for name,region in [('世界与扩展','角色世界与扩展'),('视觉素材','角色视觉素材'),('基础设置','角色展示设置')]:
            nav.get_by_role('button',name=name,exact=True).click()
            expect(p.get_by_role('region',name=region)).to_be_visible()
            expect(nav).to_be_visible()
            assert not p.evaluate('document.documentElement.scrollWidth>innerWidth+1')
        expect(p.get_by_role('textbox',name='角色名字',exact=True)).to_have_value('合成测试角色')
        nav.get_by_role('button',name='角色设定',exact=True).click()
        expect(p.get_by_role('textbox',name='角色设定',exact=True)).to_have_value('切换分区后保留设定')
        metrics=p.locator('.editor-toolbar__primary').evaluate("e=>({background:getComputedStyle(e).backgroundColor,image:getComputedStyle(e).backgroundImage,color:getComputedStyle(e).color})")
        assert metrics=={'background':'rgb(0, 102, 214)','image':'none','color':'rgb(255, 255, 255)'},metrics
        nav.get_by_role('button',name='模型设置',exact=True).click()
        p.screenshot(path=str(OUT/f'creator-settings-{width}.png'))
        nav.get_by_role('button',name='基础设置',exact=True).click()
        p.screenshot(path=str(OUT/f'creator-basic-{width}.png'))
        p.get_by_role('button',name='角色卡操作',exact=True).click()
        with p.expect_file_chooser():p.get_by_role('button',name='导入卡包',exact=True).click()
        p.goto(base+'/app/my-apps.html',wait_until='networkidle')
        expect(p.locator('.ref-library-row')).to_have_count(2)
        expect(p.locator('[data-app-bottom-nav]')).not_to_be_visible()
        p.get_by_role('searchbox',name='搜索我的角色').fill('奇幻')
        expect(p.locator('.ref-library-row')).to_have_count(1)
        p.get_by_role('searchbox',name='搜索我的角色').fill('没有这个角色')
        expect(p.get_by_role('status')).to_contain_text('没有匹配的角色')
        p.get_by_role('searchbox',name='搜索我的角色').fill('')
        p.get_by_role('combobox',name='角色公开状态').click()
        expect(p.get_by_role('searchbox',name='搜索选项')).not_to_be_visible()
        p.get_by_role('radio',name='私密',exact=True).click()
        expect(p.locator('.ref-library-row')).to_have_count(1)
        p.get_by_role('button',name='私人角色的操作').click()
        expect(p.get_by_role('dialog')).to_be_visible()
        p.get_by_role('button',name='删除角色',exact=True).click()
        p.get_by_role('button',name='取消',exact=True).click()
        assert not writes,writes
        expect(p.locator('.ref-library-row')).to_have_count(1)
        p.get_by_role('button',name='私人角色的操作').click()
        p.get_by_role('button',name='发布新版本',exact=True).click()
        expect(p.get_by_role('dialog',name='发布角色新版本')).to_be_visible()
        assert p.evaluate('window.HomerCloseOverlay()')
        expect(p.get_by_role('dialog',name='发布角色新版本')).to_have_count(0)
        p.screenshot(path=str(OUT/f'role-library-{width}.png'))
        p.goto(base+'/app/workshop.html',wait_until='networkidle')
        expect(p.get_by_role('navigation',name='创作入口').get_by_role('link')).to_have_count(4)
        expect(p.get_by_role('navigation',name='创作入口').get_by_role('link',name='Mod',exact=True)).to_be_visible()
        p.screenshot(path=str(OUT/f'workshop-{width}.png'))
        p.get_by_role('button',name='＋ 新建',exact=True).click()
        expect(p.get_by_role('dialog',name='新建作品')).to_be_visible()
        expect(p.get_by_role('dialog',name='新建作品').get_by_role('link')).to_have_count(4)
        p.screenshot(path=str(OUT/f'workshop-create-{width}.png'))
        assert p.evaluate('window.HomerCloseOverlay()')
        expect(p.get_by_role('dialog',name='新建作品')).not_to_be_visible()
        assert not p.evaluate('document.documentElement.scrollWidth>innerWidth+1')
        assert not errors,errors
        assert not failed,failed
        return {'viewport':[width,height],'metrics':metrics,'errors':errors,'checks':['always-five-tabs','duplicate-core-removed','solid-save-button','section-state-retained','file-picker','library-search-and-filter','compact-picker','delete-cancel','version-dialog-back','workshop-direct-resources','workshop-create-and-back']}
    finally:ctx.close()

if __name__=='__main__':
    OUT.mkdir(exist_ok=True,parents=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            try:results=[run(browser,f'http://127.0.0.1:{server.server_port}',w,h) for w,h in [(393,762),(360,780),(1440,900)]]
            finally:browser.close()
        (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        print(results)
    finally:server.shutdown();server.server_close()
