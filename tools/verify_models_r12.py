"""Rendered admin batch-edit and public group checks. All writes are intercepted."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/ui-models-r12'

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

def run(browser, base, width):
    ctx = browser.new_context(viewport={'width':width,'height':844}, reduced_motion='reduce')
    ctx.add_init_script("localStorage.setItem('ai_xingyue_logged_in','1')")
    errors=[]; saves=[]; fail_save=True
    nodes=[{'id':f'node-{g}','name':f'分组 {g+1}','enabled':True,'models':[f'model-{i}' for i in range(40)],'model':'model-0','model_configs':[{'model':f'model-{i}','display_name':f'模型 {i}','preset_id':'p1','pricing':{'mode':'per_request','input_price':i+1,'output_price':2}} for i in range(40)]} for g in range(3)]
    def route(r):
        nonlocal fail_save
        path=urlparse(r.request.url).path
        if path.startswith(('/admin/api/','/console/','/go/')):
            data={'data':{}}
            if path=='/admin/api/whoami':data={'data':{'id':'fixture-admin','is_admin':True}}
            if path=='/admin/api/llm-settings':
                if r.request.method!='GET':
                    saves.append(r.request.post_data_json)
                    if fail_save:r.fulfill(status=503,json={'message':'测试保存失败'});return
                data={'data':{'presets':nodes,'default_model_preset_id':'node-0'}}
            r.fulfill(json=data);return
        r.continue_()
    ctx.route('**/*',route);p=ctx.new_page();p.on('pageerror',lambda e:errors.append(str(e)))
    try:
        p.goto(base+'/admin.html',wait_until='networkidle')
        p.evaluate("async()=>{const a=Alpine.$data(document.querySelector('[x-data]'));a.activeTab='llm';a.globalPresets={prompt:{active_id:'p1',items:[{id:'p1',name:'默认预设'},{id:'p2',name:'新预设'}]}};await a.loadLlmSettings();}")
        expect(p.locator('.ui-model-row')).to_have_count(40)
        expect(p.locator('.ui-model-selection')).not_to_be_visible()
        p.get_by_role('button',name='批量管理',exact=True).click()
        p.get_by_label('搜索模型',exact=True).fill('model-39')
        p.get_by_role('button',name='全选当前筛选结果（1）',exact=True).click()
        p.get_by_role('button',name='批量编辑',exact=True).click()
        p.get_by_label('修改输入单价',exact=True).check()
        p.get_by_label('批量输入单价',exact=True).fill('9')
        p.get_by_role('button',name='取消',exact=True).click()
        assert p.evaluate("Alpine.$data(document.querySelector('[x-data]')).llmForm.presets[0].modelConfigs[39].pricing.input_price")==40
        p.get_by_role('button',name='全选全部节点（120）',exact=True).click()
        p.get_by_role('button',name='批量编辑',exact=True).click()
        expect(p.get_by_role('dialog',name='批量编辑模型')).to_contain_text('3 个节点 · 120 个模型')
        p.get_by_label('修改绑定预设',exact=True).check()
        p.evaluate("()=>{const a=Alpine.$data(document.querySelector('[x-data]'));a.uiModelBulk.preset_id='p2';}")
        p.get_by_label('修改输入单价',exact=True).check()
        p.get_by_label('批量输入单价',exact=True).fill('-1')
        p.get_by_role('button',name='应用到 120 个模型',exact=True).click()
        expect(p.locator('.ui-bulk-dialog [role=alert]')).to_contain_text('大于或等于 0')
        p.get_by_label('批量输入单价',exact=True).fill('9')
        p.screenshot(path=str(OUT/f'admin-bulk-{width}.png'))
        p.get_by_role('button',name='应用到 120 个模型',exact=True).click()
        assert p.evaluate("()=>{const a=Alpine.$data(document.querySelector('[x-data]'));return a.allModelRows().every(r=>r.config.preset_id==='p2'&&r.config.pricing.input_price===9&&r.config.pricing.output_price===2);}")
        assert not saves
        p.get_by_role('button',name='保存全部节点',exact=True).click()
        expect(p.locator('.xy-toast-error')).to_be_visible()
        assert p.evaluate("Alpine.$data(document.querySelector('[x-data]')).llmForm.presets[2].modelConfigs[39].pricing.input_price")==9
        assert len(saves)==1 and len(saves[0]['presets'])==3
        fail_save=False
        p.get_by_role('button',name='保存全部节点',exact=True).click()
        expect(p.locator('.xy-toast-success')).to_be_visible()
        p.screenshot(path=str(OUT/f'admin-models-{width}.png'))
        # Exercise shared grouped selector through the actual option-picker UI.
        p.evaluate("""async()=>{const {fillModelSelect}=await import('/assets/js/model-catalog.js');
          const select=document.createElement('select');select.id='r12-models';select.style='position:fixed;top:70px;left:20px;z-index:10000';document.body.append(select);
          fillModelSelect(select,Array.from({length:123},(_,i)=>({id:'n'+i,name:'同名模型 '+i,model:'model',preset_id:'node-'+Math.floor(i/41),group_name:'分组 '+(Math.floor(i/41)+1)})),'n122');}""")
        expect(p.locator('#r12-models option')).to_have_count(123)
        expect(p.locator('#r12-models optgroup')).to_have_count(3)
        p.locator('#r12-models').click()
        expect(p.locator('.homer-option-picker__group')).to_have_count(3)
        p.get_by_role('button',name='分组 3 41',exact=True).click()
        expect(p.locator('.homer-option-picker__option')).to_have_count(41)
        p.get_by_role('searchbox',name='搜索选项').fill('122')
        expect(p.locator('.homer-option-picker__option')).to_have_count(1)
        p.screenshot(path=str(OUT/f'group-picker-{width}.png'))
        p.get_by_role('button',name='取消',exact=True).click()
        expect(p.locator('#r12-models')).to_have_value('n122')
        assert not errors,errors
        return {'width':width,'models':120,'groups':3,'public_models':123,'errors':errors,'checks':['filter-select','cross-group-batch','cancel','invalid-price','preserve-output','save-failure-keeps-draft','saved-payload','group-search','picker-cancel']}
    finally:ctx.close()

if __name__=='__main__':
    OUT.mkdir(exist_ok=True,parents=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'frontend')))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            try:results=[run(browser,f'http://127.0.0.1:{server.server_port}',w) for w in (360,1440)]
            finally:browser.close()
        (OUT/'model-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(results)
    finally:server.shutdown();server.server_close()
