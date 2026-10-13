"""Shipping local-first helpers + actual Chromium IDB + transactional SQLite.
Not a device timing or real-account test. Offline mode denies API transport but
retains app assets, matching Android's bundled-asset availability.
"""
from pathlib import Path
import json
import os
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

URL='http://127.0.0.1:8794/'
OUT=Path(__file__).resolve().parents[2]/'output'
OUT.mkdir(exist_ok=True)
results=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,channel=os.environ.get('HOMER_TEST_BROWSER_CHANNEL') or 'chrome')
    for width,height in [(390,844),(1440,900)]:
        a=browser.new_context(viewport={'width':width,'height':height})
        b=browser.new_context(viewport={'width':width,'height':height})
        pa=a.new_page();pb=b.new_page();errors=[];failures=[]
        for page in (pa,pb):
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('requestfailed',lambda r:failures.append(r.url))
            page.goto(URL);page.wait_for_load_state('networkidle');page.wait_for_function('window.fixtureReady')
        baseline=int(pa.locator('#count').inner_text())
        assert baseline>=1101
        pa.evaluate("fixture.edit('phone-a');");pa.evaluate('fixture.flush()')
        pb.evaluate('fixture.setOffline(true)')
        pb.evaluate("fixture.edit('phone-b-offline')")
        pb.evaluate('fixture.flush()')
        assert pb.evaluate('fixture.pending()')
        assert pb.locator('#last').inner_text()=='phone-b-offline'
        pb.evaluate('fixture.delete('+str(baseline)+')')
        assert int(pb.locator('#count').inner_text())==baseline
        assert pb.evaluate('fixture.pending()')
        pb.evaluate("fixture.edit('phone-b-retained')")
        pb.reload();pb.wait_for_load_state('networkidle');pb.wait_for_function('window.fixtureReady')
        # Startup fetchSession takes phone archive before any cloud request.
        assert pb.locator('#last').inner_text()=='phone-b-retained'
        pb.evaluate('fixture.setOffline(true)')
        pb.evaluate('fixture.open()')
        assert pb.locator('#last').inner_text()=='phone-b-retained'
        pb.evaluate('fixture.rollback('+str(baseline)+')')
        assert int(pb.locator('#count').inner_text())==baseline
        pb.evaluate("fixture.edit('phone-b-current')")
        pb.evaluate('fixture.flush()')
        pb.evaluate('fixture.setOffline(false)')
        # Exact product upload performs one verified rebase after CAS conflict;
        # provider retains prior cloud body atomically, no forced fork UI.
        pb.evaluate('fixture.open()')
        assert pb.locator('#last').inner_text()=='phone-b-current'
        pb.evaluate("fixture.edit('live-reconnect')")
        pb.evaluate('fixture.flush()')
        assert not pb.evaluate('fixture.pending()')
        cloud=a.request.get(URL+'read').json()
        backups=a.request.get(URL+'backups').json()['count']
        assert cloud['messages'][-1]['content']=='live-reconnect' and backups>=2
        pa.evaluate('fixture.open()')
        assert pa.locator('#last').inner_text()=='phone-a'
        assert not errors and not failures,(errors,failures)
        pb.screenshot(path=str(OUT/f'r354-local-first-{width}.png'))
        results.append({'viewport':[width,height],'complete_messages':baseline,'offline_unsynced_delete':True,
            'offline_rollback':True,'offline_reopen':True,'phone_progress_not_replaced':True,'cas_rebase_upload':True,
            'cloud_backups':backups,'script_errors':errors,'request_failures':failures})
        a.close();b.close()
    browser.close()
(OUT/'r354-local-first-browser.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps(results))
urlopen(URL+'shutdown',timeout=3).close()
