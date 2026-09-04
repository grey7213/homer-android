import {
    eventSource,
    event_types,
} from '../../../script.js';
import { extension_settings } from '../../extensions.js';

const SETTINGS_KEY = 'homer_keyword_injector';
const ROOT_ID = 'homer-keyword-injector';
const KEYWORDS = Object.freeze([
    Object.freeze({ id: 'status', label: '状态栏', token: '【状态栏】', hint: '触发角色卡的状态栏世界书' }),
    Object.freeze({ id: 'characters', label: '预设角色', token: '【角色开始】', hint: '启用角色卡声明的预设角色' }),
    Object.freeze({ id: 'live', label: '直播', token: '【Live】', hint: '启用直播或 Live 状态栏' }),
]);
const KEYWORD_IDS = new Set(KEYWORDS.map(item => item.id));

let installed = false;
let persistSettings = async () => false;
let logDialogueEvent = async () => {};
let panelOpen = false;
let root = null;
let cardCapabilityKnown = false;
let cardCapabilityEnabled = false;

function normalizedSettings() {
    const source = extension_settings[SETTINGS_KEY];
    const hasStoredSelection = Array.isArray(source?.selected);
    const selected = hasStoredSelection
        ? [...new Set(source.selected.map(value => String(value || '')).filter(value => KEYWORD_IDS.has(value)))]
        : ['status'];
    const value = {
        enabled: source?.enabled === true,
        selected,
    };
    extension_settings[SETTINGS_KEY] = value;
    return value;
}

function selectedKeywords(settings = normalizedSettings()) {
    const selected = new Set(settings.selected);
    return KEYWORDS.filter(item => selected.has(item.id));
}

function save() {
    void Promise.resolve(persistSettings()).catch(error => {
        console.warn('homer-keyword-injector: settings persistence failed', error);
    });
}

function announce(message) {
    const node = root?.querySelector('[data-keyword-announcer]');
    if (node) node.textContent = String(message || '');
}

function render() {
    if (!root) return;
    const settings = normalizedSettings();
    const selected = new Set(settings.selected);
    root.classList.toggle('is-open', panelOpen);
    root.classList.toggle('is-enabled', settings.enabled);
    root.classList.toggle('is-card-disabled', !cardCapabilityKnown || !cardCapabilityEnabled);
    const panel = root.querySelector('[data-keyword-panel]');
    if (panel) panel.hidden = !panelOpen;
    const openButton = root.querySelector('[data-keyword-open]');
    openButton?.setAttribute('aria-expanded', String(panelOpen));
    const toggle = root.querySelector('[data-keyword-toggle]');
    toggle?.setAttribute('aria-pressed', String(settings.enabled));
    toggle?.setAttribute('aria-label', settings.enabled ? '关闭关键词自动注入' : '开启关键词自动注入');
    const state = root.querySelector('[data-keyword-state]');
    if (state) state.textContent = settings.enabled ? '已开启' : '已关闭';
    for (const button of root.querySelectorAll('[data-keyword-option]')) {
        const active = selected.has(String(button.dataset.keywordOption || ''));
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    }
    const preview = root.querySelector('[data-keyword-preview]');
    if (preview) {
        preview.textContent = selectedKeywords(settings).map(item => item.token).join('') || '尚未选择关键词';
    }
}

function updateSettings(updater) {
    const current = normalizedSettings();
    const next = updater({ ...current, selected: [...current.selected] }) || current;
    extension_settings[SETTINGS_KEY] = {
        enabled: next.enabled === true,
        selected: [...new Set((next.selected || []).filter(value => KEYWORD_IDS.has(value)))],
    };
    render();
    save();
}

function appendKeywordsToComposer() {
    const settings = normalizedSettings();
    if (!settings.enabled) return false;
    const textarea = document.querySelector('#send_textarea');
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.disabled) return false;
    const missing = selectedKeywords(settings)
        .map(item => item.token)
        .filter(token => !textarea.value.includes(token));
    if (!missing.length) return false;
    const separator = textarea.value && !/\s$/.test(textarea.value) ? '\n' : '';
    textarea.value = `${textarea.value}${separator}${missing.join('')}`;
    try {
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    } catch {
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    void Promise.resolve(logDialogueEvent('keyword_inject')).catch(() => {});
    announce(`已补入 ${missing.length} 个关键词`);
    return true;
}

function isSendControl(target) {
    return target instanceof Element && Boolean(target.closest(
        '#send_but, #send_form button[type="submit"], #send_form [data-i18n="[title]Send"]',
    ));
}

