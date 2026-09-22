"""Real backend and real extension: prepare no card, then bind a history once.

Only reads existing conversations; opening Memory Books must never generate.
Credentials remain in memory and are never written to the evidence.
"""
import json
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://192.168.1.129:8080'
CREDENTIALS = Path('D:/网站/功能/AIXingYue-main/output/offline-dev/runtime/credentials.json')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', headless=True)
    results = []
    for width, height in ((390, 844), (1440, 900)):
        context = browser.new_context(viewport={'width': width, 'height': height})
        page = context.new_page()
        credentials = json.loads(CREDENTIALS.read_text(encoding='utf-8'))
        page.goto(BASE + '/app/login.html?next=%2Fapp%2Fhistories.html', wait_until='networkidle')
        page.locator('input[x-model="loginForm.email"]').fill(credentials['email'])
        page.locator('input[x-model="loginForm.password"]').fill(credentials['password'])
        page.locator('form').filter(has=page.locator('input[x-model="loginForm.email"]')).locator('button[type=submit]').click()
        page.wait_for_url('**/app/histories.html')
        history = page.locator('.history-row__main').first
        expect(history).to_be_visible()
        href = history.get_attribute('href')
        calls, failures, errors, generated = [], [], [], []
        page.on('request', lambda r: calls.append(urlparse(r.url).path))
        page.on('requestfailed', lambda r: failures.append({'path': urlparse(r.url).path, 'error': r.failure}) if r.failure != 'net::ERR_ABORTED' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        def deny_generation(route):
            generated.append(urlparse(route.request.url).path)
            route.fulfill(status=403, json={'error': 'Acceptance does not generate'})
        page.route('**/*generate*', deny_generation)
        page.goto(BASE + '/app/chat.html?prewarm=1', wait_until='networkidle')
        try:
            page.wait_for_function("document.querySelector('#dialogue-frame')?.contentWindow.HomerMemoryBooks", timeout=20000)
        except Exception:
            print(page.locator('#dialogue-frame').evaluate("async e=>{const w=e.contentWindow;const r=await w.fetch('./scripts/extensions/third-party/dialogue-memory-books/index.build.js');const s=await r.text();return {status:r.status,hasApi:s.includes('HomerMemoryBooks'),marks:w.performance.getEntriesByType('mark').map(m=>({name:m.name,ms:Math.round(m.startTime)})),api:typeof w.HomerMemoryBooks}}"))
            print(json.dumps({'errors': errors, 'failures': failures, 'paths': calls[-20:], 'frame': page.locator('#dialogue-frame').get_attribute('src')}))
            raise
        # No cloud launch, card import, local chat read, or script scope activation.
        assert not [path for path in calls if path.endswith(('/homer/session', '/chats/get', '/characters/import'))], calls
        assert page.locator('#dialogue-frame').evaluate('e=>e.contentWindow.SillyTavern.getContext().characterId == null')
        page.locator('#dialogue-frame').evaluate('e=>e.contentWindow.__r24RetainedRuntime = true')
        started = time.perf_counter()
        page.evaluate("url=>window.dispatchEvent(new CustomEvent('homer:navigate-conversation',{cancelable:true,detail:{url}}))", href)
        # Click the actual host control immediately, not after the engine is ready.
        page.locator('#preview-settings').click()
        page.locator('[data-runtime-section=memory]').click()
        frame = page.frame_locator('#dialogue-frame')
        expect(frame.locator('.stmb-popup[open] .homer-memory-home')).to_be_visible(timeout=15000)
        elapsed = round((time.perf_counter() - started) * 1000)
        assert page.locator('#dialogue-frame').evaluate('e=>e.contentWindow.__r24RetainedRuntime === true')
        count = frame.locator('#chat .mes').count()
        assert count > 0
        session_calls = [path for path in calls if path.endswith('/homer/session')]
        assert len(session_calls) == 1, session_calls
        assert not generated and not errors and not failures, (generated, errors, failures)
        results.append({'viewport': [width, height], 'bind_and_early_memory_ms': elapsed, 'real_messages': count,
                        'retained_runtime': True, 'network_failures': failures, 'script_errors': errors, 'generation_calls': generated})
        context.close()
    browser.close()
    out = ROOT / 'output/connectivity-r24'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'prepared-memory.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps(results))
