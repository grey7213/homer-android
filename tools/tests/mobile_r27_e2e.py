"""Exercise the real Start button API and an already-rendered legacy greeting."""
import argparse,base64,json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect

p=argparse.ArgumentParser();p.add_argument('--credentials',type=Path,required=True);p.add_argument('--base',default='http://127.0.0.1:8082');p.add_argument('--output',type=Path,default=Path('output/mobile-r27/browser'));args=p.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
user=json.loads(args.credentials.read_text(encoding='utf-8-sig'));user=user.get('admin',user)
card_file=base64.b64encode(Path('D:/网站/案例1/Image_1790181493425_437.png').read_bytes()).decode()
results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,channel='chrome')
 try:
  for width,height in [(390,844),(1440,900)]:
   ctx=browser.new_context(viewport={'width':width,'height':height});page=ctx.new_page();errors=[];network=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.on('response',lambda r:network.append({'path':urlparse(r.url).path,'status':r.status}) if r.status>=400 else None)
   page.on('requestfailed',lambda r:network.append({'path':urlparse(r.url).path,'failure':r.failure}))
   page.goto(args.base+'/app/login.html');page.wait_for_load_state('networkidle')
   page.locator('input[type=email]:visible').fill(user['email']);page.locator('input[type=password]:visible').fill(user['password']);page.locator('button[type=submit]:visible').click();page.wait_for_url(lambda u:'login.html' not in u)
   app=page.evaluate("async file=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.importCard({card_file:'data:image/png;base64,'+file,filename:'case1.png'})).data}",card_file)
   page.goto(args.base+'/app/create.html?id='+app['id']);page.wait_for_load_state('networkidle')
   page.wait_for_function("window.Alpine?.$data(document.querySelector('[x-data]'))?.form?.regex_scripts?.length===2")
   metadata=page.evaluate("""()=>{const p=Alpine.$data(document.querySelector('[x-data]'));const rule=p.form.regex_scripts[0];Object.assign(rule,{placement:[2],markdownOnly:true,promptOnly:false,runOnEdit:true,substituteRegex:1,minDepth:0,maxDepth:4,trimStrings:['test']});const out=p.payload().regex_scripts[0];return Object.fromEntries(['placement','markdownOnly','promptOnly','runOnEdit','substituteRegex','minDepth','maxDepth','trimStrings'].map(k=>[k,out[k]]));}""")
   assert metadata=={'placement':[2],'markdownOnly':True,'promptOnly':False,'runOnEdit':True,'substituteRegex':1,'minDepth':0,'maxDepth':4,'trimStrings':['test']},metadata
   conv=page.evaluate("async app=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.startConversation({app_id:app.id})).data}",app)
   cid=conv.get('conversation_id',conv.get('id'));assert cid,conv.keys()
   target=args.base+'/app/chat.html?app_id='+app['id']+'&conversation_id='+cid
   page.goto(target);page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
   runtime=next(f for f in page.frames if '/module/dialogue/' in f.url)
   runtime.locator('#chat iframe[id^=TH-message]').first.wait_for(timeout=30000)
   page.screenshot(path=str(args.output/f'start-{width}.png'))
   visible=runtime.locator('#chat pre:visible').count()
   print(json.dumps({'width':width,'startSourceVisible':visible,'seedLength':len(conv.get('messages',[{}])[0].get('content',''))}),flush=True)
   assert visible==0,'Start API seeded a display-rendered document and runtime rendered it twice'
   frame=runtime.frame_locator('#chat iframe[id^=TH-message]').first
   expect(frame.get_by_text('必备前置插件',exact=False).first).to_be_visible()
   # Same payload as the phone's existing opening, kept in memory only; do not
   # overwrite the real phone conversation or clear its history to hide a bug.
   legacy=runtime.evaluate("""async()=>{const c=SillyTavern.getContext(),card=c.characters[c.characterId],raw=card.data.extensions.regex_scripts[0].replaceString;return raw;}""")
   # The bridge's pure normalization is used for both stored content and swipes.
   normalized=runtime.evaluate("""async legacy=>{const {restoreRenderedGreetings}=await import('./scripts/homer-greeting-swipes.mjs');const {getRegexedString,regex_placement}=await import('./scripts/extensions/regex/engine.js');const c=SillyTavern.getContext(),card=c.characters[c.characterId];return restoreRenderedGreetings(card,[legacy],legacy,s=>getRegexedString(s,regex_placement.AI_OUTPUT,{isMarkdown:true,depth:0}));}""",legacy)
   assert normalized['content']=='LOADING...' and normalized['swipes']==['LOADING...']
   page.reload();page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
   runtime=next(f for f in page.frames if '/module/dialogue/' in f.url)
   runtime.locator('#chat iframe[id^=TH-message]').first.wait_for(timeout=30000)
   assert runtime.locator('#chat pre:visible').count()==0
   runtime.get_by_role('button',name='下一个开场',exact=True).click()
   game=runtime.frame_locator('#chat iframe[id^=TH-message]').frame_locator('iframe')
   expect(game.get_by_text('开始游戏',exact=True)).to_be_visible(timeout=30000);game.get_by_text('开始游戏',exact=True).click()
   expect(game.get_by_text('开始游戏',exact=True)).not_to_be_visible()
   expect(game.get_by_text('选择你的身份',exact=True)).to_be_visible()
   assert not runtime.locator('.toast-error:visible').count()
   page.screenshot(path=str(args.output/f'game-{width}.png'))
   page.goto(args.base+'/app/workshop.html');page.wait_for_load_state('networkidle')
   nav=page.locator('.ws-quicknav');expect(nav).to_be_visible()
   assert nav.locator('small').count()==0
   label=nav.get_by_text('界面模板',exact=True);expect(label).to_be_visible()
   assert label.evaluate('(e)=>e.getBoundingClientRect().height<=parseFloat(getComputedStyle(e).lineHeight)+1')
   page.screenshot(path=str(args.output/f'workshop-{width}.png'))
   label.click();expect(page.locator('#resource-title')).to_have_text('界面模板')
   assert not errors,errors
   results.append({'width':width,'start':True,'legacy':True,'reopen':True,'interactive':True,'workshopSingleLine':True,'errors':errors,'network':network})
   args.output.joinpath('results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
   assert not [e for e in network if e.get('status')!=404 and e.get('failure')!='net::ERR_ABORTED'],network
   ctx.close()
 finally:browser.close()
args.output.joinpath('results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(results,ensure_ascii=False))
