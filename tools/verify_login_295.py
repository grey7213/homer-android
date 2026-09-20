"""Login failure-path checks plus real local-server recovery; no secret output."""
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
BASE='http://172.24.5.154:8080'
CREDENTIALS=Path('D:/网站/功能/AIXingYue-main/output/offline-dev/runtime/credentials.json')

def main():
    credentials=json.loads(CREDENTIALS.read_text(encoding='utf-8'))
    results=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe',headless=True)
        for width,height in ((390,844),(1440,900)):
            context=browser.new_context(viewport={'width':width,'height':height})
            page=context.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(e.message))
            page.goto(BASE+'/app/login.html?next=%2Fapp%2Fme.html',wait_until='networkidle')
            email=page.locator('input[x-model="loginForm.email"]')
            password=page.locator('input[x-model="loginForm.password"]')
            submit=page.locator('form').filter(has=email).locator('button[type="submit"]')
            email.fill(credentials['email']);password.fill(credentials['password'])
            held=[]
            def hold(route):held.append(route)
            context.route('**/console/api/login',hold)
            start=time.monotonic();submit.click()
            expect(page.get_by_role('alert')).to_contain_text('连接电脑测试服务超时',timeout=11000)
            elapsed=round((time.monotonic()-start)*1000)
            expect(submit).to_be_enabled();assert len(held)==1
            # No auto-resubmit after timeout.
            page.wait_for_timeout(400);assert len(held)==1
            context.unroute_all(behavior='ignoreErrors')
            for route in held:
                try:route.abort()
                except Exception:pass
            context.set_offline(True);submit.click()
            expect(page.get_by_role('alert')).to_contain_text('无法连接电脑测试服务')
            expect(submit).to_be_enabled()
            context.set_offline(False)
            password.fill(credentials['password']+'-invalid')
            submit.click();expect(page.get_by_role('alert')).not_to_be_empty()
            expect(submit).to_be_enabled()
            password.fill(credentials['password']);submit.click()
            page.wait_for_url('**/app/me.html',timeout=15000)
            expect(page.get_by_role('link',name='管理后台',exact=True)).to_be_visible()
            assert not errors,errors
            results.append({'viewport':[width,height],'timeout_ms':elapsed,'requests_during_timeout':len(held),'offline_recovery':True,'wrong_password_recovery':True,'real_login_admin':True,'script_errors':errors})
            context.close()
        browser.close()
    out=ROOT/'output/login-295';out.mkdir(parents=True,exist_ok=True)
    (out/'browser.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(results,ensure_ascii=False))

if __name__=='__main__':main()
