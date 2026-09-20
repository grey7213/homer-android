"""Exercise the actual isolated dialogue server, with synthetic Homer API data.

Start the runtime on port 18911 using output/ui-rework-r2/runtime-test.yaml.
No production requests, credentials, paid generation, or real chats are used.
"""
import argparse, json, mimetypes, uuid, re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/ui-rework-r2/runtime'
BASE='http://127.0.0.1:18911'

def contrast(page,selector):
    rows=page.locator(selector).evaluate_all("""nodes=>nodes.filter(e=>e.getClientRects().length&&!e.disabled).map(e=>{
        let p=e,bg='rgb(255,255,255)';
        while(p){const value=getComputedStyle(p).backgroundColor;if(!['transparent','rgba(0, 0, 0, 0)'].includes(value)){bg=value;break;}p=p.parentElement;}
        return {color:getComputedStyle(e).color,bg,text:e.textContent.trim()};
    })""")
    def luminance(css):
        rgb=[float(n)/255 for n in re.findall(r'[\d.]+',css)[:3]]
        rgb=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
        return sum(a*b for a,b in zip(rgb,[.2126,.7152,.0722]))
    for row in rows:
        a,b=sorted([luminance(row['color']),luminance(row['bg'])])
        assert (b+.05)/(a+.05)>=4.5,row
    return len(rows)

