"""Host -> actual embedded runtime -> original memory controls, without paid generation."""
import json, mimetypes, time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from verify_chat_runtime import ROOT, BASE

OUT=ROOT/'output/ui-r22'

def run(browser,w,h,cancel=False):
    ctx=browser.new_context(viewport={'width':w,'height':h},reduced_motion='reduce')
    ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r22-memory',name:'合成测试用户'}));")
    page=ctx.new_page();errors=[];held=[];generated=[];state={};memory_writes=[]
    book={'entries':{'1':{'uid':1,'comment':'车站的约定','content':'明天清晨一起出发。','stmemorybooks':True,'disable':False,'order':42},'2':{'uid':2,'comment':'不可展示的角色设定','content':'作者原始设定','disable':False}}}
    page.on('pageerror',lambda e:errors.append(str(e)))
    messages=[{'id':f'm{i}','role':'user' if i%2 else 'assistant','content':text,'created_at':1788700000000+i} for i,text in enumerate(['我们在车站相遇。','记住明天的约定。','明天清晨，一起出发。'])]
    card={'spec':'chara_card_v2','spec_version':'2.0','data':{'name':'记忆验收','description':'本地合成角色','first_mes':'我们在车站相遇。','extensions':{}}}
    session={'user':{'id':'r22-memory','name':'合成测试用户'},'runtime':{'backend_base_url':BASE,'bridge_base_url':BASE},'launch':{'app_id':'r22-card','conversation_id':'r22-chat','bridge_token':'local-fixture-not-a-credential','card':card,'messages':messages,'runtime_config':{}}}
    def route(r):
        path=urlparse(r.request.url).path
        prefixed=path.startswith('/module/dialogue/')
        if prefixed:path=path[len('/module/dialogue'):]
        target=BASE+path+('?' + urlparse(r.request.url).query if urlparse(r.request.url).query else '')
        if urlparse(r.request.url).netloc!=urlparse(BASE).netloc:return r.fulfill(status=204)
        if path.startswith(('/app/','/assets/')):
            file=ROOT/'frontend'/path.lstrip('/')
            if file.is_file():return r.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream')
        if path.startswith('/scripts/extensions/third-party/dialogue-memory-books/'):
            file=ROOT/'sillytavern-runtime/public'/path.lstrip('/').replace('third-party/dialogue-memory-books/','third-party/SillyTavern-MemoryBooks/')
            if file.is_file():return r.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream')
        if path=='/api/settings/get':
            response=r.fetch(url=target);data=response.json();settings=json.loads(data['settings']);settings['firstRun']=False
            settings.setdefault('extension_settings',{})['disabledExtensions']=['third-party/js-slash-runner','third-party/ST-Prompt-Template','third-party/st-yuzi-phone']
            data['settings']=json.dumps(settings);return r.fulfill(response=response,json=data)
        if path=='/api/worldinfo/get' and r.request.post_data_json.get('name')=='r23-test-memory':return r.fulfill(json=book)
        if path=='/api/worldinfo/edit' and r.request.post_data_json.get('name')=='r23-test-memory':
            book.update(r.request.post_data_json['data']);memory_writes.append(1);return r.fulfill(json={})
        if '/generate' in path:
            generated.append(path);return r.fulfill(status=403,json={'error':'No paid generation in test'})
        if path=='/api/backends/chat-completions/status':return r.fulfill(json={'data':[{'id':'test-model'}]})
        if path.startswith(('/api/homer/','/console/')):
            if path=='/api/homer/session':held.append(r);return
            if path.endswith('/account/profile'):return r.fulfill(json={'id':'r22-memory','is_admin':False})
            if '/messages' in path:return r.fulfill(json={'data':{'conversation_id':'r22-chat','app_id':'r22-card','messages':messages}})
            if path=='/api/homer/runtime-state':
                if r.request.method=='POST':state.update(r.request.post_data_json)
                return r.fulfill(json={'data':state})
            if path=='/api/homer/models':return r.fulfill(json={'data':{'list':[{'id':'test-model','name':'测试模型','enabled':True}],'default_id':'test-model'}})
            if path=='/api/homer/sync':return r.fulfill(json={'data':{'messages':messages}})
            return r.fulfill(json={'data':{'list':[]}})
        if prefixed:return r.fulfill(response=r.fetch(url=target))
        r.continue_()
    ctx.route('**/*',route)
    try:
        page.goto(BASE+'/app/chat.html?app_id=r22-card&conversation_id=r22-chat',wait_until='domcontentloaded')
        page.locator('#preview-settings').click();page.locator('[data-runtime-section=memory]').click()
        expect(page.locator('#homer-memory-entry')).to_have_count(0)
        pending=page.locator('dialog.homer-chat-tool');expect(pending).to_be_visible()
        if cancel:pending.get_by_role('button',name='取消').click()
        deadline=time.monotonic()+20
        while not held and time.monotonic()<deadline:page.wait_for_timeout(50)
        assert held,'Session request never reached actual runtime'
        start=time.perf_counter()
        for r in held:r.fulfill(json={'data':session})
        frame=page.frame_locator('#dialogue-frame')
        expect(frame.locator('html.homer-runtime-ready')).to_have_count(1,timeout=45000)
        expect(frame.locator('#chat .mes')).to_have_count(3)
        if cancel:
            page.wait_for_timeout(500);expect(frame.locator('.stmb-popup[open]')).to_have_count(0)
            frame.get_by_role('button',name='打开对话设置',exact=True).click()
            start=time.perf_counter();frame.locator('#homer-open-memory-books').click()
        popup=frame.locator('.stmb-popup[open]')
        expect(popup.locator('.homer-memory-layout')).to_be_visible(timeout=20000)
        elapsed=round((time.perf_counter()-start)*1000)
        expect(popup.locator('.memory-entry-next')).to_have_count(0)
        page.locator('#dialogue-frame').evaluate("e=>{const c=e.contentWindow.SillyTavern.getContext();c.chatMetadata.world_info='r23-test-memory';c.extensionSettings.STMemoryBooks.moduleSettings.manualModeEnabled=false;}")
        popup.get_by_role('button',name='我的记忆 查看与编辑 ›',exact=True).click()
        expect(popup.locator('.homer-memory-record')).to_have_count(1)
        expect(popup.get_by_text('不可展示的角色设定',exact=True)).to_have_count(0)
        popup.locator('.homer-memory-record').click();popup.get_by_role('textbox',name='记忆内容',exact=True).fill('取消不应保存')
        popup.get_by_role('button',name='取消',exact=True).click();assert not memory_writes
        popup.locator('.homer-memory-record').click();popup.get_by_role('textbox',name='记忆内容',exact=True).fill('明天早上六点在车站碰面。')
        page.screenshot(path=str(OUT/f'memory-edit-{w}-{cancel}.png'))
        popup.get_by_role('button',name='保存记忆',exact=True).click()
        expect(popup.locator('.homer-memory-record')).to_contain_text('明天早上六点在车站碰面。')
        assert len(memory_writes)==1 and book['entries']['1']['order']==42 and book['entries']['2']['content']=='作者原始设定'
        popup.locator('.homer-settings-page__back').click()
        popup.get_by_role('button',name='立即总结 选择范围并确认生成 ›',exact=True).click()
        popup.get_by_role('button',name='自定义',exact=True).click()
        popup.locator('#homer-memory-from').fill('2');popup.locator('#homer-memory-to').fill('3')
        popup.get_by_role('button',name='使用此范围',exact=True).click()
        expect(popup.locator('.homer-memory-selection')).to_contain_text('第 2–3 条')
        expect(frame.locator('#chat .mes[mesid="1"] .mes_stmb_start')).to_have_class(__import__('re').compile(r'\bon\b'))
        expect(frame.locator('#chat .mes[mesid="2"] .mes_stmb_end')).to_have_class(__import__('re').compile(r'\bon\b'))
        page.screenshot(path=str(OUT/f'memory-real-{w}-{cancel}.png'))
        assert not generated,generated
        assert not errors,errors
        return {'viewport':[w,h],'cancelBeforeReady':cancel,'actualMemoryOpenMs':elapsed,'timingStarts':'ready menu click' if cancel else 'session response released; includes runtime initialization','realMessages':3,'selectedRange':[2,3],'generated':generated,'errors':errors}
    finally:ctx.close()

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        b=p.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
        try: results=[run(b,w,h,c) for w,h,c in [(390,844,False),(390,844,True),(1440,900,False)]]
        finally:b.close()
    (OUT/'memory-host-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8');print(results)
