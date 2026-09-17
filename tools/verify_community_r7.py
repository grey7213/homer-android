"""R7 whole-page navigation acceptance. All remote traffic uses synthetic fixtures."""
import base64,functools,json,threading,re
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'output/community-r7'
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def copyfile(self,source,outputfile):
        try:super().copyfile(source,outputfile)
        except (ConnectionAbortedError,ConnectionResetError,BrokenPipeError):pass

def run(browser,base,w,h):
    ctx=browser.new_context(viewport={'width':w,'height':h},reduced_motion='reduce')
    ctx.add_init_script("""localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r7-test',name:'验收作者',is_admin:true}));window.HomerNative={isDebugBuild(){return true},setAccountScope(){},getAppVisitId(){return 'r7'},getAppVersion(){return '1.15.0'},notifyShellReady(){}};""")
    page=ctx.new_page();errors=[];writes=[];failed=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:errors.append(m.text) if m.type=='error' and '404' not in m.text else None)
    page.on('requestfailed',lambda r:failed.append(r.url))
    def route(r):
        p=urlparse(r.request.url)
        if p.scheme=='blob':return r.continue_()
        if p.netloc!=urlparse(base).netloc:return r.fulfill(status=204)
        if p.path.startswith(('/console/','/go/','/admin/api/')):
            if r.request.method not in ('GET','HEAD'):writes.append((p.path,r.request.method))
            if p.path.endswith('/account/profile'):return r.fulfill(json={'id':'r7-test','name':'验收作者','is_admin':True})
            if '/social/' in p.path:return r.fulfill(status=404,json={'message':'未部署社区服务'})
            return r.fulfill(json={'data':{'apps':[],'list':[],'total':0}})
        return r.continue_()
    ctx.route('**/*',route)
    def snap(name):
        page.screenshot(path=str(OUT/f'{name}-{w}.png'),full_page=True)
        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth+1'),name
        if name not in ('home','returned-home'):expect(page.locator('[data-app-bottom-nav]')).to_have_count(0)
    page.goto(base+'/app/community.html?acceptance=local',wait_until='networkidle')
    gate=page.get_by_role('dialog',name='进入社区前，请阅读');gate.get_by_role('checkbox').check();gate.get_by_role('button',name='同意并进入').click()
    expect(page.locator('.c-post')).to_have_count(2)
    expect(page.locator('[data-local-acceptance]')).to_be_visible()
    assert page.locator('[data-local-acceptance]').bounding_box()['height']<=36
    expect(page.locator('[data-app-bottom-nav] a')).to_have_count(5)
    snap('home')
    page.get_by_role('button',name='搜索社区',exact=True).click();page.wait_for_url('**/community-search.html')
    expect(page.get_by_role('heading',name='最近搜索')).to_be_visible();snap('search-empty')
    page.get_by_role('searchbox',name='搜索关键词').fill('示例')
    page.get_by_role('button',name='搜索',exact=True).click();expect(page.get_by_role('heading',name='试试发帖、回复和举报')).to_be_visible();snap('search-results')
    page.get_by_role('button',name='用户',exact=True).click();expect(page.locator('.c-list-link').filter(has_text='验收示例作者')).to_be_visible()
    page.locator('.c-list-link').filter(has_text='验收示例作者').click();page.wait_for_url('**/community-profile.html?user=*');expect(page.locator('.c-profile h2')).to_have_text('验收示例作者');snap('profile')
    page.get_by_role('button',name='返回',exact=True).click();page.wait_for_url('**/community-search.html*')
    expect(page.get_by_role('searchbox',name='搜索关键词')).to_have_value('示例')
    page.goto(base+'/app/community.html',wait_until='networkidle')
    page.get_by_role('link',name='试试发帖、回复和举报',exact=True).click();page.wait_for_url('**/community-post.html?id=1')
    expect(page.locator('.c-detail h2')).to_have_text('试试发帖、回复和举报')
    expect(page.locator('dialog[open]')).to_have_count(0);expect(page.locator('.c-pagination')).not_to_be_visible()
    dock=page.locator('.c-reply-dock').bounding_box();assert dock['width']==min(720,w) and dock['height']<82,dock
    assert page.locator('.c-header').bounding_box()['height']<=60
    snap('post-empty-comments')
    page.get_by_role('textbox',name='评论内容').fill('这是独立详情页中的评论')
    page.get_by_role('button',name='发送',exact=True).click();expect(page.locator('.c-comment')).to_have_count(1);snap('post-comment')
    page.get_by_role('button',name='收藏',exact=True).click();expect(page.get_by_role('button',name='已收藏',exact=True)).to_be_visible()
    page.get_by_role('button',name='返回',exact=True).click();page.wait_for_url('**/community.html');snap('returned-home')
    page.get_by_role('button',name='发布帖子',exact=True).click();page.wait_for_url('**/community-compose.html')
    expect(page.locator('dialog[open]')).to_have_count(0);expect(page.get_by_role('button',name='发布',exact=True)).to_be_disabled()
    page.get_by_role('textbox',name='帖子标题').fill('独立页面验收作品')
    page.get_by_role('textbox',name='帖子正文').fill('一次完整的创作、发布和返回过程。')
    page.get_by_role('textbox',name='话题标签').fill('创作  故事 test')
    page.get_by_role('textbox',name='话题标签').blur()
    assert page.evaluate("Alpine.$data(document.querySelector('[x-data]')).draft.tags")==['创作','故事','test']
    page.locator('input[type=file]').first.set_input_files({'name':'image.png','mimeType':'image/png','buffer':PNG})
    expect(page.locator('.c-editor-media img')).to_have_count(1)
    expect(page.get_by_text('草稿已保存到本机',exact=True)).to_be_visible();snap('compose')
    page.get_by_role('button',name='返回',exact=True).click();page.wait_for_url('**/community.html')
    page.get_by_role('button',name='发布帖子',exact=True).click();page.wait_for_url('**/community-compose.html');expect(page.get_by_role('textbox',name='帖子标题')).to_have_value('独立页面验收作品')
    expect(page.locator('.c-editor-media img')).to_have_count(1)
    page.get_by_role('button',name='发布',exact=True).click();page.wait_for_url('**/community-post.html?id=*');expect(page.locator('.c-detail h2')).to_have_text('独立页面验收作品');snap('published')
    post_url=page.url
    page.get_by_role('button',name='帖子操作',exact=True).click();page.get_by_role('dialog',name='帖子操作').get_by_role('button',name='编辑帖子',exact=True).click();page.wait_for_url('**/community-compose.html?edit=*')
    expect(page.get_by_role('textbox',name='帖子标题')).to_have_value('独立页面验收作品')
    page.get_by_role('textbox',name='帖子标题').fill('已编辑的验收作品');page.get_by_role('button',name='发布',exact=True).click();page.wait_for_url(post_url);expect(page.locator('.c-detail h2')).to_have_text('已编辑的验收作品')
    page.goto(base+'/app/community-activity.html',wait_until='networkidle');expect(page.locator('.c-post')).to_have_count(2);snap('activity')
    page.get_by_role('button',name='评论',exact=True).click();expect(page.locator('.c-list-link')).to_contain_text('这是独立详情页中的评论');snap('activity-comments')
    page.get_by_role('link',name='收藏',exact=True).click();page.wait_for_url('**/favorites.html?tab=community');expect(page.locator('.c-post')).to_have_count(1);snap('saved')
    page.get_by_role('button',name='收藏帖子',exact=True).click();expect(page.locator('.c-post')).to_have_count(0);expect(page.get_by_role('heading',name='还没有收藏帖子')).to_be_visible();snap('saved-empty')
    page.get_by_role('link',name='角色卡',exact=True).click();page.wait_for_url('**/favorites.html');expect(page.get_by_role('heading',name='我的收藏')).to_be_visible()
    page.goto(base+'/app/community-messages.html',wait_until='networkidle');expect(page.get_by_text('暂时没有这类消息')).to_be_visible();expect(page.get_by_role('button',name='更多消息')).not_to_be_visible();snap('messages-empty')
    page.goto(base+'/app/community-post.html?id=999999',wait_until='networkidle');expect(page.get_by_text('内容不存在或暂不可查看',exact=True)).to_be_visible();snap('post-deleted')
    page.goto(post_url,wait_until='networkidle');expect(page.locator('.c-detail-image img')).to_be_visible();page.wait_for_function("document.querySelector('.c-detail-image img').naturalWidth>0")
    page.get_by_role('button',name='帖子操作',exact=True).click();page.get_by_role('dialog',name='帖子操作').get_by_role('button',name='删除帖子',exact=True).click();page.get_by_role('dialog',name='确认操作').get_by_role('button',name='取消',exact=True).click();expect(page.locator('.c-detail h2')).to_have_text('已编辑的验收作品')
    page.goto(base+'/app/community.html',wait_until='networkidle')
    page.evaluate('window.scrollTo(0,200)');position=page.evaluate('scrollY')
    page.locator('.c-post-copy a').last.click();page.wait_for_url('**/community-post.html?id=*')
    page.get_by_role('button',name='返回',exact=True).click();page.wait_for_url('**/community.html')
    expect(page.locator('.c-post')).to_have_count(3)
    page.wait_for_function('(expected)=>Math.abs(scrollY-expected)<3',arg=position)
    assert not writes,writes;assert not errors,errors;assert not failed,failed
    ctx.close();return {'viewport':[w,h],'pages':8,'remote_writes':writes,'errors':errors,'request_failures':failed,'checks':['whole document routes','no main-dialog overlays','compact local disclosure','reply dock','draft/media restore','publish and edit','search and profile','activity and saved','empty/deleted states','delete cancelled']}

