"""Measure the actual admin runtime. Local-only; no generation or production writes."""
import argparse, json, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

p=argparse.ArgumentParser();p.add_argument('--credentials',type=Path,required=True);p.add_argument('--output',type=Path,default=Path('output/mobile-r30/cold.json'));p.add_argument('--base',default='http://127.0.0.1:8191')
p.add_argument('--cpu',action='store_true');p.add_argument('--width',type=int,default=390)
a=p.parse_args();assert urlparse(a.base).hostname in ('localhost','127.0.0.1')
credentials=json.loads(a.credentials.read_text(encoding='utf-8-sig'));user=credentials.get('admin',credentials)
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,channel='chrome');context=browser.new_context(viewport={'width':a.width,'height':844 if a.width<768 else 900});page=context.new_page();errors=[]
    page.add_init_script("performance.setResourceTimingBufferSize(5000);window.__coldTasks=[];try{new PerformanceObserver(list=>window.__coldTasks.push(...list.getEntries().map(e=>({start:Math.round(e.startTime),ms:Math.round(e.duration)})))).observe({type:'longtask',buffered:true})}catch{}")
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(a.base+'/app/login.html');page.wait_for_load_state('networkidle')
    page.locator('input[type=email]:visible').fill(user['email']);page.locator('input[type=password]:visible').fill(user['password']);page.locator('button[type=submit]:visible').click();page.wait_for_url(lambda u:'login.html' not in u)
    if a.cpu:
        cdp=context.new_cdp_session(page);cdp.send('Profiler.enable');cdp.send('Profiler.start')
    page.goto(a.base+'/admin.html',wait_until='domcontentloaded')
    if a.width<768: page.get_by_label('管理后台功能',exact=True).select_option('dialogue-preview')
    else: page.get_by_role('button',name='会话工作区',exact=True).first.click()
    page.get_by_placeholder('输入名称或 ID').fill('R29 后台试聊验收');page.get_by_role('button',name='搜索',exact=True).click()
    expect(page.locator('select[aria-label="测试角色"] option')).not_to_have_count(1)
    page.evaluate("""()=>{document.addEventListener('click',e=>{if(e.target.closest('button')?.textContent==='开始会话'){window.__r31CoreAtClick=!!document.querySelector('#admin-dialogue-frame')?.contentWindow.performance.getEntriesByName('homer-prewarm-core-ready').length}},true);window.addEventListener('message',e=>{if(e.source===document.querySelector('#admin-dialogue-frame')?.contentWindow&&e.data?.type==='ready')requestAnimationFrame(()=>requestAnimationFrame(()=>performance.mark('r31-ready-painted')))})}""")
    start=time.perf_counter();page.get_by_role('button',name='开始会话',exact=True).click()
    frame=page.frame_locator('iframe[title="管理员会话工作区"]')
    expect(frame.locator('html')).to_have_class(__import__('re').compile('.*homer-runtime-ready.*'),timeout=90000)
    ready_ms=round((time.perf_counter()-start)*1000)
    if a.cpu:
        cpu=cdp.send('Profiler.stop')['profile']
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.with_suffix('.cpuprofile').write_text(json.dumps(cpu),encoding='utf-8')
    expect(frame.locator('#send_textarea')).to_be_enabled()
    expect(frame.locator('#send_textarea')).to_be_visible()
    frame.get_by_role('button',name='打开对话设置',exact=True).click();expect(frame.locator('#homer-admin-prompt')).to_be_visible()
    marks=frame.locator('html').evaluate("()=>performance.getEntriesByType('mark').filter(e=>e.name.startsWith('homer')).map(e=>({name:e.name,ms:Math.round(e.startTime)}))")
    profile=frame.locator('html').evaluate("""()=>({tasks:window.__coldTasks,resources:performance.getEntriesByType('resource').filter(e=>e.startTime<performance.getEntriesByName('homer-bootstrap-ready')[0].startTime).map(e=>({path:new URL(e.name).pathname.replace(/(avatars|characters|media-cache)\\/.*/, '$1/[redacted]'),start:Math.round(e.startTime),ms:Math.round(e.duration),size:e.transferSize,type:e.initiatorType}))})""")
    host_marks=page.evaluate("Object.fromEntries(['homer-admin-workspace-click','homer-admin-workspace-ready'].map(n=>[n,performance.getEntriesByName(n).at(-1)?.startTime]))")
    input_ms=round(host_marks['homer-admin-workspace-ready']-host_marks['homer-admin-workspace-click'])
    painted_ms=round(page.evaluate("performance.getEntriesByName('r31-ready-painted').at(-1).startTime-performance.getEntriesByName('homer-admin-workspace-click').at(-1).startTime"))
    core_ready_at_click=page.evaluate('window.__r31CoreAtClick')
    result={'ready_ms':ready_ms,'input_to_ready_ms':input_ms,'input_to_painted_ms':painted_ms,'core_ready_at_click':core_ready_at_click,'marks':marks,'profile':profile,'page_errors':errors,'sample_count':1,'viewport_width':a.width,'environment':'local fresh browser / actual APK assets'}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({k:result[k] for k in ['ready_ms','input_to_ready_ms','input_to_painted_ms','core_ready_at_click','page_errors']},ensure_ascii=False));browser.close()
