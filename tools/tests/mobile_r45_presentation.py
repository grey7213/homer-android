"""Synthetic regression of actual APK/WebView inputs, not a website demo or real-card proof.

Runs source assets first, then --apk uses exclusively compiled packaged assets.
No account/provider data, production writes or third-party code in fixtures.
"""
import argparse
import json
import mimetypes
import zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
HTML = r'''<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/runtime/scripts/extensions/homer-bridge/style.css">
<link rel="stylesheet" href="/assets/css/chat-design.css">
<link rel="stylesheet" href="/assets/css/chat-settings-page.css">
<style>html,body{margin:0;min-height:100%;background:#212121}#chat{display:block!important;position:static!important;width:100%!important;height:auto!important;padding:12px!important;box-sizing:border-box;overflow:visible!important}.mes{position:static!important}dialog{max-width:100%}</style>
</head><body class="homer-runtime homer-app-ready"><main id="chat"></main>
<script type="module">
const ui=await import('/assets/js/tavo-chat-ui.js');await ui.loadTavoUi();
const tone=await import('/assets/js/message-tones.js');
const appearance=await import('/assets/js/chat-appearance.js');
window.scope={owner:'synthetic-owner',conversation:'a'};
window.appearance=appearance.bindChatAppearance(()=>window.scope);
window.ui=ui;window.tone=tone;
window.addMessage=(id,markup,user=false)=>{
 const mes=document.createElement('div');mes.className='mes';mes.setAttribute('is_user',String(user));mes.id=id;
 const block=document.createElement('div');block.className='mes_block';const text=document.createElement('div');text.className='mes_text';text.innerHTML=markup;block.append(text);mes.append(block);document.querySelector('#chat').append(mes);
 ui.decorateTavoMessage(mes,{id,isUser:user});tone.decorateMessage(text);return mes;
};
addMessage('plain','<p>夜色降临。“你好，<strong>旅人</strong>。”（轻声） (quietly) <em>若有所思</em></p><p>「欢迎」 『谢谢』 "hello"</p>');
addMessage('mixed','<p>“状态良好。”（点头）</p><iframe title="作者界面" srcdoc="&lt;button style=\'border:3px solid #bb6699;background:#132435;color:#fff\' onclick=\'this.textContent=String(++window.n)\'&gt;操作&lt;/button&gt;&lt;script&gt;window.n=0;window.identity={id:42}&lt;/script&gt;"></iframe><p>我们继续。</p>');
addMessage('fenced','<pre><code class="custom-language-html">&lt;!doctype html&gt;&lt;html&gt;&lt;script&gt;const a="hello";&lt;/script&gt;&lt;/html&gt;</code></pre>');
addMessage('ordinary-code','<p>这是代码。</p><pre><code class="language-js">const x="hello";</code></pre>');
addMessage('user','<p>“我准备好了。”（挥手）</p>',true);
addMessage('protected','<p>“正常” <a href="#">“链接”</a><code>"代码"</code><span class="katex">(公式)</span></p><div class="homer-card-component" style="border:4px solid #9f71c3;color:#aabbcc">“作者自绘” (自绘)</div>');
addMessage('inline-author','<div class="creator-panel" style="border:2px solid #888;background:#123456;color:#ccddee"><p>“自绘正文” (保持原样)</p></div>');
addMessage('core-q','<p><q>“核心已经包了引号”</q></p>');
window.ready=true;
</script></body></html>'''

