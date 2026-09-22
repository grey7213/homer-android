"""Hold Mod requests until the real conversation is ready; no remote services."""
import json
from playwright.sync_api import sync_playwright
from verify_chat_runtime import run, ROOT, OUT

if __name__ == '__main__':
    OUT.mkdir(exist_ok=True,parents=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
        try:results=[run(browser,w,h,loading_only=True) for w,h in [(360,780),(1440,900)]]
        finally:browser.close()
    (ROOT/'output/ui-r14/loading-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    print(results)
