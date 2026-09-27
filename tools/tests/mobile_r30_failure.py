"""Local-only negative-path acceptance against APK assets; no generation."""
import argparse,json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
p=argparse.ArgumentParser();p.add_argument('--credentials',type=Path,required=True);p.add_argument('--output',type=Path,default=Path('output/mobile-r30/failure'));a=p.parse_args()
user=json.loads(a.credentials.read_text(encoding='utf-8-sig'));user=user.get('admin',user)
a.output.mkdir(parents=True,exist_ok=True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,channel='chrome');page=browser.new_page(viewport={'width':390,'height':844});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:8191/app/login.html');page.wait_for_load_state('networkidle')
    page.locator('input[type=email]:visible').fill(user['email']);page.locator('input[type=password]:visible').fill(user['password']);page.locator('button[type=submit]:visible').click();page.wait_for_url(lambda u:'login.html' not in u)
    page.route('**/api/homer/admin-preview?*',lambda route:route.fulfill(status=503,content_type='application/json',body='{"error":"测试连接暂不可用"}'))
    page.goto('http://127.0.0.1:8191/admin.html');page.wait_for_load_state('networkidle')
    page.get_by_label('管理后台功能',exact=True).select_option('dialogue-preview')
    page.get_by_placeholder('输入名称或 ID').fill('R29 后台试聊验收');page.get_by_role('button',name='搜索',exact=True).click()
    expect(page.locator('select[aria-label="测试角色"] option')).not_to_have_count(1)
    page.get_by_role('button',name='开始会话',exact=True).click()
    expect(page.locator('.admin-dialogue__error')).to_be_visible(timeout=30000)
    expect(page.get_by_role('button',name='开始会话',exact=True)).to_be_enabled()
    page.screenshot(path=str(a.output/'failed-with-retry.png'))
    frame=page.frame_locator('#admin-dialogue-frame');origin=frame.locator('html').evaluate('()=>performance.timeOrigin')
    page.unroute('**/api/homer/admin-preview?*')
    page.get_by_role('button',name='开始会话',exact=True).click()
    expect(frame.locator('#chat')).to_contain_text('后台独立测试对话',timeout=30000)
    expect(frame.locator('#send_textarea')).to_be_enabled()
    assert frame.locator('html').evaluate('()=>performance.timeOrigin')==origin
    assert not errors, errors
    (a.output/'report.json').write_text(json.dumps({'injected_status':503,'retry_same_frame':True,'messages_and_input_ready':True,'page_errors':errors}),encoding='utf-8')
    browser.close()
print('PASS: explicit failure, retry in same iframe, actual conversation ready; zero page errors.')
