"""Real PC backend acceptance; never records credentials, cookies or tokens."""
import argparse
import json
import time
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def run(base, credentials_path):
    credentials = json.loads(credentials_path.read_text(encoding="utf-8"))
    if os.environ.get('HOMER_ACCEPTANCE_PASSWORD'):
        credentials = {"email": os.environ['HOMER_ACCEPTANCE_EMAIL'], "password": os.environ['HOMER_ACCEPTANCE_PASSWORD']}
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe", headless=True)
        for width, height in ((390, 844), (1440, 900)):
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            errors, failed = [], []
            network_failed = []
            page.on("requestfailed", lambda r: network_failed.append({"path": r.url.split('?')[0].replace(base, ''), "error": r.failure}) if r.failure != 'net::ERR_ABORTED' else None)
            page.on("pageerror", lambda e: errors.append({"page": page.url.split('?')[0], "stack": e.stack[:650]}))
            page.on("console", lambda m: errors.append({"page": page.url.split('?')[0], "message": m.text[:400]}) if m.type == "warning" and "Alpine Expression" in m.text else None)
            page.on("response", lambda r: failed.append({"path": r.url.split("?")[0].replace(base, ""), "status": r.status}) if r.status >= 400 else None)
            page.goto(base + "/app/login.html?next=%2Fapp%2Fme.html", wait_until="networkidle")
            page.locator('input[x-model="loginForm.email"]').fill(credentials["email"])
            page.locator('input[x-model="loginForm.password"]').fill(credentials["password"])
            started = time.monotonic()
            page.locator('form').filter(has=page.locator('input[x-model="loginForm.email"]')).locator('button[type="submit"]').click()
            page.wait_for_url("**/app/me.html", timeout=15000)
            admin = page.get_by_role("link", name="管理后台", exact=True)
            expect(admin).to_be_visible(timeout=10000)
            login_ms = round((time.monotonic() - started) * 1000)
            whoami = context.request.get(base + "/admin/api/whoami")
            assert whoami.ok, f"Admin authorization HTTP {whoami.status}"
            admin.click()
            page.wait_for_url("**/admin.html")
            page.wait_for_load_state("networkidle")
            timings = {}
            for name in ("community", "explore", "workshop", "histories", "me"):
                start = time.monotonic()
                response = page.goto(base + f"/app/{name}.html", wait_until="networkidle")
                timings[name] = {"status": response.status, "settled_ms": round((time.monotonic()-start)*1000)}
            expect(page.get_by_role("link", name="管理后台", exact=True)).to_be_visible()
            # Exercise real cookie invalidation, not just a cached login flag.
            page.evaluate("async () => { const {api,clearAuth}=await import('/assets/js/api.js'); await api.logout(); clearAuth(); }")
            assert context.request.get(base + '/admin/api/whoami').status in (401,403)
            failed[:] = [item for item in failed if not (item['path'] == '/admin/api/whoami' and item['status'] in (401,403))]
            page.goto(base + '/app/login.html?next=%2Fapp%2Fme.html', wait_until='networkidle')
            page.locator('input[x-model="loginForm.email"]').fill(credentials['email'])
            page.locator('input[x-model="loginForm.password"]').fill(credentials['password'])
            page.locator('form').filter(has=page.locator('input[x-model="loginForm.email"]')).locator('button[type="submit"]').click()
            page.wait_for_url('**/app/me.html')
            expect(page.get_by_role('link', name='管理后台', exact=True)).to_be_visible()
            assert not errors, errors
            assert not failed, failed
            assert not network_failed, network_failed
            results.append({"width": width, "login_to_admin_ms": login_ms, "pages": timings, "errors": errors, "http_errors": failed, "network_failures": network_failed})
            context.close()
        browser.close()
    output = Path(__file__).resolve().parents[1] / "output/local-acceptance"
    output.mkdir(parents=True, exist_ok=True)
    (output / "browser.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--credentials", required=True, type=Path)
    args = parser.parse_args()
    run(args.base.rstrip("/"), args.credentials)
