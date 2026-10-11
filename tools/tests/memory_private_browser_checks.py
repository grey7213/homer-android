"""Actual Memory Books bundle/Popup, synthetic provider, actual local durability.

Run memory_private_runtime_server.py first. No account data or paid model calls.
Provider transport is the ONLY substituted operation in the tested user journey.
"""
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/memory-private-20261011'
OUT.mkdir(parents=True, exist_ok=True)
results = []

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, channel='chrome')
    try:
        for width, height in [(390, 844), (1440, 900)]:
            context = browser.new_context(viewport={'width': width, 'height': height})
            page = context.new_page()
            errors, failures, generated, console_errors, http_errors = [], [], [], [], []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: console_errors.append(m.text) if m.type=='error' else None)
            page.on('requestfailed', lambda r: failures.append(r.url))
            page.on('response', lambda r: http_errors.append({'url':r.url,'status':r.status}) if r.status>=400 else None)

            def assets(route):
                path = route.request.url.split('/assets/', 1)[1].split('?', 1)[0]
                target = (ROOT / 'frontend/assets' / path).resolve()
                if target.is_relative_to((ROOT / 'frontend/assets').resolve()) and target.is_file():
                    route.fulfill(path=str(target))
                else:
                    route.continue_()
            page.route('**/assets/**', assets)
            # The product routes this public alias to the same shipped extension.
            def memory_alias(route):
                path=route.request.url.split('/dialogue-memory-books/',1)[1].split('?',1)[0]
                target=(ROOT/'sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks'/path).resolve()
                if path=='index.build.js':
                    # Both public paths resolve one real module, never two
                    # independently initialized copies of the same extension.
                    route.fulfill(body="import '/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js';",content_type='text/javascript')
                elif target.is_file():route.fulfill(path=str(target))
                else:route.continue_()
            page.route('**/scripts/extensions/third-party/dialogue-memory-books/**',memory_alias)
            page.route('**/scripts/extensions/homer-bridge/index.js*', lambda r: r.fulfill(
                body='// Isolated test: cloud launch host not mounted.', content_type='text/javascript'))

            def provider(route):
                body = route.request.post_data_json
                generated.append(body)
                memory = {'title': 'Village promise', 'content': 'Synthetic A remembers the village promise.', 'keywords': ['village']}
                route.fulfill(json={'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': json.dumps(memory)}, 'finish_reason': 'stop'}]})
            page.route('**/api/backends/**/generate*', provider)
            page.goto('http://127.0.0.1:8802/')
            page.wait_for_load_state('networkidle')
            page.wait_for_function('!!window.SillyTavern?.getContext && !document.querySelector("#loader")')
            setup='''async()=>{
                document.body.classList.add('homer-runtime');
                document.documentElement.classList.remove('homer-runtime-pending');
                localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'synthetic-memory-owner'}));
                localStorage.setItem('ai_xingyue_logged_in','1');
                const data={name:'Synthetic memory fixture',first_mes:'Synthetic opening',description:'Synthetic character',personality:'',scenario:'',mes_example:'',system_prompt:'',post_history_instructions:'',creator_notes:'',extensions:{homer_bridge:{app_id:'synthetic-A'}}};
                const card={spec:'chara_card_v2',spec_version:'2.0',data};
                const fd=new FormData();fd.set('avatar',new File([JSON.stringify(card)],'synthetic.json',{type:'application/json'}));
                fd.set('file_type','json');fd.set('preserved_name','synthetic');
                const imported=await fetch('/api/characters/import',{method:'POST',body:fd});
                if(!imported.ok)throw Error('Synthetic card fixture import failed');
                const importedCard=await imported.json();window.__syntheticAvatar=importedCard.file_name.endsWith('.png')?importedCard.file_name:importedCard.file_name+'.png';
                const {getCharacters}=await import('/script.js');await getCharacters();
                const {installLocalRuntime}=await import('/scripts/homer-local-runtime.mjs');
                window.__localMemoryRuntime=installLocalRuntime({isEmbedded:true,owner:()=>JSON.parse(localStorage.getItem('ai_xingyue_user')||'null')?.id||''});
                await window.__localMemoryRuntime.seedCharacter(window.__syntheticAvatar,card);
                const {extension_settings}=await import('/scripts/extensions.js');
                extension_settings.STMemoryBooks??={};
                extension_settings.STMemoryBooks.moduleSettings??={};
                Object.assign(extension_settings.STMemoryBooks.moduleSettings,{
                    dismissMissingTopInfoBarJobsNotice:true,showMemoryPreviews:true,
                    alwaysUseDefault:true,autoHideMode:'none',refreshEditor:false
                });
                const {oai_settings}=await import('/scripts/openai.js');
                oai_settings.chat_completion_source='openai';oai_settings.openai_model='synthetic-model';
                (await import('/assets/js/memory-ui.js')).installMemoryUi();
                const css=document.createElement('link');css.rel='stylesheet';css.href='/assets/css/chat-design.css';document.head.append(css);
                if(!window.HomerMemoryBooks)await import('/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js');
            }'''
            page.evaluate(setup)
            page.wait_for_function('!!window.HomerMemoryBooks?.open')
            page.evaluate('''async()=>{
                const {Popup}=await import('/scripts/popup.js');
                for(const p of Popup.util.popups.filter(p=>p.dlg.open&&p.content.textContent.includes('欢迎来到惑梦'))){
                    const input=p.content.querySelector('input');if(input)input.value='Synthetic';await p.completeAffirmative();
                }
            }''')

            def bind(label, count=35):
                page.evaluate('''async({label,count})=>{
                    const c=window.SillyTavern.getContext();
                    const characterIndex=c.characters.findIndex(e=>e.avatar===window.__syntheticAvatar);
                    if(characterIndex<0)throw Error('Actual synthetic character missing');
                    const {saveWorldInfo}=await import('/scripts/world-info.js');
                    await saveWorldInfo('synthetic-author-world',{entries:{}},true);
                    await c.selectCharacterById(characterIndex,{skipChatLoad:true,switchMenu:false,persistSelection:false});
                    const active=window.SillyTavern.getContext();
                    const character=active.characters.find(e=>e.avatar===window.__syntheticAvatar);
                    if(!character)throw Error('Synthetic vanished after selection: '+JSON.stringify({avatar:window.__syntheticAvatar,characters:active.characters.map(e=>({name:e.name,avatar:e.avatar}))}));
                    character.chat='Synthetic-'+label;
                    active.chatMetadata.homer_bridge={app_id:'synthetic-'+label,conversation_id:'synthetic-'+label};
                    const headerResponse=await fetch('/api/chats/get',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatar_url:window.__syntheticAvatar,file_name:'Synthetic-'+label,metadata_only:true})});
                    if(!headerResponse.ok)throw Error('Synthetic chat fixture header failed');
                    const header=await headerResponse.json();
                    active.chatMetadata.integrity=header.chat_metadata.integrity;
                    active.chatMetadata.STMemoryBooks={contextSettingKey:'__none__'};
                    active.chatMetadata.world_info='synthetic-author-world';
                    active.chat.splice(0,active.chat.length,...Array.from({length:count},(_,i)=>({is_user:i%2===0,is_system:false,mes:'Synthetic '+label+' village '+i,name:'Synthetic',extra:{}})));
                    await active.printMessages({scroll:false});
                    const {event_types}=await import('/script.js');
                    await active.eventSource.emit(event_types.CHAT_CHANGED,'Synthetic-'+label);
                    // The real parent host dispatches this when switching owner/presentation.
                    document.dispatchEvent(new Event('homer-presentation-invalidated'));
                }''', {'label': label, 'count': count})

            def open_memory():
                page.evaluate("document.documentElement.classList.remove('homer-runtime-pending');document.querySelector('#homer-runtime-gate')?.remove()")
                return page.evaluate('''async()=>{
                    const start=performance.now();void window.HomerMemoryBooks.open();
                    await new Promise((resolve,reject)=>{const poll=()=>{
                        if(document.querySelector('.stmb-popup[open] .homer-memory-home'))requestAnimationFrame(resolve);
                        else if(performance.now()-start>3000)reject(Error('Actual memory home missing'));else setTimeout(poll,5);
                    };poll();});return performance.now()-start;
                }''')
            def close_memory():
                page.locator('.stmb-popup[open] .homer-settings-page__back').click()
                page.wait_for_selector('.stmb-popup[open]', state='detached')
            def memory_list():
                return page.evaluate('window.HomerMemoryBooks.memories.list()')
            def injection():
                return page.evaluate('''async()=>{
                    const {getSortedEntries,getWorldInfoPrompt}=await import('/scripts/world-info.js');
                    const entries=await getSortedEntries();
                    const prompt=await getWorldInfoPrompt(['Synthetic village promise'],4096,false,{});
                    return {entries:entries.filter(e=>e.stmemorybooks),prompt:JSON.stringify(prompt)};
                }''')

            bind('A')
            first_ms = open_memory()
            assert not generated
            assert not memory_list()['items']
            assert page.evaluate('window.SillyTavern.getContext().chatMetadata.STMemoryBooks.sceneStart==null')
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='立即总结').click()
            # Remove only message DOM rows to prove the actual context array,
            # not the invisible #chat marker buttons, drives range selection.
            page.evaluate("document.querySelectorAll('#chat .mes_stmb_start,#chat .mes_stmb_end').forEach(e=>e.remove())")
            page.get_by_role('button', name='最近 20 条', exact=True).click()
            selected = page.evaluate('''()=>{const s=window.SillyTavern.getContext().chatMetadata.STMemoryBooks;return [s.sceneStart,s.sceneEnd]}''')
            assert selected == [15, 34], selected
            assert not generated
            # Reopen before generation; selected markers must survive even when
            # their hidden DOM controls do not exist.
            page.locator('.stmb-popup[open] .homer-settings-page__back').click()
            close_memory();open_memory()
            assert page.locator('#homer-memory-from').input_value()=='16'
            assert page.locator('#homer-memory-to').input_value()=='35'
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='立即总结').click()
            page.locator('.stmb-popup[open] [data-memory-generate]').click()
            page.wait_for_selector('#stmb-preview-content', timeout=20000)
            assert len(generated) == 1, generated
            assert 'Synthetic A village 15' in json.dumps(generated[0])
            assert 'Synthetic A village 34' in json.dumps(generated[0])
            assert 'Synthetic A village 14' not in json.dumps(generated[0])
            assert not memory_list()['items'], 'Preview must not save automatically'
            page.locator('#stmb-preview-content').fill('Saved synthetic village promise.')
            page.locator('#stmb-preview-title').fill('Saved village promise')
            page.screenshot(path=str(OUT / f'preview-{width}.png'))
            page.locator('.stmb-popup[open] .popup-button-ok').click()
            page.wait_for_selector('#stmb-preview-content',state='detached')
            deadline=time.monotonic()+10
            stored=memory_list()
            while not stored['items'] and time.monotonic()<deadline:
                page.wait_for_timeout(30)
                stored=memory_list()
            assert len(stored['items'])==1, stored
            assert stored['items'][0]['content'] == 'Saved synthetic village promise.', stored
            assert page.evaluate('window.SillyTavern.getContext().chatMetadata.world_info') == 'synthetic-author-world'
            assert not page.locator('dialog[open]').filter(has_text='Memory Lorebook Missing').count()
            prompt = injection()
            assert 'Saved synthetic village promise.' in prompt['prompt'], prompt

            reopen_ms = open_memory()
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='我的记忆').click()
            page.locator('.homer-memory-record').click()
            page.get_by_role('textbox', name='记忆内容', exact=True).fill('Edited synthetic village promise.')
            page.get_by_role('button', name='保存记忆', exact=True).click()
            page.wait_for_selector('.homer-memory-record')
            assert 'Edited synthetic village promise.' in injection()['prompt']
            page.locator('.homer-memory-record').click()
            page.get_by_role('checkbox', name='在后续对话中使用', exact=True).uncheck()
            page.get_by_role('button', name='保存记忆', exact=True).click()
            page.wait_for_selector('.homer-memory-record')
            assert 'Edited synthetic village promise.' not in injection()['prompt'], 'Disabled memory injected'
            page.locator('.homer-memory-record').click()
            page.get_by_role('checkbox', name='在后续对话中使用', exact=True).check()
            page.get_by_role('button', name='保存记忆', exact=True).click()
            page.wait_for_selector('.homer-memory-record')
            page.locator('.stmb-popup[open] .homer-settings-page__back').click()
            close_memory()
            bind('B', 7)
            assert not memory_list()['items']
            assert 'Edited synthetic village promise.' not in injection()['prompt']
            bind('A')
            assert memory_list()['items'][0]['content'] == 'Edited synthetic village promise.'
            assert 'Edited synthetic village promise.' in injection()['prompt']
            open_memory()
            page.locator('.homer-memory-home .homer-memory-row').filter(has_text='我的记忆').click()
            page.screenshot(path=str(OUT / f'records-{width}.png'))
            page.locator('.stmb-popup[open] .homer-settings-page__back').click()
            close_memory()
            assert len(generated) == 1, 'Passive reopening or switching generated content'
            # Real document/module cold reopen, same device IDB. No memory data
            # is seeded or re-created here; summary and edits must be durable.
            page.reload();page.wait_for_load_state('networkidle')
            page.wait_for_function('!!window.SillyTavern?.getContext && !document.querySelector("#loader")')
            page.evaluate(setup);bind('A')
            assert memory_list()['items'][0]['content']=='Edited synthetic village promise.'
            assert 'Edited synthetic village promise.' in injection()['prompt']
            cold_reopen_ms=open_memory()
            close_memory()
            assert len(generated)==1,'Cold reopening generated content'
            assert not errors, errors
            assert not failures, failures
            assert not http_errors,http_errors
            assert not console_errors,console_errors
            results.append({'viewport': [width, height], 'first_open_ms': first_ms, 'reopen_ms': reopen_ms,
                            'range': selected, 'provider_stub_requests': len(generated), 'saved_entries': len(stored['items']),
                            'preview_no_autosave': True, 'edit_toggle_real_injection': True, 'ABA_isolation': True,
                            'document_cold_reopen_durable':True,'cold_memory_open_ms':cold_reopen_ms,
                            'script_errors': errors, 'request_failures': failures,'http_errors':http_errors,'console_errors':console_errors})
            context.close()
    except Exception:
        if not page.is_closed():
            page.screenshot(path=str(OUT / 'browser-failure.png'))
            print(json.dumps({'dialogs': page.locator('dialog[open]').all_text_contents(), 'errors': errors,
                              'requests': generated, 'failures': failures, 'console': console_errors, 'http':http_errors,
                              'toasts': page.locator('#toast-container').all_text_contents(),
                              'memory_scope': page.evaluate('window.SillyTavern.getContext().chatMetadata')}, ensure_ascii=False))
        raise
    finally:
        browser.close()
(OUT / 'browser-checks.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(results, ensure_ascii=False))
