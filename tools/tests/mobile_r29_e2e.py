"""Local-only actual APK + backend + runtime test. Provider is a marked synthetic fixture."""
import argparse, base64, json
import sqlite3, uuid
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
p=argparse.ArgumentParser();p.add_argument('--credentials',type=Path,required=True);p.add_argument('--base',default='http://127.0.0.1:8191');p.add_argument('--output',type=Path,default=Path('output/mobile-r29/browser'))
p.add_argument('--width',type=int,choices=(390,1440),help='Reproduce one viewport; by default test both')
a=p.parse_args()
assert urlparse(a.base).hostname in ('127.0.0.1','localhost'), 'Local fixture only'
credential=json.loads(a.credentials.read_text(encoding='utf-8-sig')); user=credential.get('admin',credential)
a.output.mkdir(parents=True,exist_ok=True)
# A synthetic ordinary account in the disposable local database; no production writes.
test_db=Path('output/mobile-r29/test.sqlite3').resolve()
ordinary_email='r29-reader-'+uuid.uuid4().hex[:8]+'@example.invalid'
with sqlite3.connect(test_db) as db:
    db.row_factory=sqlite3.Row
    template=dict(db.execute('SELECT * FROM users WHERE email=?',(user['email'],)).fetchone())
    template.update(id=uuid.uuid4().hex,email=ordinary_email,name='普通用户验收',is_admin=0)
    columns=list(template)
    db.execute('INSERT INTO users ('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',[template[k] for k in columns])
report=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,channel='chrome')
    for width,height in [(390,844),(1440,900)]:
        if a.width and a.width != width: continue
        context=browser.new_context(viewport={'width':width,'height':height},permissions=['clipboard-read','clipboard-write'])
        page=context.new_page(); errors=[]; failed=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.on('response',lambda r: failed.append({'path':urlparse(r.url).path,'status':r.status}) if r.status>=400 else None)
        page.goto(a.base+'/app/login.html');page.wait_for_load_state('networkidle')
        page.locator('input[type=email]:visible').fill(user['email']);page.locator('input[type=password]:visible').fill(user['password']);page.locator('button[type=submit]:visible').click()
        page.wait_for_url(lambda u:'login.html' not in u,timeout=30000)
        fixture=page.evaluate("""async ()=>{
          const {api}=await import('/assets/js/api.js');
          const {api:app}=await import('/app/assets/js/app-core.js');
          const unwrap=r=>r.data||r;
          const prompt=unwrap(await api.admin.importGlobalPresetBundle({filename:'r29.json',preset:{name:'R29 预设验收',prompts:[{identifier:'main',name:'测试',role:'system',content:'R29_PRESET_MARKER',enabled:true}],prompt_order:[{character_id:100001,order:[{identifier:'main',enabled:true}]}],extensions:{regex_scripts:[{id:'r29-input',scriptName:'输入验证',findRegex:'/R29_INPUT_RAW/g',replaceString:'R29_INPUT_PROCESSED',placement:[1],promptOnly:true},{id:'r29-display',scriptName:'显示验证',findRegex:'/R29_RENDER_RAW/g',replaceString:'正则显示验证成功',placement:[2],markdownOnly:true}]}}}));
          await api.admin.saveLlmSettings({enabled:true,default_model_preset_id:'r29-node',presets:[{id:'r29-node',name:'本机验证',enabled:true,protocol:'openai',base_url:'http://127.0.0.1:8187/test-provider',api_key:'synthetic-not-a-real-key',model:'r29-test',models:['r29-test'],temperature:1,model_configs:[{model:'r29-test',enabled:true,display_name:'本机验收模型',prompt_preset_id:prompt.prompt_preset?.id,pricing:{mode:'per_request',points:0}}]}]});
          const card={spec:'chara_card_v2',spec_version:'2.0',data:{name:'R29 后台试聊验收',description:'只用于本机验收',first_mes:'你好，这是后台独立测试对话。',personality:'',scenario:'',mes_example:'',creator_notes:'',system_prompt:'',post_history_instructions:'',alternate_greetings:[],tags:[],creator:'test',character_version:'1',extensions:{}}};
          const imported=unwrap(await app.importCard({card_file:'data:application/json;base64,'+btoa(unescape(encodeURIComponent(JSON.stringify(card)))),filename:'r29-card.json'}));
          const before=unwrap(await (await fetch('/console/api/web/conversations')).json());
          return {id:imported.id,history:(before.list||[]).map(c=>c.id||c.conversation_id)};
        }""")
        page.goto(a.base+'/admin.html');page.wait_for_load_state('networkidle')
        page.screenshot(path=str(a.output/f'admin-{width}.png'),mask=[page.get_by_text(user['email'],exact=False)])
        if width < 768: page.get_by_label('管理后台功能',exact=True).select_option('dialogue-preview')
        else: page.get_by_role('button',name='会话工作区',exact=True).first.click()
        page.get_by_placeholder('输入名称或 ID').fill('R29 后台试聊验收');page.get_by_role('button',name='搜索',exact=True).click()
        page.wait_for_timeout(300)
        # Native select may be decorated by the shared accessible picker; bind via its change event.
        page.locator('select[aria-label="测试角色"]').select_option(fixture['id'],force=True)
        page.get_by_role('button',name='开始会话',exact=True).click()
        frame=page.frame_locator('iframe[title="管理员会话工作区"]')
        expect(frame.locator('#chat')).to_contain_text('后台独立测试对话',timeout=90000)
        frame.locator('#send_textarea').fill('R29_INPUT_RAW')
        frame.locator('#send_but').click()
        try: expect(frame.locator('#chat')).to_contain_text('正则显示验证成功',timeout=30000)
        except Exception:
            page.screenshot(path=str(a.output/f'failure-{width}.png'))
            diagnostic = None
            failure_copy = frame.get_by_role('button',name='复制本次失败日志',exact=True)
            if failure_copy.count():
                failure_copy.click()
                copied = json.loads(page.evaluate('navigator.clipboard.readText()'))
                diagnostic = {k:copied[k] for k in ('code','error_code','status','stage','duration_ms') if k in copied}
            print(json.dumps({'stage':'generate','errors':errors,'http':failed,'diagnostic':diagnostic},ensure_ascii=False))
            raise
        button=frame.get_by_role('button',name='复制诊断日志',exact=True).last
        expect(button).to_be_visible(timeout=10000);button.click()
        copied=json.loads(page.evaluate('navigator.clipboard.readText()'))
        assert copied['status']=='complete' and copied.get('prompt_revision') and copied.get('regex_count')==2, copied
        assert not any(key in copied for key in ['headers','api_key','messages','content','bridge_token'])
        # Save a new official display replacement in the backend, return to same test conversation.
        page.evaluate("""async()=>{const {api}=await import('/assets/js/api.js');const r=await api.admin.globalPresets(),d=r.data||r;const preset=d.regex.items.find(x=>x.id===d.regex.active_id);preset.scripts.find(x=>x.id==='r29-display').replaceString='最新正则已生效';await api.admin.saveGlobalPreset('regex',preset.id,preset)}""")
        frame.locator('#send_textarea').fill('R29_INPUT_RAW 第二轮');frame.locator('#send_but').click()
        expect(frame.locator('#chat')).to_contain_text('最新正则已生效',timeout=30000)
        # Full workspace: actual gear -> sidebar -> edit -> apply, not an admin-page shortcut.
        frame.get_by_role('button',name='打开对话设置',exact=True).click()
        frame.locator('#homer-open-model-settings').click()
        model=frame.locator('#homer-model-dialog')
        model.locator('.homer-model-field[data-key="temperature"] .homer-model-field__number').fill('0.65')
        model.get_by_role('button',name='保存到本次会话',exact=True).click()
        expect(model).not_to_be_visible()
        frame.get_by_role('button',name='打开对话设置',exact=True).click()
        frame.locator('#homer-admin-prompt').click()
        editor=frame.get_by_role('region',name='预设会话设置')
        # section has an accessible name and is a region.
        editor.locator('.haw-entry summary').first.click()
        editor.get_by_label('内容',exact=True).first.fill('R29_PRESET_MARKER R29_DRAFT_PROMPT')
        editor.get_by_role('button',name='应用到本次会话',exact=True).click()
        expect(editor.get_by_role('status')).to_have_text('已应用于本次会话，下一轮生成生效')
        editor.get_by_role('button',name='‹ 返回',exact=True).click()
        frame.locator('#homer-admin-worldbook').click()
        world=frame.get_by_role('region',name='世界书会话设置')
        world.get_by_role('button',name='＋ 添加条目',exact=True).click()
        world.get_by_label('内容',exact=True).last.fill('R29_DRAFT_WORLD')
        world.get_by_role('button',name='应用到本次会话',exact=True).click()
        expect(world.get_by_role('status')).to_have_text('已应用于本次会话，下一轮生成生效')
        page.screenshot(path=str(a.output/f'worldbook-{width}.png'))
        world.get_by_role('button',name='‹ 返回',exact=True).click()
        frame.locator('#homer-admin-regex').click()
        regex=frame.get_by_role('region',name='正则会话设置')
        regex.locator('.haw-entry summary').filter(has_text='显示验证').click()
        regex.get_by_label('替换内容',exact=True).last.fill('会话草稿正则生效')
        regex.get_by_role('button',name='应用到本次会话',exact=True).click()
        expect(regex.get_by_role('status')).to_have_text('已应用于本次会话，下一轮生成生效')
        assert not regex.evaluate('(node)=>node.scrollWidth>node.clientWidth+1'),'editor overflow'
        regex.get_by_role('button',name='‹ 返回',exact=True).click()
        page.screenshot(path=str(a.output/f'sidebar-{width}.png'))
        frame.get_by_role('button',name='关闭设置',exact=True).click()
        frame.locator('#send_textarea').fill('R29_INPUT_RAW ADMIN_DRAFT');frame.locator('#send_but').click()
        expect(frame.locator('#chat')).to_contain_text('会话草稿正则生效',timeout=30000)
        unchanged=page.evaluate("""async()=>{const {api}=await import('/assets/js/api.js');const r=await api.admin.globalPresets();return !JSON.stringify(r).includes('R29_DRAFT_PROMPT')&&!JSON.stringify(r).includes('会话草稿正则生效')}""")
        assert unchanged,'Session drafts changed global presets'
        frame.locator('#send_textarea').fill('TEST_FAILURE');frame.locator('#send_but').click()
        expect(frame.get_by_role('button',name='复制本次失败日志')).to_be_visible(timeout=30000)
        expect(frame.locator('body')).to_contain_text('HM-G502')
        frame.get_by_role('button',name='复制本次失败日志').click()
        copied_error=json.loads(page.evaluate('navigator.clipboard.readText()')); assert copied_error['error_code']=='HM-G502'
        try: expect(frame.locator('body')).not_to_have_class(__import__('re').compile(r'.*homer-generating.*'),timeout=10000)
        except Exception:
            print(json.dumps({'stage':'recovery','generating':frame.locator('body').evaluate("async()=> (await import('./script.js')).isGenerating()"),'errors':errors},ensure_ascii=False))
            raise
        expect(frame.locator('#chat')).not_to_contain_text('TEST_FAILURE',timeout=10000)
        after=page.evaluate("""async()=>{const r=await(await fetch('/console/api/web/conversations')).json();return(r.data||r).list.map(c=>c.id||c.conversation_id)}""")
        assert after==fixture['history'], 'Preview changed normal history'
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth + 1'), 'admin overflow'
        page.wait_for_timeout(3200)
        page.screenshot(path=str(a.output/f'preview-{width}.png'),mask=[page.get_by_text(user['email'],exact=False)])
        # Unauthenticated API access cannot create preview tokens.
        anonymous=browser.new_context();r=anonymous.request.get(a.base+'/admin/api/dialogue/preview?app_id='+fixture['id']);assert r.status in (401,403);anonymous.close()
        ordinary=browser.new_context()
        login=ordinary.request.post(a.base+'/console/api/login',data={'email':ordinary_email,'password':user['password']})
        assert login.ok
        denied=ordinary.request.get(a.base+'/admin/api/dialogue/preview?app_id='+fixture['id'])
        assert denied.status==403, 'Ordinary account acquired an admin preview token'
        denied=ordinary.request.post(a.base+'/admin/api/dialogue/configuration',data={'app_id':fixture['id'],'draft':{'prompt':{'prompts':[]}}})
        assert denied.status==403, 'Ordinary account could access admin configuration'
        ordinary.close()
        report.append({'viewport':[width,height],'history_unchanged':True,'workspace_prompt_worldbook_regex':True,'drafts_leave_global_unchanged':True,'model_parameters_saved':True,'copied_success':copied,'copied_error':copied_error,'page_errors':errors,'http':failed})
        assert not failed,failed
        assert not errors,errors
        context.close()
    browser.close()
(a.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('PASS: mobile + desktop, official prompt/regex, live preset refresh, isolated history, copied diagnostics, numbered SSE error + recovery, anonymous and ordinary account denial')
