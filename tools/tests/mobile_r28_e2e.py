"""Test packaged Android assets against local APIs; never use production accounts."""
import argparse
import json
import mimetypes
import zipfile
import base64
from pathlib import Path
from urllib.parse import urlparse, unquote, parse_qs
from playwright.sync_api import sync_playwright, expect

p = argparse.ArgumentParser()
p.add_argument('--credentials', type=Path, required=True)
p.add_argument('--base', default='http://127.0.0.1:8082')
p.add_argument('--runtime', default='')
p.add_argument('--media', default='')
p.add_argument('--only-chat', action='store_true')
p.add_argument('--native-proxy', action='store_true')
p.add_argument('--incomplete-session', action='store_true', help='Exercise full-session fallback after an ID-only embedded response')
p.add_argument('--apk', type=Path, default=Path('android-app/app/build/outputs/apk/debug/app-debug.apk'))
p.add_argument('--output', type=Path, default=Path('output/mobile-r28/browser'))
args = p.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
credentials = json.loads(args.credentials.read_text(encoding='utf-8-sig'))
user = credentials.get('admin', credentials)
apk = zipfile.ZipFile(args.apk)
assets = set(apk.namelist())

def intercept(route):
    path = unquote(urlparse(route.request.url).path)
    # The isolated copied test DB retains R27's old local origin in media URLs.
    # Replay its real fixture bytes, not unrelated services now using that port.
    if path.startswith('/media-cache/'):
        rel = Path(path[len('/media-cache/'):])
        media = Path('D:/网站/功能/AIXingYue-main/output/offline-dev/data/media') / rel
        if '..' not in rel.parts and media.is_file():
            if args.media:
                return route.continue_(url=args.media + '/' + rel.as_posix())
            return route.fulfill(status=200, content_type=mimetypes.guess_type(media.name)[0] or 'image/png', body=media.read_bytes())
        if path == '/media-cache/profile/default-avatar.png':
            return route.fulfill(status=200, content_type='image/png', body=apk.read('assets/client/web/assets/img/apk/default_avatar.png'))
    mapped = None
    if path in ('/app', '/app/'): mapped = 'web/app/index.html'
    elif path.startswith(('/app/', '/assets/')) or path in ('/admin.html', '/dashboard.html', '/favicon.ico'): mapped = 'web' + path
    elif path in ('/module/dialogue', '/module/dialogue/'): mapped = 'runtime/index.html'
    elif path.startswith('/module/dialogue/'): mapped = 'runtime/' + path[len('/module/dialogue/'):]
    elif path.startswith(('/scripts/', '/lib/', '/css/', '/webfonts/', '/locales/', '/sounds/')) or path in ('/script.js', '/lib.js', '/style.css'): mapped = 'runtime' + path
    if mapped:
        mapped = mapped.replace('third-party/dialogue-memory-books/', 'third-party/SillyTavern-MemoryBooks/')
        name = 'assets/client/' + mapped
        if name in assets:
            mime = 'text/javascript' if name.endswith(('.js', '.mjs')) else mimetypes.guess_type(name)[0] or 'application/octet-stream'
            return route.fulfill(status=200, content_type=mime, body=apk.read(name))
    if args.runtime and path.startswith(('/module/dialogue/', '/api/', '/csrf-token', '/user/')):
        runtime_path = path[len('/module/dialogue'):] if path.startswith('/module/dialogue/') else path
        query = urlparse(route.request.url).query
        headers = route.request.all_headers()
        headers.update({'x-forwarded-prefix':'/module/dialogue', 'host':urlparse(args.base).netloc})
        response = route.fetch(url=args.runtime + runtime_path + ('?' + query if query else ''), headers=headers)
        return route.fulfill(response=response)
    route.continue_()

