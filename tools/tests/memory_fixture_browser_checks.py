"""Validate the reusable Android QA JavaScript fixture against the real bundle.

The cloud launch host is intentionally unmounted; all memory UI, extension,
world scanner and local persistence are genuine. Only provider generation is
stubbed by the JavaScript fixture. No real account or model requests.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/memory-private-20261011'
FIXTURE = (ROOT / 'tools/tests/fixtures/memory-private-fixture.js').read_text(encoding='utf-8')
results = []

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, channel='chrome')
    try:
        for width, height in [(390, 844), (1440, 900)]:
            context = browser.new_context(viewport={'width': width, 'height': height})
            page = context.new_page()
            errors, failures, http_errors, console_errors = [], [], [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('requestfailed', lambda request: failures.append(request.url))
            page.on('response', lambda response: http_errors.append({'url': response.url, 'status': response.status}) if response.status >= 400 else None)
            page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)

            def assets(route):
                path = route.request.url.split('/assets/', 1)[1].split('?', 1)[0]
                target = (ROOT / 'frontend/assets' / path).resolve()
                if target.is_relative_to((ROOT / 'frontend/assets').resolve()) and target.is_file():
                    route.fulfill(path=str(target))
                else:
                    route.continue_()
            page.route('**/assets/**', assets)

            def memory_alias(route):
                path = route.request.url.split('/dialogue-memory-books/', 1)[1].split('?', 1)[0]
                target = (ROOT / 'sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks' / path).resolve()
                if path == 'index.build.js':
                    route.fulfill(body="import '/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js';", content_type='text/javascript')
                elif target.is_file():
                    route.fulfill(path=str(target))
                else:
                    route.continue_()
            page.route('**/scripts/extensions/third-party/dialogue-memory-books/**', memory_alias)
            page.route('**/scripts/extensions/homer-bridge/index.js*', lambda route: route.fulfill(
                body='// Isolated test: cloud launch host not mounted.', content_type='text/javascript'))

            def initialize():
                page.wait_for_load_state('networkidle')
                page.wait_for_function('!!window.SillyTavern?.getContext && !document.querySelector("#loader")')
                page.evaluate(FIXTURE)
                # Fixture host does not have the cloud launch controller. Remove
                # its host-only gate, never fake any Memory Books ready state.
                page.evaluate("document.documentElement.classList.remove('homer-runtime-pending');document.querySelector('#homer-runtime-gate')?.remove()")
                page.evaluate('HomerMemoryQaFixture.setup({isolated:true,providerStub:true})')

            page.goto('http://127.0.0.1:8802/')
            initialize()
            report = page.evaluate('HomerMemoryQaFixture.runJourney()')
            page.reload()
            initialize()
            report.update(page.evaluate('HomerMemoryQaFixture.verifyColdReopen()'))
            assert not errors, errors
            assert not failures, failures
            assert not http_errors, http_errors
            assert not console_errors, console_errors
            report.update({'viewport': [width, height], 'page_errors': errors,
                           'request_failures': failures, 'http_errors': http_errors, 'console_errors': console_errors})
            results.append(report)
            context.close()
    finally:
        browser.close()

(OUT / 'reusable-fixture-checks.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(results, ensure_ascii=False))
