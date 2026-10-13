"""Actual appearance editor/color controls; private source or APK assets only."""
import argparse
import json
import mimetypes
from pathlib import Path
from urllib.parse import urlsplit
import zipfile
from playwright.sync_api import sync_playwright, expect
import mobile_r45_presentation as fixture

ROOT = fixture.ROOT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT/'output/repair-20261011/color')
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    archive = zipfile.ZipFile(args.apk) if args.apk else None
    errors = []; failures = []; results = []
    def serve(route):
        path = urlsplit(route.request.url).path
        if path == '/fixture.html': return route.fulfill(content_type='text/html', body=fixture.HTML)
        if path == '/favicon.ico': return route.fulfill(status=204)
        if path.startswith('/assets/'):
            target = ROOT/'frontend'/path.lstrip('/'); asset = 'assets/client/web/'+path.lstrip('/')
        elif path.startswith('/runtime/'):
            target = ROOT/'sillytavern-runtime/public'/path.removeprefix('/runtime/'); asset = 'assets/client/runtime/'+path.removeprefix('/runtime/')
        else:
            failures.append(path); return route.abort()
        try: data = archive.read(asset) if archive else target.read_bytes()
        except (FileNotFoundError, KeyError): failures.append(path); return route.fulfill(status=404)
        mime = {'.mjs':'text/javascript','.js':'text/javascript','.css':'text/css'}.get(target.suffix, mimetypes.guess_type(path)[0] or 'application/octet-stream')
        route.fulfill(content_type=mime, body=data)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        try:
            for width,height in [(390,844),(1440,900)]:
                for theme in ['light','dark']:
                    context = browser.new_context(viewport={'width':width,'height':height}, color_scheme=theme)
                    page = context.new_page(); page.route('**/*', serve)
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    page.goto('http://127.0.0.1:8796/fixture.html');page.wait_for_function('window.ready')
                    page.evaluate('appearance.open()')
                    assert page.locator('input[type=color]').count() == 0
                    target = page.get_by_label('角色气泡',exact=True)
                    target.fill('#bad'); expect(target).to_have_attribute('aria-invalid','true')
                    page.get_by_role('button',name='保存',exact=True).click()
                    expect(page.get_by_role('dialog')).to_be_visible()
                    assert page.evaluate("localStorage.getItem('homer.chat-appearance.v1:synthetic-owner:a')") is None
                    target.fill('#f0e3fa');expect(target).not_to_have_attribute('aria-invalid','true')
                    page.get_by_role('button',name='自定义角色气泡颜色',exact=True).click()
                    # Genuine keyboard control, not a fabricated change event.
                    red = page.get_by_role('slider',name='角色气泡红色',exact=True)
                    red.focus();red.press('Home');red.press('ArrowRight')
                    expect(target).to_have_value('#01e3fa')
                    panel = page.locator('.homer-color-control').first
                    dimensions = panel.bounding_box(); assert dimensions['width'] <= width and dimensions['x'] >= 0
                    page.screenshot(path=str(args.output/f'picker-{theme}-{width}.png'),full_page=True)
                    page.get_by_role('button',name='保存',exact=True).click()
                    assert page.evaluate("JSON.parse(localStorage.getItem('homer.chat-appearance.v1:synthetic-owner:a')).assistant")=='#01e3fa'
                    page.evaluate('appearance.open()'); expect(page.get_by_label('角色气泡',exact=True)).to_have_value('#01e3fa')
                    page.get_by_label('角色气泡',exact=True).fill('#ffffff');page.get_by_role('button',name='取消',exact=True).click()
                    page.wait_for_function("document.body.style.getPropertyValue('--tavo-assistant-bubble')==='#01e3fa'")
                    assert page.evaluate("document.body.style.getPropertyValue('--tavo-assistant-bubble')")=='#01e3fa'
                    page.evaluate('appearance.open()');page.get_by_label('角色气泡',exact=True).fill('#invalid')
                    page.get_by_role('button',name='恢复默认',exact=True).click()
                    expect(page.get_by_label('角色气泡',exact=True)).to_have_value('#29485f')
                    expect(page.get_by_label('角色气泡',exact=True)).not_to_have_attribute('aria-invalid','true')
                    page.get_by_role('button',name='取消',exact=True).click()
                    page.evaluate('appearance.open();scope.owner="other";appearance.refresh()')
                    page.wait_for_function("document.body.style.getPropertyValue('--tavo-assistant-bubble')==='#29485f'")
                    assert page.locator('dialog[open]').count()==0
                    assert page.evaluate("document.body.style.getPropertyValue('--tavo-assistant-bubble')")=='#29485f'
                    results.append({'viewport':[width,height],'theme':theme,'save_cancel_keyboard_invalid_reset_scope':'pass'})
                    context.close()
        finally: browser.close()
    assert not errors and not failures,(errors,failures)
    (args.output/'results.json').write_text(json.dumps({'assets':'apk' if archive else 'source','results':results,'errors':errors,'failures':failures},ensure_ascii=False,indent=2),encoding='utf-8')
    if archive:archive.close()
    print('PASS: 4 appearance/color journeys; no native color dialogs, errors, external requests or scope leaks.')


if __name__=='__main__':main()
