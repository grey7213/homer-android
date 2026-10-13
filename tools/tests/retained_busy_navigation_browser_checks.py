"""Shipping chat document/dialogs; synthetic child transport, no real account/provider."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/repair-20261011'
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    try:
        for width, height in [(390, 844), (1440, 900)]:
            context = browser.new_context(viewport={'width': width, 'height': height})
            context.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'qa-owner',name:'QA'}));")
            page = context.new_page(); errors = []; bad = []; failures = []; creates = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('response', lambda r: bad.append(r.url) if r.status >= 400 else None)
            page.on('requestfailed', lambda r: failures.append(r.url))
            def launch(route):
                creates.append(route.request.url)
                route.fulfill(json={'data': {'launch': {'app_id': 'qa-new', 'conversation_id': 'qa-new-chat'}, 'character': {'name': 'Synthetic new card'}}})
            page.route('**/console/api/web/dialogue/session**', launch)
            page.goto('http://127.0.0.1:8806/app/chat.html?app_id=qa-card&conversation_id=qa-chat')
            live = page.frames[-1]; live.wait_for_function('window.qaFixtureReady')
            live.evaluate('qaBind()'); live.wait_for_function('window.qaReceived')
            live.evaluate('qaReady()'); page.wait_for_function("document.body.classList.contains('is-ready')")
            live.evaluate("""window.qaNavigationCommands=[];addEventListener('message',e=>{
                if(e.origin!==location.origin||e.source!==parent)return;
                if(['stop','switch-conversation'].includes(e.data?.type))qaNavigationCommands.push(e.data.type);
                if(e.data?.type==='stop')qaPublish({generating:false});
            });qaPublish({generating:true});""")
            def navigate(app='qa-other', conversation='qa-other-chat'):
                return page.evaluate("""([app,conversation])=>{const u=new URL('/app/chat.html',location.href);u.searchParams.set('app_id',app);if(conversation)u.searchParams.set('conversation_id',conversation);const e=new CustomEvent('homer:navigate-conversation',{cancelable:true,detail:{url:u.href}});window.dispatchEvent(e);return e.defaultPrevented;}""", [app, conversation])
            assert navigate()
            dialog = page.get_by_role('dialog', name='切换会话'); dialog.wait_for(state='visible')
            page.screenshot(path=str(OUT / f'busy-switch-dialog-{width}.png'))
            page.get_by_role('button', name='留在当前会话').click()
            dialog.wait_for(state='hidden')
            assert live.evaluate('qaNavigationCommands.length') == 0
            assert 'conversation_id=qa-chat' in page.url
            assert navigate()
            page.get_by_role('button', name='停止并切换').click()
            live.wait_for_function("qaNavigationCommands.includes('switch-conversation')")
            assert live.evaluate('qaNavigationCommands') == ['stop', 'switch-conversation']
            assert 'conversation_id=qa-other-chat' in page.url
            live.evaluate('qaReady();qaPublish()')
            page.wait_for_function("document.body.classList.contains('is-ready')")
            assert navigate('qa-new', '')
            page.wait_for_function("new URL(location.href).searchParams.get('conversation_id')==='qa-new-chat'")
            assert len(creates) == 1
            assert live.evaluate("qaNavigationCommands.filter(v=>v==='switch-conversation').length") == 2
            assert not errors, errors
            assert not bad, bad
            assert not failures, failures
            results.append({'viewport': [width, height], 'cancel_keeps_current': True, 'stop_then_exact_switch': True,
                            'new_card_single_create': True, 'errors': errors, 'http_errors': bad, 'network_failures': failures,
                            'scope': 'shipping host and real dialog; synthetic child/provider, not Android full host'})
            context.close()
    finally:
        browser.close()
(OUT / 'retained-busy-navigation-browser.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(results, ensure_ascii=False))
