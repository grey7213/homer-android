"""Shipping full runtime + Mod handler and message menu; loopback-only QA.

Reads the supplied Daoyuan PNG only as an isolated test input. No user account,
old archive, credentials, production service or real model generation is used.
Native page retention is separately unit-tested, not emulated as device proof.
"""
import functools
import importlib.util
import json
import threading
import time
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/mod-return-r368';OUT.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('isolated_activity_fixture',ROOT/'tools/tests/activity_runtime_fixture.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
def read_card(path):
    import base64
    raw=path.read_bytes();offset=8;cards={}
    while offset+12<=len(raw):
        size=int.from_bytes(raw[offset:offset+4],'big');kind=raw[offset+4:offset+8]
        chunk=raw[offset+8:offset+8+size]
        if kind==b'tEXt':
            name,_,value=chunk.partition(b'\0')
            if name in (b'chara',b'ccv3'):cards[name]=json.loads(base64.b64decode(value))
        offset+=size+12
    return cards.get(b'ccv3',cards.get(b'chara'))

rich_html='<!doctype html><html><head><style>body{color:white;background:#293d54;padding:20px;font:16px system-ui}</style></head><body><p id="r368-text">强渲染消息长按正文</p><button id="r368-button" onclick="this.textContent=\'操作完成\'">卡内操作</button><input id="r368-input" value="卡内输入"><iframe srcdoc="&lt;p id=\'nested\'&gt;嵌套正文&lt;/p&gt;"></iframe></body></html>'
rich_card={'spec':'chara_card_v2','spec_version':'2.0','data':{'name':'R368 synthetic rich card','first_mes':'R368-RICH-SEED','description':'Isolated gesture fixture',
    'personality':'','scenario':'','mes_example':'','creator_notes':'','system_prompt':'','post_history_instructions':'','alternate_greetings':[],
    'extensions':{'regex_scripts':[{'id':'r368-rule','scriptName':'R368 rich fixture','findRegex':'R368-RICH-SEED','replaceString':'```html\n'+rich_html+'\n```','placement':[2],
        'disabled':False,'markdownOnly':True,'promptOnly':False,'runOnEdit':True,'minDepth':None,'maxDepth':None,'trimStrings':[],'substituteRegex':0}]},'tags':[],'creator':'QA','character_version':'1'}}
daoyuan=read_card(Path('D:/网站/绘梦物语/《道渊》v5.2.png'))
cards={'qa-a':rich_card,'qa-b':daoyuan,'qa-c':rich_card}
def launch(conv):
    conv=conv if conv in cards else 'qa-a';card=cards[conv]
    messages=[{'id':conv+'-opening','role':'assistant','content':card['data']['first_mes'],'created_at':1720000000000}]
    return {'user':{'id':fixture.OWNER,'name':'Isolated QA','is_admin':False},'runtime':{'dialogue_api_base_url':fixture.ORIGIN+'/synthetic-provider','backend_base_url':fixture.ORIGIN},
        'launch':{'app_id':'r368-'+conv,'conversation_id':conv,'title':card['data']['name'],'bridge_token':'synthetic-only-not-credential','bridge_token_ttl_seconds':900,
            'card':card,'messages':messages,'storage':{'protocol':2,'complete':True,'version':conv[-1]*32,'message_count':1,'unchanged':False}}}
fixture.launch=launch
WRAPPER='''<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe id=dialogue-frame></iframe><script>
localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'activity-cold-synthetic-owner',name:'QA'}));
window.notices=[];addEventListener('message',e=>{if(e.origin===location.origin&&e.source===document.querySelector('iframe').contentWindow)notices.push(e.data)});
let u=new URL('/module/dialogue/',location.href);for(const [k,v] of Object.entries({homer_embed:'1',homer_host_channel:'homer:dialogue-host:v1',homer_site_origin:location.origin,homer_app_id:'r368-qa-a',homer_conversation_id:'qa-a'}))u.searchParams.set(k,v);document.querySelector('iframe').src=u.href;
</script>'''
class Handler(fixture.Handler):
    def dispatch(self):
        path=urlparse(self.path).path
        if self.command=='GET' and path=='/qa/host':return self.send(WRAPPER.encode(),mime='text/html; charset=utf-8')
        local_path=path.removeprefix('/module/dialogue')
        if self.command=='GET' and (local_path.startswith('/assets/') or local_path.startswith('/app/')):
            target=(ROOT/'frontend'/local_path.lstrip('/')).resolve()
            if not target.is_relative_to((ROOT/'frontend').resolve()):return self.send_error(403)
            if target.is_file():
                import mimetypes
                mime='text/javascript' if target.suffix in ('.js','.mjs') else mimetypes.guess_type(str(target))[0]
                return self.send(target.read_bytes(),mime=mime or 'application/octet-stream')
        if local_path.startswith('/scripts/extensions/third-party/dialogue-memory-books/'):
            target=ROOT/'sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks'/local_path.removeprefix('/scripts/extensions/third-party/dialogue-memory-books/')
            if target.is_file():return self.send(target.read_bytes(),mime='text/javascript' if target.suffix in ('.js','.mjs') else 'text/html')
        if local_path in ('/api/homer/conversations','/console/api/web/conversations'):
            value={'list':[{'id':c,'app_id':'r368-'+c,'title':cards[c]['data']['name'],'app_name':cards[c]['data']['name']} for c in cards]}
            return self.send({'data':value} if local_path.startswith('/console/') else value)
        return super().dispatch()
    do_GET=dispatch;do_POST=dispatch
