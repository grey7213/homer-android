"""Whole shipping embedded-runtime browser gates; synthetic loopback data only.

Run with an isolated Node server on :8796. API denial leaves bundle assets
available, matching the Android asset interceptor, rather than browser offline.
"""
from pathlib import Path
from urllib.parse import urlparse
import json
import mimetypes
import os
import time
import traceback
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output"
PORT = int(os.environ.get('HOMER_RUNTIME_QA_PORT', '8796'))
ORIGIN = f"http://127.0.0.1:{PORT}"
URL = ORIGIN + "/?homer_embed=1&homer_app_id=synthetic-card&homer_conversation_id=synthetic-conv"
OWNER = "r354-synthetic-owner"
SCOPE = json.dumps([OWNER, "synthetic-card", "synthetic-conv"], separators=(",", ":"))
MESSAGES = [{"id": f"synthetic-{i}", "role": "assistant" if i % 2 == 0 else "user",
             "content": f"synthetic-R{i:04d}", "created_at": 1720000000000 + i,
             "swipes": [f"synthetic-R{i:04d}", f"synthetic-alt-{i}"] if i == 1100 else [],
             "swipe_index": 0} for i in range(1101)]
CARD = {"spec": "chara_card_v2", "spec_version": "2.0", "data": {
    "name": "Synthetic runtime acceptance", "description": "r354-card-description-retained",
    "personality": "Synthetic only", "scenario": "Isolated browser verification",
    "first_mes": "synthetic-R0000", "mes_example": "", "creator_notes": "",
    "system_prompt": "", "post_history_instructions": "", "alternate_greetings": [],
    "extensions": {}, "tags": [], "creator": "QA", "character_version": "1"}}
STATE = {"extension_settings": {"r354_full_runtime_sentinel": {"retained": "settings-retained"}},
         "variables": {"homer_model_settings": {"model_id": "synthetic-model", "temperature": 0.37,
                                                "top_p": 0.9, "frequency_penalty": 0, "presence_penalty": 0}}}
REGEX = {"revision": "r354-synthetic-regex", "scripts": [{"id": "synthetic-rule",
    "scriptName": "synthetic display rule", "findRegex": "synthetic-R1100", "replaceString": "REGEX-RETAINED-1100",
    "placement": [2], "disabled": False, "minDepth": None, "maxDepth": None, "trimStrings": [], "substituteRegex": 0}]}
SESSION = {"user": {"id": OWNER, "name": "Synthetic QA", "is_admin": False},
    "runtime": {"dialogue_api_base_url": ORIGIN+"/synthetic-provider", "backend_base_url": ORIGIN},
    "launch": {"app_id": "synthetic-card", "conversation_id": "synthetic-conv", "title": "Synthetic 1101 history",
        "card": CARD, "bridge_token": "synthetic-only-not-credential", "bridge_token_ttl_seconds": 900,
        "messages": MESSAGES, "storage": {"protocol": 2, "complete": True, "version": "1" * 32,
            "message_count": 1101, "unchanged": False}}}

SNAPSHOT = """async () => {
 const {getContext} = await import('/scripts/st-context.js');
 const {officialDisplayRules} = await import('/scripts/homer-official-regex.mjs');
 const {isGenerating} = await import('/script.js');
 const ctx=getContext(), card=ctx.characters[ctx.characterId];
 return {count:ctx.chat.length, chatId:ctx.chatId, first:ctx.chat[0]?.mes, last:ctx.chat.at(-1)?.mes,
   swipes:ctx.chat.at(-1)?.swipes, card:card?.data?.description,
   setting:ctx.extensionSettings.r354_full_runtime_sentinel,
   model:ctx.chatMetadata.homer_model_settings, rules:officialDisplayRules(),
   ready:document.documentElement.classList.contains('homer-runtime-ready'),
   gate:document.querySelector('#homer-runtime-gate')?.className,
   overflow:document.documentElement.scrollWidth>innerWidth,
   badSvgPaths:[...document.querySelectorAll('svg path[d="undefined"]')].map(path=>path.parentElement.parentElement.outerHTML.slice(0,900)),
   renderedLast:document.querySelector('#chat .mes:last-child .mes_text')?.textContent,
   initialized:performance.getEntriesByName('homer-native-init-start').length,
   coreReady:performance.getEntriesByName('homer-prewarm-core-ready').length,
   generating:isGenerating(),
   appReady:performance.getEntriesByName('homer-prewarm-core-ready').length>=2};
}"""

