"""Rendered R26 acceptance, both viewports/themes and real local API writes."""
import argparse,base64,json,time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect

parser=argparse.ArgumentParser();parser.add_argument('--credentials',type=Path,required=True);parser.add_argument('--base',default='http://127.0.0.1:8082');args=parser.parse_args()
out=Path('output/mobile-r26/e2e');out.mkdir(parents=True,exist_ok=True)
user=json.loads(args.credentials.read_text(encoding='utf-8-sig'));user=user.get('admin',user)
result={'runs':[],'errors':[],'httpErrors':[],'requestFailures':[]}
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,channel='chrome')
 for width,height in [(390,844),(1440,900)]:
  context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page()
  page.on('pageerror',lambda e:result['errors'].append(str(e)))
  page.on('response',lambda r:result['httpErrors'].append({'path':urlparse(r.url).path,'status':r.status}) if r.status>=400 else None)
  page.on('requestfailed',lambda r:result['requestFailures'].append({'path':urlparse(r.url).path,'failure':r.failure}))
  page.goto(args.base+'/app/login.html');page.wait_for_load_state('networkidle');page.locator('input[type=email]:visible').fill(user['email']);page.locator('input[type=password]:visible').fill(user['password']);page.locator('button[type=submit]:visible').click();page.wait_for_url(lambda u:'login.html' not in u)
  app=page.evaluate("""async()=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.importCard({spec:'chara_card_v2',spec_version:'2.0',data:{name:'R26 界面与标签验收',tags:['R26奇幻','R26冒险'],description:'本地验收角色',first_mes:'这是一条真实会话中的测试消息。'}})).data}""")
  page.goto(args.base+'/app/character.html?id='+app['id']);page.wait_for_load_state('networkidle')
  tag=page.locator('[data-feedback-tag="R26奇幻"]');expect(tag).to_be_visible()
  prefs=page.evaluate("async()=>{const r=await import('/app/assets/js/recommendations.js');const {getCachedUser}=await import('/app/assets/js/app-core.js?v=20260917-r8');return r.readPreferences(getCachedUser())}")
  try:
   tag.evaluate("e=>e.scrollIntoView({block:'center'})");page.wait_for_timeout(150);box=tag.bounding_box();page.mouse.move(box['x']+8,box['y']+8);page.mouse.down();page.wait_for_timeout(520);page.mouse.up()
   expect(page.locator('.tag-feedback-menu')).to_be_visible();page.screenshot(path=str(out/f'tag-{width}.png'))
   page.locator('[data-feedback-action=like]').click()
   assert page.evaluate("async()=>{const r=await import('/app/assets/js/recommendations.js');const {getCachedUser}=await import('/app/assets/js/app-core.js?v=20260917-r8');return r.tagFeedback(getCachedUser(),'R26奇幻')}")=='like'
   tag.click();page.locator('[data-feedback-action=dislike]').click();tag.click();expect(page.locator('[data-feedback-action=dislike]')).to_have_attribute('aria-pressed','true');page.locator('[data-feedback-action=block]').click()
   assert page.evaluate("async()=>{const r=await import('/app/assets/js/recommendations.js');const {getCachedUser}=await import('/app/assets/js/app-core.js?v=20260917-r8');return r.recommend(getCachedUser(),[{id:1,tags:['R26奇幻']},{id:2,tags:['其他']}]).map(x=>x.id)}")==[2]
   page.locator('.tag-feedback-toast').get_by_role('button',name='撤销').click();page.reload();page.wait_for_load_state('networkidle');tag=page.locator('[data-feedback-tag="R26奇幻"]');tag.click();expect(page.locator('[data-feedback-action=dislike]')).to_have_attribute('aria-pressed','true');page.keyboard.press('Escape')
   # Scroll/move cancels a hold; no accidental feedback while reading.
   tag.evaluate("e=>e.scrollIntoView({block:'center'})");page.wait_for_timeout(100);box=tag.bounding_box();page.mouse.move(box['x']+8,box['y']+8);page.mouse.down();page.mouse.move(box['x']+35,box['y']+8);page.wait_for_timeout(520);page.mouse.up();assert page.locator('.tag-feedback-menu[open]').count()==0
  finally:
   page.evaluate("async prefs=>{const r=await import('/app/assets/js/recommendations.js');const {getCachedUser}=await import('/app/assets/js/app-core.js?v=20260917-r8');r.writePreferences(getCachedUser(),prefs)}",prefs)
  page.goto(args.base+'/app/chat.html?app_id='+app['id']);page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
  runtime=next(f for f in page.frames if '/module/dialogue' in f.url);run={'width':width,'tagActions':True,'settings':[]}
  for theme in ['light','dark']:
   runtime.evaluate("theme=>document.documentElement.dataset.theme=theme",theme)
   runtime.locator('.homer-header-button').last.click();runtime.locator('#homer-right-drawer.is-open').wait_for();page.screenshot(path=str(out/f'menu-{theme}-{width}.png'));runtime.locator('#homer-right-drawer header button').click()
   for key,selector in [('model','#homer-open-model-settings'),('preset','#homer-open-preset-settings'),('memory','#homer-open-memory-books'),('mod','#homer-open-mods'),('appearance','[data-control=appearance]')]:
    runtime.locator(selector).evaluate('(e)=>e.click()');dialog=runtime.locator('dialog[open].homer-settings-page');expect(dialog).to_be_visible(timeout=15000)
    assert dialog.locator('.homer-settings-page__head h2').inner_text()
    assert not dialog.evaluate('(e)=>e.scrollWidth>e.clientWidth+1'),(key,width,theme,'overflow')
    if key=='model':
     expect(dialog.locator('.homer-model-field__range').first).to_be_visible()
     original=dialog.locator('input[type=number]').first.input_value()
     dialog.locator('.homer-model-select').click();picker=runtime.locator('dialog.homer-option-picker[open]');expect(picker).to_be_visible();picker.get_by_role('button',name='取消',exact=True).click()
     dialog.locator('input[type=number]').first.fill('0.7')
    if key=='mod':
     dialog.get_by_role('searchbox').fill('不存在的验收内容');expect(dialog.locator('.homer-mod-no-results')).to_be_visible();dialog.get_by_role('searchbox').fill('')
    page.screenshot(path=str(out/f'{key}-{theme}-{width}.png'));dialog.locator('.homer-settings-page__back').click();expect(dialog).not_to_be_visible();run['settings'].append(theme+':'+key)
    if key=='model':
     runtime.locator(selector).evaluate('(e)=>e.click()');expect(dialog.locator('input[type=number]').first).to_have_value(original);dialog.locator('.homer-settings-page__back').click()
  # Reproduction fixture: before the fix Showdown split this into 2 pre blocks
  # and raw HTML outside code. Real helper must receive exactly one full document.
  formatted=runtime.evaluate("""async()=>{const s=await import('./script.js');const html=s.messageFormatting('    ```html\\n<html><body>\\n<div>标题</div>\\n\\n    <div>正文</div>\\n</body></html>\\n    ```',s.name2,false,false,-1);const d=new DOMParser().parseFromString(html,'text/html');return {count:d.querySelectorAll('pre').length,full:d.querySelector('pre')?.textContent.includes('</body>'),outside:d.body.querySelectorAll('div').length}}""")
  assert formatted=={'count':1,'full':True,'outside':0},formatted;run['indentedHtmlFixed']=True
  if width==390:
   encoded=base64.b64encode(Path('D:/网站/案例1/Image_1790181493425_437.png').read_bytes()).decode()
   case=page.evaluate("async encoded=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.importCard({card_file:'data:image/png;base64,'+encoded,filename:'case1.png'})).data}",encoded)
   page.evaluate("url=>window.dispatchEvent(new CustomEvent('homer:navigate-conversation',{cancelable:true,detail:{url}}))",args.base+'/app/chat.html?app_id='+case['id'])
   try:page.wait_for_function("id=>document.body.classList.contains('is-ready')&&new URL(location.href).searchParams.get('app_id')===id",arg=case['id'],timeout=60000)
   except Exception:
    page.screenshot(path=str(out/'switch-failure.png'))
    print(json.dumps({'switchFailure':runtime.evaluate("({body:document.body.className,notices:[...document.querySelectorAll('.toast-message')].map(e=>e.innerText),marks:performance.getEntriesByType('mark').slice(-8).map(e=>e.name)})")},ensure_ascii=False));raise
   runtime.locator('#chat iframe[id^=TH-message]').wait_for(timeout=20000);page.wait_for_timeout(500)
   assert runtime.locator('#chat pre:visible').count()==0
   runtime.get_by_role('button',name='下一个开场',exact=True).click()
   runtime.wait_for_function("SillyTavern.getContext().chat[0].swipe_id===1&&document.querySelectorAll('#chat iframe[id^=TH-message]').length===1",timeout=60000)
   frontend=runtime.frame_locator('#chat iframe[id^=TH-message]').frame_locator('iframe')
   expect(frontend.get_by_text('开始游戏',exact=True)).to_be_visible(timeout=30000)
   assert runtime.locator('#chat pre:visible').count()==0
   assert not runtime.locator('.toast-error:visible').count(), 'Actual card must not report an extension error'
   page.screenshot(path=str(out/'case1-alternate.png'));run['case1AlternateRendered']=True
   frontend.get_by_text('开始游戏',exact=True).click()
   expect(frontend.get_by_text('开始游戏',exact=True)).not_to_be_visible()
   page.screenshot(path=str(out/'case1-interactive.png'));run['case1Interactive']=True
   runtime.get_by_role('button',name='上一个开场',exact=True).click()
   runtime.wait_for_function("SillyTavern.getContext().chat[0].swipe_id===0&&document.querySelectorAll('#chat iframe[id^=TH-message]').length===1",timeout=20000)
   # A delayed/broken helper utility CSS previously revealed already-rendered source.
   runtime.evaluate("[...document.querySelectorAll('link[rel=stylesheet]')].filter(l=>/slash-runner.*index.css/i.test(l.href)).forEach(l=>l.disabled=true)")
   assert runtime.locator('#chat pre:visible').count()==0
   runtime.evaluate("()=>{const p=document.createElement('pre');p.id='r26-ordinary-code';p.textContent='const ordinary=1;';document.querySelector('#chat .mes_text').append(p)}")
   expect(runtime.locator('#r26-ordinary-code')).to_be_visible();runtime.locator('#r26-ordinary-code').evaluate('(e)=>e.remove()')
   page.screenshot(path=str(out/'case1.png'));run['case1Rendered']=True;run['missingHelperCssSafe']=True
  result['runs'].append(run);context.close()
 browser.close()
out.joinpath('results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({'runs':result['runs'],'errors':result['errors'],'httpErrorCount':len(result['httpErrors'])},ensure_ascii=False));assert not result['errors']
assert not [r for r in result['httpErrors'] if r!={'path':'/media-cache/profile/default-avatar.png','status':404}]
assert not [r for r in result['requestFailures'] if r['failure']!='net::ERR_ABORTED']
