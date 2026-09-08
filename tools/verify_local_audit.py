"""Offline regression for account caches, stream framing and chat races.

Serves real frontend files and mocks only business APIs/runtime messages.
No credentials, production requests, or user database are used.
"""
from __future__ import annotations

import functools
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output' / 'local-audit-20260905' / 'browser'
CHANNEL = 'homer:dialogue-host:v1'
USER = {'id': 'audit-user', 'name': '本地测试用户'}
HISTORY = [{'id': cid, 'app_id': 'card-' + cid, 'app_name': '角色' + cid,
            'last_message': '缓存' + cid} for cid in ['a', 'b']]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def emit(page, kind, **data):
    frame = page.frame_locator('#dialogue-frame').locator('body')
    frame.evaluate('(el, data) => parent.postMessage(data, location.origin)',
                   {'channel': CHANNEL, 'version': 1, 'type': kind, **data})


def inspect(browser, base, width, height):
    context = browser.new_context(viewport={'width': width, 'height': height})
    context.add_init_script("""(() => {
      localStorage.setItem('ai_xingyue_logged_in', '1');
      localStorage.setItem('ai_xingyue_user', JSON.stringify({id:'audit-user',name:'本地测试用户'}));
      localStorage.setItem('homer.dialogue.preview.v2:a:owner:audit-user', JSON.stringify({
        conversation_id:'a',app_id:'card-a',title:'角色a',messages:[{role:'assistant',content:'缓存a'}]}));
      localStorage.setItem('homer.dialogue.history.v2:owner:audit-user', JSON.stringify([
        {id:'a',app_id:'card-a',app_name:'角色a'}, {id:'b',app_id:'card-b',app_name:'角色b'}]));
      localStorage.setItem('homer.page-cache.v1.histories.audit-user', JSON.stringify({savedAt:Date.now(),value:{list:[
        {id:'a',app_id:'card-a',app_name:'角色a'}, {id:'b',app_id:'card-b',app_name:'角色b'}]}}));
      window.nativeCalls=[];
      window.HomerNative={
        setAccountScope(owner){ if(this!==window.HomerNative) throw Error('receiver'); window.nativeCalls.push(['scope',owner]); },
        readConversationSnapshot(id){ if(this!==window.HomerNative) throw Error('receiver');window.nativeCalls.push(['read',id]);return '{}'; },
        readConversationHistory(){ return '[]'; },
        saveConversationSnapshot(s){ if(this!==window.HomerNative) throw Error('receiver');window.nativeCalls.push(['save',JSON.parse(s).conversation_id]); },
        notifyShellReady(){ if(this!==window.HomerNative) throw Error('receiver');window.nativeCalls.push(['shell']); }
      };
    })();""")
    page = context.new_page()
    errors, failed, held, calls = [], [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('requestfailed', lambda r: failed.append(r.url))

    def route(r):
        path = urlparse(r.request.url).path
        if urlparse(r.request.url).netloc != urlparse(base).netloc:
            r.fulfill(status=204)
        elif path.startswith('/module/dialogue/'):
            calls.append(path)
            r.fulfill(content_type='text/html', body='<!doctype html><body><script>window.commands=[];addEventListener("message",e=>commands.push(e.data));</script></body>')
        elif path.endswith('/chat/stream'):
            r.fulfill(content_type='text/event-stream', body='event: delta\r\ndata: {"content":"你好"}\r\n\r\nevent: message_end\r\ndata: {"reply":"你好"}\r\n\r\n')
        elif path.endswith('/conversations/a/messages'):
            held.append(r)
        elif path.endswith('/conversations/b/messages'):
            r.fulfill(json={'data': {'conversation': {'id': 'b', 'app_id': 'card-b'}, 'messages': []}})
        elif path == '/console/api/web/conversations':
            r.fulfill(json={'data': {'list': HISTORY}})
        elif path == '/console/api/account/profile':
            r.fulfill(json=USER)
        elif path.startswith(('/console/', '/go/', '/admin/api/')):
            r.fulfill(json={'data': {}, 'points': 100})
        else:
            r.continue_()
    page.route('**/*', route)
    started = time.perf_counter()
    page.goto(base + '/app/chat.html?app_id=card-a&conversation_id=a', wait_until='domcontentloaded')
    page.wait_for_selector('#preview-messages .preview-message')
    first_ms = round((time.perf_counter() - started) * 1000)
    assert page.locator('#preview-messages').inner_text() == '缓存a'
    assert page.evaluate("nativeCalls.some(x=>x[0]==='read') && nativeCalls.some(x=>x[0]==='shell')")
    page.locator('#preview-settings').click()
    page.locator('#preview-model-settings').click()
    assert page.locator('#preview-model-dialog').evaluate('(el)=>el.open')
    page.locator('#preview-model-close').click()

    # The ready signal must invalidate an older network preview.
    emit(page, 'state', state={'conversation_id':'a','app_id':'card-a','title':'角色a',
                              'messages':[{'role':'assistant','content':'新消息a'}]})
    emit(page, 'ready', app_id='card-a', conversation_id='a')
    page.wait_for_function("document.body.classList.contains('is-ready')")
    for r in held:
        r.fulfill(json={'data': {'conversation': {'id':'a','app_id':'card-a'},
                                 'messages':[{'role':'assistant','content':'过时消息a'}]}})
    held.clear()
    page.wait_for_load_state('networkidle')
    assert '过时消息' not in page.evaluate("localStorage.getItem('homer.dialogue.preview.v2:a:owner:audit-user')")

    # Switching to an uncached chat clears the previous content immediately.
    assert page.evaluate("""() => !dispatchEvent(new CustomEvent('homer:navigate-conversation',
      {cancelable:true,detail:{url:location.origin+'/app/chat.html?app_id=card-b&conversation_id=b'}}))""")
    page.wait_for_function("location.search.includes('conversation_id=b') && document.body.classList.contains('has-preview')")
    assert '新消息a' not in page.locator('#preview-messages').inner_text()
    emit(page, 'state', state={'conversation_id':'a','messages':[{'content':'串会话'}]})
    emit(page, 'ready', app_id='card-a', conversation_id='a')
    page.wait_for_load_state('networkidle')
    assert 'conversation_id=b' in page.url
    page.locator('#preview-input').wait_for(state='visible')
    page.locator('#preview-input').fill('未发送的草稿')
    emit(page, 'conversation-switching', app_id='card-b', conversation_id='b')
    page.wait_for_timeout(50)
    assert page.locator('#preview-input').input_value() == '未发送的草稿'
    page.locator('#preview-input').fill('发给b')
    page.locator('#preview-send').click()
    emit(page, 'ready', app_id='card-b', conversation_id='b')
    page.wait_for_function("document.body.classList.contains('is-ready')")
    commands = page.frame_locator('#dialogue-frame').locator('body').evaluate('()=>window.commands')
    assert len([c for c in commands if c['type']=='draft' and c['content']=='发给b']) == 1
    assert len([c for c in commands if c['type']=='switch-conversation']) == 1
    assert len(calls) == 1, 'A warm history switch must not reload the dialogue runtime'

    # A rejected send restores the text and re-enables the composer.
    emit(page, 'conversation-switch-failed', app_id='card-b', conversation_id='b')
    emit(page, 'conversation-switching', app_id='card-b', conversation_id='b')
    page.locator('#preview-input').fill('失败保留')
    page.locator('#preview-send').click()
    emit(page, 'command-error', message='本地测试失败')
    page.wait_for_function("document.querySelector('#preview-input').value === '失败保留'")
    assert page.locator('#preview-send').is_enabled()
    emit(page, 'state', state={'conversation_id':'b','app_id':'card-b',
                              'messages':[{'role':'user','content':'<tag>原始输入</tag>'}]})
    page.wait_for_function("document.querySelector('#preview-messages').textContent.includes('<tag>原始输入</tag>')")
    # CRLF framing must deliver both delta and terminal event.
    stream = page.evaluate("""async () => {
      const {api} = await import('/app/assets/js/app-core.js?v=20260905-notices-v1');
      const chunks=[]; const result=await api.sendChatStream({}, {onDelta:s=>chunks.push(s)});
      return {chunks,result};
    }""")
    assert stream == {'chunks':['你好'], 'result':{'reply':'你好'}}
    stream_edges = page.evaluate("""async () => {
      const {api} = await import('/app/assets/js/app-core.js?v=20260905-notices-v1');
      const original = window.fetch;
      let cancelled = false;
      const bytes = new TextEncoder().encode('event: delta\\r\\ndata: {"content":"你好"}\\r\\n\\r\\nevent: message_end\\r\\ndata: {"reply":"你好"}\\r\\n\\r\\n');
      try {
        window.fetch = async () => new Response(new ReadableStream({start(c) {
          for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close();
        }}));
        const chunks=[];
        const result=await api.sendChatStream({}, {onDelta:s=>chunks.push(s)});
        window.fetch = async () => new Response(new ReadableStream({
          start(c) {c.enqueue(bytes);}, cancel() {cancelled=true;}
        }));
        let rejected=false;
        try {await api.sendChatStream({}, {onDelta:()=>{throw Error('handler failed');}});}
        catch(e) {rejected=e.message==='handler failed';}
        return {chunks,result,cancelled,rejected};
      } finally {window.fetch=original;}
    }""")
    assert stream_edges == {'chunks':['你好'], 'result':{'reply':'你好'}, 'cancelled':True, 'rejected':True}
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
    page.screenshot(path=str(OUT / f'chat-{width}.png'), full_page=True)

    # Sign-out removes unscoped and per-account browser caches and calls native.
    auth = page.evaluate("""async () => {
      const auth = await import('/assets/js/api.js?v=20260905-notices-v1');
      auth.clearAuth();
      return {remaining:Object.keys(localStorage).filter(k=>k.startsWith('homer.dialogue.')),
        logged:auth.isLoggedIn(), last:nativeCalls.at(-1)};
    }""")
    assert auth == {'remaining':[], 'logged':False, 'last':['scope','']}
    page.goto(base + '/app/histories.html', wait_until='networkidle')
    assert page.locator('.history-row').count() == 2
    page.evaluate("""() => {const a=document.createElement('a');a.id='audit-new-card';
      a.href='/app/chat.html?app_id=new-card';a.textContent='test';document.body.prepend(a);}""")
    page.locator('#audit-new-card').hover()
    assert page.locator('link[rel="prefetch"][href*="app_id=new-card"]').count() == 0
    page.locator('#audit-new-card').evaluate('(el)=>el.remove()')
    assert page.locator('iframe').count() == 0
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
    page.screenshot(path=str(OUT / f'histories-{width}.png'), full_page=True)
    assert not errors, errors
    assert not failed, failed
    context.close()
    return {'viewport':[width,height], 'cache_first_ms':first_ms, 'assertions':'passed',
            'console_page_errors':errors, 'failed_requests':failed}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT/'frontend'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            try:
                results=[inspect(browser, f'http://127.0.0.1:{server.server_port}', w,h)
                         for w,h in [(1440,900),(390,844)]]
            finally:
                browser.close()
        (OUT/'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(results, ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