def check_snapshot(snapshot):
    assert snapshot["ready"], snapshot
    assert snapshot["count"] == 1101, snapshot
    assert snapshot["first"] == "synthetic-R0000", snapshot
    assert snapshot["last"] == "synthetic-R1100", snapshot
    assert snapshot["swipes"] == ["synthetic-R1100", "synthetic-alt-1100"], snapshot
    assert snapshot["card"] == "r354-card-description-retained", snapshot
    assert snapshot["setting"] == {"retained": "settings-retained"}, snapshot
    assert snapshot["model"]["model_id"] == "synthetic-model", snapshot
    assert snapshot["model"]["temperature"] == 0.37, snapshot
    assert snapshot["rules"][0]["id"] == "synthetic-rule", snapshot
    assert "REGEX-RETAINED-1100" in snapshot["renderedLast"], snapshot
    assert snapshot["initialized"] == 1 and snapshot["coreReady"] >= 2 and snapshot["appReady"], snapshot
    assert not snapshot["overflow"], snapshot
    assert not snapshot["badSvgPaths"], snapshot

def switch_cached_history(page, conversation, expected_last):
    started = time.monotonic()
    page.get_by_role("button", name="打开导航与历史会话", exact=True).click()
    page.locator(f'.homer-history-item[data-conversation-id="{conversation}"] .homer-history-item__main').click()
    page.wait_for_function("""expected => {
        const ctx=window.SillyTavern.getContext();
        return ctx.chat.length===1101 && ctx.chat.at(-1)?.mes===expected
            && !document.body.classList.contains('homer-switching-chat');
    }""", arg=expected_last, timeout=15000)
    page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    return round(time.monotonic() - started, 3)

def wait_ready(page, timeout=45000):
    try:
        page.wait_for_function("document.documentElement.classList.contains('homer-runtime-ready')", timeout=timeout)
    except BaseException:
        page.screenshot(path=str(OUT / "r354-full-runtime-failure.png"))
        diagnostic = {"page_errors": errors, "console": warnings, "requests": requests,
            "network_errors": network_errors, "body": page.locator('body').inner_text()[:12000],
            "html_classes": page.locator('html').get_attribute('class'),
            "marks": page.evaluate("performance.getEntriesByType('mark').map(x=>x.name)")}
        (OUT / "r354-full-runtime-failure.json").write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2), encoding="utf-8")
        raise

