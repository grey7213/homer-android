"""Complete deletion journey through shipping histories UI and real IndexedDB."""
import json, time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/history-delete-20261010'
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='chrome')
    try:
        for width,height in [(390,844),(1440,900)]:
            context=browser.new_context(viewport={'width':width,'height':height})
            context.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'qa-delete-owner',name:'删除验收'}));")
            page=context.new_page();errors=[];unexpected=[]
            page.on('pageerror', lambda e:errors.append(str(e)))
            page.on('response', lambda r:unexpected.append(r.status) if r.status>=400 else None)
            page.goto('http://127.0.0.1:8804/app/histories.html');page.wait_for_load_state('networkidle')
            page.wait_for_selector('.history-row');assert page.locator('.history-row').count()==8
            # Prepare genuine large canonical bytes before deleting through UI.
            page.evaluate('''async()=>{
              const {createChatOutbox}=await import('/scripts/homer-chat-outbox.mjs');
              const {createLocalSessionStore}=await import('/scripts/homer-local-session.mjs');
              const outbox=createChatOutbox(), sessions=createLocalSessionStore();
              const messages=Array.from({length:1200},()=>({content:'完整隔离消息'.repeat(50)}));
              for(const conv of ['qa-0','qa-1']){
                const scope=JSON.stringify(['qa-delete-owner','qa-card',conv]);
                await outbox.prepare({scope,body:JSON.stringify({app_id:'qa-card',conversation_id:conv,messages})});
                await sessions.remember('qa-delete-owner',{user:{id:'qa-delete-owner'},launch:{app_id:'qa-card',conversation_id:conv,card:{name:'QA'},messages,storage:{protocol:2,complete:true,version:'a'.repeat(32),message_count:messages.length}}});
              }
            }''')
            page.get_by_role('button',name='管理',exact=True).click()
            page.get_by_role('checkbox',name='选择会话：验收会话 0',exact=True).check()
            page.get_by_role('checkbox',name='选择会话：验收会话 1',exact=True).check()
            page.screenshot(path=str(OUT/f'batch-{width}.png'),full_page=True)
            page.get_by_role('button',name='删除所选',exact=True).click()
            page.get_by_role('button',name='取消',exact=True).click()
            assert page.locator('.history-row').count()==8
            page.get_by_role('button',name='删除所选',exact=True).click()
            start=time.perf_counter();page.get_by_role('button',name='删除 2 段',exact=True).click()
            page.wait_for_function("document.querySelectorAll('.history-row').length===6")
            elapsed=round((time.perf_counter()-start)*1000)
            assert elapsed<2000,elapsed
            assert page.locator('.history-sync-status').is_visible()
            page.evaluate("window.dispatchEvent(new Event('homer:page-visible'))")
            page.wait_for_timeout(400);assert page.locator('.history-row').count()==6
            # Same-origin second document must observe canonical deletion, not
            # resurrect bytes via a retained session read or late cloud ACK.
            state=page.evaluate('''async()=>{
              const {createChatOutbox}=await import('/scripts/homer-chat-outbox.mjs');
              const {createLocalSessionStore}=await import('/scripts/homer-local-session.mjs');
              const outbox=createChatOutbox(),sessions=createLocalSessionStore();
              return {markers:(await outbox.deletions('qa-delete-owner')).length,pending:(await outbox.pending('qa-delete-owner')).length,sessions:(await sessions.list('qa-delete-owner')).length};
            }''')
            assert state=={'markers':2,'pending':0,'sessions':0},state
            page.reload();page.wait_for_load_state('networkidle');assert page.locator('.history-row').count()==6
            page.wait_for_timeout(8500)
            assert page.locator('.history-row').count()==6
            assert '待同步' in page.locator('.history-sync-status').inner_text()
            assert not page.locator('.homer-action-dialog').count()
            # Offline deletion runs after document assets loaded, just like the
            # bundled mobile page. Persistent marker survives a later online reload.
            context.set_offline(True)
            page.get_by_role('button',name='管理',exact=True).click()
            page.locator('input[type=checkbox]').first.check()
            page.get_by_role('button',name='删除所选',exact=True).click()
            page.get_by_role('button',name='删除 1 段',exact=True).click()
            page.wait_for_function("document.querySelectorAll('.history-row').length===5")
            context.set_offline(False)
            page.reload();page.wait_for_load_state('networkidle');assert page.locator('.history-row').count()==5
            # Search select-all targets only visible results, never all histories.
            page.locator('input[type=search]').fill('会话 7')
            page.get_by_role('button',name='管理',exact=True).click()
            page.get_by_role('button',name='全选当前列表',exact=True).click()
            assert page.get_by_role('checkbox',checked=True).count()==1
            page.get_by_role('button',name='删除所选',exact=True).click()
            page.get_by_role('button',name='删除 1 段',exact=True).click()
            page.locator('input[type=search]').fill('')
            page.wait_for_function("document.querySelectorAll('.history-row').length===4")
            assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
            assert not errors,errors
            # An absent favicon is not product functional failure; any other
            # non-2xx response from this fixture is unexpected.
            assert not unexpected,unexpected
            page.screenshot(path=str(OUT/f'deleted-{width}.png'),full_page=True)
            results.append({'viewport':[width,height],'confirmed_delete_to_removed_ms':elapsed,'cancel':True,'stale_list':True,'restart':True,'offline':True,'timeout_pending':True,'filtered_selection':True,'canonical_cleanup':state,'script_errors':errors,'http_errors':unexpected})
            context.close()
    finally:browser.close()
(OUT/'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False,indent=2))
