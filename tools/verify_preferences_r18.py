"""Rendered preference persistence, recommendation integration and shared option/confirmation states."""
import functools,json,threading
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'output/ui-r18'
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
def run(browser,base,w,h):
 ctx=browser.new_context(viewport={'width':w,'height':h},reduced_motion='reduce')
 ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'prefs-fixture',name:'测试用户'}));")
 errors=[];writes=[];bad=[]
 def route(r):
  u=urlparse(r.request.url)
  if u.netloc!=urlparse(base).netloc:return r.fulfill(status=204)
  if u.path.startswith(('/console/','/admin/api/','/go/')):
   if r.request.method not in ['GET','HEAD']:writes.append(u.path);return r.fulfill(status=403,json={'message':'禁止测试写入'})
   if u.path.endswith('/account/profile'):return r.fulfill(json={'id':'prefs-fixture','name':'测试用户','is_admin':False})
   if u.path=='/go/api/explore/search':return r.fulfill(json={'data':{'apps':[{'id':str(i),'name':'测试角色'+str(i),'tags':['奇幻' if i%2 else '日常'],'description':'测试摘要'} for i in range(1,9)],'total':8}})
   return r.fulfill(json={'data':{'list':[],'apps':[],'total':0}})
  r.continue_()
 ctx.route('**/*',route);p=ctx.new_page();p.on('pageerror',lambda e:errors.append(str(e)));p.on('requestfailed',lambda r:bad.append(urlparse(r.url).path))
 try:
  p.goto(base+'/app/me.html?panel=preferences',wait_until='networkidle')
  expect(p.get_by_role('heading',name='内容偏好').first).to_be_visible()
  expect(p.get_by_role('switch',name='个性化推荐')).to_be_checked()
  p.get_by_role('switch',name='个性化推荐').check();p.get_by_label('感兴趣的标签',exact=True).fill('奇幻')
  p.get_by_role('button',name='保存偏好',exact=True).click();expect(p.get_by_text('偏好已保存，下次刷新推荐时生效')).to_be_visible()
  p.reload(wait_until='networkidle');expect(p.get_by_role('switch',name='个性化推荐')).to_be_checked();expect(p.get_by_label('感兴趣的标签',exact=True)).to_have_value('奇幻')
  for theme in ['light','dark']:
   p.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
   p.screenshot(path=str(OUT/f'preferences-{theme}-{w}.png'),full_page=True)
   p.get_by_role('button',name='重置推荐学习记录').click();expect(p.get_by_role('dialog',name='重置推荐')).to_be_visible()
   p.screenshot(path=str(OUT/f'confirmation-{theme}-{w}.png'))
   assert p.evaluate('window.HomerCloseOverlay()');expect(p.get_by_role('dialog')).to_have_count(0)
   # Real shared select adapter, nested groups/multiple selection fixture.
   p.evaluate("()=>{const s=document.createElement('select');s.id='picker-fixture';s.multiple=true;s.setAttribute('aria-label','选择兴趣');s.innerHTML='<optgroup label=故事><option selected>奇幻</option><option>日常</option><option disabled>暂不可用</option></optgroup><optgroup label=社区><option>创作交流</option></optgroup>';document.querySelector('.preference-settings').append(s);}")
   p.locator('#picker-fixture').click();expect(p.get_by_role('dialog',name='选择兴趣')).to_be_visible()
   p.get_by_role('checkbox',name='日常',exact=True).click()
   p.screenshot(path=str(OUT/f'picker-{theme}-{w}.png'))
   assert p.evaluate('window.HomerCloseOverlay()')
   assert p.locator('#picker-fixture').evaluate('e=>[...e.selectedOptions].map(o=>o.text)')==['奇幻']
   p.locator('#picker-fixture').click();p.get_by_role('checkbox',name='日常',exact=True).click();p.get_by_role('button',name='确认选择',exact=True).click()
   assert p.locator('#picker-fixture').evaluate('e=>[...e.selectedOptions].map(o=>o.text)')==['奇幻','日常']
   p.locator('#picker-fixture').evaluate('e=>e.remove()')
  p.goto(base+'/app/explore.html',wait_until='networkidle')
  expect(p.locator('[x-data]')).to_be_visible()
  p.wait_for_function("Alpine.$data(document.querySelector('[x-data]')).cards.length===8")
  ids=p.evaluate("Alpine.$data(document.querySelector('[x-data]')).cards.map(c=>c.id)")
  assert ids[:4]==['1','3','5','7'],ids
  assert not p.evaluate('document.documentElement.scrollWidth>innerWidth+1')
  assert not errors,errors
  assert not writes,writes
  assert not bad,bad
  return {'viewport':[w,h],'checks':['preference persistence','opt-in','reset cancellation','light/dark confirmation','multi-select cancel/commit','ranked exploration'],'errors':errors,'writes':writes}
 finally:ctx.close()
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True)
 server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')));threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   b=p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe',headless=True)
   try:results=[run(b,f'http://127.0.0.1:{server.server_port}',w,h) for w,h in [(390,844),(1440,900)]]
   finally:b.close()
  (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8');print(results)
 finally:server.shutdown()
