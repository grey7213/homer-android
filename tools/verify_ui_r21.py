import functools,json,threading,time
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
from verify_community_r7 import Quiet,ROOT
from verify_chat_runtime import contrast
OUT=ROOT/'output/ui-r21'
def run(browser,base,w,h):
 ctx=browser.new_context(viewport={'width':w,'height':h},reduced_motion='reduce');p=ctx.new_page();errors=[];writes=[];notices=[]
 ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r21-test',name:'测试用户',is_admin:true}));window.HomerNative={isDebugBuild(){return true},getAppVisitId(){return 'r21'},readConversationSnapshot(){return JSON.stringify({conversation_id:'r21-chat',app_id:'r21-card',title:'测试对话',messages:[{id:'m1',role:'assistant',content:'记住这次旅行。'},{id:'m2',role:'user',content:'我们明天出发。'}]})}};")
 p.on('pageerror',lambda e:errors.append(str(e)))
 def route(r):
  path=urlparse(r.request.url).path
  if path.startswith(('/module/','/dialogue-core/')):return r.fulfill(body='<html></html>',content_type='text/html')
  if urlparse(r.request.url).netloc!=urlparse(base).netloc:return r.fulfill(status=204)
  if path.startswith(('/console/','/go/','/admin/api/')):
   if r.request.method not in ['GET','HEAD']:writes.append(path)
   if path.endswith('/notifications'):return r.fulfill(json={'data':{'list':notices}})
   if path.endswith('/account/profile'):return r.fulfill(json={'id':'r21-test','is_admin':True})
   if 'messages' in path:return r.fulfill(status=503,json={'message':'测试断开消息同步，保留本地快照'})
   if '/social/' in path:return r.fulfill(status=404,json={'message':'未部署'})
   return r.fulfill(json={'data':{'list':[],'apps':[]}})
  r.continue_()
 ctx.route('**/*',route)
 try:
  p.goto(base+'/app/community.html?acceptance=local',wait_until='networkidle');gate=p.get_by_role('dialog',name='进入社区前，请阅读');gate.get_by_role('checkbox').check();gate.get_by_role('button',name='同意并进入').click()
  p.evaluate("localStorage.setItem('ai_xingyue_shell_theme','dark')");p.reload(wait_until='networkidle');community=p.locator('.c-page').evaluate('e=>getComputedStyle(e).backgroundColor')
  p.goto(base+'/app/explore.html',wait_until='networkidle');expect(p.locator('html')).to_have_attribute('data-theme','dark')
  main=p.locator('.app-main').evaluate('e=>getComputedStyle(e).backgroundColor');assert main==community,(main,community)
  search=p.locator('.home-search-box input');search.fill('旅行');contrast(p,'.home-search-box input');assert p.locator('.home-search-box').evaluate('e=>getComputedStyle(e).backgroundColor')!='rgb(255, 255, 255)';p.screenshot(path=str(OUT/f'search-focus-dark-{w}.png'))
  p.get_by_title('高级搜索',exact=True).click();p.locator('#advanced-search-panel input').first.fill('森林');contrast(p,'#advanced-search-panel input');p.screenshot(path=str(OUT/f'advanced-dark-{w}.png'))
  notices.append({'title':'维护公告','content':'今晚进行服务维护。聊天记录会保留。','enabled':True})
  p.get_by_role('button',name='查看当前通知').click();d=p.get_by_role('dialog',name='站内公告');expect(d).to_contain_text('维护公告');assert d.bounding_box()['height']<h-90;expect(d.locator('nav')).to_have_count(0);p.screenshot(path=str(OUT/f'announcement-dark-{w}.png'))
  d.get_by_role('button',name='今日不再显示').click();p.evaluate("window.dispatchEvent(new Event('homer:app-enter'))");p.wait_for_timeout(150);expect(d).to_have_count(0)
  p.get_by_role('button',name='查看当前通知').click();expect(d).to_contain_text('维护公告');d.get_by_role('button',name='我知道了').click()
  p.evaluate("localStorage.setItem('homer.notice.v1.r21-test.muted','2000-1-1');localStorage.removeItem('homer.notice.v1.r21-test.shown');window.dispatchEvent(new Event('homer:app-enter'))");expect(d).to_be_visible();d.get_by_role('button',name='今日不再显示').click();notices.clear()
  for theme in ['dark','light']:
   p.evaluate('(t)=>localStorage.setItem("ai_xingyue_shell_theme",t)',theme);p.goto(base+'/app/community-compose.html',wait_until='networkidle');expect(p.locator('.c-editor')).to_be_visible()
   p.locator('.c-title-input').fill('雨夜里的新故事');p.locator('.c-body-input').fill('想和大家分享这次角色创作的灵感。\nID：1234');contrast(p,'.c-body-input,.c-title-input');p.screenshot(path=str(OUT/f'compose-{theme}-{w}.png'))
   p.get_by_label('发布版块').click();p.locator('.homer-option-picker').get_by_role('radio',name='角色故事',exact=True).click();p.wait_for_timeout(350);p.reload(wait_until='networkidle');expect(p.locator('.c-title-input')).to_have_value('雨夜里的新故事');expect(p.get_by_label('发布版块')).to_have_value('角色故事')
  p.goto(base+'/app/chat.html?app_id=r21-card&conversation_id=r21-chat',wait_until='networkidle');expect(p.locator('.preview-message')).to_have_count(2);p.locator('#preview-settings').click()
  start=time.perf_counter();p.locator('[data-runtime-section=memory]').click();entry=p.get_by_role('dialog',name='长记忆',exact=True);expect(entry).to_be_visible();elapsed=round((time.perf_counter()-start)*1000)
  entry.get_by_role('button',name='自定义',exact=True).click();entry.get_by_label('起始消息').fill('2');entry.get_by_label('结束消息').fill('2');expect(entry.locator('[role=status]')).to_contain_text('共 1 条');entry.get_by_role('button',name='下一步').click();expect(entry.locator('[role=alert]')).to_contain_text('还未连接');p.screenshot(path=str(OUT/f'memory-offline-{w}.png'));p.keyboard.press('Escape');expect(entry).to_have_count(0)
  assert not errors,errors;assert not writes,writes
  return {'viewport':[w,h],'background':main,'coldMemoryInteractiveMs':elapsed,'checks':['focused search contrast','advanced search contrast','admin announcements modal and manual override','daily mute and next-day restore','compose draft and topic persistence','offline memory range usable, no automatic generation'],'errors':errors,'writes':writes}
 finally:ctx.close()
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True);s=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')));threading.Thread(target=s.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   b=p.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
   try:results=[run(b,f'http://127.0.0.1:{s.server_port}',w,h) for w,h in [(390,844),(1440,900)]]
   finally:b.close()
  (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8');print(results)
 finally:s.shutdown()
