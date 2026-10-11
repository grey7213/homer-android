"""Real bundled Memory Books and Popup; isolated synthetic runtime only.
No credentials, real histories or paid generation requests.
"""
import json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/memory-session-20261010'
results=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,channel='chrome')
    try:
        for width,height in [(390,844),(1440,900)]:
            page=browser.new_page(viewport={'width':width,'height':height})
            errors=[];failures=[];generation=[];offline={'active':False};request_phases={}
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('request',lambda r:request_phases.__setitem__(r,offline['active']))
            page.on('requestfailed',lambda r:failures.append({'url':r.url,'offline':request_phases.get(r,False)}))
            def assets(route):
                path=route.request.url.split('/assets/',1)[1].split('?',1)[0]
                target=(ROOT/'frontend/assets'/path).resolve()
                if target.is_relative_to((ROOT/'frontend/assets').resolve()) and target.is_file():route.fulfill(path=str(target))
                else:route.continue_()
            page.route('**/assets/**',assets)
            # Isolate this extension test from the host's cloud launch controller.
            # The actual host/Android journey is tested separately, unmodified.
            page.route('**/scripts/extensions/homer-bridge/index.js*',lambda route:route.fulfill(body='// Isolated Memory Books test: cloud host not mounted.',content_type='text/javascript'))
            def block_generation(route):
                generation.append(route.request.method);route.abort()
            page.route('**/api/backends/**/generate*',block_generation)
            page.goto('http://127.0.0.1:8802/')
            page.wait_for_load_state('networkidle')
            page.wait_for_function('!!window.SillyTavern?.getContext && !document.querySelector("#loader")')
            page.evaluate('''async()=>{
                document.body.classList.add('homer-runtime');
                document.documentElement.classList.remove('homer-runtime-pending');
                localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'synthetic-memory-owner'}));
                localStorage.setItem('ai_xingyue_logged_in','1');
                // This standalone fixture intentionally does not install the
                // optional upstream Top Info Bar. Use its supported persisted
                // dismissal, not a CSS mask or synthetic click-through.
                const {extension_settings}=await import('/scripts/extensions.js');
                extension_settings.STMemoryBooks ??= {};
                extension_settings.STMemoryBooks.moduleSettings ??= {};
                extension_settings.STMemoryBooks.moduleSettings.dismissMissingTopInfoBarJobsNotice=true;
                (await import('/assets/js/memory-ui.js')).installMemoryUi();
                const css=document.createElement('link');css.rel='stylesheet';css.href='/assets/css/chat-design.css';document.head.append(css);
                if(!window.HomerMemoryBooks)await import('/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js');
            }''')
            page.wait_for_function('!!window.HomerMemoryBooks?.open')
            # Complete the standalone fixture's first-user onboarding through
            # its real Popup API. No Homer account data is present in this server.
            page.evaluate('''async()=>{
              const {Popup}=await import('/scripts/popup.js');
              for(const p of Popup.util.popups.filter(p=>p.dlg.open&&p.content.textContent.includes('欢迎来到惑梦'))){
                const input=p.content.querySelector('input');if(input)input.value='Synthetic';
                await p.completeAffirmative();
              }
              for(const p of Popup.util.popups.filter(p=>p.dlg.open&&p.content.querySelector('#stmb-jobs-dismiss-topinfobar-notice'))){
                p.content.querySelector('#stmb-jobs-dismiss-topinfobar-notice').checked=true;
                await p.completeAffirmative();
              }
            }''')
            def bind(label,count):
                page.evaluate('''async({label,count})=>{
                    const c=window.SillyTavern.getContext();
                    if(!c.characters.length)c.characters.push({name:'Synthetic memory fixture',avatar:'synthetic.png',chat:'Synthetic',data:{name:'Synthetic memory fixture',extensions:{}}});
                    await c.selectCharacterById(0,{skipChatLoad:true,switchMenu:false,persistSelection:false});
                    const active=window.SillyTavern.getContext();
                    active.characters[0].chat='Synthetic-'+label;
                    active.chatMetadata.homer_bridge={app_id:'synthetic-'+label,conversation_id:'synthetic-'+label};
                    // Fixture explicitly selects no extra context; otherwise
                    // the real plugin asks for it in a second unrelated popup.
                    active.chatMetadata.STMemoryBooks={contextSettingKey:'__none__'};
                    active.chat.splice(0,active.chat.length,...Array.from({length:count},(_,i)=>({is_user:i%2===0,is_system:false,mes:'Synthetic '+label+' '+i,name:'Synthetic',extra:{}})));
                    await active.printMessages({scroll:false});
                    const {event_types}=await import('/script.js');
                    await active.eventSource.emit(event_types.CHAT_CHANGED,'Synthetic-'+label);
                }''',{'label':label,'count':count})
            def open_memory():
                # This standalone runtime has no Homer cloud host. Its gate is
                # unrelated to Memory Books; Android below tests the real host.
                page.evaluate("document.documentElement.classList.remove('homer-runtime-pending');document.querySelector('#homer-runtime-gate')?.remove()")
                return page.evaluate('''async()=>{
                    const start=performance.now();void window.HomerMemoryBooks.open();
                    await new Promise((resolve,reject)=>{const deadline=start+3000;const poll=()=>{
                        const dlg=document.querySelector('.stmb-popup[open] .homer-memory-home');
                        if(dlg)requestAnimationFrame(()=>resolve());else if(performance.now()>deadline)reject(Error('Missing actual memory home'));else setTimeout(poll,5);
                    };poll();});
                    const dlg=document.querySelector('.stmb-popup[open]');
                    const reused=window.__memoryDialog===dlg;window.__memoryDialog=dlg;
                    return {ms:performance.now()-start,reused};
                }''')
            def close_memory():
                page.locator('.stmb-popup[open] .homer-settings-page__back').click()
                page.wait_for_selector('.stmb-popup[open]',state='detached')
            bind('A',35)
            timings=[open_memory()]
            # Actual visible UI, no automatic generation or default marker writes.
            assert page.locator('.homer-memory-home').is_visible()
            assert page.evaluate('window.SillyTavern.getContext().chatMetadata.STMemoryBooks.sceneStart == null')
            for _ in range(10):
                close_memory();timings.append(open_memory());assert timings[-1]['reused']
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='立即总结').click()
            page.wait_for_selector('#chat .mes_stmb_start',timeout=10000,state='attached')
            page.get_by_role('button',name='最近 20 条',exact=True).click()
            start=page.evaluate('window.SillyTavern.getContext().chatMetadata.STMemoryBooks.sceneStart')
            end=page.evaluate('window.SillyTavern.getContext().chatMetadata.STMemoryBooks.sceneEnd')
            assert start==15 and end==34,(start,end)
            # Back to home, close, reuse and keep the explicitly selected range.
            page.locator('.stmb-popup[open] .homer-settings-page__back').click()
            close_memory();open_memory()
            assert page.locator('#homer-memory-from').input_value()=='16'
            assert page.locator('#homer-memory-to').input_value()=='35'
            # The plugin's real clear action closes the popup; reopen it without
            # changing that behavior or losing the existing action controls.
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='立即总结').click()
            page.get_by_text('取消范围选择',exact=True).click()
            page.wait_for_selector('.stmb-popup[open]',state='detached')
            open_memory()
            assert page.locator('[data-memory-consolidation]').count()==1
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='立即总结').click()
            page.locator('.stmb-popup[open] .homer-settings-page__back').click()
            assert page.locator('.homer-memory-home').is_visible()
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='总结设置').click()
            assert page.locator('[data-memory-consolidation]').is_visible()
            page.locator('.stmb-popup[open] .homer-settings-page__back').click()
            close_memory()
            # A/B/A uses real context and CHAT_CHANGED; no artificial prewarm wait.
            for label,count in [('B',7),('A',35),('C',100)]:
                bind(label,count);item=open_memory();assert not item['reused'];timings.append(item)
                assert page.locator('#homer-memory-to').get_attribute('max')==str(count)
                page.locator('.homer-memory-home .homer-memory-row').filter(has_text='我的记忆').click()
                assert page.get_by_text('还没有记忆。返回后点“立即总结”',exact=False).is_visible()
                page.locator('.stmb-popup[open] .homer-settings-page__back').click();close_memory()
            # Offline opens stay local, no dependency on the lorebook endpoint.
            offline['active']=True;page.context.set_offline(True);item=open_memory();assert item['reused'];timings.append(item)
            page.screenshot(path=str(OUT/f'memory-home-{width}.png'))
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='总结设置').click()
            assert page.locator('.stmb-popup[open] #stmb-profile-select').is_visible()
            page.locator('.stmb-popup[open] .homer-settings-page__back').click()
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='高级设置').click()
            assert page.locator('.homer-memory-advanced-group').count()>0
            page.locator('.stmb-popup[open] .homer-settings-page__back').click();close_memory()
            bind('Offline-new-scope',12);item=open_memory();assert not item['reused'];timings.append(item)
            assert page.locator('#homer-memory-to').get_attribute('max')=='12'
            close_memory()
            page.wait_for_timeout(150)
            offline['active']=False
            page.context.set_offline(False)
            # Abort never opens later. Retiring an active owner closes its form.
            page.evaluate('''()=>{const c=new AbortController();c.abort();void window.HomerMemoryBooks.open({signal:c.signal});}''')
            page.wait_for_timeout(100);assert page.locator('.stmb-popup[open]').count()==0
            open_memory()
            page.evaluate("localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'different-synthetic-owner'}));document.dispatchEvent(new Event('homer-presentation-invalidated'))")
            page.wait_for_selector('.stmb-popup[open]',state='detached')
            assert not generation,generation
            assert not errors,errors
            # A standalone upstream CHAT_CHANGED probes sprites, avatars and
            # token counts even offline. Record those deliberate fixture errors;
            # do not excuse any Memory Books request or online request failure.
            expected_paths=['/api/sprites/get','/api/avatars/get','/api/tokenizers/openai/count']
            unexpected=[f for f in failures if not f['offline'] or not any(f['url'].split('?',1)[0].endswith(p) for p in expected_paths)]
            assert not unexpected,unexpected
            results.append({'viewport':[width,height],'timings':timings,'generation_requests':len(generation),'script_errors':errors,'unexpected_request_failures':unexpected,'expected_offline_fixture_failures':failures})
            page.close()
    except Exception:
        if not page.is_closed():
            page.screenshot(path=str(OUT/'browser-failure.png'))
            print(json.dumps({'fixture_open_dialogs':page.locator('dialog[open]').all_text_contents(),'script_errors':errors},ensure_ascii=False))
        raise
    finally:browser.close()
OUT.mkdir(exist_ok=True)
(OUT/'browser-checks.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(results,ensure_ascii=False))