results = []
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        for width, height in [(390, 844), (1440, 900)]:
            context = browser.new_context(viewport={"width": width, "height": height})
            context.add_init_script("""localStorage.setItem('ai_xingyue_logged_in','1');
                localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'r354-synthetic-owner',name:'Synthetic QA'}));""")
            online = [True]
            requests = []
            denied = []
            errors = []
            warnings = []
            failed = []
            network_errors = []
            generation_requests = []
            posts = []
            generation_started = [False]
            runtime_state_baseline = [None]
            state_write_diffs = []

            def routing(route):
                request = route.request
                parsed = urlparse(request.url)
                path = parsed.path
                if parsed.hostname not in ("127.0.0.1", "localhost"):
                    denied.append({"phase": "external", "path": path})
                    return route.abort("internetdisconnected")
                if path.startswith("/scripts/extensions/third-party/dialogue-memory-books/"):
                    # The native asset router ships this public alias for the
                    # upstream extension directory; preserve that APK routing.
                    suffix = path.removeprefix("/scripts/extensions/third-party/dialogue-memory-books/")
                    target = (ROOT / "sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks" / suffix).resolve()
                    if target.is_file():
                        mime = "text/javascript" if target.suffix in (".js", ".mjs") else mimetypes.guess_type(str(target))[0]
                        return route.fulfill(path=str(target), content_type=mime or "application/octet-stream")
                if path.startswith("/assets/"):
                    target = (ROOT / "frontend" / path.lstrip("/")).resolve()
                    assert target.is_relative_to((ROOT / "frontend").resolve())
                    if target.is_file():
                        mime = "text/javascript" if target.suffix in (".js", ".mjs") else mimetypes.guess_type(str(target))[0]
                        return route.fulfill(path=str(target), content_type=mime or "application/octet-stream")
                if path == "/thumbnail":
                    return route.fulfill(path=str(ROOT / "sillytavern-runtime/public/img/ai4.png"), content_type="image/png")
                is_api = path.startswith(("/api/", "/console/", "/synthetic-provider")) or path in ("/version", "/csrf-token")
                if is_api:
                    requests.append({"phase": "online" if online[0] else "offline", "method": request.method, "path": path})
                    if request.method == "POST": posts.append(path)
                    if not online[0]:
                        denied.append({"phase": "offline", "path": path})
                        return route.abort("internetdisconnected")
                data = None
                if path == "/api/settings/get":
                    response = route.fetch()
                    data = response.json()
                    settings = json.loads(data["settings"])
                    # A prepared, already-used synthetic account has completed
                    # standalone onboarding; no dialog click bypass is needed.
                    settings["firstRun"] = False
                    data["settings"] = json.dumps(settings)
                elif path in ("/api/homer/session", "/console/api/web/dialogue/session"):
                    data = SESSION
                elif path == "/api/homer/runtime-state":
                    if request.method == "GET":
                        data = json.loads(json.dumps(STATE))
                        baseline = page.evaluate("""async () => {const {sanitizeRuntimeValue}=await import('/scripts/homer-local-runtime.mjs');
                            return sanitizeRuntimeValue(JSON.parse(JSON.stringify(window.SillyTavern.getContext().extensionSettings)));} """)
                        data["extension_settings"] = {**baseline, **data["extension_settings"]}
                        runtime_state_baseline[0] = json.loads(json.dumps(data))
                    else:
                        body = request.post_data_json
                        def differences(a, b, path=""):
                            if isinstance(a, dict) and isinstance(b, dict):
                                return [child for key in a.keys() | b.keys() for child in differences(a.get(key), b.get(key), f"{path}.{key}")]
                            return [] if a == b else [path]
                        change_paths = differences(runtime_state_baseline[0]["extension_settings"], body.get("extension_settings", {}), "extension_settings")
                        state_write_diffs.append(change_paths)
                        print(f"Runtime-state initialization normalized {len(change_paths)} setting paths", flush=True)
                        data = STATE
                elif path == "/api/homer/models":
                    data = {"default_id": "synthetic-model", "list": [{"id": "synthetic-model", "name": "Synthetic model", "enabled": True}]}
                elif path == "/api/homer/regex": data = REGEX
                elif path == "/api/homer/conversations": data = {"list": [{"id": "synthetic-conv", "app_id": "synthetic-card", "title": "Synthetic 1101 history"}]}
                elif path.startswith("/api/homer/mods/") or path == "/api/homer/extensions": data = {"list": []}
                elif path == "/api/homer/images/history": data = {"list": []}
                elif path == "/api/homer/events": data = {"ok": True}
                elif path == "/api/homer/sync":
                    if not generation_started[0]:
                        raise AssertionError("Read-only opening must not upload canonical chat")
                    return route.fulfill(status=503, json={"error": "synthetic backup transport unavailable"})
                elif path == "/api/backends/chat-completions/generate" or path.startswith("/synthetic-provider"):
                    generation_requests.append(path)
                    return route.fulfill(status=503, json={"error": {"message": "synthetic generation rejected", "code": "HM-G204"}})
                if data is not None: return route.fulfill(json=data)
                return route.continue_()

            context.route("**/*", routing)
            page = context.new_page()
            def page_error(error):
                errors.append(str(error))
                print("Script error: " + str(error), flush=True)
            page.on("pageerror", page_error)
            page.on("console", lambda msg: warnings.append({"type": msg.type, "text": msg.text[:800]}) if msg.type in ("warning", "error") else None)
            page.on("requestfailed", lambda req: failed.append({"path": urlparse(req.url).path, "error": req.failure}))
            page.on("response", lambda response: network_errors.append({"status": response.status, "path": urlparse(response.url).path}) if response.status >= 400 else None)
            started = time.monotonic()
            print(f"Loading whole runtime {width}x{height}", flush=True)
            page.goto(URL, wait_until="domcontentloaded", timeout=120000)
            try:
                page.wait_for_load_state("networkidle", timeout=30000)
            except Exception:
                print("Network remains active; checking actual readiness", flush=True)
            print(f"DOM loaded; classes={page.locator('html').get_attribute('class')}", flush=True)
            wait_ready(page)
            page.wait_for_timeout(1500)
            primed = page.evaluate(SNAPSHOT)
            (OUT / f"r354-full-runtime-prime-{width}.json").write_text(json.dumps({"snapshot": primed, "requests": requests,
                "state_write_diffs": state_write_diffs}, ensure_ascii=False, indent=2), encoding="utf-8")
            check_snapshot(primed)
            priming_seconds = round(time.monotonic() - started, 3)
            page.screenshot(path=str(OUT / f"r354-full-runtime-online-{width}.png"))
            assert "/api/homer/sync" not in posts
            readonly_state_posts = [entry for entry in requests if entry["method"] == "POST" and entry["path"] == "/api/homer/runtime-state"]
            second_session = json.loads(json.dumps(SESSION))
            second_session["launch"]["conversation_id"] = "synthetic-conv-b"
            second_session["launch"]["title"] = "Synthetic second 1101 history"
            for index, message in enumerate(second_session["launch"]["messages"]):
                message["id"] = f"synthetic-b-{index}"
                message["content"] = f"synthetic-B-R{index:04d}"
            second_session["launch"]["messages"][-1]["content"] = "synthetic-B-R1100"
            second_session["launch"]["messages"][-1]["swipes"] = ["synthetic-B-R1100", "synthetic-B-alt-1100"]
            second_session["launch"]["storage"]["version"] = "2" * 32
            third_session = json.loads(json.dumps(second_session))
            third_session["launch"]["app_id"] = "synthetic-card-c"
            third_session["launch"]["conversation_id"] = "synthetic-conv-c"
            third_session["launch"]["title"] = "Synthetic different card 1101 history"
            third_session["launch"]["card"]["data"]["name"] = "Synthetic different offline card"
            third_session["launch"]["card"]["data"]["description"] = "r354-different-card-description-retained"
            third_session["launch"]["storage"]["version"] = "3" * 32
            for index, message in enumerate(third_session["launch"]["messages"]):
                message["id"] = f"synthetic-c-{index}"
                message["content"] = f"synthetic-C-R{index:04d}"
            third_session["launch"]["messages"][-1]["swipes"] = ["synthetic-C-R1100", "synthetic-C-alt-1100"]
            page.evaluate("""async payloads => {
                const {createLocalSessionStore}=await import('/scripts/homer-local-session.mjs');
                const {sanitizeRuntimeValue}=await import('/scripts/homer-local-runtime.mjs');
                const store=createLocalSessionStore();
                for(const payload of payloads) {
                const owner=payload.user.id;
                const a=JSON.stringify([owner,'synthetic-card','synthetic-conv']);
                const b=JSON.stringify([owner,payload.launch.app_id,payload.launch.conversation_id]);
                const state=await store.resource(a,'runtime-state');
                state.extension_settings=sanitizeRuntimeValue(JSON.parse(JSON.stringify(window.SillyTavern.getContext().extensionSettings)));
                await store.remember(owner,payload);
                await store.rememberResource(b,'runtime-state',state);
                await store.rememberResource(b,'models',await store.resource(a,'models'));
                const regex=await store.resource(a,'regex:synthetic-model');
                const marker=payload.launch.app_id==='synthetic-card'?'B':'C';
                regex.scripts[0].findRegex=`synthetic-${marker}-R1100`;
                regex.scripts[0].replaceString=`REGEX-${marker}-RETAINED-1100`;
                await store.rememberResource(b,'regex:synthetic-model',regex);
                }
                await store.close();
            }""", [second_session, third_session])
            online[0] = False
            failed.clear()
            started = time.monotonic()
            page.reload(wait_until="networkidle", timeout=120000)
            wait_ready(page, 45000)
            page.wait_for_timeout(1000)
            offline = page.evaluate(SNAPSHOT)
            check_snapshot(offline)
            offline_seconds = round(time.monotonic() - started, 3)
            page.screenshot(path=str(OUT / f"r354-full-runtime-offline-{width}.png"))
            offline_failed = list(failed)
            assert not errors, errors
            assert not any("<path> attribute d:" in entry["text"] for entry in warnings), warnings
            assert not any(entry["path"] != "/api/characters/get" or entry["status"] != 404 for entry in network_errors), network_errors
            assert not any(not entry["path"].startswith(("/api/", "/console/"))
                and entry["path"] not in ("/csrf-token", "/version") for entry in offline_failed), offline_failed
            assert not any(entry["phase"] == "offline" and entry["path"] in ("/api/homer/session", "/console/api/web/dialogue/session") for entry in requests), requests
            engine_before = page.evaluate("performance.getEntriesByName('homer-native-init-start').length")
            switch_request_start = len(requests)
            b_seconds = switch_cached_history(page, "synthetic-conv-b", "synthetic-B-R1100")
            b_snapshot = page.evaluate(SNAPSHOT)
            (OUT / "r354-full-runtime-warm-diagnostic.json").write_text(json.dumps({"snapshot": b_snapshot,
                "console": warnings, "requests": requests, "url":page.url,
                "classes": page.locator('body').get_attribute('class')}, ensure_ascii=False, indent=2), encoding="utf-8")
            assert b_snapshot["count"] == 1101 and b_snapshot["last"] == "synthetic-B-R1100", b_snapshot
            assert b_snapshot["card"] == "r354-card-description-retained" and b_snapshot["setting"] == {"retained": "settings-retained"}
            assert not b_snapshot["badSvgPaths"], b_snapshot
            assert "REGEX-B-RETAINED-1100" in b_snapshot["renderedLast"], b_snapshot
            page.screenshot(path=str(OUT / f"r354-full-runtime-warm-b-{width}.png"))
            a_seconds = switch_cached_history(page, "synthetic-conv", "synthetic-R1100")
            a_snapshot = page.evaluate(SNAPSHOT)
            check_snapshot(a_snapshot)
            c_seconds = switch_cached_history(page, "synthetic-conv-c", "synthetic-C-R1100")
            c_snapshot = page.evaluate(SNAPSHOT)
            assert c_snapshot["count"] == 1101 and c_snapshot["last"] == "synthetic-C-R1100", c_snapshot
            assert c_snapshot["card"] == "r354-different-card-description-retained", c_snapshot
            assert c_snapshot["setting"] == {"retained": "settings-retained"}, c_snapshot
            assert c_snapshot["model"]["temperature"] == 0.37, c_snapshot
            assert not c_snapshot["badSvgPaths"], c_snapshot
            assert "REGEX-C-RETAINED-1100" in c_snapshot["renderedLast"], c_snapshot
            page.screenshot(path=str(OUT / f"r354-full-runtime-warm-c-{width}.png"))
            c_back_seconds = switch_cached_history(page, "synthetic-conv", "synthetic-R1100")
            check_snapshot(page.evaluate(SNAPSHOT))
            assert page.evaluate("performance.getEntriesByName('homer-native-init-start').length") == engine_before == 1
            switch_requests = requests[switch_request_start:]
            assert not any(entry["path"] in ("/api/homer/session", "/console/api/web/dialogue/session", "/api/homer/sync") for entry in switch_requests), switch_requests
            warm_switch = {"second_seconds": b_seconds, "back_seconds": a_seconds, "second": b_snapshot,
                "back": a_snapshot, "different_card_seconds": c_seconds, "different_card_back_seconds": c_back_seconds,
                "different_card": c_snapshot, "native_engine_initializations": engine_before, "requests": switch_requests}
            page.get_by_role("button", name="打开对话设置", exact=True).click()
            storage_control = page.locator("#homer-chat-storage")
            assert storage_control.get_attribute("data-control") == "sync"
            assert storage_control.locator("strong").inner_text() == "存档同步"
            assert page.locator('[data-control="appearance"] strong').inner_text() == "界面设置"
            page.screenshot(path=str(OUT / f"r354-full-runtime-controls-{width}.png"))
            storage_control.click()
            page.wait_for_timeout(200)
            check_snapshot(page.evaluate(SNAPSHOT))
            assert "本机进度已保留" in page.locator('body').inner_text()
            assert not any("<path> attribute d:" in entry["text"] for entry in warnings), warnings
            warm_switch["sync_control_label_and_click"] = True
            print(f"Offline reopen passed at {width}x{height}: {offline['count']} real rows", flush=True)
            (OUT / f"r354-full-runtime-reopen-{width}.json").write_text(json.dumps({"viewport": [width, height], "prime": primed,
                "offline": offline, "prime_seconds": priming_seconds, "offline_reload_seconds": offline_seconds,
                "requests": requests, "page_errors": errors, "network_errors": network_errors, "warm_switch": warm_switch}, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"viewport": [width,height], "warm_offline_second_seconds": b_seconds, "warm_offline_back_seconds": a_seconds}), flush=True)
            if os.environ.get("HOMER_RUNTIME_WARM_ONLY") == "1":
                results.append({"viewport": [width,height], "warm_switch": warm_switch, "page_errors": errors})
                (OUT / "r354-full-runtime-warm-browser.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
                context.close()
                continue
            generation_started[0] = True
            print('Beginning bounded offline generation rejection check', flush=True)
            offline_generation = page.evaluate("""async () => {
              const {getContext}=await import('/scripts/st-context.js'); const ctx=getContext();
              try {await Promise.race([ctx.generate('normal'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('QA_GENERATION_TIMEOUT')),45000))]);return {resolved:true,count:ctx.chat.length};}
              catch(e){return {resolved:false,error:String(e.message),count:ctx.chat.length};}
            }""")
            page.wait_for_timeout(1500)
            after_offline_generation = page.evaluate(SNAPSHOT)
            check_snapshot(after_offline_generation)
            assert not offline_generation["resolved"] and not after_offline_generation["generating"], offline_generation
            assert not generation_requests, generation_requests
            online[0] = True
            print('Beginning bounded online generation rejection check', flush=True)
            online_generation = page.evaluate("""async () => {
              const {getContext}=await import('/scripts/st-context.js'); const ctx=getContext();
              try {await Promise.race([ctx.generate('normal'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('QA_GENERATION_TIMEOUT')),45000))]);return {resolved:true,count:ctx.chat.length};}
              catch(e){return {resolved:false,error:String(e.message),count:ctx.chat.length};}
            }""")
            page.wait_for_timeout(1500)
            after_online_generation = page.evaluate(SNAPSHOT)
            check_snapshot(after_online_generation)
            assert not online_generation["resolved"] and "HM-G204" in online_generation["error"], online_generation
            assert not after_online_generation["generating"], after_online_generation
            assert len(generation_requests) == 1, "Actual online generation must reach backend rejection once without replay"
            record = {"viewport": [width, height], "prime_seconds": priming_seconds,
                "offline_reload_seconds": offline_seconds, "prime": primed, "offline": offline,
                "offline_generation": offline_generation, "online_generation": online_generation,
                "after_offline_generation": after_offline_generation, "after_online_generation": after_online_generation,
                "generation_requests": generation_requests, "page_errors": errors,
                "console": warnings, "requests": requests, "denied": denied,
                "offline_request_failures": offline_failed, "network_errors": network_errors,
                "readonly_state_posts": readonly_state_posts, "state_write_diffs": state_write_diffs, "warm_switch": warm_switch}
            results.append(record)
            (OUT / "r354-full-runtime-browser.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"viewport": [width, height], "passed": True, "prime_seconds": priming_seconds,
                              "offline_reload_seconds": offline_seconds, "count": offline["count"]}))
            context.close()
        browser.close()
except BaseException as error:
    try:
        page.screenshot(path=str(OUT / "r354-full-runtime-failure.png"))
        diagnostic = {"error": str(error), "trace": traceback.format_exc(), "page_errors": errors,
            "console": warnings, "requests": requests, "network_errors": network_errors,
            "body": page.locator('body').inner_text()[:12000], "html_classes": page.locator('html').get_attribute('class')}
        (OUT / "r354-full-runtime-failure.json").write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception: pass
    raise
