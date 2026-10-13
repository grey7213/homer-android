"""Real iframe: unavailable font CSS cannot block scripts/play; font later applies.

Uses synthetic markup and intercepts the font request locally, no Google request
or account/provider operation. Separately verified in the full Android Activity.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[2]
out=root/'output/mod-return-r368';out.mkdir(parents=True,exist_ok=True)
html='''<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=R371Fixture" onload="window.fontLoaded=true"><style>body{font:16px system-ui}button{min-height:44px}</style></head><body><p>字体下载未完成也能使用卡片</p><button id=play onclick="this.textContent='操作完成'">开始</button><script>window.cardReady=true;</script></body></html>'''
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='msedge')
    for viewport in [{'width':390,'height':844},{'width':1440,'height':900}]:
        page=browser.new_page(viewport=viewport);pending=[];errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('https://fonts.googleapis.com/**',lambda route:pending.append(route))
        page.goto('http://127.0.0.1:8817/qa/setup')
        page.evaluate('''async html=>{const {deferRemoteFontStylesheets}=await import('/module/dialogue/scripts/homer-async-fonts.mjs');document.body.innerHTML='<iframe id=card style="width:100%;height:400px;border:0"></iframe>';document.querySelector('#card').srcdoc=deferRemoteFontStylesheets(html,true)}''',html)
        card=page.frame_locator('#card');card.locator('#play').wait_for()
        frame=next(f for f in page.frames if f!=page.main_frame)
        frame.wait_for_function("document.readyState==='complete'&&window.cardReady")
        assert not frame.evaluate('!!window.fontLoaded')
        origin=frame.evaluate('performance.timeOrigin')
        card.locator('#play').click();assert card.locator('#play').inner_text()=='操作完成'
        page.wait_for_function("!!document.querySelector('#card').contentDocument.querySelector('link[href]')")
        assert len(pending)==1
        pending[0].fulfill(status=200,content_type='text/css',body='body{--r371-font-sheet-loaded:1}')
        frame.wait_for_function("window.fontLoaded===true&&getComputedStyle(document.body).getPropertyValue('--r371-font-sheet-loaded').trim()==='1'")
        assert frame.evaluate('performance.timeOrigin')==origin
        assert not errors
        results.append({'viewport':viewport,'card_scripts_and_button_before_font':True,'font_download_and_stylesheet_retained':True,'same_document':True,'console_errors':errors,'scope':'Synthetic iframe, deliberately held font CSS, not device/provider timing'})
        page.close()
    browser.close()
(out/'async-fonts-browser.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
