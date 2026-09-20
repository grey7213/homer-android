"""Actual community picker / cross-document theme / notices / earnings / text presentation."""
import functools,json,threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
from verify_community_r7 import Quiet,ROOT
from verify_chat_runtime import contrast
OUT=ROOT/'output/ui-r20'
def run(browser,base,w,h):
 ctx=browser.new_context(viewport={'width':w,'height':h},reduced_motion='reduce');errors=[];writes=[]
 ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r19-local',name:'测试用户'}));window.HomerNative={isDebugBuild(){return true},setAccountScope(){},getAppVisitId(){return 'r19'},notifyShellReady(){}};")
 earnings={'unit':'积分','creator_points':350,'invite_points':None,'cards':[{'app_id':'test-a','name':'星海旅人','points':280},{'app_id':'test-b','name':'雨夜来信','points':70}]}
 admin={'allowed':True,'available':True,'rate_bps':3500};admin_writes=[]
 def route(r):
  path=urlparse(r.request.url).path
  if urlparse(r.request.url).netloc!=urlparse(base).netloc:return r.fulfill(status=204)
  if path.startswith(('/console/','/go/','/admin/api/')):
   if path=='/admin/api/whoami':return r.fulfill(status=200 if admin['allowed'] else 403,json={'data':{'id':'test-admin','is_admin':admin['allowed']}})
   if path=='/admin/api/creator-revenue':
    if not admin['available']:return r.fulfill(status=404,json={'message':'未部署积分结算'})
    if r.request.method=='PUT':
     admin_writes.append(r.request.post_data_json);admin['rate_bps']=r.request.post_data_json['rate_bps']
    return r.fulfill(json={'data':{'rate_bps':admin['rate_bps']}})
   if r.request.method not in ['GET','HEAD']:writes.append(path);return r.fulfill(status=403,json={})
   if path.endswith('/account/profile'):return r.fulfill(json={'id':'r19-local','name':'测试用户','is_admin':True})
   if path.endswith('/web/earnings'):return r.fulfill(json={'data':earnings})
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
   notice=page.locator('.homer-notice-center');expect(notice).to_be_visible();expect(notice.locator('section')).to_contain_text('暂时没有新通知')
   if w<700:
    assert abs(notice.bounding_box()['height']-h)<2
    assert abs(notice.bounding_box()['width']-w)<2
   page.screenshot(path=str(OUT/f'notice-{theme}-{w}.png'));notice.get_by_role('button',name='关闭通知中心').click()
   page.goto(base+'/app/community.html',wait_until='networkidle')
  page.goto(base+'/app/earnings.html',wait_until='networkidle')
  expect(page.locator('#creator-total')).to_have_text('350');expect(page.locator('#earnings-list li')).to_have_count(2)
  expect(page.locator('#earnings-list')).to_contain_text('280 积分');expect(page.locator('#invite-state')).to_have_text('尚未接入邀请结算')
  assert not page.locator('#earnings-list').get_by_text('35%').count()
  assert not page.locator('a[href*=rewards],button:has-text("充值")').count()
  page.screenshot(path=str(OUT/f'earnings-{w}.png'))
  earnings.clear();page.get_by_role('button',name='刷新',exact=True).click();expect(page.locator('#earnings-status')).to_contain_text('收益服务暂未接入')
  def open_revenue():
   if w<700:
    page.get_by_label('管理后台功能').click();page.locator('.homer-option-picker').get_by_role('radio',name='创作收益',exact=True).click()
   else:page.get_by_role('button',name='创作收益',exact=True).click()
  page.goto(base+'/admin.html',wait_until='networkidle');open_revenue()
  rate=page.get_by_label('创作者收益比例');expect(rate).to_have_value('35')
  rate.fill('40.5');page.get_by_role('button',name='保存比例',exact=True).click();expect(page.locator('.xy-toast')).to_contain_text('收益比例已更新')
  page.get_by_role('button',name='重新读取',exact=True).click();expect(rate).to_have_value('40.5')
  page.screenshot(path=str(OUT/f'admin-revenue-{w}.png'))
  rate.fill('101');page.get_by_role('button',name='保存比例',exact=True).click();assert admin_writes==[{'rate_bps':4050}]
  admin['available']=False;page.get_by_role('button',name='重新读取',exact=True).click();expect(page.get_by_role('button',name='保存比例',exact=True)).to_be_disabled()
  admin['allowed']=False;page.reload(wait_until='networkidle');expect(page.get_by_role('heading',name='权限不足',exact=True)).to_be_visible();expect(page.locator('.revenue-admin')).to_have_count(0)
  result=page.evaluate("""async()=>{const m=await import('/assets/js/message-tones.js');const e=document.createElement('div');e.innerHTML='<p>她说：“你好。” <em>其实很紧张。</em> 叙述。</p><pre>"code"</pre>';const before=e.textContent;m.decorateMessage(e);m.decorateMessage(e);return {unchanged:before===e.textContent,speech:e.querySelectorAll('[data-message-tone=speech]').length,thought:e.querySelectorAll('[data-message-tone=thought]').length,code:e.querySelector('pre').innerHTML};}""")
  assert result=={'unchanged':True,'speech':1,'thought':1,'code':'"code"'},result
  assert not errors,errors;assert not writes,writes
  return {'viewport':[w,h],'checks':['actual compose category picker','theme toggle across retained documents','search contrast','full-page notifications','per-card points only','admin rate save/read/invalid/unavailable','ordinary user denied admin','text unchanged and idempotent'],'errors':errors,'writes':writes,'mock_admin_writes':admin_writes}
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
