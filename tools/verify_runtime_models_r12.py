"""Actual iframe -> host model catalog integration; synthetic models, no generation."""
import json
import mimetypes
from pathlib import Path
from urllib.parse import urlparse, urlencode
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
BASE='http://127.0.0.1:18911'
OUT=ROOT/'output/ui-models-r12'

def run(browser,width):
    context=browser.new_context(viewport={'width':width,'height':844})
    models=[{'id':f'n{i}','model':'same-model','name':f'模型 {i}','preset_id':f'group-{i//41}','group_name':f'分组 {i//41+1}','enabled':True,'base_url':'https://invalid.example','api_key':'not-a-credential'} for i in range(123)]
    errors=[];bad=[]
    def route(r):
        u=urlparse(r.request.url);path=u.path
        if u.netloc!=urlparse(BASE).netloc:return r.fulfill(status=204)
        if path=='/r12-model-host':
            src='/?'+urlencode({'homer_embed':'1','homer_app_id':'r12-model-card','homer_conversation_id':'r12-model-chat','homer_site_origin':BASE,'homer_host_channel':'homer:dialogue-host:v1'})
            return r.fulfill(content_type='text/html',body='<html><body style="margin:0"><script>window.catalogStates=[];addEventListener("message",e=>{if(e.origin===location.origin&&e.data?.type==="state")catalogStates.push(e.data.state)})</script><iframe title="对话" src="'+src+'" style="border:0;width:100vw;height:100vh"></iframe></body></html>')
        if path.startswith('/assets/'):
            file=ROOT/'frontend'/path.lstrip('/')
            if file.is_file():return r.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream')
        if path.startswith('/scripts/extensions/third-party/dialogue-memory-books/'):
            file=ROOT/'sillytavern-runtime/public'/path.lstrip('/').replace('third-party/dialogue-memory-books/','third-party/SillyTavern-MemoryBooks/')
            if file.is_file():return r.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream')
        if path=='/api/settings/get':
            response=r.fetch();data=response.json();settings=json.loads(data['settings']);settings['firstRun']=False
            settings.setdefault('extension_settings',{})['disabledExtensions']=['third-party/js-slash-runner','third-party/ST-Prompt-Template','third-party/st-yuzi-phone','third-party/SillyTavern-MemoryBooks']
            data['settings']=json.dumps(settings);return r.fulfill(response=response,json=data)
        if path=='/api/backends/chat-completions/status':return r.fulfill(json={'data':[{'id':'same-model'}]})
        if path.startswith('/api/homer/'):
            data={}
            if path=='/api/homer/session':data={'user':{'id':'runtime-model-test','name':'模型验收用户'},'runtime':{'backend_base_url':BASE,'bridge_base_url':BASE},'launch':{'app_id':'r12-model-card','conversation_id':'r12-model-chat','bridge_token':'local-fixture-not-a-credential','card':{'spec':'chara_card_v2','spec_version':'2.0','data':{'name':'分组测试角色','first_mes':'模型分组验收','extensions':{}}},'messages':[{'id':'model-msg-1','role':'assistant','content':'模型分组验收'}],'runtime_config':{}}}
            elif path=='/api/homer/models':data={'list':models,'default_id':'n122'}
            elif path=='/api/homer/runtime-state':data={'variables':{},'extension_settings':{}}
            elif path=='/api/homer/conversations':data={'list':[]}
            return r.fulfill(json={'data':data})
        r.continue_()
    context.route('**/*',route)
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.on('response',lambda r:bad.append([urlparse(r.url).path,r.status]) if r.status>=400 else None)
    try:
        page.goto(BASE+'/r12-model-host',wait_until='networkidle',timeout=60000)
        page.wait_for_function('catalogStates.some(s=>s.models?.length===123)',timeout=30000)
        catalog=page.evaluate('catalogStates.findLast(s=>s.models?.length===123).models')
        assert {m['group_name'] for m in catalog}=={'分组 1','分组 2','分组 3'}
        assert len({m['id'] for m in catalog})==123
        assert all('api_key' not in m and 'base_url' not in m for m in catalog)
        frame=page.frame_locator('iframe')
        frame.get_by_role('button',name='打开对话设置',exact=True).click()
        frame.locator('#homer-open-model-settings').click()
        expect(frame.locator('#homer-model-select optgroup')).to_have_count(3)
        expect(frame.locator('#homer-model-select option')).to_have_count(123)
        frame.locator('#homer-model-select').click()
        frame.get_by_role('button',name='分组 3 41',exact=True).click()
        frame.get_by_role('searchbox',name='搜索选项').fill('122')
        expect(frame.locator('.homer-option-picker__option')).to_have_count(1)
        page.screenshot(path=str(OUT/f'runtime-groups-{width}.png'))
        frame.locator('.homer-option-picker').get_by_role('button',name='取消',exact=True).click()
        expect(frame.locator('#homer-model-select')).to_have_value('n122')
        assert not errors,errors
        assert not bad,bad
        return {'width':width,'host_models':len(catalog),'groups':3,'private_fields':False,'errors':errors,'http_errors':bad}
    finally:context.close()

if __name__=='__main__':
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
        try:results=[run(browser,w) for w in (390,1440)]
        finally:browser.close()
    (OUT/'runtime-model-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    print(results)