def permissions(browser,base):
    for debug,admin in [(False,True),(True,False)]:
        ctx=browser.new_context(viewport={'width':390,'height':844})
        ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'permission-test',is_admin:true}));window.HomerNative={isDebugBuild(){return "+str(debug).lower()+"},setAccountScope(){},notifyShellReady(){}}")
        def route(r):
            p=urlparse(r.request.url)
            if p.path.endswith('/account/profile'):return r.fulfill(json={'id':'permission-test','is_admin':admin})
            if '/social/' in p.path:return r.fulfill(status=404,json={'message':'社区尚未开放'})
            if p.path.startswith(('/console/','/go/','/admin/')):return r.fulfill(json={'data':{'list':[]}})
            return r.continue_()
        ctx.route('**/*',route);page=ctx.new_page();page.goto(base+'/app/community.html?acceptance=local',wait_until='networkidle')
        expect(page.locator('[data-local-acceptance]')).to_have_count(0)
        expect(page.locator('.c-compose-fab')).not_to_be_visible()
        expect(page.locator('.c-gate')).to_be_visible();ctx.close()
    return {'release_local_access':False,'ordinary_user_local_access':False}

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True);server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')));threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            try:
                results=[run(browser,f'http://127.0.0.1:{server.server_port}',w,h) for w,h in [(390,844),(360,800),(1440,900)]]
                results.append(permissions(browser,f'http://127.0.0.1:{server.server_port}'))
                (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(results,ensure_ascii=False))
            finally:browser.close()
    finally:server.shutdown();server.server_close()
