"""Real bundle/UI/outbox/scanner + actual SQLite provider contract recovery.

Cloud host authentication is synthetic and unmounted, never claimed as a live
server/deployment test. The selected product restore method is unchanged.
Original accounts, models and databases are never opened or modified.
"""
import json
from pathlib import Path
import sqlite3
import threading
from playwright.sync_api import sync_playwright
from test_memory_cloud_r366 import provider_class

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/memory-private-20261011'
OUT.mkdir(parents=True, exist_ok=True)
FIXTURE = (ROOT / 'tools/tests/fixtures/memory-private-fixture.js').read_text(encoding='utf-8')
BRIDGE = (ROOT / 'sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js').read_text(encoding='utf-8')
RESTORE = BRIDGE[BRIDGE.index('let stagedMemoryRestore = null;'):BRIDGE.index('async function persistModelSettings(')]
SCOPE = ['synthetic-memory-owner', 'synthetic-A', 'synthetic-A']
KEY = 'homer_memory_book'
Provider, _ = provider_class()
store = Provider()
store.lock = threading.RLock()
store.conn = sqlite3.connect(':memory:')
store.conn.row_factory = sqlite3.Row
store.conn.execute('''create table sillytavern_runtime_states(
 user_id text, app_id text, conversation_id text, extension_settings_json text,
 worldbook_overrides_json text, regex_overrides_json text, script_trees_json text,
 mvu_state_json text, variables_json text, updated_at integer,
 primary key(user_id,app_id,conversation_id))''')