legacy_apis = """
delete AbortSignal.prototype.throwIfAborted;
delete AbortSignal.prototype.reason;
delete AbortSignal.timeout; delete AbortSignal.any;
delete Array.prototype.at; delete Object.hasOwn;
delete Promise.withResolvers; delete window.structuredClone;
delete Crypto.prototype.randomUUID;
delete HTMLDialogElement.prototype.show; delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close;
"""
report = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, channel='chrome')
    try:
        # Reproduce the formal source's API bug independently of a remote outage.
        baseline = browser.new_page()
        baseline.goto(args.base + '/app/login.html')
        baseline.wait_for_load_state('networkidle')
        defect = baseline.evaluate("""async source=>{
            delete AbortSignal.prototype.throwIfAborted;
            const {apiText}=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));
            let calls=0;try {await apiText('/test',{}, {fetchImpl:async()=>{calls++;return {text:async()=> 'ok'}}});}
            catch(e){return {name:e.name,calls}};return {calls};
        }""", Path('frontend/assets/js/api-transport.js').read_text(encoding='utf-8'))
        assert defect == {'name': 'ApiConnectionError', 'calls': 0}, defect
        baseline.close()
        report.append({'before': defect})
        for width, height in [(390, 844), (1440, 900)]:
            ctx = browser.new_context(viewport={'width': width, 'height': height})
            if not args.native_proxy: ctx.route(args.base + '/**', intercept)
            if not args.native_proxy: ctx.route('http://127.0.0.1:8082/media-cache/**', intercept)
            incomplete_sessions = []
            if args.incomplete_session:
                def incomplete_session(route):
                    query = parse_qs(urlparse(route.request.url).query)
                    if not query.get('conversation_id'):
                        return route.continue_()
                    incomplete_sessions.append(True)
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'data': {'launch': {
                        'app_id': query.get('app_id', [''])[0],
                        'conversation_id': query['conversation_id'][0],
                    }}}))
                ctx.route('**/api/homer/session?*', incomplete_session)
            ctx.add_init_script(legacy_apis)
            page = ctx.new_page()
            errors, network, cancellations = [], [], []
            inflight = {}
            page.on('request', lambda r: inflight.update({r: urlparse(r.url).path}))
            page.on('requestfinished', lambda r: inflight.pop(r, None))
            page.on('requestfailed', lambda r: inflight.pop(r, None))
            page.on('pageerror', lambda e: errors.append(str(e)))
            def failed(r):
                item={'path':urlparse(r.url).path,'error':r.failure}
                # Runtime intentionally supersedes its model-status probe;
                # navigation cancels notification reads. Keep them in evidence,
                # but do not misclassify a client cancellation as a server error.
                expected = r.failure == 'net::ERR_ABORTED' and item['path'] in (
                    '/module/dialogue/api/backends/chat-completions/status', '/console/api/public/notifications')
                (cancellations if expected else network).append(item)
            page.on('requestfailed', failed)
            page.on('response', lambda r: network.append({'path': urlparse(r.url).path, 'status': r.status}) if r.status >= 400 else None)
            page.goto(args.base + '/app/login.html')
            page.wait_for_load_state('networkidle')
            assert page.evaluate('HomerWebViewCompatibility.minimumChromium') == 89
            behavior = page.evaluate("""async()=>{
              const {apiText}=await import('/assets/js/api-transport.js');let calls=0;
              const ok=await apiText('/test',{}, {fetchImpl:async()=>{calls++;return {text:async()=> 'ok'}}});
              const parent=new AbortController(),sig=AbortSignal.any([parent.signal]);parent.abort('cancelled');
              let reason;try{sig.throwIfAborted()}catch(e){reason=e}
              const holder=document.createElement('div');document.body.append(holder);holder.innerHTML='<dialog><button>关闭</button></dialog>';
              const dialog=holder.firstChild;dialog.close();dialog.showModal();const opened=dialog.open;dialog.close();dialog.close();const closed=!dialog.open;holder.remove();
              return {calls,text:ok.text,reason,opened,closed,at:[1,2].at(-1),clone:structuredClone({a:1}).a,
                hasOwn:Object.hasOwn({a:1},'a'),promise:typeof Promise.withResolvers,uuid:crypto.randomUUID().length};
            }""")
            assert behavior == {'calls':1,'text':'ok','reason':'cancelled','opened':True,'closed':True,'at':2,'clone':1,'hasOwn':True,'promise':'function','uuid':36}, behavior
            page.locator('input[type=email]:visible').fill(user['email'])
            page.locator('input[type=password]:visible').fill(user['password'])
            page.locator('button[type=submit]:visible').click()
            try:
                page.wait_for_url(lambda u: 'login.html' not in u, timeout=30000)
            except Exception:
                print(json.dumps({'stage':'login','errors':errors,'network':network},ensure_ascii=False),flush=True)
                raise
            visited = []
            for name in ([] if args.only_chat else ['community', 'explore', 'workshop', 'histories', 'me']):
                try:
                    page.goto(args.base + '/app/' + name + '.html')
                except Exception:
                    print(json.dumps({'stage':name,'inflight':list(inflight.values()),'errors':errors,'network':network},ensure_ascii=False),flush=True)
                    raise
                page.wait_for_load_state('networkidle')
                expect(page.locator('body')).to_be_visible()
                assert page.evaluate('document.body.innerText.trim().length') > 15
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth+1'), name
                page.screenshot(path=str(args.output / f'{name}-{width}.png'), mask=[page.get_by_text(user['email'], exact=False)])
                visited.append(name)
            if args.runtime:
                card = {'spec':'chara_card_v2','spec_version':'2.0','data':{'name':'兼容性验收','first_mes':'这是本机兼容性验收消息。','description':'测试角色','personality':'','scenario':'','mes_example':'','creator_notes':'','system_prompt':'','post_history_instructions':'','alternate_greetings':[],'tags':[],'creator':'test','character_version':'1','extensions':{}}}
                payload = 'data:application/json;base64,' + base64.b64encode(json.dumps(card,ensure_ascii=False).encode()).decode()
                target = page.evaluate("""async payload=>{
                  const {api}=await import('/app/assets/js/app-core.js');
                  const app=(await api.importCard({card_file:payload,filename:'compat-test.json'})).data;
                  const conv=(await api.startConversation({app_id:app.id})).data;
                  return '/app/chat.html?app_id='+app.id+'&conversation_id='+(conv.conversation_id||conv.id);
                }""", payload)
                page.goto(args.base + target, wait_until='domcontentloaded')
                try:
                    page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
                except Exception:
                    print(json.dumps({'stage':'chat','errors':errors,'network':network},ensure_ascii=False),flush=True)
                    raise
                runtime = next(f for f in page.frames if '/module/dialogue/' in f.url)
                expect(runtime.locator('#chat')).to_contain_text('这是本机兼容性验收消息。')
                if args.incomplete_session:
                    assert incomplete_sessions, 'The incomplete embedded session path was not exercised'
                page.screenshot(path=str(args.output / f'chat-{width}.png'))
                visited.append('chat-real-runtime')
            assert not errors, errors
            assert not network, network
            report.append({'width':width,'compatibility':behavior,'pages':visited,'pageErrors':errors,'networkErrors':network,'cancellations':cancellations})
            ctx.close()
    except Exception as error:
        report.append({'passed':False,'failureType':type(error).__name__, 'errors':globals().get('errors',[]), 'network':globals().get('network',[])})
        (args.output / 'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        raise
    finally:
        browser.close()
        apk.close()
(args.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