CHECK = '''async()=>{
const q=id=>document.querySelector('#'+id+' .mes_text');
const style=node=>{const s=getComputedStyle(node);return {background:s.backgroundColor,border:s.borderWidth,padding:s.padding,borderRadius:s.borderRadius,color:s.color,width:node.getBoundingClientRect().width};};
const text=q('plain').textContent;const stable=q('plain').innerHTML;tone.decorateMessage(q('plain'));
const tokens=[...q('plain').querySelectorAll('[data-message-tone]')].map(n=>({tone:n.dataset.messageTone,text:n.textContent,color:getComputedStyle(n).color}));
const frame=q('mixed').querySelector('iframe');await new Promise(r=>frame.contentDocument?.readyState==='complete'?r():frame.addEventListener('load',r,{once:true}));
const before=frame.contentWindow.identity;frame.contentDocument.querySelector('button').click();
for(let i=0;i<20;i++){ui.decorateTavoMessage(document.querySelector('#mixed'));tone.decorateMessage(q('mixed'));}
const liveIdentity=frame===q('mixed').querySelector('iframe')&&frame.contentWindow.identity===before&&frame.contentWindow.n===1;
const author=style(frame.contentDocument.querySelector('button'));
author.declaredBorder=frame.contentDocument.querySelector('button').style.border;
const ancestorStyles=[];for(let n=frame.parentElement;n&&!n.matches('.mes');n=n.parentElement)ancestorStyles.push(style(n));
const baseline=q('protected').querySelector('.homer-card-component').outerHTML;
tone.decorateMessage(q('protected'));const protectedSame=baseline===q('protected').querySelector('.homer-card-component').outerHTML;
const stream=addMessage('stream','<p>“你</p>');const streamText=stream.querySelector('.mes_text');
const incomplete=!!streamText.querySelector('[data-message-tone=speech]');
streamText.querySelector('p').append(document.createTextNode('好。”（坐下）'));tone.decorateMessage(streamText);
const completed=streamText.textContent==='“你好。”（坐下）'&&!!streamText.querySelector('[data-message-tone=aside]');
const fragment=addMessage('edit','<p>“原文”</p><iframe srcdoc="original"></iframe>');
fragment.querySelector('.mes_text').innerHTML='<p>普通正文</p>';ui.decorateTavoMessage(fragment);tone.decorateMessage(fragment.querySelector('.mes_text'));
const backToPlain=!fragment.classList.contains('homer-author-message');
return {text,unchanged:stable===q('plain').innerHTML,tokens,liveIdentity,author,ancestorStyles,protectedSame,
 mixedTone:q('mixed').querySelector('[data-message-tone=speech]')?.textContent,
 mixedProse:style(q('mixed').querySelector('p')),fenced:document.querySelector('#fenced').classList.contains('homer-author-message'),
 ordinaryCode:document.querySelector('#ordinary-code').classList.contains('homer-author-message'),codeSame:q('ordinary-code').querySelector('code').textContent==='const x="hello";',
 userTones:q('user').querySelectorAll('[data-message-tone]').length,userAlignment:getComputedStyle(document.querySelector('#user .homer-tavo-chrome')).justifyContent,
 protectedTones:q('protected').querySelectorAll('a [data-message-tone],code [data-message-tone],.katex [data-message-tone],.homer-card-component [data-message-tone]').length,
 inlineAuthor:document.querySelector('#inline-author').classList.contains('homer-author-message'),inlineAuthorUntouched:q('inline-author').querySelectorAll('[data-message-tone]').length===0,
 noDuplicateQuotes:['::before','::after'].every(p=>getComputedStyle(q('core-q').querySelector('q'),p).content==='none'),
 incomplete,completed,backToPlain,overflow:document.documentElement.scrollWidth>innerWidth+1};
}'''

