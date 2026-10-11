/* Test-only fixture for actual Memory Books in a synthetic runtime/WebView.
 * Never bundle this into production. No extension, Popup or persistence stub.
 * The only optional replacement is an explicitly enabled provider transport.
 * Load after the genuine runtime; call setup({ isolated: true }).
 */
(function installMemoryQaFixture() {
    'use strict';
    const state = { avatar: '', localRuntime: null, providerRequests: [], providerRestore: null };
    // APK modules have canonical /module/dialogue/ identities. Root URLs
    // are correct only for the standalone browser fixture; never import a
    // second copy of the packaged extension/core under another URL.
    const runtimePath = path => new URL(path.replace(/^\/+/, ''), document.baseURI).href;
    const providerMemory = {
        title: 'Village promise',
        content: 'Synthetic A remembers the village promise.',
        keywords: ['village'],
    };
    const providerResponse = {
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(providerMemory) }, finish_reason: 'stop' }],
    };
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    const visible = element => Boolean(element && element.isConnected && !element.closest('[hidden]') && element.getClientRects().length);
    const openDialog = () => Array.from(document.querySelectorAll('.stmb-popup[open]')).reverse().find(visible);
    const button = (name, selector = 'button') => Array.from((openDialog() || document).querySelectorAll(selector))
        .find(element => visible(element) && (element.getAttribute('aria-label') || element.textContent.trim()) === name);
    const row = name => Array.from((openDialog() || document).querySelectorAll('.homer-memory-home .homer-memory-row'))
        .find(element => visible(element) && element.querySelector('span')?.textContent === name);
    async function until(check, message, timeout = 12000) {
        const start = performance.now();
        while (performance.now() - start < timeout) {
            const value = await check();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw Error(message);
    }
    function click(element, label) {
        assert(visible(element), 'Actual UI control missing: ' + label);
        assert(!element.disabled, 'Actual UI control disabled: ' + label);
        element.click();
    }
    function input(element, value) {
        assert(element && visible(element), 'Actual input missing');
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function syntheticOwner(owner) {
        assert(/^synthetic[-_][a-z0-9_-]+$/i.test(owner), 'Only a synthetic owner may use this fixture');
        const stored = JSON.parse(localStorage.getItem('ai_xingyue_user') || 'null');
        assert(!stored || /^synthetic[-_][a-z0-9_-]+$/i.test(String(stored.id || stored.user_id || '')),
            'Refusing to replace an existing real account');
        localStorage.setItem('ai_xingyue_user', JSON.stringify({ id: owner }));
        localStorage.setItem('ai_xingyue_logged_in', '1');
    }
    async function setup({ isolated = false, owner = 'synthetic-memory-owner', providerStub = false } = {}) {
        assert(isolated === true, 'Explicit isolated test host is required');
        assert(window.SillyTavern?.getContext, 'Load the genuine runtime first');
        const core = await import(runtimePath('/script.js'));
        const { Popup } = await import(runtimePath('/scripts/popup.js'));
        // #loader may disappear BEFORE genuine first-run onboarding and core
        // settings have settled. Complete only this synthetic welcome via its
        // real handler, then wait for the exported genuine readiness flag. A
        // native fixture may additionally latch genuine embedded core-ready in
        // window.qaRuntimeReady before loading core (never a guessed timeout).
        const completedWelcomes = new WeakSet();
        const readinessStarted = performance.now();
        await until(async () => {
            for (const popup of Popup.util.popups.filter(value => value.dlg.open && value.content.textContent.includes('欢迎来到惑梦'))) {
                if (completedWelcomes.has(popup)) continue;
                completedWelcomes.add(popup);
                const name = popup.content.querySelector('input');
                if (name) name.value = 'Synthetic';
                await popup.completeAffirmative();
            }
            return core.settingsReady === true && (typeof window.qaRuntimeReady !== 'boolean' || window.qaRuntimeReady === true);
        }, 'Genuine runtime settings/core-ready or welcome did not settle', 120000);
        state.coreReadyWaitMs = Math.round(performance.now() - readinessStarted);
        syntheticOwner(owner);
        document.body.classList.add('homer-runtime');
        // This fixture explicitly unmounts the cloud host, not the memory
        // extension. Remove only that unmounted host's presentation gate.
        document.documentElement.classList.remove('homer-runtime-pending');
        document.querySelector('#homer-runtime-gate')?.remove();
        const data = {
            name: 'Synthetic memory fixture', first_mes: 'Synthetic opening', description: 'Synthetic character',
            personality: '', scenario: '', mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '',
            extensions: { homer_bridge: { app_id: 'synthetic-A' } },
        };
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data };
        const avatarKey = 'homer_memory_qa_avatar:' + owner;
        state.avatar = localStorage.getItem(avatarKey) || '';
        if (!state.avatar) {
            const form = new FormData();
            form.set('avatar', new File([JSON.stringify(card)], 'synthetic.json', { type: 'application/json' }));
            form.set('file_type', 'json');
            form.set('preserved_name', 'synthetic');
            // This journey also exercises the genuine engine character list.
            // The phone adapter deliberately imports into its private mirror,
            // not the isolated engine server's /characters/all list. Use the
            // service's real import on this loopback-only fixture, with its
            // genuine CSRF header; do not forge a character array or extend the
            // product's network allowlist to make a test pass.
            assert(['127.0.0.1', 'localhost', '::1'].includes(location.hostname), 'Loopback service required');
            const result = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/api/characters/import');
                for (const [key, value] of Object.entries(core.getRequestHeaders())) {
                    if (key.toLowerCase() !== 'content-type') xhr.setRequestHeader(key, value);
                }
                xhr.onload = () => {
                    if (xhr.status < 200 || xhr.status >= 300) return reject(Error('Genuine synthetic character import failed: ' + xhr.status));
                    try { resolve(JSON.parse(xhr.responseText)); } catch (error) { reject(error); }
                };
                xhr.onerror = () => reject(Error('Isolated character import transport failed'));
                xhr.send(form);
            });
            assert(typeof result.file_name === 'string' && result.file_name.length > 0, 'Genuine import did not return a character file');
            state.avatar = result.file_name.endsWith('.png') ? result.file_name : result.file_name + '.png';
            localStorage.setItem(avatarKey, state.avatar);
        }
        const { getCharacters } = core;
        await getCharacters();
        const { installLocalRuntime } = await import(runtimePath('/scripts/homer-local-runtime.mjs'));
        state.localRuntime = installLocalRuntime({ isEmbedded: true,
            owner: () => JSON.parse(localStorage.getItem('ai_xingyue_user') || 'null')?.id || '' });
        await state.localRuntime.seedCharacter(state.avatar, card);
        // After switching the real API transport from fixture disk to the
        // owner-local mirror, refresh the genuine character array once. Never
        // select an index from the pre-adapter (possibly larger) server list.
        await getCharacters();
        const { extension_settings } = await import(runtimePath('/scripts/extensions.js'));
        extension_settings.STMemoryBooks ??= {};
        extension_settings.STMemoryBooks.moduleSettings ??= {};
        // Synthetic configuration only. Leave defaultProfile and storage flags
        // alone so first-install normalization and private-book binding run.
        Object.assign(extension_settings.STMemoryBooks.moduleSettings, {
            dismissMissingTopInfoBarJobsNotice: true, showMemoryPreviews: true,
            alwaysUseDefault: true, autoHideMode: 'none', refreshEditor: false,
        });
        const { oai_settings } = await import(runtimePath('/scripts/openai.js'));
        oai_settings.chat_completion_source = 'openai';
        oai_settings.openai_model = 'synthetic-model';
        (await import('/assets/js/memory-ui.js')).installMemoryUi();
        if (!document.querySelector('link[data-memory-qa-design]')) {
            const css = document.createElement('link');
            css.rel = 'stylesheet'; css.href = '/assets/css/chat-design.css';
            css.dataset.memoryQaDesign = '1'; document.head.append(css);
        }
        if (!window.HomerMemoryBooks) await import(runtimePath('/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js'));
        await until(() => window.HomerMemoryBooks?.open, 'Actual Memory Books not registered');
        for (const popup of Popup.util.popups.filter(value => value.dlg.open && value.content.textContent.includes('欢迎来到惑梦'))) {
            const name = popup.content.querySelector('input');
            if (name) name.value = 'Synthetic';
            await popup.completeAffirmative();
        }
        if (providerStub) installProviderStub();
        return { avatar: state.avatar, actualExtension: true, owner };
    }
    function installProviderStub() {
        assert(state.localRuntime, 'Call synthetic setup first');
        if (state.providerRestore) return;
        const previous = window.fetch;
        window.fetch = async function syntheticProviderFetch(resource, init) {
            const url = new URL(resource instanceof Request ? resource.url : String(resource), location.href);
            if (/^\/api\/backends\/.*\/generate/.test(url.pathname)) {
                assert(url.origin === location.origin, 'Synthetic provider must use this test host: ' + url.hostname + url.pathname);
                const body = resource instanceof Request && init?.body == null ? await resource.clone().text() : init?.body;
                const parsed = JSON.parse(typeof body === 'string' ? body : '{}');
                // Record only synthetic message text, never headers/API keys.
                const text = JSON.stringify(parsed.messages ?? parsed.prompt ?? '');
                assert(text.includes('Synthetic'), 'Refusing non-synthetic provider input');
                state.providerRequests.push({ text });
                return new Response(JSON.stringify(providerResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            assert(url.origin === location.origin, 'Unexpected external request in isolated provider fixture: ' + url.hostname + url.pathname);
            return previous.call(this, resource, init);
        };
        state.providerRestore = () => { window.fetch = previous; state.providerRestore = null; };
    }
    async function bind(label, count = 35) {
        assert(state.localRuntime && /^[A-Z0-9_-]+$/.test(label), 'Synthetic setup/label required');
        assert(Number.isInteger(count) && count > 0 && count <= 100, 'Synthetic message count invalid');
        const { saveWorldInfo } = await import(runtimePath('/scripts/world-info.js'));
        await saveWorldInfo('synthetic-author-world', { entries: {} }, true);
        const index = await until(() => {
            const value = window.SillyTavern.getContext().characters.findIndex(item => item.avatar === state.avatar);
            return value >= 0 ? { value } : null;
        }, 'Imported synthetic character missing');
        const context = window.SillyTavern.getContext();
        await context.selectCharacterById(index.value, { skipChatLoad: true, switchMenu: false, persistSelection: false });
        await until(() => window.SillyTavern.getContext().characters.some(value => value.avatar === state.avatar),
            'Imported synthetic character refresh did not settle');
        const active = window.SillyTavern.getContext();
        const character = active.characters.find(value => value.avatar === state.avatar);
        assert(character, 'Imported synthetic character vanished');
        character.chat = 'Synthetic-' + label;
        active.chatMetadata.homer_bridge = { app_id: 'synthetic-' + label, conversation_id: 'synthetic-' + label };
        const response = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: state.avatar, file_name: 'Synthetic-' + label, metadata_only: true }) });
        assert(response.ok, 'Synthetic conversation header failed: ' + response.status);
        const header = await response.json();
        active.chatMetadata.integrity = header.chat_metadata.integrity;
        active.chatMetadata.STMemoryBooks = { contextSettingKey: '__none__' };
        active.chatMetadata.world_info = 'synthetic-author-world';
        active.chat.splice(0, active.chat.length, ...Array.from({ length: count }, (_, index) => ({
            is_user: index % 2 === 0, is_system: false, mes: 'Synthetic ' + label + ' village ' + index,
            name: 'Synthetic', extra: {},
        })));
        await active.printMessages({ scroll: false });
        const { event_types } = await import(runtimePath('/script.js'));
        await active.eventSource.emit(event_types.CHAT_CHANGED, 'Synthetic-' + label);
        document.dispatchEvent(new Event('homer-presentation-invalidated'));
        return { label, count, metadata: { ...active.chatMetadata.homer_bridge } };
    }
    async function open() {
        const start = performance.now();
        void window.HomerMemoryBooks.open();
        await until(() => visible(openDialog()?.querySelector('.homer-memory-home')), 'Actual memory home missing', 4000);
        return performance.now() - start;
    }
    async function close() {
        for (let attempt = 0; openDialog() && attempt < 8; attempt++) {
            click(openDialog().querySelector('.homer-settings-page__back'), 'Memory Back');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        await until(() => !openDialog(), 'Actual memory popup failed to close');
    }
    async function chooseRecentRange({ removeHiddenMarkers = true } = {}) {
        click(row('立即总结'), '立即总结');
        if (removeHiddenMarkers) document.querySelectorAll('#chat .mes_stmb_start,#chat .mes_stmb_end').forEach(value => value.remove());
        click(button('最近 20 条'), '最近 20 条');
        const selected = window.SillyTavern.getContext().chatMetadata.STMemoryBooks;
        assert(selected.sceneStart === 15 && selected.sceneEnd === 34, 'Actual range did not use the 35-message context');
        return [selected.sceneStart, selected.sceneEnd];
    }
    async function generatePreview() {
        if (visible(row('立即总结'))) click(row('立即总结'), '立即总结');
        click(openDialog()?.querySelector('[data-memory-generate]'), '生成记忆');
        await until(() => visible(document.querySelector('#stmb-preview-content')), 'Actual generation preview missing', 20000);
        assert(!(await list()).items.length, 'Actual preview unexpectedly auto-saved');
        return { previewNoAutosave: true };
    }
    async function savePreview({ title = 'Saved village promise', content = 'Saved synthetic village promise.' } = {}) {
        input(document.querySelector('#stmb-preview-title'), title);
        input(document.querySelector('#stmb-preview-content'), content);
        click(openDialog()?.querySelector('.popup-button-ok'), 'Accept preview');
        const snapshot = await until(async () => {
            const result = await list(); return result.items.length ? result : null;
        }, 'Actual memory save did not persist');
        assert(snapshot.items.length === 1 && snapshot.items[0].content === content, 'Actual persisted summary differs');
        assert(window.SillyTavern.getContext().chatMetadata.world_info === 'synthetic-author-world', 'Creator book binding changed');
        assert(!Array.from(document.querySelectorAll('dialog[open]')).some(value => value.textContent.includes('Memory Lorebook Missing')),
            'Legacy missing-book recovery appeared');
        return { savedEntries: snapshot.items.length, content };
    }
    async function editRecord({ content, enabled } = {}) {
        if (!openDialog()) await open();
        if (visible(row('我的记忆'))) click(row('我的记忆'), '我的记忆');
        const record = await until(() => Array.from(document.querySelectorAll('.homer-memory-record')).find(visible), 'Actual memory record missing');
        click(record, 'Memory record');
        if (content != null) input(document.querySelector('.homer-memory-editor [aria-label="记忆内容"]'), content);
        if (enabled != null) {
            const checkbox = document.querySelector('.homer-memory-editor input[type="checkbox"]');
            assert(checkbox && visible(checkbox), 'Actual memory enabled control missing');
            checkbox.checked = enabled;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
        click(button('保存记忆'), '保存记忆');
        await until(() => Array.from(document.querySelectorAll('.homer-memory-record')).find(visible), 'Actual editor save did not return to records');
        return list();
    }
    async function list() { return window.HomerMemoryBooks.memories.list(); }
    async function injection() {
        const { getSortedEntries, getWorldInfoPrompt } = await import(runtimePath('/scripts/world-info.js'));
        const entries = await getSortedEntries();
        const prompt = await getWorldInfoPrompt(['Synthetic village promise'], 4096, false, {});
        return { entries: entries.filter(value => value.stmemorybooks), prompt: JSON.stringify(prompt) };
    }
    async function runJourney() {
        assert(state.providerRestore, 'For an automated journey, enable the synthetic provider stub');
        state.providerRequests.length = 0;
        await bind('A');
        const firstOpenMs = await open();
        assert(!(await list()).items.length, 'Use a fresh synthetic owner/store for this full journey');
        assert(!state.providerRequests.length, 'Passive opening generated content');
        assert(window.SillyTavern.getContext().chatMetadata.STMemoryBooks.sceneStart == null, 'Passive opening selected a range');
        const range = await chooseRecentRange();
        await close(); await open();
        assert(document.querySelector('#homer-memory-from').value === '16' && document.querySelector('#homer-memory-to').value === '35',
            'Actual selected range was not restored');
        await generatePreview();
        assert(state.providerRequests.length === 1, 'Expected exactly one synthetic provider request');
        const text = state.providerRequests[0].text;
        assert(text.includes('Synthetic A village 15') && text.includes('Synthetic A village 34') && !text.includes('Synthetic A village 14'),
            'Actual generation did not use the selected range');
        await savePreview();
        assert((await injection()).prompt.includes('Saved synthetic village promise.'), 'Actual scanner omitted saved memory');
        await close();
        const reopenMs = await open();
        await editRecord({ content: 'Edited synthetic village promise.' });
        assert((await injection()).prompt.includes('Edited synthetic village promise.'), 'Actual scanner omitted edited memory');
        await editRecord({ enabled: false });
        assert(!(await injection()).prompt.includes('Edited synthetic village promise.'), 'Actual scanner injected disabled memory');
        await editRecord({ enabled: true });
        await close();
        await bind('B', 7);
        assert(!(await list()).items.length && !(await injection()).prompt.includes('Edited synthetic village promise.'), 'Conversation B leaked A memory');
        await bind('A');
        assert((await list()).items[0].content === 'Edited synthetic village promise.', 'A/B/A lost durable record');
        assert((await injection()).prompt.includes('Edited synthetic village promise.'), 'A/B/A lost actual injection');
        assert(state.providerRequests.length === 1, 'Passive reopening/switching generated content');
        return { coreReadyWaitMs: state.coreReadyWaitMs, firstOpenMs, reopenMs, range, providerStubRequests: 1, savedEntries: 1,
            previewNoAutosave: true, editToggleRealInjection: true, abaIsolation: true };
    }
    async function verifyColdReopen() {
        await bind('A');
        assert((await list()).items[0]?.content === 'Edited synthetic village promise.', 'Document restart lost persisted memory');
        assert((await injection()).prompt.includes('Edited synthetic village promise.'), 'Document restart lost actual injection');
        const openMs = await open(); await close();
        assert(!state.providerRequests.length, 'Cold passive reopen generated content');
        return { coreReadyWaitMs: state.coreReadyWaitMs, documentColdReopenDurable: true, coldMemoryOpenMs: openMs };
    }
    window.HomerMemoryQaFixture = Object.freeze({
        setup, bind, open, close, chooseRecentRange, generatePreview, savePreview, editRecord, list, injection,
        runJourney, verifyColdReopen, installProviderStub, providerResponse,
        providerRequests: () => state.providerRequests.map(value => ({ ...value })),
        restoreProvider: () => state.providerRestore?.(),
    });
})();
