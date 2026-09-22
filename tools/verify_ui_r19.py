"""Actual community picker / cross-document theme / notices / earnings / text presentation."""
import functools,json,threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
from verify_community_r7 import Quiet,ROOT
from verify_chat_runtime import contrast
OUT=ROOT/'output/ui-r19'
def run(browser,base,w,h):
 ctx=browser.new_context(viewport={'width':w,'height':h},reduced_motion='reduce');errors=[];writes=[]
 ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r19-local',name:'测试用户'}));window.HomerNative={isDebugBuild(){return true},setAccountScope(){},getAppVisitId(){return 'r19'},notifyShellReady(){}};")
 earnings={'summary':{'creator':{'amount':12,'unit':'元'},'invite':{'amount':30,'unit':'积分'}},'list':[{'kind':'creator','title':'测试创作结算','amount':12,'unit':'元','status_label':'已入账'},{'kind':'invite','title':'测试邀请奖励','amount':30,'unit':'积分','status_label':'已入账'}]}
 def route(r):
  path=urlparse(r.request.url).path
  if urlparse(r.request.url).netloc!=urlparse(base).netloc:return r.fulfill(status=204)
  if path.startswith(('/console/','/go/','/admin/api/')):
   if r.request.method not in ['GET','HEAD']:writes.append(path);return r.fulfill(status=403,json={})
   if path.endswith('/account/profile'):return r.fulfill(json={'id':'r19-local','name':'测试用户','is_admin':True})
   if path.endswith('/web/rewards'):return r.fulfill(json={'data':{'earnings':earnings}})
   if '/social/' in path:return r.fulfill(status=404,json={'message':'未部署社区'})
   return r.fulfill(json={'data':{'list':[],'apps':[]}})
  r.continue_()
 ctx.route('**/*',route)
 me=ctx.new_page();page=ctx.new_page()
 for p in [me,page]:p.on('pageerror',lambda e:errors.append(str(e)))
 try:
  page.goto(base+'/app/community.html?acceptance=local',wait_until='networkidle')
  gate=page.get_by_role('dialog',name='进入社区前，请阅读');gate.get_by_role('checkbox').check();gate.get_by_role('button',name='同意并进入').click()
  expect(page.locator('.c-post')).to_have_count(2)
  me.goto(base+'/app/me.html?panel=settings',wait_until='networkidle')
  for theme in ['dark','light']:
   me.locator('.profile-settings-routes [data-shell-action=theme]').click()
   expect(page.locator('html')).to_have_attribute('data-theme',theme)
   page.screenshot(path=str(OUT/f'community-{theme}-{w}.png'))
   page.goto(base+'/app/community-compose.html',wait_until='networkidle')
   select=page.locator('select').first;expect(select).to_be_visible();select.click()
   picker=page.locator('.homer-option-picker');expect(picker).to_be_visible()
   page.screenshot(path=str(OUT/f'actual-category-{theme}-{w}.png'))
   picker.get_by_role('radio',name='角色故事',exact=True).click()
   expect(select).to_have_value('角色故事')
   page.goto(base+'/app/explore.html',wait_until='networkidle')
   expect(page.locator('html')).to_have_attribute('data-theme',theme)
   inputs=page.locator('input:visible')
   contrast(page,'input:visible')
   for input in inputs.all():
    colors=input.evaluate('e=>({bg:getComputedStyle(e).backgroundColor,fg:getComputedStyle(e).color})')
    assert colors['bg']!=colors['fg'],colors
   page.evaluate("async()=>{const n=await import('/app/assets/js/notifications.js?v=20260917-r8');void n.openCurrentNotifications();}")
   notice=page.locator('.homer-notice-center');expect(notice).to_be_visible();expect(notice.locator('section')).to_contain_text('暂无通知')
   page.screenshot(path=str(OUT/f'notice-{theme}-{w}.png'));notice.get_by_role('button',name='关闭通知中心').click()
   page.goto(base+'/app/community.html',wait_until='networkidle')
  page.goto(base+'/app/earnings.html',wait_until='networkidle')
  expect(page.locator('#creator-total')).to_have_text('12 元');expect(page.locator('#invite-total')).to_have_text('30 积分')
  page.get_by_role('button',name='邀请奖励',exact=True).click();expect(page.locator('#earnings-list li')).to_have_count(1)
  assert not page.locator('a[href*=rewards],button:has-text("充值")').count()
  page.screenshot(path=str(OUT/f'earnings-{w}.png'))
  earnings.clear();page.get_by_role('button',name='刷新',exact=True).click();expect(page.locator('#creator-total')).to_have_text('—')
  result=page.evaluate("""async()=>{const m=await import('/assets/js/message-tones.js');const e=document.createElement('div');e.innerHTML='<p>她说：“你好。” <em>其实很紧张。</em> 叙述。</p><pre>"code"</pre>';const before=e.textContent;m.decorateMessage(e);m.decorateMessage(e);return {unchanged:before===e.textContent,speech:e.querySelectorAll('[data-message-tone=speech]').length,thought:e.querySelectorAll('[data-message-tone=thought]').length,code:e.querySelector('pre').innerHTML};}""")
  assert result=={'unchanged':True,'speech':1,'thought':1,'code':'"code"'},result
  assert not errors,errors;assert not writes,writes
  return {'viewport':[w,h],'checks':['actual compose category picker','theme toggle across retained documents','search colors','notification center','separate earnings by source and unit','text unchanged and idempotent'],'errors':errors,'writes':writes}
 except Exception:
  print('R19 failure',errors,page.url,page.locator('body').inner_text()[:1000]);page.screenshot(path=str(OUT/f'failure-{w}.png'));raise
 finally:ctx.close()
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True);server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')));threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   b=p.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
   try:results=[run(b,f'http://127.0.0.1:{server.server_port}',w,h) for w,h in [(390,844),(1440,900)]]
   finally:b.close()
  (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8');print(results)
 finally:server.shutdown()
