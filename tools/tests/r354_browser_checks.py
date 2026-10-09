"""Synthetic HTTP/SQLite + actual browser IndexedDB and shipping conflict dialog.
Not an Android-device or production-account performance claim.
"""
from pathlib import Path
import json
import os
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'output';OUT.mkdir(exist_ok=True)
URL='http://127.0.0.1:8794/'
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel=os.environ.get('HOMER_TEST_BROWSER_CHANNEL') or None)
    for width,height in [(390,844),(1440,900)]:
        a=browser.new_context(viewport={'width':width,'height':height});b=browser.new_context(viewport={'width':width,'height':height})
        pa=a.new_page();pb=b.new_page();errors=[];failures=[];console=[];http_errors=[]
        for page in (pa,pb):
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('requestfailed',lambda r:failures.append(r.url))
            page.on('console',lambda m:console.append(m.text) if m.type=='error' else None)
            page.on('response',lambda r:http_errors.append({'url':r.url,'status':r.status}) if r.status>=400 else None)
            page.goto(URL);page.wait_for_load_state('networkidle');page.wait_for_function('window.fixtureReady')
        baseline=int(pa.locator('#count').inner_text())
        assert baseline>=1101
        unchanged=pa.evaluate('fixture.read()')
        assert unchanged['storage']['unchanged'] and unchanged['messages']==[]
        pa.locator('textarea').fill('device-a-new');pa.locator('#save').click();pa.wait_for_function("document.querySelector('#last').textContent==='device-a-new'")
        pb.locator('textarea').fill('device-b-local');pb.locator('#save').click();pb.wait_for_function("document.querySelector('#status').textContent.includes('冲突')")
        pb.reload();pb.wait_for_load_state('networkidle');pb.wait_for_function('window.fixtureReady')
        assert pb.locator('#last').inner_text()=='device-b-local'
        pb.locator('#fork').click();dialog=pb.get_by_role('dialog');dialog.wait_for(state='visible')
        pb.screenshot(path=str(OUT/f'r354-conflict-{width}.png'))
        box=dialog.bounding_box();assert box['x']>=0 and box['x']+box['width']<=width
        pb.get_by_role('button',name='取消',exact=True).click();dialog.wait_for(state='detached')
        assert pb.locator('#last').inner_text()=='device-b-local'
        pb.locator('#fork').click();pb.get_by_role('button',name='另存本机进度',exact=True).click()
        pb.wait_for_function("document.querySelector('#status').textContent.includes('已另存')")
        child=pb.evaluate('fixture.getLaunch().conversation_id');assert child!='conv'
        cloud=a.request.get(URL+'read').json();fork=a.request.get(URL+'read?conv='+child).json()
        assert cloud['messages'][-1]['content']=='device-a-new'
        assert fork['messages'][-1]['content']=='device-b-local'
        assert len(cloud['messages'])==baseline+1 and len(fork['messages'])==baseline+1
        pa.reload();pa.wait_for_load_state('networkidle');pa.wait_for_function('window.fixtureReady')
        assert pa.locator('#last').inner_text()=='device-a-new'
        assert pa.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors and not failures, (errors,failures)
        assert len(http_errors)==1 and http_errors[0]['status']==409 and http_errors[0]['url'].endswith('/api/homer/sync'),http_errors
        assert len(console)<=1 and all('409' in line for line in console),console
        results.append({'viewport':[width,height],'baseline':baseline,'cloud_count':len(cloud['messages']),'fork_count':len(fork['messages']),'conditional_rows':0,'console_errors':errors,'expected_conflict_console':console,'expected_http_conflicts':http_errors,'request_failures':failures})
        a.close();b.close()
    browser.close()
(OUT/'r354-browser.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps(results))
# with_server stops its shell parent; explicitly terminate this task-owned
# synthetic server too, so Windows shell grandchildren cannot outlive the test.
urlopen(URL+'shutdown',timeout=3).close()