function bindComposer() {
    document.addEventListener('click', event => {
        if (isSendControl(event.target)) appendKeywordsToComposer();
    }, true);
    document.addEventListener('keydown', event => {
        if (
            event.key === 'Enter'
            && !event.shiftKey
            && !event.isComposing
            && event.target instanceof HTMLTextAreaElement
            && event.target.id === 'send_textarea'
        ) {
            appendKeywordsToComposer();
        }
    }, true);
}

function buildUi() {
    if (root || !document.body) return;
    root = document.createElement('aside');
    root.id = ROOT_ID;
    root.className = 'homer-keyword-injector';
    root.setAttribute('aria-label', '关键词自动注入');
    root.innerHTML = `
        <div class="homer-keyword-injector__rail">
            <button type="button" class="homer-keyword-injector__open" data-keyword-open aria-expanded="false" aria-controls="homer-keyword-panel">关键词注入</button>
            <button type="button" class="homer-keyword-injector__toggle" data-keyword-toggle aria-pressed="false">
                <span class="homer-keyword-injector__light" aria-hidden="true"></span>
                <span data-keyword-state>已关闭</span>
            </button>
        </div>
        <section id="homer-keyword-panel" class="homer-keyword-injector__panel" data-keyword-panel hidden>
            <header>
                <div><strong>关键词注入</strong><span>设置仅作用于当前会话</span></div>
                <button type="button" data-keyword-close aria-label="关闭关键词面板">×</button>
            </header>
            <p class="homer-keyword-injector__intro">发送前自动补入已选关键词，用于触发角色卡世界书。总结或不需要状态栏时可随时关闭。</p>
            <div class="homer-keyword-injector__options">
                ${KEYWORDS.map(item => `<button type="button" data-keyword-option="${item.id}" aria-pressed="false"><strong>${item.label}</strong><span>${item.hint}</span></button>`).join('')}
            </div>
            <div class="homer-keyword-injector__preview"><span>发送预览</span><code data-keyword-preview></code></div>
            <footer>
                <button type="button" data-keyword-clear>清空选择</button>
                <button type="button" class="is-primary" data-keyword-confirm>确认并启用</button>
            </footer>
            <p class="homer-keyword-injector__sr" data-keyword-announcer aria-live="polite"></p>
        </section>`;
    document.body.append(root);
    root.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target.closest('button') : null;
        if (!target) return;
        if (target.matches('[data-keyword-open]')) {
            panelOpen = !panelOpen;
            render();
            return;
        }
        if (target.matches('[data-keyword-close]')) {
            panelOpen = false;
            render();
            return;
        }
        if (target.matches('[data-keyword-toggle]')) {
            updateSettings(settings => ({ ...settings, enabled: !settings.enabled }));
            return;
        }
        if (target.matches('[data-keyword-option]')) {
            const id = String(target.dataset.keywordOption || '');
            updateSettings(settings => ({
                ...settings,
                selected: settings.selected.includes(id)
                    ? settings.selected.filter(value => value !== id)
                    : [...settings.selected, id],
            }));
            return;
        }
        if (target.matches('[data-keyword-clear]')) {
            updateSettings(settings => ({ ...settings, selected: [], enabled: false }));
            announce('已清空并关闭自动注入');
            return;
        }
        if (target.matches('[data-keyword-confirm]')) {
            const settings = normalizedSettings();
            if (!settings.selected.length) {
                announce('请至少选择一个关键词');
                return;
            }
            panelOpen = false;
            updateSettings(value => ({ ...value, enabled: true }));
            announce('关键词自动注入已开启');
        }
    });
    render();
}

export function installKeywordInjector(options = {}) {
    if (installed || options.active === false) return;
    installed = true;
    if (typeof options.persist === 'function') persistSettings = options.persist;
    if (typeof options.logEvent === 'function') logDialogueEvent = options.logEvent;
    normalizedSettings();
    buildUi();
    if (!root) window.addEventListener('DOMContentLoaded', buildUi, { once: true });
    bindComposer();
    // Card-stage publishes this after the active card is known.  Hide the
    // generic rail until then, and keep it hidden for cards without opt-in
    // sidebar declarations.
    document.addEventListener('homer-card-sidebar-capability', event => {
        cardCapabilityKnown = true;
        cardCapabilityEnabled = event?.detail?.enabled === true;
        if (!cardCapabilityEnabled) panelOpen = false;
        render();
    });
    eventSource.on(event_types.SETTINGS_LOADED, render);
}
