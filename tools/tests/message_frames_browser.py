"""Real iframe documents and shipping gesture adapter; isolated synthetic data.

Not a native Android test or an actual provider/card compatibility claim.
"""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/mod-return-r368'
OUT.mkdir(parents=True, exist_ok=True)
PAGE = '''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#202124;color:white;font-family:system-ui}#chat{padding:12px}.mes{margin:8px 0}
iframe{width:100%;height:350px;border:0}dialog{background:#292a2f;color:#eee;border:0;border-radius:20px;padding:20px}
button{min-width:44px;min-height:44px}#dialog button{display:block;width:100%}</style>
<main id=chat><article class=mes data-id=message-a><div class=mes_text><iframe id=rich></iframe></div></article></main>
<dialog id=dialog><p id=target></p><button id=cancel>取消</button><button id=rollback>撤回此条及之后</button></dialog>
<script type=module>
import {createMessageFrameMenus} from '/scripts/homer-message-frames.mjs';
window.testScope=1;window.opens=[];window.rollbacks=[];
const root=document.querySelector('#chat'), frame=document.querySelector('#rich'), dialog=document.querySelector('#dialog');
window.bridge=createMessageFrameMenus({root,
 capture: f=>({scope:testScope,message:f.closest('.mes').dataset.id}),
 accepts: (b,f)=>b.scope===testScope&&b.message===f.closest('.mes').dataset.id,
 open: (b,point)=>{opens.push({message:b.message,scope:b.scope,point});document.querySelector('#target').textContent=b.message;dialog.showModal();}
});
document.querySelector('#cancel').onclick=()=>dialog.close();
document.querySelector('#rollback').onclick=()=>{rollbacks.push(opens.at(-1).message);dialog.close();};
window.setCard=()=>{frame.srcdoc=`<!doctype html><meta charset=utf-8><style>body{margin:0;background:#293d54;color:white;padding:16px;font:16px system-ui}p{padding:12px}input{font:16px system-ui}button{min-height:44px}iframe{height:120px;width:100%;border:0}</style><p id=text>无气泡的卡片正文，长按应该打开消息菜单。</p><button id=card-button onclick="this.textContent='卡内操作完成'">卡内按钮</button><input id=card-input value="可编辑与选择文字"><iframe srcdoc="<p id='nested'>嵌套卡片正文</p>"></iframe>`;};
setCard();window.fixtureReady=true;
</script>'''

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        if self.path == '/':
            raw = PAGE.encode(); self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.end_headers(); self.wfile.write(raw)
        elif self.path == '/scripts/homer-message-frames.mjs':
            raw = (ROOT/'sillytavern-runtime/public/scripts/homer-message-frames.mjs').read_bytes()
            self.send_response(200); self.send_header('Content-Type','text/javascript'); self.end_headers(); self.wfile.write(raw)
        elif self.path == '/favicon.ico': self.send_response(204); self.end_headers()
        else: self.send_error(404)

server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
results=[]
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,channel='msedge')
        for width,height in [(375,812),(390,844),(1440,900)]:
            context=browser.new_context(viewport={'width':width,'height':height},has_touch=True)
            page=context.new_page(); errors=[]; failures=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('response',lambda r:failures.append([r.status,r.url]) if r.status>=400 else None)
            page.on('requestfailed',lambda r:failures.append(['failed',r.url]))
            page.goto(f'http://127.0.0.1:{server.server_port}/');page.wait_for_function('fixtureReady')
            child=page.frame_locator('#rich'); text=child.locator('#text'); text.wait_for()
            def hold(locator, release=True):
                box=locator.bounding_box();page.mouse.move(box['x']+20,box['y']+15);page.mouse.down();page.wait_for_timeout(550)
                if release: page.mouse.up()
            hold(text);page.locator('#dialog').wait_for(state='visible')
            assert page.evaluate('opens.length')==1
            assert child.locator('body').evaluate('e=>getComputedStyle(e).userSelect')=='none'
            assert child.locator('#card-input').evaluate('e=>getComputedStyle(e).userSelect')=='text'
            page.screenshot(path=str(OUT/f'rich-message-menu-{width}.png'))
            page.locator('#cancel').click(); assert page.evaluate('rollbacks.length')==0
            child.locator('#card-button').click();assert child.locator('#card-button').inner_text()=='卡内操作完成'
            child.locator('#card-input').fill('卡内输入正常');assert child.locator('#card-input').input_value()=='卡内输入正常'
            nested=child.frame_locator('iframe').locator('#nested'); nested.wait_for();hold(nested)
            page.locator('#dialog').wait_for(state='visible'); assert page.evaluate('opens.at(-1).message')=='message-a'
            page.locator('#rollback').click(); assert page.evaluate('rollbacks')==['message-a']
            # A scroll/move gesture must not turn into a message operation.
            before=page.evaluate('opens.length'); box=text.bounding_box();page.mouse.move(box['x']+20,box['y']+20);page.mouse.down();page.mouse.move(box['x']+20,box['y']+70);page.wait_for_timeout(550);page.mouse.up()
            assert page.evaluate('opens.length')==before
            # Stale scope during the delay cannot operate on the new conversation.
            page.mouse.move(box['x']+20,box['y']+20);page.mouse.down();page.evaluate('testScope++');page.wait_for_timeout(550);page.mouse.up()
            assert page.evaluate('opens.length')==before
            page.evaluate('bridge.refresh()');hold(text);page.locator('#dialog').wait_for(state='visible');page.locator('#cancel').click()
            # Reloaded iframe documents regain exactly one listener set.
            page.evaluate('setCard()');text.wait_for();page.wait_for_timeout(150);before=page.evaluate('opens.length');hold(text)
            page.locator('#dialog').wait_for(state='visible');assert page.evaluate('opens.length')==before+1;page.locator('#cancel').click()
            # Pending presses are cancelled when the actual frame leaves the chat.
            box=text.bounding_box();page.mouse.move(box['x']+20,box['y']+15);page.mouse.down();before=page.evaluate('opens.length');page.evaluate('document.querySelector("#rich").remove()');page.wait_for_timeout(550);page.mouse.up();assert page.evaluate('opens.length')==before
            assert not errors,errors;assert not failures,failures
            results.append({'viewport':[width,height],'menu_controls_nested_reload_cancel_scope':True,'console_errors':errors,'request_failures':failures,'scope':'Real documents + shipping adapter, synthetic message actions; not Android/device'})
            context.close()
        browser.close()
finally: server.shutdown()
(OUT/'message-frame-browser.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