server=None if '--client-only' in sys.argv else ThreadingHTTPServer(('127.0.0.1',8817),Handler)
if server:threading.Thread(target=server.serve_forever,daemon=True).start()
if '--serve' in sys.argv:
    print('Isolated R368 runtime fixture on 127.0.0.1:8817; no user account/provider',flush=True)
    try: threading.Event().wait()
    finally: server.shutdown()
    raise SystemExit(0)
results=[]
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,channel='msedge')
        for width,height in [(390,844),(1440,900)]:
            page=browser.new_page(viewport={'width':width,'height':height});errors=[];network=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('requestfailed',lambda r:network.append({'path':urlparse(r.url).path,'failed':True,'reason':r.failure}))
            start=time.perf_counter();page.goto(fixture.ORIGIN+'/qa/host')
            runtime=page.frame_locator('#dialogue-frame')
            runtime.locator('html.homer-runtime-ready').wait_for(timeout=60000)
            cold_ms=round((time.perf_counter()-start)*1000)
            child=runtime.frame_locator('iframe[id^="TH-message"]');child.locator('#r368-text').wait_for(timeout=20000)
            live=next(f for f in page.frames if '/module/dialogue/' in f.url)
            engine=live.evaluate('performance.timeOrigin')
            # Real Mod UI and real link; capture its genuine outer-host command.
            runtime.get_by_role('button',name='打开对话设置',exact=True).click()
            runtime.locator('#homer-open-mods').click()
            runtime.locator('#homer-mod-dialog').wait_for(state='visible')
            runtime.locator('#homer-mod-dialog .homer-mod-library-link').click()
            page.wait_for_function("notices.some(n=>n.type==='navigate'&&n.target==='/app/workshop.html')")
            assert live.evaluate('performance.timeOrigin')==engine
            assert not live.locator('#homer-mod-dialog').evaluate('e=>e.open')
            # The real message menu, not a fixture replacement, receives the hold.
            box=child.locator('#r368-text').bounding_box();page.mouse.move(box['x']+20,box['y']+15);page.mouse.down();page.wait_for_timeout(550);page.mouse.up()
            live.locator('#homer-message-menu-dialog').wait_for(state='visible')
            assert not child.locator('body').evaluate('e=>String(getSelection()).length')
            assert live.get_by_role('menuitem',name='回溯',exact=True).is_enabled()
            page.screenshot(path=str(OUT/f'full-runtime-rich-menu-{width}.png'))
            live.locator('#homer-message-menu-dialog').evaluate('e=>e.close()')
            child.locator('#r368-button').click();assert child.locator('#r368-button').inner_text()=='操作完成'
            child.locator('#r368-input').fill('真实卡内控件仍可使用')
            # Read original large card, without a real account/provider.
            before=time.perf_counter();live.get_by_role('button',name='打开导航与历史会话',exact=True).click()
            live.locator('[data-conversation-id="qa-b"] .homer-history-item__main').click()
            live.wait_for_function("!document.body.classList.contains('homer-switching-chat')&&SillyTavern.getContext().chat[0]?.mes.length>10000",timeout=60000)
            live.wait_for_function("(()=>{const frames=[...document.querySelectorAll('#chat iframe[id^=TH-message]')];return frames.length>0&&frames.every(f=>f.contentDocument?.readyState==='complete'&&f.contentDocument.body?.textContent.trim().length>0&&f.getBoundingClientRect().height>100)})()",timeout=60000)
            large_ms=round((time.perf_counter()-before)*1000)
            activation=live.evaluate("(()=>{const c=SillyTavern.getContext(),a=c.characters[c.characterId],s=c.extensionSettings?.tavern_helper;return {adapter:typeof HomerTavernHelperActivation,character:a?.name,cardHelperType:typeof a?.data?.extensions?.tavern_helper,cardScripts:Array.isArray(a?.data?.extensions?.tavern_helper?.scripts)?a.data.extensions.tavern_helper.scripts.length:null,enabled:s?.script?.enabled?.characters,openDialogs:document.querySelectorAll('dialog[open]').length}})()")
            page.screenshot(path=str(OUT/f'daoyuan-final-{width}.png'))
            warm=[]
            for target in ['qa-a','qa-b','qa-a','qa-b']:
                live.get_by_role('button',name='打开导航与历史会话',exact=True).click()
                tick=time.perf_counter()
                live.locator(f'[data-conversation-id="{target}"] .homer-history-item__main').click()
                live.wait_for_function("target=>!document.body.classList.contains('homer-switching-chat')&&SillyTavern.getContext().chatMetadata.homer_bridge.conversation_id===target",arg=target,timeout=60000)
                live.wait_for_function("(()=>{const f=document.querySelector('#chat iframe[id^=TH-message]');return f?.contentDocument?.readyState==='complete'&&f.contentDocument.body?.textContent.trim().length>0&&f.getBoundingClientRect().height>100})()",timeout=60000)
                warm.append({'target':target,'ms':round((time.perf_counter()-tick)*1000)})
            assert live.evaluate('performance.timeOrigin')==engine
            marks=live.evaluate("performance.getEntriesByType('mark').filter(x=>x.name.startsWith('homer-')).map(x=>({name:x.name,ms:Math.round(x.startTime)}))")
            results.append({'viewport':[width,height],'full_runtime_mod_dispatch':True,'full_runtime_message_menu':True,'cold_ms':cold_ms,'daoyuan_switch_ms':large_ms,
                'warm_switches':warm,'activation':activation,'console_errors':errors,'failed_requests':network,'marks':marks,'scope':'Shipping runtime, actual supplied card, isolated synthetic service; NOT Android/production/provider measurement'})
            page.close()
        browser.close()
finally:
    if server:server.shutdown()
    (OUT/'full-runtime-browser.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps([{k:v for k,v in result.items() if k!='marks'} for result in results],ensure_ascii=False))
