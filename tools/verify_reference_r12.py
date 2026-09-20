"""Measured creator geometry and workflow; only synthetic, intercepted APIs."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/ui-models-r12'
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
        expect(p.get_by_role('region',name='角色核心内容')).to_be_visible()
        expect(p.get_by_role('navigation',name='角色卡编辑分区')).not_to_be_visible()
        expect(p.get_by_role('region',name='角色世界与扩展')).not_to_be_visible()
        metrics=p.evaluate("""()=>Object.fromEntries(['.editor-toolbar','.creator-core__portrait','.creator-core__name','.creator-core__writing','.editor-toolbar__primary'].map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect(),c=getComputedStyle(e);return [s,{x:r.x,y:r.y,width:r.width,height:r.height,bg:c.backgroundColor,radius:c.borderRadius,font:c.fontSize}]}))""")
        p.screenshot(path=str(OUT/f'creator-reference-{width}.png'))
        (OUT/f'creator-geometry-{width}.json').write_text(json.dumps(metrics,indent=2),encoding='utf-8')
        if width==393:
            # Native screenshot: 1080x2160, 440 dpi, content begins at y=66.
            expected={'.editor-toolbar':(0,0,393,44),'.creator-core__portrait':(158.5,50.5,76,76),'.creator-core__name':(19.3,144.7,354.2,65.5),'.creator-core__writing':(19.3,223.3,354.2,175.3),'.editor-toolbar__primary':(83,699.6,227,47)}
            for sel,values in expected.items():
                for name,value in zip(('x','y','width','height'),values):
                    assert abs(metrics[sel][name]-value)<=3,(sel,name,metrics[sel][name],value)
            assert metrics['.creator-core__name']['bg']=='rgb(235, 235, 235)'
            assert p.locator('main').evaluate('e=>getComputedStyle(e).backgroundColor')=='rgb(240, 240, 240)'
        p.screenshot(path=str(OUT/f'creator-reference-{width}.png'))
        p.get_by_role('textbox',name='角色名字',exact=True).fill('合成测试角色')
        p.get_by_role('textbox',name='角色核心设定',exact=True).fill('切换分区后应保留这段设定')
        p.get_by_role('button',name='高级定义',exact=True).click()
        expect(p.get_by_role('textbox',name='性格特点',exact=True)).to_be_visible()
        p.get_by_role('textbox',name='性格特点',exact=True).fill('温和')
        p.get_by_role('button',name='世界与扩展 世界书、正则、脚本与互动界面',exact=True).click()
        expect(p.get_by_role('region',name='角色世界与扩展')).to_be_visible()
        expect(p.get_by_role('region',name='角色核心内容')).not_to_be_visible()
        p.get_by_role('button',name='核心内容',exact=True).click()
        expect(p.get_by_role('textbox',name='角色核心设定',exact=True)).to_have_value('切换分区后应保留这段设定')
        expect(p.get_by_role('textbox',name='性格特点',exact=True)).to_have_value('温和')
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
        return {'viewport':[width,height],'metrics':metrics,'errors':errors,'checks':['native-geometry','core-first','inline-advanced','section-state-retained','file-picker','library-search-and-filter','compact-picker','delete-cancel','version-dialog-back','workshop-direct-resources','workshop-create-and-back']}
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
        (OUT/'creator-reference-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        print(results)
    finally:server.shutdown();server.server_close()
