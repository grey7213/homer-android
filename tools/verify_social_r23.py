"""Real community service + isolated SQLite + current UI; no live users or credentials."""
import json,sqlite3,sys,threading,functools
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'server-extensions'))
from community_feed import ensure_feed_schema,handle_feed_route
from community_policy import VERSION
OUT=ROOT/'output/social-r23';OUT.mkdir(parents=True,exist_ok=True)
db=sqlite3.connect(':memory:',check_same_thread=False);lock=threading.RLock();ensure_feed_schema(db,lock)
def api(path,method='GET',body=None,uid='alice',query=None):
    return handle_feed_route(method,'console/api/web/social/'+path,query or {},body or {},dict(conn=db,lock=lock,user={'id':uid,'name':'验收用户' if uid=='alice' else uid},is_admin=False))
for uid in ['alice','author-a','author-b']:
    db.execute('INSERT INTO social_consents VALUES(?,?,0)',(uid,VERSION));db.execute('INSERT INTO social_members(user_id,name) VALUES(?,?)',(uid,uid))
db.execute('UPDATE social_members SET name=?,bio=?,avatar=? WHERE user_id=?',('雾里行舟','写一些慢慢展开的故事。','/assets/img/apk/default_avatar.png','author-a'))
db.execute('UPDATE social_members SET name=?,bio=? WHERE user_id=?',('枕星入梦','世界很大，故事也是。','author-b'))
db.execute('INSERT INTO social_follows VALUES(?,?)',('alice','author-a'))
db.execute('INSERT INTO social_follows VALUES(?,?)',('author-b','alice'))
for uid,name,bio in [('author-c','山间来信','分享世界书与创作心得'),('author-d','一个名字很长很长很长很长的创作者','这是一段较长的个人介绍，用来验证窄屏下不会挤压关注按钮'),('author-e','拾光','')]:
    db.execute('INSERT INTO social_members(user_id,name,bio) VALUES(?,?,?)',(uid,name,bio))
    db.execute('INSERT INTO social_follows VALUES(?,?)',('alice',uid))
    db.execute('INSERT INTO social_follows VALUES(?,?)',(uid,'alice'))