def run(browser,width,height,visual_only=False,loading_only=False,scheme='light'):
    held_mods=[]
    state={'variables':{},'extension_settings':{}}
    messages=[{'id':str(uuid.uuid4()),'role':role,'content':content,'created_at':1788700000000+i} for i,(role,content) in enumerate([
        ('assistant','是否开启第一集'),('user','dynamic-baseline-20260720'),('assistant','这是一条用于折叠和编辑的测试消息。\n'+('故事里的风吹过长街。'*30))])]
    if visual_only:messages=messages[:2]
    card={'spec':'chara_card_v2','spec_version':'2.0','data':{'name':'爱情公寓蜗牛制作','description':'本地合成测试角色','first_mes':'是否开启第一集','personality':'','scenario':'','mes_example':'','extensions':{}}}
    context=browser.new_context(viewport={'width':width,'height':height},device_scale_factor=1,reduced_motion='reduce',color_scheme=scheme)
    context.add_init_script("const add=DOMTokenList.prototype.add;DOMTokenList.prototype.add=function(...args){if(args.includes('homer-runtime-pending'))console.debug('TEST gate added',new Error().stack);return add.apply(this,args)};")
    page=context.new_page();errors=[];failed=[];bad_http=[];logs=[];cancelled_status=[]
    page.on('console',lambda m:logs.append(m.text[:3000]))
    page.on('request',lambda r:logs.append('TEST request '+urlparse(r.url).path) if r.resource_type in ('xhr','fetch') else None)
    page.on('pageerror',lambda e:errors.append(str(e)))
    def request_failed(request):
        path=urlparse(request.url).path
        # Runtime replaces its model-status probe when reloading a chat. Keep
        # these explicit cancellations separate from failed business requests.
        if path=='/api/backends/chat-completions/status' and request.failure=='net::ERR_ABORTED':
            cancelled_status.append(path)
        else:failed.append({'path':path,'error':request.failure})
    page.on('requestfailed',request_failed)
    page.on('response',lambda r:bad_http.append([urlparse(r.url).path,r.status]) if r.status>=400 else None)
    def route(r):
        nonlocal messages,state
        p=urlparse(r.request.url);path=p.path
        if p.netloc!=urlparse(BASE).netloc:return r.fulfill(status=204)
        if path=='/api/backends/chat-completions/status':return r.fulfill(json={'data':[{'id':'test-model'}]})
        # This scenario exercises a plain card. Third-party script-card behavior
        # is a separate suite; disable it only in this isolated test user's settings.
        if path=='/api/settings/get':
            response=r.fetch();data=response.json();settings=json.loads(data['settings'])
            settings['firstRun']=False
            settings.setdefault('extension_settings',{})['disabledExtensions']=['third-party/js-slash-runner','third-party/ST-Prompt-Template','third-party/st-yuzi-phone']
            data['settings']=json.dumps(settings);return r.fulfill(response=response,json=data)
        if path.startswith('/scripts/extensions/third-party/dialogue-memory-books/'):
            file=ROOT/'sillytavern-runtime/public'/path.lstrip('/').replace('third-party/dialogue-memory-books/','third-party/SillyTavern-MemoryBooks/')
            if file.is_file():return r.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream')
        if path.startswith('/assets/'):
            file=ROOT/'frontend'/path.lstrip('/')
            if file.is_file():return r.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream')
        if path.startswith('/api/homer/') or path.startswith('/console/'):
            if loading_only and '/api/homer/mods/' in path:
                held_mods.append(r)
                return
            body=r.request.post_data_json if r.request.method in ('POST','PUT','PATCH') else {}
            data={}
            if path=='/api/homer/session':data={'user':{'id':'runtime-test','name':'测试用户'},'runtime':{'backend_base_url':BASE,'bridge_base_url':BASE},'launch':{'app_id':'runtime-test-card','conversation_id':'runtime-test-chat','bridge_token':'local-fixture-not-a-credential','card':card,'messages':messages,'runtime_config':{}}}
            elif path=='/api/homer/runtime-state':
                if r.request.method=='POST':state.update({k:v for k,v in body.items() if k in ('variables','extension_settings')})
                data=state
            elif path=='/api/homer/sync':
                messages=[{'id':m['extra']['homer_message_id'] or str(uuid.uuid4()),'role':'system' if m['is_system'] else 'user' if m['is_user'] else 'assistant','content':m['mes'],'created_at':m['extra']['homer_created_at']} for m in body['messages']]
                data={'messages':messages}
            elif path=='/api/homer/models':data={'list':[{'id':'test-model','name':'测试模型','enabled':True}],'default_id':'test-model'}
            elif path=='/api/homer/mods/library':data={'list':[{'id':'style','name':'叙事风格','summary':'让当前对话更偏向细腻描写。'},{'id':'pace','name':'节奏控制','summary':'控制故事推进速度。'}]}
            elif path.startswith('/api/homer/mods/conversation/'):data={'list':[{'id':'style'}]}
            elif path.endswith('/delete') and '/messages/' in path:
                mid=path.split('/')[-2];messages=[m for m in messages if m['id']!=mid];data={'deleted':True}
            elif path.endswith('/rollback') and '/messages/' in path:
                mid=path.split('/')[-2];index=next(i for i,m in enumerate(messages) if m['id']==mid)
                data={'deleted_count':len(messages)-index};messages=messages[:index]
            elif path=='/api/homer/conversations':data={'list':[{'id':'runtime-test-chat','app_id':'runtime-test-card','title':card['data']['name']}]}
            else:data={'list':[]}
            return r.fulfill(json={'data':data})
        return r.continue_()
    page.route('**/*',route)
    try:
        page.goto(BASE+'/?homer_embed=1&homer_app_id=runtime-test-card&homer_conversation_id=runtime-test-chat',wait_until='domcontentloaded' if loading_only else 'networkidle',timeout=60000)
        page.locator('html.homer-runtime-ready').wait_for(state='attached',timeout=15000)
        page.locator('#chat .mes').first.wait_for(timeout=5000)
        page.screenshot(path=str(OUT/f'chat-{width}.png'))
        assert page.locator('.homer-chat-header').evaluate('e=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
        expect(page.locator('.homer-chat-header__title')).not_to_be_visible()
        if loading_only:
            assert len(held_mods)==2, len(held_mods)
            page.get_by_role('button',name='打开对话设置',exact=True).click()
            page.locator('#homer-open-mods').click()
            expect(page.locator('#homer-mod-dialog')).to_be_visible()
            expect(page.get_by_role('button',name='保存 Mod',exact=True)).to_be_disabled()
            page.screenshot(path=str(OUT/f'mod-pending-{width}.png'))
            page.keyboard.press('Escape')
            for r in held_mods:r.fulfill(json={'data':{'list':[]}})
            held_mods.clear()
            page.wait_for_function("!document.querySelector('#homer-mod-dialog button.homer-primary-button').disabled")
            expect(page.locator('#homer-mod-dialog')).not_to_be_visible()
            page.wait_for_function('!!window.HomerMemoryBooks?.open',timeout=45000)
            page.evaluate('window.__memoryApi=window.HomerMemoryBooks;window.HomerMemoryBooks=null')
            page.get_by_role('button',name='打开对话设置',exact=True).click()
            page.locator('#homer-open-memory-books').click()
            expect(page.locator('#homer-memory-dialog')).to_be_visible()
            expect(page.locator('#homer-memory-entry')).to_have_count(0)
            page.keyboard.press('Escape')
            page.evaluate("window.HomerMemoryBooks=window.__memoryApi;delete window.__memoryApi;window.dispatchEvent(new Event('homer:memory-ready'))")
            page.wait_for_timeout(250)
            expect(page.locator('.stmb-popup[open]')).to_have_count(0)
            page.get_by_role('button',name='打开导航与历史会话',exact=True).click()
            nav=page.locator('.homer-main-navigation__item').filter(has_text='创意工坊')
            expect(nav).to_be_visible()
            assert nav.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
            page.screenshot(path=str(OUT/f'left-drawer-{width}.png'))
            page.keyboard.press('Escape')
            text=page.locator('#chat .mes[mesid="0"] .mes_text')
            expect(text).to_have_css('font-size','15px')
            expect(text).to_have_css('line-height','21.75px')
            assert not errors,errors
            return {'viewport':[width,height],'modRequestsHeldUntilChatReady':True,'saveDisabledWhileLoading':True,'closedDialogStaysClosed':True,'memoryCancelledBeforeReady':True,'compactText':True,'errors':errors}
        if visual_only:
            expect(page.locator('#chat .mes')).to_have_count(2)
            metrics=page.evaluate("""()=>Object.fromEntries(['.homer-chat-header','#chat','#form_sheld','#send_textarea','#chat .mes[mesid="0"]','#chat .mes[mesid="1"]','#send_form','#homer-continuation-trigger'].map(selector=>{const e=document.querySelector(selector),s=getComputedStyle(e);return [selector,{rect:e.getBoundingClientRect().toJSON(),background:s.backgroundColor,font:s.fontSize,radius:s.borderRadius,align:s.textAlign,padding:s.padding,position:s.position,bottom:s.bottom,transform:s.transform}]}))""")
            assert not errors,errors
            return {'viewport':[width,height],'geometry':metrics,'errors':errors,'failed':failed,'http_errors':bad_http}
        expect(page.locator('#chat .mes')).to_have_count(3)
        page.get_by_role('button',name='打开导航与历史会话',exact=True).click()
        page.locator('.homer-history-item__more').first.click()
        expect(page.locator('#homer-chat-manage-dialog')).to_be_visible()
        assert contrast(page,'#homer-chat-manage-dialog button')==6
        page.screenshot(path=str(OUT/f'chat-manager-{width}.png'))
        page.keyboard.press('Escape');page.keyboard.press('Escape')
        # Real event handlers, native message list, persistence and reload.
        bubble=page.locator('#chat .mes[mesid="0"] .mes_text');bubble.scroll_into_view_if_needed()
        box=bubble.bounding_box();page.mouse.move(box['x']+10,box['y']+10);page.mouse.down();page.wait_for_timeout(600);page.mouse.up()
        menu=page.locator('#homer-message-menu-dialog')
        expect(menu).to_be_visible()
        page.wait_for_timeout(300)
        page.wait_for_function("""()=>{const m=document.querySelector('#homer-message-menu-dialog'),r=m.getBoundingClientRect(),h=document.querySelector('.homer-chat-header').getBoundingClientRect();return !m.classList.contains('is-positioning')&&r.top>=h.bottom&&r.bottom<=innerHeight}""")
        assert bubble.evaluate('e=>getComputedStyle(e).userSelect')=='none'
        assert page.evaluate('getSelection().toString()')==''
        page.wait_for_function("""()=>{const m=document.querySelector('#homer-message-menu-dialog').getBoundingClientRect(),b=document.querySelector('#chat .mes[mesid="0"]').getBoundingClientRect();return m.bottom<=b.top-8||m.top>=b.bottom+8}""")
        page.screenshot(path=str(OUT/f'longpress-{width}.png'))
        menu.get_by_role('menuitem',name='隐藏',exact=True).click()
        expect(page.locator('#chat .mes[mesid="0"]')).to_have_class(__import__('re').compile('homer-message-hidden'))
        page.wait_for_function("SillyTavern.getContext().chat[0].is_system === true")
        assert messages[0]['role']=='assistant'
        page.reload(wait_until='networkidle')
        page.locator('html.homer-runtime-ready').wait_for(state='attached',timeout=15000)
        expect(page.locator('#chat .mes[mesid="0"]')).to_have_class(__import__('re').compile('homer-message-hidden'))
        assert page.evaluate('SillyTavern.getContext().chat[0].is_system') is True
        # Assemble a real prompt without sending it to a model. Hidden messages
        # must remain in history but not participate in model context.
        prompt=page.evaluate("""async()=>{const c=SillyTavern.getContext();let prompt=[];
          const listener=data=>{if(data.dryRun)prompt=data.chat};
          c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY,listener);
          try{await c.generate('normal',{},true);return prompt;}finally{c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_PROMPT_READY,listener)}}""")
        assert prompt and 'dynamic-baseline-20260720' in json.dumps(prompt,ensure_ascii=False)
        assert '是否开启第一集' not in json.dumps(prompt,ensure_ascii=False)
        page.locator('#chat .mes[mesid="0"] .mes_text').click(button='right')
        menu.get_by_role('menuitem',name='取消隐藏',exact=True).click()
        page.wait_for_function('!SillyTavern.getContext().chat[0].is_system')
        page.locator('#chat .mes[mesid="2"] .mes_text').click(button='right')
        menu.get_by_role('menuitem',name='折叠',exact=True).click()
        expect(page.locator('#chat .mes[mesid="2"]')).to_have_class(__import__('re').compile('homer-message-collapsed'))
        assert page.evaluate('SillyTavern.getContext().chat[2].is_system') is False
        page.locator('#chat .mes[mesid="1"] .mes_text').click(button='right')
        menu.get_by_role('menuitem',name='多选',exact=True).click()
        selection=page.locator('#homer-message-selection')
        expect(selection.locator('.homer-selection-head')).to_be_visible()
        logs.append('TEST selection '+json.dumps(selection.evaluate("e=>[...e.children].map(n=>({tag:n.tagName,rect:n.getBoundingClientRect().toJSON(),style:{display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility,top:getComputedStyle(n).top,bottom:getComputedStyle(n).bottom}}))")))
        selection.get_by_role('button',name='全选',exact=True).click()
        expect(selection).to_contain_text('已选择 3 条消息')
        page.screenshot(path=str(OUT/f'multiselect-{width}.png'))
        selection.get_by_role('button',name='删除',exact=True).click()
        page.locator('#homer-delete-selected-dialog').get_by_role('button',name='取消',exact=True).click()
        expect(page.locator('#chat .mes')).to_have_count(3)
        selection.get_by_role('button',name='取消',exact=True).click()
        page.get_by_role('button',name='打开对话设置',exact=True).click()
        page.screenshot(path=str(OUT/f'settings-{width}.png'))
        print('control-panel',page.locator('#homer-right-drawer').evaluate("e=>({cls:e.className,rect:e.getBoundingClientRect().toJSON(),transform:getComputedStyle(e).transform,inset:getComputedStyle(e).inset})"),flush=True)
        page.locator('#homer-right-drawer').get_by_role('button',name='统计',exact=True).click()
        stats=page.get_by_role('dialog',name='本次对话统计')
        expect(stats.locator('dd').first).to_have_text('3')
        page.screenshot(path=str(OUT/f'stats-{width}.png'));page.keyboard.press('Escape')
        page.get_by_role('button',name='打开对话设置',exact=True).click()
        page.locator('#homer-right-drawer').get_by_role('button',name='搜索',exact=True).click()
        search=page.get_by_role('dialog',name='搜索本次对话')
        search.get_by_role('searchbox').fill('没有这条内容')
        expect(search.get_by_role('status')).to_have_text('没有找到相关消息')
        search.get_by_role('searchbox').fill('dynamic-baseline')
        expect(search.get_by_role('status')).to_have_text('找到 1 条消息')
        page.screenshot(path=str(OUT/f'search-{width}.png'))
        search.locator('.homer-chat-tool__results button').click()
        expect(page.locator('#chat .mes[mesid="1"]')).to_have_class(__import__('re').compile('homer-search-hit'))
        page.get_by_role('button',name='打开对话设置',exact=True).click()
        expect(page.locator('#homer-right-drawer').get_by_role('button',name='重启',exact=True)).to_have_count(0)
        expect(page.locator('#homer-right-drawer').get_by_role('link',name='收藏',exact=True)).to_have_count(0)
        page.locator('#homer-right-drawer').get_by_role('button',name='界面设置',exact=True).click()
        appearance=page.get_by_role('dialog',name='界面设置')
        expect(appearance).to_be_visible()
        appearance.get_by_role('button',name='角色气泡 #ffffff',exact=True).click()
        assert page.locator('#chat .mes[mesid="0"]').evaluate('e=>getComputedStyle(e).color')=='rgb(0, 0, 0)'
        page.screenshot(path=str(OUT/f'appearance-{width}.png'))
        appearance.get_by_role('button',name='保存',exact=True).click()
        assert page.evaluate("JSON.parse(localStorage.getItem('homer.chat-appearance.v1:runtime-test:runtime-test-chat')).assistant")=='#ffffff'
        page.get_by_role('button',name='打开对话设置',exact=True).click()
        page.locator('#homer-right-drawer').get_by_role('button',name='界面设置',exact=True).click()
        appearance.get_by_role('button',name='纯色背景',exact=True).click()
        appearance.get_by_role('button',name='纯色背景 #ffffff',exact=True).click()
        appearance.get_by_role('button',name='取消',exact=True).click()
        assert page.locator('body').evaluate('e=>getComputedStyle(e).getPropertyValue("--chat-bg").trim()')=='#212121'
        page.get_by_role('button',name='打开对话设置',exact=True).click()
        page.locator('#homer-open-preset-settings').click()
        expect(page.locator('#homer-preset-panel')).to_be_visible()
        assert page.evaluate('window.HomerCloseOverlay()')
        expect(page.locator('#homer-preset-panel')).not_to_be_visible()
        for trigger,dialog_id in [('homer-open-model-settings','homer-model-dialog'),('homer-open-mods','homer-mod-dialog'),('homer-open-memory-books','memory-direct')]:
            if dialog_id=='memory-direct':
                page.locator('#stmb-menu-item[data-homer-ready=true]').wait_for(state='attached',timeout=45000)
            page.get_by_role('button',name='打开对话设置',exact=True).click()
            if dialog_id=='memory-direct':
                page.evaluate("""()=>{window.__memoryOpenedMs=null;document.querySelector('#homer-open-memory-books').addEventListener('click',()=>{const start=performance.now();const o=new MutationObserver(()=>{if(document.querySelector('.stmb-popup[open] .homer-memory-layout')){window.__memoryOpenedMs=performance.now()-start;o.disconnect();}});o.observe(document.body,{subtree:true,childList:true,attributes:true});},{once:true});}""")
            page.locator('#'+trigger).click()
            dialog=page.locator('.stmb-popup').filter(has=page.locator('.homer-memory-layout')) if dialog_id=='memory-direct' else page.locator('#'+dialog_id)
            expect(dialog).to_be_visible(timeout=30000)
            box=dialog.bounding_box()
            assert abs(box['width']-width)<2 and abs(box['height']-height)<2,box
            expect(dialog.locator('.homer-settings-page__head')).to_be_visible()
            page.screenshot(path=str(OUT/f'{dialog_id}-{width}.png'))
            if dialog_id=='homer-model-dialog':
                dialog.get_by_label('调整温度',exact=True).click()
                cdp=context.new_cdp_session(page);cdp.send('DOM.enable');cdp.send('CSS.enable')
                doc=cdp.send('DOM.getDocument');node=cdp.send('DOM.querySelector',{'nodeId':doc['root']['nodeId'],'selector':'.homer-model-field__label'})
                (OUT/f'platform-font-{width}.json').write_text(json.dumps(cdp.send('CSS.getPlatformFontsForNode',{'nodeId':node['nodeId']}),ensure_ascii=False,indent=2),encoding='utf-8');cdp.detach()
                (OUT/f'model-style-{width}.json').write_text(json.dumps(dialog.evaluate("""e=>Object.fromEntries(['.homer-model-field__label','.homer-model-field__range'].map(s=>{const n=e.querySelector(s),c=getComputedStyle(n);return [s,{font:c.fontFamily,filter:c.filter,thumb:getComputedStyle(n,'::-webkit-slider-thumb').backgroundColor}]}))"""),ensure_ascii=False,indent=2),encoding='utf-8')
                value=dialog.get_by_role('spinbutton',name='温度',exact=True).input_value()
                dialog.get_by_role('spinbutton',name='温度',exact=True).fill('1.5')
                dialog.locator('.homer-settings-page__back').click()
                page.get_by_role('button',name='打开对话设置',exact=True).click();page.locator('#'+trigger).click()
                expect(dialog.get_by_role('spinbutton',name='温度',exact=True)).to_have_value(value)
                page.locator('#homer-model-select').click();expect(page.locator('.homer-option-picker')).to_be_visible()
                # Same handler used by the Android Back bridge: closes only the top layer.
                assert page.evaluate('window.HomerCloseOverlay()')
                expect(dialog).to_be_visible();expect(page.locator('.homer-option-picker')).to_have_count(0)
            if dialog_id=='homer-mod-dialog':
                dialog.get_by_role('searchbox',name='查找 Mod').fill('不存在的名称')
                expect(dialog.get_by_text('没有匹配的 Mod，试试其他关键词。')).to_be_visible()
                dialog.get_by_role('searchbox',name='查找 Mod').fill('')
                expect(dialog.get_by_role('checkbox',name='启用 叙事风格')).to_be_checked()
                dialog.get_by_role('checkbox',name='启用 节奏控制').check()
                dialog.locator('.homer-settings-page__back').click()
                page.get_by_role('button',name='打开对话设置',exact=True).click();page.locator('#'+trigger).click()
                expect(dialog.get_by_role('checkbox',name='启用 节奏控制')).not_to_be_checked()
            if dialog_id=='memory-direct':
                # Fresh isolated profiles may still be initializing the extension.
                opened=page.evaluate('window.__memoryOpenedMs');assert opened is not None and opened<600,opened
                print('memory-ready-open-ms',width,scheme,opened,flush=True)
                page.locator('#stmb-menu-item').wait_for(state='attached',timeout=30000)
                memory=page.locator('.stmb-popup').filter(has=page.locator('.homer-memory-layout'))
                expect(memory).to_be_visible(timeout=15000)
                expect(memory.get_by_role('button',name='我的记忆 查看与编辑 ›',exact=True)).to_be_visible()
                expect(memory.locator('#stmb-auto-summary-enabled')).to_be_visible()
                expect(memory.get_by_text('选择对话范围',exact=True)).not_to_be_visible()
                memory.get_by_role('button',name='立即总结 选择范围并确认生成 ›',exact=True).click()
                expect(memory.get_by_text('选择对话范围',exact=True)).to_be_visible()
                memory.get_by_role('button',name='自定义',exact=True).click()
                memory.get_by_role('button',name='使用此范围',exact=True).click()
                expect(memory.locator('.homer-memory-selection')).to_contain_text('已选择第 1–3 条消息')
                assert page.evaluate('SillyTavern.getContext().chatMetadata.STMemoryBooks.sceneStart')==0
                assert page.evaluate('SillyTavern.getContext().chatMetadata.STMemoryBooks.sceneEnd')==2
                page.screenshot(path=str(OUT/f'memory-actual-{width}.png'))
                assert contrast(page,'.stmb-popup .popup-controls .menu_button')>=2
                expect(memory.get_by_role('button',name='生成记忆',exact=True)).to_be_visible()
                memory.get_by_role('button',name='保存设置',exact=True).click()
                expect(memory.get_by_text('记忆保存位置',exact=True)).to_be_visible()
                memory.locator('.homer-settings-page__back').click()
                expect(memory.locator('.homer-memory-home')).to_be_visible()
                memory.get_by_role('button',name='高级设置 指令、压缩与追踪 ›',exact=True).click()
                expect(memory.locator('#stmb-manual-mode-enabled')).to_be_visible()
                page.screenshot(path=str(OUT/f'memory-advanced-{width}.png'))
                actions=memory.locator('#stmb-prompt-manager-buttons .menu_button');expect(actions.first).to_be_visible()
                for action in actions.all():
                    box=action.bounding_box();assert box['width']>=250 and box['height']<85,box
                actions.first.scroll_into_view_if_needed()
                page.screenshot(path=str(OUT/f'memory-actions-{width}.png'))
                assert page.evaluate('window.HomerCloseOverlay()')
                expect(memory.locator('.homer-memory-home')).to_be_visible()
            dialog.locator('.homer-settings-page__back').click();expect(dialog).not_to_be_visible()
        page.locator('#options_button').click();expect(page.locator('#homer-attachment-dialog')).to_be_visible()
        page.screenshot(path=str(OUT/f'attachments-{width}.png'));page.keyboard.press('Escape')
        expect(page.locator('#homer-continuation-trigger')).not_to_be_visible()
        expect(page.locator('#chat .mes')).to_have_count(3)
        # Edit cancel must preserve the original content; confirm must persist.
        page.locator('#chat .mes[mesid="1"] .mes_text').click(button='right')
        menu.get_by_role('menuitem',name='改写',exact=True).click()
        editor=page.locator('#chat .mes[mesid="1"] .edit_textarea');expect(editor).to_be_visible()
        editor.fill('取消的编辑不能保存')
        page.locator('#chat .mes[mesid="1"] .mes_edit_cancel').click()
        expect(page.locator('#chat .mes[mesid="1"] .mes_text')).to_contain_text('dynamic-baseline-20260720')
        page.locator('#chat .mes[mesid="1"] .mes_text').click(button='right')
        menu.get_by_role('menuitem',name='改写',exact=True).click()
        editor.fill('确认编辑后的测试消息')
        page.screenshot(path=str(OUT/f'edit-{width}.png'))
        with page.expect_response(lambda response: urlparse(response.url).path=='/api/homer/sync' and '确认编辑后的测试消息' in (response.request.post_data or ''),timeout=10000):
            page.locator('#chat .mes[mesid="1"] .mes_edit_done').click()
        expect(page.locator('#chat .mes[mesid="1"] .mes_text')).to_contain_text('确认编辑后的测试消息')
        assert messages[1]['content']=='确认编辑后的测试消息'
        page.reload(wait_until='networkidle')
        page.locator('html.homer-runtime-ready').wait_for(state='attached',timeout=15000)
        expect(page.locator('#chat .mes[mesid="1"] .mes_text')).to_contain_text('确认编辑后的测试消息')
        page.locator('#chat .mes[mesid="1"] .mes_text').click(button='right')
        menu.get_by_role('menuitem',name='回溯',exact=True).click()
        page.locator('#homer-rollback-dialog').get_by_role('button',name='取消',exact=True).click()
        expect(page.locator('#chat .mes')).to_have_count(3)
        page.locator('#chat .mes[mesid="1"] .mes_text').click(button='right')
        menu.get_by_role('menuitem',name='回溯',exact=True).click()
        page.locator('#homer-rollback-dialog').get_by_role('button',name='确认回溯',exact=True).click()
        expect(page.locator('#chat .mes')).to_have_count(1)
        assert len(messages)==1
        page.locator('#chat .mes[mesid="0"] .mes_text').click(button='right')
        menu.get_by_role('menuitem',name='多选',exact=True).click()
        selection.get_by_role('button',name='全选',exact=True).click()
        selection.get_by_role('button',name='删除',exact=True).click()
        page.locator('#homer-delete-selected-dialog').get_by_role('button',name='确认删除',exact=True).click()
        expect(page.locator('#chat .mes')).to_have_count(0)
        assert not messages
        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
        assert not errors,errors
        assert not failed,failed
        assert not bad_http,bad_http
        return {'viewport':[width,height],'errors':errors,'failed':failed,'http_errors':bad_http,'cancelled_status_probes':len(cancelled_status),'checks':['hold-menu','hide-reload-restore','hidden-excluded-from-real-dryrun-prompt','collapse','multiselect-all','delete-cancel-confirm','edit-cancel-save-reload','rollback-cancel-confirm','model-mod-memory-attachments-dialogs','nested-dialog-back','search-jump-empty','loaded-message-stats','appearance-save-cancel','transparent-header-no-title-no-continuation','memory-real-range-markers','chat-manager-and-memory-contrast-4.5']}
    except Exception as error:
        print('failure-memory-state',page.evaluate("({menu:document.querySelector('#stmb-menu-item')?.outerHTML,popups:[...document.querySelectorAll('dialog')].map(e=>({open:e.open,cls:e.className,text:e.textContent.slice(0,60)}))})"),flush=True)
        page.screenshot(path=str(OUT/f'failure-{width}.png'))
        (OUT/f'failure-{width}.json').write_text(json.dumps({'exception':str(error),'errors':errors,'failed':failed,'http':bad_http,'logs':logs,'body':page.locator('body').inner_text()[:12000]},ensure_ascii=False,indent=2),encoding='utf-8')
        raise
    finally:context.close()

def main():
    global OUT
    parser=argparse.ArgumentParser();parser.add_argument('--visual',action='store_true');parser.add_argument('--dark',action='store_true');args=parser.parse_args()
    if args.dark:OUT=ROOT/'output/ui-r16/dark'
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
        try:results=[run(browser,w,h,args.visual,scheme='dark' if args.dark else 'light') for w,h in ([(393,762)] if args.visual else [(360,780),(1440,900)] if args.dark else [(390,844),(1440,900)])]
        finally:browser.close()
    (OUT/('visual-geometry.json' if args.visual else 'results.json')).write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(results)
if __name__=='__main__':main()