def validate(r):
    assert r['unchanged'] and r['liveIdentity'] and r['protectedSame'], r
    assert r['text'] == '夜色降临。“你好，旅人。”（轻声） (quietly) 若有所思「欢迎」 『谢谢』 "hello"', r
    colors = {token['color'] for token in r['tokens']}
    assert len(colors) >= 2 and all(c != 'rgb(255, 255, 255)' for c in colors), r
    assert ''.join(t['text'] for t in r['tokens'] if t['tone']=='speech').startswith('“你好，旅人。”'), r
    assert any(t['text']=='(quietly)' and t['tone']=='aside' for t in r['tokens']), r
    assert r['mixedTone']=='“状态良好。”' and r['mixedProse']['background']=='rgb(41, 72, 95)', r
    assert all(s['background']=='rgba(0, 0, 0, 0)' and s['border']=='0px' and s['padding']=='0px' and s['borderRadius']=='0px' for s in r['ancestorStyles']), r
    # Native DPR snaps CSS border widths to physical pixels. Assert the unchanged
    # authored declaration as well, not an impossible exact 3px computed width.
    assert r['author']['declaredBorder'].startswith('3px ') and abs(float(r['author']['border'].removesuffix('px'))-3)<=.5 and r['author']['background']=='rgb(19, 36, 53)', r
    assert r['fenced'] and not r['ordinaryCode'] and r['codeSame'], r
    assert not r['userTones'] and r['userAlignment']=='flex-end' and not r['protectedTones'], r
    assert r['incomplete'] and r['completed'] and r['backToPlain'] and not r['overflow'], r
    assert r['inlineAuthor'] and r['inlineAuthorUntouched'] and r['noDuplicateQuotes'], r

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apk',type=Path);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    archive=zipfile.ZipFile(args.apk) if args.apk else None
    report={'assets':'packaged' if archive else 'source','cases':[],'errors':[],'failed_requests':[]}
    def serve(route):
        path=urlsplit(route.request.url).path
        if path=='/fixture.html':return route.fulfill(content_type='text/html',body=HTML)
        if path=='/favicon.ico':return route.fulfill(status=204)
        if path.startswith('/assets/'):
            rel='web/'+path.lstrip('/');target=ROOT/'frontend'/path.lstrip('/')
        elif path.startswith('/runtime/'):
            rel='runtime/'+path.removeprefix('/runtime/');target=ROOT/'sillytavern-runtime/public'/path.removeprefix('/runtime/')
        else:
            report['failed_requests'].append(path);return route.abort()
        try:data=archive.read('assets/client/'+rel) if archive else target.read_bytes()
        except (KeyError,FileNotFoundError):report['failed_requests'].append(path);return route.fulfill(status=404)
        mime={'js':'text/javascript','css':'text/css'}.get(Path(path).suffix.lstrip('.'),mimetypes.guess_type(path)[0] or 'application/octet-stream')
        route.fulfill(content_type=mime,body=data)
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
        for width,height in [(390,844),(1440,900)]:
            context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page()
            page.on('pageerror',lambda e:report['errors'].append(str(e)));page.on('requestfailed',lambda r:report['failed_requests'].append(urlsplit(r.url).path))
            page.route('**/*',serve);page.goto('http://127.0.0.1:8796/fixture.html');page.wait_for_load_state('networkidle')
            try:page.wait_for_function('window.ready',timeout=15000)
            except Exception:
                (args.output/'failure.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report));raise
            r=page.evaluate(CHECK);validate(r)
            page.screenshot(path=str(args.output/f'chat-{width}.png'),full_page=True)
            page.evaluate('appearance.open()');page.get_by_role('button',name='文字',exact=True).click()
            page.get_by_role('group',name='对白字型').get_by_role('button',name='衬线').click()
            page.get_by_role('group',name='正文字型').get_by_role('button',name='衬线').click()
            assert 'Noto Serif' in page.evaluate("getComputedStyle(document.querySelector('#plain .mes_text')).fontFamily")
            page.get_by_role('group',name='括号与旁白字型').get_by_role('button',name='等宽').click()
            assert 'monospace' in page.evaluate("getComputedStyle(document.querySelector('#plain [data-message-tone=aside]')).fontFamily"), 'Legacy inheritance must not override independent tone fonts'
            page.get_by_label('对白颜色',exact=True).evaluate("el=>{el.value='#777777';el.dispatchEvent(new Event('input'));}")
            page.get_by_role('button',name='保存',exact=True).click()
            saved=page.evaluate("JSON.parse(localStorage.getItem('homer.chat-appearance.v1:synthetic-owner:a'))")
            assert saved['speechFont']=='serif' and saved['proseFont']=='serif' and saved['speech']=='#777777', saved
            page.evaluate('appearance.open()');page.get_by_role('button',name='文字',exact=True).click();assert page.get_by_role('group',name='对白字型').get_by_role('button',name='衬线').get_attribute('aria-pressed')=='true'
            page.screenshot(path=str(args.output/f'settings-{width}.png'),full_page=True)
            page.get_by_role('group',name='对白字型').get_by_role('button',name='等宽').click();page.get_by_role('button',name='取消',exact=True).click()
            page.wait_for_function("document.body.style.getPropertyValue('--homer-speech-font').includes('Noto Serif')")
            page.evaluate("scope.conversation='b';appearance.refresh()")
            assert page.evaluate("document.body.style.getPropertyValue('--homer-speech-font')").startswith('system-ui'), 'Conversation scope must reset'
            page.evaluate("scope.owner='other';scope.conversation='a';appearance.refresh()")
            assert page.evaluate("document.body.style.getPropertyValue('--homer-speech-font')").startswith('system-ui'), 'Account scope must reset'
            # Check colors against dark/light/custom bubbles through actual UI.
            contrast=[]
            for bg in ['#ffffff','#212121','#29485f','#777777']:
                page.evaluate('appearance.open()');page.get_by_label('角色气泡',exact=True).evaluate("(el,v)=>{el.value=v;el.dispatchEvent(new Event('input'));}",bg)
                actual=page.evaluate("getComputedStyle(document.querySelector('#plain .tav-bubble')).backgroundColor")
                expected='rgb('+', '.join(str(int(bg[i:i+2],16)) for i in (1,3,5))+')';assert actual==expected, (bg,actual)
                values=page.evaluate("[...['prose','speech','thought'].map(k=>document.body.style.getPropertyValue('--homer-'+k+'-color'))]")
                def lum(h):
                    rgb=[int(h[i:i+2],16)/255 for i in (1,3,5)];rgb=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb];return sum(v*w for v,w in zip(rgb,[.2126,.7152,.0722]))
                ratios=[(max(lum(bg),lum(c))+.05)/(min(lum(bg),lum(c))+.05) for c in values];assert min(ratios)>=4.5, (bg,ratios)
                contrast.append({'background':bg,'min_contrast':min(ratios)})
                page.get_by_role('button',name='取消',exact=True).click()
            report['cases'].append({'viewport':[width,height],'assertions':r,'contrast':contrast,'settings':'save_cancel_account_conversation_pass'})
            context.close()
        browser.close()
    assert not report['errors'] and not report['failed_requests'], report
    report['status']='passed';(args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({'status':'passed','viewports':2,'errors':0,'failed_requests':0}))
    if archive:archive.close()

if __name__=='__main__':main()