db.commit()
post=api('posts','POST',{'client_id':'r23','title':'普通用户的帖子','content':'这是我记录的故事。','topic':'角色故事'})['data']
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def dispatch(self):
        p=urlparse(self.path)
        if not p.path.startswith(('/console/','/admin/api/','/go/')):return False
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or '{}')
        if '/social/' in p.path:result=api(p.path.split('/social/',1)[1],self.command,body,query={k:v[-1] for k,v in parse_qs(p.query).items()})
        elif p.path.endswith('/account/profile'):result={'id':'alice','name':'验收用户','is_admin':False}
        else:result={'data':{'list':[],'apps':[],'total':0}}
        status=result.pop('__http__',200);data=json.dumps(result,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return True
    def do_GET(self):
        if not self.dispatch():super().do_GET()
    def do_POST(self):self.dispatch()
    do_PUT=do_PATCH=do_DELETE=do_POST
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'frontend')));threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
def run(browser,w,h,dark):
    ctx=browser.new_context(viewport={'width':w,'height':h},reduced_motion='reduce',color_scheme='dark' if dark else 'light')
    ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'alice',name:'验收用户',is_admin:false}));localStorage.setItem('ai_xingyue_shell_theme',"+json.dumps('dark' if dark else 'light')+");")
    page=ctx.new_page();errors=[];failed=[]
    page.on('pageerror',lambda e:errors.append(str(e)));page.on('requestfailed',lambda r:failed.append(urlparse(r.url).path))
    ctx.route('**/*',lambda r:r.continue_() if urlparse(r.request.url).netloc==urlparse(base).netloc else r.fulfill(status=204))
    try:
        page.goto(base+'/app/me.html',wait_until='networkidle')
        expect(page.get_by_role('link',name='我关注的')).to_be_visible();expect(page.get_by_role('link',name='关注我的')).to_be_visible()
        expect(page.locator('a[aria-label="管理后台"]')).not_to_be_visible()
        page.get_by_role('link',name='我关注的').click();page.wait_for_url('**/community-relations.html?tab=following')
        expect(page.locator('.c-relations article')).to_have_count(4)
        styles=page.evaluate("""Object.fromEntries(['.c-relation-search input','.c-relation-search>div','.c-relation-person strong','.c-relation-person'].map(q=>{const s=getComputedStyle(document.querySelector(q));return [q,{font:s.font,background:s.backgroundColor,color:s.color,radius:s.borderRadius,shadow:s.textShadow}]}))""")
        (OUT/f'styles-{w}-{dark}.json').write_text(json.dumps(styles,indent=2),encoding='utf8')
        assert styles['.c-relation-search input']['background']=='rgba(0, 0, 0, 0)',styles
        page.screenshot(path=str(OUT/f'following-{w}-{dark}.png'),full_page=True)
        search=page.get_by_role('searchbox',name='搜索名单');search.fill('雾里')
        expect(page.locator('.c-relations article')).to_have_count(1)
        page.get_by_role('button',name='已关注',exact=True).click()
        page.get_by_role('button',name='取消',exact=True).click()
        expect(page.get_by_role('button',name='已关注',exact=True)).to_be_enabled()
        assert db.execute('SELECT 1 FROM social_follows WHERE user_id=? AND author_id=?',('alice','author-a')).fetchone()
        page.get_by_role('button',name='清除搜索',exact=True).click();expect(page.locator('.c-relations article')).to_have_count(4)
        page.get_by_role('button',name='关注我的',exact=True).click();expect(page.locator('.c-relations article')).to_have_count(4)
        page.get_by_role('button',name='回关',exact=True).click()
        expect(page.get_by_role('button',name='互相关注',exact=True)).to_have_count(4)
        assert db.execute('SELECT 1 FROM social_follows WHERE user_id=? AND author_id=?',('alice','author-b')).fetchone()
        page.screenshot(path=str(OUT/f'relations-{w}-{dark}.png'),full_page=True)
        search.fill('不会存在的名字');expect(page.get_by_role('heading',name='没有找到这个用户')).to_be_visible()
        page.screenshot(path=str(OUT/f'empty-{w}-{dark}.png'),full_page=True)
        search.fill('枕星');expect(page.locator('.c-relations article')).to_have_count(1)
        page.get_by_role('button',name='查看 枕星入梦 的主页').click();page.wait_for_url('**/community-profile.html?user=author-b')
        page.get_by_role('button',name='返回',exact=True).click();page.wait_for_url('**/community-relations.html?tab=followers&q=*')
        expect(page.get_by_role('searchbox',name='搜索名单')).to_have_value('枕星')
        expect(page.locator('.c-relations article')).to_have_count(1)
        page.goto(base+f'/app/community-post.html?id={post["id"]}',wait_until='networkidle')
        page.get_by_role('button',name='帖子操作',exact=True).click();page.get_by_role('dialog',name='帖子操作').get_by_role('button',name='编辑帖子',exact=True).click()
        page.wait_for_url('**/community-compose.html?edit=*');page.get_by_role('textbox',name='帖子标题').fill('普通用户编辑成功')
        page.get_by_role('button',name='发布',exact=True).click();page.wait_for_url('**/community-post.html?id=*')
        expect(page.locator('.c-detail h2')).to_have_text('普通用户编辑成功')
        assert api('posts/'+str(post['id']))['data']['title']=='普通用户编辑成功'
        page.screenshot(path=str(OUT/f'owner-edit-{w}-{dark}.png'),full_page=True)
        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
        assert not errors,errors;assert not failed,failed
        return {'viewport':[w,h],'dark':dark,'ordinaryOwnerEdit':True,'relationsSaved':True,'errors':errors,'failed':failed}
    except:
        page.screenshot(path=str(OUT/'failure.png'),full_page=True);print('UI:',page.locator('body').inner_text()[:2500]);raise
    finally:
        with lock:db.execute('DELETE FROM social_follows WHERE user_id=? AND author_id=?',('alice','author-b'));db.commit()
        ctx.close()
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
        try:result=[run(browser,*args) for args in [(390,844,False),(390,844,True),(1440,900,False)]]
        finally:browser.close()
    (OUT/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(result)
finally:server.shutdown();db.close()
