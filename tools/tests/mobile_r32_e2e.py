"""Actual APK UI, local fixture backend; synthetic upstream only, no production calls."""
import argparse
import json
import sqlite3
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

p=argparse.ArgumentParser();p.add_argument('--credentials',type=Path,required=True);p.add_argument('--output',type=Path,default=Path('output/mobile-r32/browser'))
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
user=json.loads(a.credentials.read_text(encoding='utf-8-sig'));user=user.get('admin',user)
base='http://127.0.0.1:8191'
reports=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,channel='chrome')
    for width,height in [(390,844),(1440,900)]:
        context=browser.new_context(viewport={'width':width,'height':height})
        page=context.new_page();errors=[];http=[];generations=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('response',lambda r:http.append({'path':urlparse(r.url).path,'status':r.status}) if r.status>=400 else None)
        page.on('request',lambda r:generations.append(r.url) if r.method=='POST' and r.url.endswith('/api/backends/chat-completions/generate') else None)
        page.goto(base+'/app/login.html');page.wait_for_load_state('networkidle')
        page.locator('input[type=email]:visible').fill(user['email']);page.locator('input[type=password]:visible').fill(user['password']);page.locator('button[type=submit]:visible').click()
        page.wait_for_url(lambda u:'login.html' not in u)
        fixture=page.evaluate("""async()=>{
          const {api}=await import('/assets/js/api.js');const {api:app}=await import('/app/assets/js/app-core.js');const d=r=>r.data||r;
          await api.admin.saveLlmSettings({enabled:true,default_model_preset_id:'r32-node',presets:[{id:'r32-node',name:'本机故障验证',enabled:true,protocol:'openai',base_url:'http://127.0.0.1:8187/test-provider',api_key:'synthetic-not-a-real-key',model:'model-a',models:['model-a','model-b'],model_configs:[{model:'model-a',enabled:true,display_name:'测试模型 A',pricing:{mode:'per_request',input_price:3,output_price:4}},{model:'model-b',enabled:true,display_name:'测试模型 B',pricing:{mode:'per_request',input_price:3,output_price:4}}]}]});
          const card={spec:'chara_card_v2',spec_version:'2.0',data:{name:'R32 故障验收',description:'仅本机测试',first_mes:'测试会话已就绪',extensions:{}}};
          const imported=d(await app.importCard({card_file:'data:application/json;base64,'+btoa(unescape(encodeURIComponent(JSON.stringify(card)))),filename:'r32.json'}));
          const s=d(await app.dialogueSession(imported.id,'',{launchOnly:true}));return {app:imported.id,conversation:s.launch.conversation_id};
        }""")
        page.goto(base+'/app/chat.html?app_id='+str(fixture['app'])+'&conversation_id='+fixture['conversation'])
        frame=page.frame_locator('#dialogue-frame')
        expect(frame.locator('#send_textarea')).to_be_visible(timeout=90000)
        page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
        expect(frame.locator('#chat')).to_contain_text('测试会话已就绪')
        def balance():
            with sqlite3.connect('output/mobile-r29/test.sqlite3') as db:
                return db.execute('select points from users where email=?',(user['email'],)).fetchone()[0]
        before=balance()
        frame.locator('#send_textarea').fill('R32_FAIL');frame.locator('#send_but').click()
        notice=frame.locator('#homer-model-pause-notice')
        expect(notice).to_be_visible(timeout=30000);expect(notice).to_contain_text('请更换模型')
        expect(frame.locator('#send_but')).to_have_attribute('aria-disabled','true')
        expect(frame.locator('body')).not_to_have_class(__import__('re').compile(r'.*homer-generating.*'),timeout=15000)
        assert balance()==before,'Failure charged points'
        page.screenshot(path=str(a.output/f'paused-{width}.png'))
        count=len(generations)
        frame.locator('#send_textarea').fill('R32_OK');frame.locator('#send_textarea').press('Enter');frame.locator('#send_but').click()
        page.wait_for_timeout(400);assert len(generations)==count,'Paused model sent again'
        page.reload();page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
        expect(notice).to_be_visible(timeout=30000)
        expect(frame.locator('#send_but')).to_have_attribute('aria-disabled','true')
        assert balance()==before,'Reload changed failure billing'
        frame.locator('#send_textarea').fill('R32_OK')
        frame.get_by_role('button',name='打开对话设置',exact=True).click()
        # Use the actual model settings dialog, not a hidden config mutation.
        frame.locator('#homer-open-model-settings').click()
        dialog=frame.locator('#homer-model-dialog')
        expect(dialog).to_be_visible()
        model_select=dialog.locator('select')
        options=model_select.locator('option').evaluate_all('(xs)=>xs.map(x=>({value:x.value,text:x.textContent}))')
        second=next(o['value'] for o in options if '测试模型 B' in o['text'])
        model_select.select_option(second,force=True)
        dialog.get_by_role('button',name='保存到本次会话',exact=True).click()
        expect(dialog).not_to_be_visible(timeout=30000)
        expect(notice).not_to_be_visible()
        close_settings=frame.get_by_role('button',name='关闭设置',exact=True)
        if close_settings.is_visible(): close_settings.click()
        frame.locator('#send_textarea').fill('R32_OK');frame.locator('#send_but').click()
        try:
            expect(frame.locator('#chat')).to_contain_text('R32 生成成功',timeout=30000)
        except Exception:
            page.screenshot(path=str(a.output/f'failure-{width}.png'))
            state=frame.locator('body').evaluate("""async b=>({classes:b.className,
              send:document.querySelector('#send_but')?.outerHTML,
              input:document.querySelector('#send_textarea')?.value,
              model:(await import('/module/dialogue/scripts/openai.js')).oai_settings.openai_model,
              chatLength:document.querySelector('#chat')?.textContent.length,
              dialogs:[...document.querySelectorAll('dialog')].map(d=>({id:d.id,open:d.open}))})""")
            print(json.dumps({'state':state,'generation_count':len(generations),'before_switch_count':count,'errors':errors,'http':http},ensure_ascii=False))
            raise
        assert balance()==before-7,('Successful generation must charge once',before,balance())
        assert not errors,errors
        assert not http,http
        page.screenshot(path=str(a.output/f'success-{width}.png'))
        reports.append({'viewport':[width,height],'failure_uncharged':True,'blocked_click_and_enter':True,'reload_keeps_gate':True,'different_model_unlocks':True,'success_debit':7,'script_errors':errors,'http':http})
        context.close()
    browser.close()
(a.output/'report.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf-8')
print('PASS: mobile and desktop failure=0 points; click/Enter blocked; actual model switch unlocks; success=7 points once.')