results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, channel='chrome')
    try:
        for width, height in [(390, 844), (1440, 900)]:
            errors, failed, http_errors, console_errors = [], [], [], []

            def new_phone():
                context = browser.new_context(viewport={'width': width, 'height': height})
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('requestfailed', lambda r: failed.append(r.url))
                page.on('response', lambda r: http_errors.append({'url': r.url, 'status': r.status}) if r.status >= 400 else None)
                page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)

                def assets(route):
                    path = route.request.url.split('/assets/', 1)[1].split('?', 1)[0]
                    target = (ROOT / 'frontend/assets' / path).resolve()
                    if target.is_relative_to((ROOT / 'frontend/assets').resolve()) and target.is_file():
                        route.fulfill(path=str(target))
                    else:
                        route.continue_()

                def alias(route):
                    path = route.request.url.split('/dialogue-memory-books/', 1)[1].split('?', 1)[0]
                    target = (ROOT / 'sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks' / path).resolve()
                    if path == 'index.build.js':
                        route.fulfill(body="import '/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js';", content_type='text/javascript')
                    elif target.is_file():
                        route.fulfill(path=str(target))
                    else:
                        route.continue_()
                page.route('**/assets/**', assets)
                page.route('**/scripts/extensions/third-party/dialogue-memory-books/**', alias)
                page.route('**/scripts/extensions/homer-bridge/index.js*', lambda route: route.fulfill(
                    body='// Isolated test: authenticated cloud launch is unmounted.', content_type='text/javascript'))
                page.goto('http://127.0.0.1:8802/')
                page.wait_for_load_state('networkidle')
                page.wait_for_function('!!window.SillyTavern?.getContext && !document.querySelector("#loader")')
                page.evaluate(FIXTURE)
                page.evaluate('HomerMemoryQaFixture.setup({isolated:true,providerStub:true})')
                return context, page

            context, page = new_phone()
            report = page.evaluate('HomerMemoryQaFixture.runJourney()')
            phone = page.evaluate('''async(scope)=>{
                const {createChatOutbox}=await import('/scripts/homer-chat-outbox.mjs');
                const row=await createChatOutbox().read(JSON.stringify(scope),'extension-settings');
                if(!row?.pending||!row.payload.variables.homer_memory_book)throw Error('Actual UI save did not commit real outbox');
                return row.payload;
            }''', SCOPE)
            # Execute the actual maintained provider's methods and additive
            # contract on fresh synthetic SQLite. No HTTP auth impersonation.
            incoming = {**phone, 'variables': {**phone['variables'], KEY: {**phone['variables'][KEY], 'base_version': '0' * 32}}}
            current = store.get_sillytavern_runtime_state(*SCOPE)
            incoming['variables'][KEY]['base_version'] = current['memory_storage']['version']
            remote = store.save_sillytavern_runtime_state(*SCOPE, incoming)
            assert remote['memory_storage']['digest'] == phone['variables'][KEY]['digest']
            context.close()

            fresh, restored = new_phone()
            restored.evaluate("HomerMemoryQaFixture.bind('A')")
            restored.evaluate('''async({remote,source,scope})=>{
                const {createChatOutbox}=await import('/scripts/homer-chat-outbox.mjs');
                const chatOutbox=createChatOutbox();
                if(await chatOutbox.read(JSON.stringify(scope),'extension-settings'))throw Error('Recovery needs entirely fresh phone storage');
                const {captureCloudSync}=await import('/scripts/homer-cloud-sync.mjs');
                const protocol=await import('/scripts/homer-memory-sync.mjs');
                // Execute the selected real bridge method unchanged. Only its
                // account/launch peripherals are synthetic fixture bindings.
                const actual=new Function('chatOutbox','captureCloudSync','protocol','remote','scope',`
                    const {MEMORY_VARIABLE,MEMORY_ZERO_VERSION,memoryFromPayload,memoryReceipt,verifiedMemoryBook}=protocol;
                    const launch={app_id:scope[1],conversation_id:scope[2]};
                    const session={user:{id:scope[0]}};
                    let storageAccountEpoch=0,runtimeVariables={};
                    const conversationRecoveryBlocked=false;
                    const getContext=()=>window.SillyTavern.getContext();
                    const reconcileStorageAccount=()=>scope[0];
                    const cloudSyncScope=()=>JSON.stringify(scope);
                    const hasCanonicalConversationScope=()=>getContext().chatMetadata.homer_bridge.app_id===scope[1]
                        &&getContext().chatMetadata.homer_bridge.conversation_id===scope[2];
                    const captureExtensionStorage=()=>{throw Error('Passive recovery must not commit');};
                    const extensionSyncQueue={enqueue:()=>{throw Error('Passive recovery must not upload');}};
                    const localSessions={rememberResource:()=>{throw Error('Passive recovery must not save unrelated resources');}};
                    ${source}
                    stagedMemoryRestore={scope:JSON.stringify(scope),owner:scope[0],epoch:storageAccountEpoch,launch,state:remote};
                    return HomerMemoryStorage;
                `)(chatOutbox,captureCloudSync,protocol,remote,scope);
                // Restore invokes exactly the product method. Writes use the
                // real standalone outbox path; no fake save implementation.
                window.HomerMemoryStorage={restore:actual.restore,status:actual.status};
            }''', {'remote': remote, 'source': RESTORE, 'scope': SCOPE})
            opened = restored.evaluate('HomerMemoryQaFixture.open()')
            records = restored.evaluate('HomerMemoryQaFixture.list()')
            assert records['items'][0]['content'] == 'Edited synthetic village promise.', records
            injection = restored.evaluate('HomerMemoryQaFixture.injection()')
            assert 'Edited synthetic village promise.' in injection['prompt'], injection
            restored.wait_for_function("document.querySelector('.homer-memory-backup')?.textContent.includes('云端备份已确认')")
            restored.screenshot(path=str(OUT / f'cloud-recovered-{width}.png'))
            restored.evaluate('HomerMemoryQaFixture.close()')
            restored.evaluate("HomerMemoryQaFixture.bind('B',7)")
            assert not restored.evaluate('HomerMemoryQaFixture.list()')['items']
            assert 'Edited synthetic village promise.' not in restored.evaluate('HomerMemoryQaFixture.injection()')['prompt']
            restored.evaluate("HomerMemoryQaFixture.bind('A')")
            assert 'Edited synthetic village promise.' in restored.evaluate('HomerMemoryQaFixture.injection()')['prompt']
            assert not restored.evaluate('HomerMemoryQaFixture.providerRequests()')
            assert not errors, errors
            assert not failed, failed
            assert not http_errors, http_errors
            assert not console_errors, console_errors
            report.update({'viewport': [width, height], 'freshStorageRestore': True,
                'actualSqliteContract': True, 'actualSelectedBridgeRestore': True, 'actualOutboxCanonical': True,
                'recoveredPromptInjection': True, 'recoveredAbaIsolation': True, 'recoveryNoGeneration': True,
                'recoveredMemoryOpenMs': opened, 'pageErrors': errors, 'requestFailures': failed,
                'httpErrors': http_errors, 'consoleErrors': console_errors, 'productionDeploymentTested': False})
            results.append(report)
            fresh.close()
    finally:
        browser.close()
        store.conn.close()

(OUT / 'cloud-restore-browser-checks.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(results, ensure_ascii=False))
