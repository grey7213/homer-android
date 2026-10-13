"""Rendered source-component checks only; this is NOT Android device acceptance."""
import functools
import json
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[2]
output=root/'output/preset-ball-r367'
output.mkdir(parents=True,exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*_): pass
    def translate_path(self,path):
        if path=='/': return str(root/'tools/tests/preset-ball-fixture.html')
        if path.startswith('/runtime/'): return str(root/'sillytavern-runtime/public'/path.removeprefix('/runtime/'))
        return super().translate_path(path)
    def do_POST(self):
        if self.path.startswith('/api/preset/'):
            data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
            result={'conversation_id':self.path.rsplit('/',1)[-1],**data}
        elif self.path.startswith('/api/generate/'): result={'generated':True,'synthetic':True}
        else: self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(result).encode())
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
threading.Thread(target=server.serve_forever,daemon=True).start()
url=f'http://127.0.0.1:{server.server_port}/'
results=[]
try:
  with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, channel='msedge')
    for width,height in [(375,812),(390,844),(1440,900)]:
      context=browser.new_context(viewport={'width':width,'height':height})
      page=context.new_page();errors=[];failures=[]
      page.on('pageerror',lambda error:errors.append(str(error)))
      page.on('response',lambda response:failures.append([response.status,response.url]) if response.status>=400 else None)
      page.goto(url);page.locator('.chaoxi-fab').wait_for()
      ball=page.locator('.chaoxi-fab');position=ball.bounding_box()
      page.mouse.move(position['x']+22,position['y']+22);page.mouse.down();page.mouse.move(position['x']-60,position['y']+50,steps=5);page.mouse.up()
      assert page.locator('.chaoxi-panel').count()==0,'Dragging opened panel'
      start=time.perf_counter();ball.click();page.locator('.chaoxi-panel').wait_for();opened_ms=(time.perf_counter()-start)*1000
      assert page.get_by_role('switch').count()==2
      assert 'PRIVATE' not in page.locator('#root').inner_text()
      assert page.locator('#root textarea').count()==0
      assert page.get_by_text('预设仓库',exact=True).count()==0
      page.get_by_role('switch',name='场景描写开关').click()
      page.wait_for_function("window.fixture.controller.snapshot().pending===false")
      assert page.get_by_role('switch',name='场景描写开关').get_attribute('aria-checked')=='false'
      assert page.evaluate('window.fixtureChatRepaints()')==0
      page.locator('.chaoxi-topbar-search-input').fill('对白')
      assert page.get_by_role('switch').count()==1
      page.locator('.chaoxi-topbar-search-input').fill('')
      page.get_by_role('button',name='展开完整列表').click()
      panel=page.locator('.chaoxi-panel').bounding_box()
      assert panel['x']>=-1 and panel['x']+panel['width']<=width+1
      assert panel['y']>=-1 and panel['y']+panel['height']<=height+1
      page.screenshot(path=str(output/f'panel-{width}.png'))
      assert page.evaluate('window.HomerCloseOverlay()')
      page.wait_for_function("!document.querySelector('.chaoxi-panel')")
      page.locator('#b').click();page.locator('#settings').click()
      assert page.get_by_role('switch',name='场景描写开关').get_attribute('aria-checked')=='true'
      page.evaluate('window.HomerCloseOverlay()');page.locator('#a').click();page.locator('#settings').click()
      assert page.get_by_role('switch',name='场景描写开关').get_attribute('aria-checked')=='false'
      context.set_offline(True);page.get_by_role('switch',name='角色对白开关').click()
      page.wait_for_function('window.fixture.controller.snapshot().pending && !window.fixture.controller.snapshot().saving')
      assert page.evaluate("(()=>{try{window.fixture.controller.captureGenerationGuard()();return false}catch(e){return e.code==='HM-P001'}})()")
      context.set_offline(False);page.get_by_role('button',name='重试同步').click()
      page.wait_for_function('!window.fixture.controller.snapshot().pending')
      page.evaluate('window.HomerCloseOverlay()');page.reload();page.locator('.chaoxi-fab').wait_for();page.locator('#settings').click()
      assert page.get_by_role('switch',name='角色对白开关').get_attribute('aria-checked')=='false'
      page.get_by_role('button',name='亮色',exact=True).click();page.screenshot(path=str(output/f'light-{width}.png'))
      assert not errors,errors
      assert not failures,failures
      results.append({'viewport':[width,height],'passed':True,'panel_open_ms':round(opened_ms,1),'console_errors':errors,'unexpected_http_failures':failures,
        'native_android_test':False,'baseline_pixel_diff':'not available; original phone runtime baseline not captured'})
      context.close()
    browser.close()
finally: server.shutdown()
(output/'browser-report.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
