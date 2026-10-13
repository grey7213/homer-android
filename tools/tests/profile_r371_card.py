"""Isolated final card frame timing; no credentials/provider or real archive."""
import json
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[2]
out=root/'output/mod-return-r368'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='msedge')
    page=browser.new_page(viewport={'width':390,'height':844})
    requests={};events=[];start=time.perf_counter()
    def ms():return round((time.perf_counter()-start)*1000)
    def begin(r):
        requests[r]={'path':urlparse(r.url).path,'host':urlparse(r.url).hostname,'start':ms(),'type':r.resource_type}
    def end(r):
        item=requests.pop(r,{})
        if item:events.append({**item,'end':ms(),'failed':r.failure})
    page.on('request',begin);page.on('requestfinished',end);page.on('requestfailed',end)
    page.goto('http://127.0.0.1:8817/qa/host')
    live=next(f for f in page.frames if '/module/dialogue/' in f.url)
    live.wait_for_function("document.documentElement.classList.contains('homer-runtime-ready')")
    live.evaluate("""(()=>{window.r371Events=[];let prior=null;const c=SillyTavern.getContext();for(const type of ['chat_id_changed','chatLoaded','message_updated','character_message_rendered','message_deleted','settings_updated','settings_loaded'])c.eventSource.on(type,(...args)=>{const source=[...document.querySelectorAll('#chat .TH-render > pre code')].map(e=>e.textContent).join('');r371Events.push({type,ms:Math.round(performance.now()),sameSource:prior===source,sourceLength:source.length,stack:new Error().stack});if(source)prior=source})})()""")
    live.get_by_role('button',name='打开导航与历史会话',exact=True).click()
    events.clear();start=time.perf_counter()
    live.locator('[data-conversation-id="qa-b"] .homer-history-item__main').click()
    timeline=[];last=None
    for _ in range(220):
        state=live.evaluate("""(()=>{const frames=[...document.querySelectorAll('#chat iframe[id^=TH-message]')];return {conv:SillyTavern.getContext().chatMetadata.homer_bridge?.conversation_id,ready:!document.body.classList.contains('homer-switching-chat'),frames:frames.map(f=>({id:f.id,ready:f.contentDocument?.readyState,len:f.contentDocument?.body?.textContent.trim().length,height:Math.round(f.getBoundingClientRect().height),fonts:f.contentDocument?.fonts?.status,resources:f.contentWindow?.performance.getEntriesByType('resource').map(r=>({name:new URL(r.name,location.href).pathname,duration:Math.round(r.duration)}))}))}})()""")
        sig=json.dumps(state,ensure_ascii=False)
        if last!=sig:timeline.append({'ms':ms(),**state});last=sig
        if state.get('conv')=='qa-b' and state['ready'] and state['frames'] and all(f['ready']=='complete' and f['len'] and f['height']>100 for f in state['frames']):break
        page.wait_for_timeout(25)
    page.screenshot(path=str(out/'r371-profile-final.png'))
    internal=live.evaluate('r371Events')
    (out/'r371-profile.json').write_text(json.dumps({'timeline':timeline,'events':internal,'requests':events,'pending':list(requests.values())},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'timeline':[{k:v if k!='frames' else [{fk:fv for fk,fv in f.items() if fk!='resources'} for f in v] for k,v in t.items()} for t in timeline],'events':internal,'slow_requests':[r for r in events if r['end']-r['start']>900]},ensure_ascii=False))
    browser.close()
