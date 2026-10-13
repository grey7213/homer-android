"""Full shipping host document; synthetic protocol and data only."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/repair-20261011'
OUT.mkdir(parents=True,exist_ok=True)
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='chrome')
    try:
        for width,height in [(390,844),(1440,900)]:
            context=browser.new_context(viewport={'width':width,'height':height})
            context.add_init_script('''
localStorage.setItem('ai_xingyue_logged_in','1');
localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'qa-owner',name:'QA'}));
localStorage.setItem('homer.dialogue.preview.v2:qa-chat:owner:qa-owner',JSON.stringify({conversation_id:'qa-chat',app_id:'qa-card',title:'QA',messages:[{id:'qa-message',role:'assistant',content:'Complete cached QA body'}]}));
''')
            page=context.new_page(); errors=[];bad=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('response',lambda r:bad.append({'status':r.status,'path':r.url.split('8806')[-1]}) if r.status>=400 else None)
            page.goto('http://127.0.0.1:8806/app/chat.html?app_id=qa-card&conversation_id=qa-chat')
            page.wait_for_function("document.querySelector('#preview-messages')?.innerText.includes('Complete cached QA body')")
            child=page.frame_locator('#dialogue-frame')
            live=page.frames[-1];live.wait_for_function('window.qaFixtureReady')
            live.evaluate('qaBind()');live.wait_for_function('window.qaReceived')
            # Before canonical ready, late states cannot clear the preview.
            live.evaluate('qaPublish({messages:[]})')
            page.wait_for_timeout(100)
            assert 'Complete cached QA body' in page.locator('#preview-messages').inner_text()
            live.evaluate('qaReady()');page.wait_for_function("document.body.classList.contains('is-ready')")
            live.evaluate('qaPublish({messages:[]})');page.wait_for_timeout(150)
            page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            cached=page.evaluate("JSON.parse(localStorage.getItem('homer.dialogue.preview.v2:qa-chat:owner:qa-owner')).messages")
            assert len(cached)==1 and cached[0]['content']=='Complete cached QA body',cached
            live.evaluate('qaPublish()');page.wait_for_timeout(100)
            page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            page.wait_for_function("JSON.parse(localStorage.getItem('homer.dialogue.preview.v2:qa-chat:owner:qa-owner')).messages[0].content==='Recovered complete QA body'")
            live.evaluate("qaPublish({messages:[{id:'rich',display_text:'',content:'<script>synthetic</script>'}]})")
            page.wait_for_timeout(100);page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            assert page.evaluate("JSON.parse(localStorage.getItem('homer.dialogue.preview.v2:qa-chat:owner:qa-owner')).messages[0].content")=='Recovered complete QA body'
            live.evaluate('qaPublish({messages:[],empty_authorized:true})')
            page.wait_for_timeout(100);page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            page.wait_for_function("JSON.parse(localStorage.getItem('homer.dialogue.preview.v2:qa-chat:owner:qa-owner')).messages.length===0")
            assert not errors,errors
            assert not bad,bad
            page.screenshot(path=str(OUT/f'host-snapshot-{width}.png'))
            results.append({'viewport':[width,height],'late_empty_retains_body':True,'recovery_persisted':True,'rich_projection_retains_body':True,'explicit_removal_allowed':True,'script_errors':errors,'http_errors':bad,'scope':'shipping host; synthetic child, not full runtime'})
            context.close()
    finally:browser.close()
(OUT/'host-snapshot-browser.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
