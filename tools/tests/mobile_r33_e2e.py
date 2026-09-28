"""Actual APK assets + real backend tasks/credits; synthetic local image supplier."""
import argparse
import json
import sqlite3
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

p=argparse.ArgumentParser();p.add_argument('--credentials',type=Path,required=True);p.add_argument('--output',type=Path,default=Path('output/mobile-r33/browser'));a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
user=json.loads(a.credentials.read_text(encoding='utf-8-sig'));user=user.get('admin',user)
base='http://127.0.0.1:8191';reports=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,channel='chrome')
    for width,height in [(390,844),(1440,900)]:
        context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];http=[];console_errors=[];network=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m:console_errors.append(m.text) if m.type=='error' else None)
        page.on('requestfailed',lambda r:network.append({'path':urlparse(r.url).path,'failure':r.failure}) if 'ERR_ABORTED' not in str(r.failure) else None)
        page.on('response',lambda r:http.append({'path':urlparse(r.url).path,'status':r.status}) if r.status>=400 else None)
        page.goto(base+'/app/login.html');page.wait_for_load_state('networkidle')
        page.locator('input[type=email]:visible').fill(user['email']);page.locator('input[type=password]:visible').fill(user['password']);page.locator('button[type=submit]:visible').click();page.wait_for_url(lambda u:'login.html' not in u)
        page.goto(base+'/admin.html');page.wait_for_load_state('networkidle')
        if width < 700: page.get_by_label('管理后台功能',exact=True).select_option('image-models',force=True)
        else: page.get_by_role('button',name='生图模型',exact=True).click()
        section=page.locator('#admin-image-models');expect(section).to_be_visible();expect(section.get_by_role('button',name='添加模型',exact=True)).to_be_enabled()
        # Reset only this disposable fixture image catalog; all edits below use real form controls.
        page.evaluate("async()=>{const {api}=await import('/assets/js/api.js');await api.saveImageModels([]);await Alpine.$data(document.querySelector('main[x-data]')).loadImageModels();}")
        section.get_by_role('button',name='添加模型',exact=True).click()
        section.get_by_label('展示名称',exact=True).fill('本机生图验收')
        section.get_by_label('模型标识',exact=True).fill('fixture-image')
        section.get_by_label('API 地址',exact=False).fill('https://example.com/v1')
        section.locator('input[type=password]').fill('synthetic-fixture-placeholder')
        section.get_by_label('单张积分',exact=True).fill('7')
        section.get_by_label('向用户开放',exact=True).check()
        section.get_by_role('button',name='保存全部生图模型',exact=True).click()
        expect(section.locator('input[type=password]')).to_have_value('')
        expect(section.locator('[role=alert]')).not_to_be_visible()
        page.screenshot(path=str(a.output/f'admin-{width}.png'))
        fixture=page.evaluate("""async()=>{
          const {api:app}=await import('/app/assets/js/app-core.js');const d=r=>r.data||r;
          const card={spec:'chara_card_v2',spec_version:'2.0',data:{name:'生图交互验收',description:'仅本机合成数据',first_mes:'窗边的花瓶，远处是山。',extensions:{}}};
          const imported=d(await app.importCard({card_file:'data:application/json;base64,'+btoa(unescape(encodeURIComponent(JSON.stringify(card)))),filename:'r33.json'}));
          const s=d(await app.dialogueSession(imported.id,'',{launchOnly:true}));return {app:imported.id,conversation:s.launch.conversation_id};
        }""")
        page.goto(base+'/app/chat.html?app_id='+str(fixture['app'])+'&conversation_id='+fixture['conversation'])
        frame=page.frame_locator('#dialogue-frame');expect(frame.locator('#send_textarea')).to_be_visible(timeout=90000);page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
        expect(frame.locator('#chat')).to_contain_text('窗边的花瓶')
        def balance():
            with sqlite3.connect('output/mobile-r29/test.sqlite3') as db:return db.execute('SELECT points FROM users WHERE email=?',(user['email'],)).fetchone()[0]
        before=balance()
        def open_sheet():
            frame.locator('#chat .mes').first.click(button='right')
            frame.locator('#homer-message-menu-dialog').get_by_role('menuitem',name='生图',exact=True).click()
            sheet=frame.locator('#homer-image-sheet');expect(sheet).to_be_visible();expect(sheet).to_contain_text('本机生图验收');return sheet
        sheet=open_sheet();expect(sheet.get_by_role('button',name='生成',exact=True)).to_be_disabled()
        sheet.get_by_label('图片内容',exact=True).fill('窗边的一瓶花，背景为远山，柔和的紫色和绿色。')
        expect(sheet).to_contain_text('7 积分');page.screenshot(path=str(a.output/f'sheet-{width}.png'))
        rect=sheet.bounding_box();assert rect['width']<=width and rect['x']>=0
        sheet.get_by_role('button',name='生成',exact=True).click();expect(sheet).not_to_be_visible(timeout=15000)
        generated=frame.locator('.homer-generated-image img');expect(generated).to_be_visible(timeout=20000)
        expect(generated).to_have_js_property('naturalWidth',640);assert balance()==before-7
        page.screenshot(path=str(a.output/f'success-{width}.png'))
        page.reload();page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
        expect(generated).to_be_visible(timeout=20000);expect(generated).to_have_js_property('naturalWidth',640);assert balance()==before-7
        sheet=open_sheet();sheet.get_by_label('图片内容',exact=True).fill('R33_FAIL')
        sheet.get_by_role('button',name='生成',exact=True).click();expect(sheet).not_to_be_visible(timeout=15000)
        expect(frame.locator('.homer-generated-images')).to_contain_text('本次未扣积分',timeout=20000);assert balance()==before-7
        sheet=open_sheet();sheet.get_by_role('button',name='取消',exact=True).click();expect(sheet).not_to_be_visible();assert balance()==before-7
        page.evaluate("localStorage.setItem('ai_xingyue_shell_theme','dark')")
        page.reload();page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
        sheet=open_sheet();sheet.get_by_label('图片内容',exact=True).fill('暗色模式验收')
        page.screenshot(path=str(a.output/f'sheet-dark-{width}.png'))
        colors=sheet.evaluate("e=>({bg:getComputedStyle(e).backgroundColor,text:getComputedStyle(e).color})")
        assert colors['bg']!=colors['text'],colors
        sheet.press('Escape');expect(sheet).not_to_be_visible()
        page.evaluate("localStorage.setItem('ai_xingyue_shell_theme','light')")
        # Verify real HTTP authorization without recording cookies or changing production data.
        public=context.request.get(base+'/console/api/web/images/providers');assert public.status==200
        assert all(set(m)<= {'id','name','memo','cost_points'} for m in public.json()['data']['list'])
        anonymous=browser.new_context();assert anonymous.request.get(base+'/console/api/web/images/providers').status==401;anonymous.close()
        with sqlite3.connect('output/mobile-r29/test.sqlite3') as db:
            old_admin=db.execute('SELECT is_admin FROM users WHERE email=?',(user['email'],)).fetchone()[0]
            db.execute('UPDATE users SET is_admin=0 WHERE email=?',(user['email'],));db.commit()
        try:
            assert context.request.get(base+'/admin/api/image-models').status==403
            assert context.request.post(base+'/admin/api/image-models',data={'list':[]}).status==403
            assert context.request.get(base+'/console/api/web/images/providers').status==200
            assert context.request.get(base+'/console/api/web/images/history?conversation_id='+fixture['conversation']).status==200
        finally:
            with sqlite3.connect('output/mobile-r29/test.sqlite3') as db:
                db.execute('UPDATE users SET is_admin=? WHERE email=?',(old_admin,user['email']));db.commit()
        assert not errors,errors;assert not http,http;assert not console_errors,console_errors;assert not network,network
        reports.append({'viewport':[width,height],'admin_save':True,'long_press_entry':True,'success_cost':7,'reload_image':True,'failure_cost':0,'cancel_cost':0,'regular_user_permission':True,'anonymous_denied':True,'public_keys_redacted':True,'dark_colors':colors,'script_errors':errors,'http_errors':http,'console_errors':console_errors,'request_failures':network})
        context.close()
    browser.close()
(a.output/'report.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf-8')
print('PASS: mobile/desktop admin → long-press → image → reload → failure → cancel; credit and error checks passed.')
