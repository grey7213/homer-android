import { eventSource, event_types } from '../../../script.js';
import { getContext } from '../../st-context.js';

const COMPONENT_TYPES = new Set(['map', 'inventory', 'relationship', 'skill_tree', 'status']);
const BODY_LAYOUT_CLASSES = [
    'homer-card-stage-active',
    'homer-archive-stage-active',
    'homer-stage-layout-standard',
    'homer-stage-layout-landscape',
    'homer-stage-layout-split',
    'homer-stage-layout-visual_novel',
    'homer-stage-input-floating',
    'homer-stage-portrait-left',
    'homer-stage-portrait-center',
    'homer-stage-portrait-right',
    'homer-stage-portrait-hidden',
    'homer-stage-avatars-hidden',
    'homer-stage-avatars-split',
    'homer-stage-avatars-left',
    'homer-stage-avatars-right',
];
const MAX_COMPONENT_BYTES = 100_000;
const MAX_ITEMS = 200;
const PRESENTATION_MODE_VISUAL = 'visual_novel';
const PRESENTATION_MODE_TAVERN = 'tavern';
let installed = false;
let legacyRuntimePromise = null;
let legacyRuntimeModule = null;
let refreshEpoch = 0;

function currentCharacter() {
    const context = getContext();
    return context.characters?.[context.characterId] || null;
}

function cardExtensions(character = currentCharacter()) {
    const value = character?.data?.extensions;
    return value && typeof value === 'object' ? value : {};
}

function experience(character = currentCharacter()) {
    const value = cardExtensions(character).homer_card_experience;
    return value && typeof value === 'object' ? value : {};
}

function mediaAssets(character = currentCharacter()) {
    const items = cardExtensions(character).homer_media_assets;
    return Array.isArray(items) ? items.filter(item => item && typeof item === 'object').slice(0, MAX_ITEMS) : [];
}

function safeUrl(value, kind = 'image') {
    const input = String(value || '').trim();
    if (!input) return '';
    if (input.startsWith('/') && !input.startsWith('//')) return input;
    if (/^https:\/\//i.test(input)) return input;
    if (kind === 'image' && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(input)) return input;
    return '';
}

function number(value, min, max, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function text(value, maximum = 4000) {
    return String(value == null ? '' : value).slice(0, maximum);
}

function element(tag, className = '', content = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = text(content);
    return node;
}

function findAsset(id, kinds = []) {
    const allowed = new Set(Array.isArray(kinds) ? kinds : [kinds]);
    return mediaAssets().find(item => String(item.id || '') === String(id || '') && (!allowed.size || allowed.has(item.kind)));
}

function clearStage() {
    document.body.classList.remove(...BODY_LAYOUT_CLASSES);
    for (const name of [
        '--homer-stage-chat-width', '--homer-stage-accent', '--homer-stage-user-bubble',
        '--homer-stage-assistant-bubble', '--homer-stage-text', '--homer-stage-radius',
        '--homer-stage-font-scale', '--homer-stage-input-background',
        '--homer-stage-input-text', '--homer-stage-input-border',
        '--homer-stage-portrait-width', '--homer-stage-portrait-opacity',
    ]) document.body.style.removeProperty(name);
    const backdrop = document.getElementById('homerCardStageBackdrop');
    for (const video of backdrop?.querySelectorAll('video') || []) {
        video.pause();
        video.removeAttribute('src');
        try { video.load(); } catch { /* already detached or unavailable */ }
    }
    backdrop?.remove();
    document.getElementById('homerCardExperienceRoot')?.remove();
}

function requestHostOrientation(value = 'default') {
    const orientation = value === 'landscape' ? 'landscape' : 'default';
    document.documentElement.dataset.homerOrientation = orientation;
    try {
        const nativeBridge = window.HomerNative || window.parent?.HomerNative || window.top?.HomerNative;
        if (typeof nativeBridge?.requestOrientation === 'function') {
            nativeBridge.requestOrientation(orientation);
        }
    } catch {
        // Browser/PWA hosts intentionally keep their current orientation.
    }
}

function closeShellDrawersForStage() {
    for (const drawer of document.querySelectorAll('#homer-left-drawer, #homer-right-drawer')) {
        drawer.classList.remove('is-open');
        drawer.setAttribute('aria-hidden', 'true');
    }
    const backdrop = document.querySelector('#homer-drawer-backdrop');
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove('homer-drawer-open', 'homer-left-drawer-open');
}

function applyStage(stage = {}) {
    if (!stage || stage.enabled !== true) return;
    const layouts = new Set(['standard', 'landscape', 'split', 'visual_novel']);
    const layout = layouts.has(stage.layout) ? stage.layout : 'standard';
    const portraitPositions = new Set(['left', 'center', 'right']);
    const portraitPosition = portraitPositions.has(stage.portrait_position)
        ? stage.portrait_position
        : 'right';
    const avatarPositions = new Set(['split', 'left', 'right']);
    const avatarPosition = avatarPositions.has(stage.avatar_position) ? stage.avatar_position : 'split';
    document.body.classList.add('homer-card-stage-active', `homer-stage-layout-${layout}`);
    if (stage.input_style === 'floating') document.body.classList.add('homer-stage-input-floating');
    document.body.classList.add(`homer-stage-portrait-${portraitPosition}`);
    if (stage.show_portrait === false) document.body.classList.add('homer-stage-portrait-hidden');
    if (stage.show_avatars === false) document.body.classList.add('homer-stage-avatars-hidden');
    document.body.classList.add(`homer-stage-avatars-${avatarPosition}`);
    document.body.style.setProperty('--homer-stage-chat-width', `${number(stage.chat_width, 35, 100, 72)}%`);
    document.body.style.setProperty('--homer-stage-accent', text(stage.accent_color || '#d7b878', 32));
    document.body.style.setProperty('--homer-stage-user-bubble', text(stage.user_bubble_color || '#5b4635', 32));
    document.body.style.setProperty('--homer-stage-assistant-bubble', text(stage.assistant_bubble_color || '#211d19', 32));
    document.body.style.setProperty('--homer-stage-text', text(stage.text_color || '#fff8ed', 32));
    document.body.style.setProperty('--homer-stage-radius', `${number(stage.bubble_radius, 0, 36, 18)}px`);
    document.body.style.setProperty('--homer-stage-font-scale', String(number(stage.font_scale, 0.8, 1.35, 1)));
    document.body.style.setProperty('--homer-stage-input-background', text(stage.input_background_color || stage.assistant_bubble_color || '#211d19', 32));
    document.body.style.setProperty('--homer-stage-input-text', text(stage.input_text_color || stage.text_color || '#fff8ed', 32));
    document.body.style.setProperty('--homer-stage-input-border', text(stage.input_border_color || stage.accent_color || '#d7b878', 32));
    document.body.style.setProperty('--homer-stage-portrait-width', `${number(stage.portrait_width, 18, 70, 43)}vw`);
    document.body.style.setProperty('--homer-stage-portrait-opacity', String(number(stage.portrait_opacity, 0.2, 1, 1)));

    const backdrop = element('div', 'homer-card-stage-backdrop');
    backdrop.id = 'homerCardStageBackdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    const background = findAsset(stage.background_asset_id, 'background');
    const backgroundUrl = safeUrl(background?.url, String(background?.mime_type || '').startsWith('video/') ? 'media' : 'image');
    if (backgroundUrl && String(background?.mime_type || '').startsWith('video/')) {
        const video = document.createElement('video');
        video.src = backgroundUrl;
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.referrerPolicy = 'no-referrer';
        backdrop.append(video);
        void video.play().catch(() => {});
    } else if (backgroundUrl) {
        const image = document.createElement('img');
        image.src = backgroundUrl;
        image.alt = '';
        image.decoding = 'async';
        image.fetchPriority = 'high';
        image.referrerPolicy = 'no-referrer';
        backdrop.append(image);
    }
    const portrait = findAsset(stage.portrait_asset_id, ['portrait']);
    const portraitUrl = safeUrl(portrait?.url, 'image');
    if (portraitUrl) {
        const image = document.createElement('img');
        image.className = 'homer-card-stage-backdrop__portrait';
        image.src = portraitUrl;
        image.alt = '';
        image.decoding = 'async';
        image.fetchPriority = 'high';
        image.referrerPolicy = 'no-referrer';
        backdrop.append(image);
    }
    document.body.prepend(backdrop);
}

function cardForLegacyRuntime(character) {
    const cardExperience = experience(character);
    const entries = Array.isArray(character?.data?.character_book?.entries)
        ? character.data.character_book.entries
        : [];
    // Only IDs, public labels and media bindings enter the visual layer. The
    // protected worldbook body is intentionally never copied into browser UI.
    const publicWorld = entries.slice(0, 2000).map((entry, index) => ({
        id: String(entry?.id ?? entry?.uid ?? index),
        name: text(entry?.name || entry?.comment || `场景 ${index + 1}`, 120),
        content: '',
        media_bindings: Array.isArray(entry?.extensions?.homer_media_bindings)
            ? entry.extensions.homer_media_bindings
            : (Array.isArray(entry?.media_bindings) ? entry.media_bindings : []),
    }));
    return {
        name: text(character?.name || character?.data?.name || '', 160),
        card_experience: cardExperience,
        media_assets: mediaAssets(character),
        world_info: publicWorld,
    };
}

function shouldMountLegacyRuntime(config) {
    return Boolean(
        config?.stage?.enabled
        || config?.bgm?.enabled
        || config?.galgame?.enabled
        || (Array.isArray(config?.ui_rules) && config.ui_rules.length)
        || sidebarCapability(config),
    );
}

function visualPresentationAvailable(config = experience()) {
    return Boolean(
        shouldMountLegacyRuntime(config)
        && (config?.stage?.enabled || config?.galgame?.enabled),
    );
}

// Card sidebars are opt-in.  Keep the capability decision in the card
// configuration so ordinary cards do not receive an unrelated rail or empty
// trigger container.
function sidebarCapability(config = experience()) {
    return Array.isArray(config?.sidebars)
        && config.sidebars.some(item => item && typeof item === 'object' && item.enabled !== false);
}

function publishSidebarCapability(config = experience()) {
    document.dispatchEvent(new CustomEvent('homer-card-sidebar-capability', {
        detail: { enabled: sidebarCapability(config) },
    }));
}

function presentationModeStorageKey() {
    const context = getContext();
    const character = String(context?.characterId ?? 'none');
    const conversation = String(context?.chatId ?? context?.chatMetadata?.chat_id ?? 'default');
    return `homer:presentation-mode:${character}:${conversation}`;
}

function presentationMode(config = experience()) {
    if (!visualPresentationAvailable(config)) return PRESENTATION_MODE_TAVERN;
    try {
        return sessionStorage.getItem(presentationModeStorageKey()) === PRESENTATION_MODE_TAVERN
            ? PRESENTATION_MODE_TAVERN
            : PRESENTATION_MODE_VISUAL;
    } catch {
        return PRESENTATION_MODE_VISUAL;
    }
}

function publishPresentationMode(config = experience()) {
    document.dispatchEvent(new CustomEvent('homer-presentation-mode-state', {
        detail: {
            mode: presentationMode(config),
            visualAvailable: visualPresentationAvailable(config),
        },
    }));
}

async function setPresentationMode(mode) {
    const config = experience();
    const next = mode === PRESENTATION_MODE_TAVERN
        ? PRESENTATION_MODE_TAVERN
        : PRESENTATION_MODE_VISUAL;
    if (next === PRESENTATION_MODE_VISUAL && !visualPresentationAvailable(config)) {
        publishPresentationMode(config);
        return false;
    }
    try {
        sessionStorage.setItem(presentationModeStorageKey(), next);
    } catch {
        // Session-only preference gracefully falls back to the card default.
    }
    await refreshStage();
    return true;
}

async function legacyRuntime() {
    legacyRuntimePromise ||= import('/app/assets/js/card-experience-runtime.mjs?v=20260821-chatarchive-dialogue-only-v5').catch(error => {
        console.warn('homer-card-stage: legacy visual runtime unavailable', error?.message || error);
        return null;
    });
    legacyRuntimeModule = await legacyRuntimePromise;
    return legacyRuntimeModule;
}

function composerInsert(event) {
    const detail = event?.detail || {};
    const textarea = document.querySelector('#send_textarea');
    const value = text(detail.text, 2000).trim();
    if (!textarea || !value) return;
    textarea.value = detail.mode === 'replace'
        ? value
        : `${textarea.value || ''}${textarea.value ? '\n' : ''}${value}`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
}

function composerSubmit(event) {
    const value = text(event?.detail?.text, 10_000).trim();
    const textarea = document.querySelector('#send_textarea');
    const sendButton = document.querySelector('#send_but, #send_form button[type="submit"]');
    if (!value || !textarea || !sendButton) return;
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    if (sendButton.matches('[disabled], .disabled')) return;
    sendButton.click();
}

async function generateFromStage(event) {
    const type = String(event?.detail?.type || 'continue');
    if (type !== 'continue') return;
    const context = getContext();
    if (typeof context?.generate !== 'function') return;
    try {
        await context.generate('continue');
    } catch (error) {
        console.warn('homer-card-stage: continue failed', error?.message || error);
    }
}

function exitArchiveStage() {
    if (window.parent === window) return;
    window.parent.postMessage({
        channel: 'homer:dialogue-host:v1',
        version: 1,
        type: 'navigate',
        target: '/app/explore.html',
    }, window.location.origin);
}

function structuredSettings() {
    const raw = experience().structured_components;
    const output = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: output.enabled !== false,
        map: output.map !== false,
        inventory: output.inventory !== false,
        relationship: output.relationship !== false,
        skill_tree: output.skill_tree !== false,
        status: output.status !== false,
    };
}

function parseStructuredBlocks(raw) {
    const source = text(raw, 250_000);
    const blocks = [];
    const matcher = /```(?:homer-ui|homer_component)[^\r\n]*\r?\n([\s\S]*?)```/gi;
    let match;
    while ((match = matcher.exec(source)) && blocks.length < 12) {
        const json = match[1].trim();
        if (!json || json.length > MAX_COMPONENT_BYTES) continue;
        try {
            const payload = JSON.parse(json);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
            const type = String(payload.type || '').toLowerCase().replaceAll('-', '_');
            if (!COMPONENT_TYPES.has(type)) continue;
            blocks.push({ type, payload, json, raw: match[0] });
        } catch {
            // Invalid author/model data remains a normal code block for diagnosis.
        }
    }
    return blocks;
}

function componentShell(payload, type) {
    const root = element('section', `homer-card-component homer-card-component--${type}`);
    root.dataset.componentType = type;
    root.dataset.componentId = text(payload.id || '', 100);
    const accent = text(payload.accent_color || '', 32);
    if (/^(?:#[0-9a-f]{3,8}|rgba?\([^)]{1,28}\)|hsla?\([^)]{1,28}\))$/i.test(accent)) {
        root.style.setProperty('--component-accent', accent);
    }
    const header = element('header', 'homer-card-component__header');
    const titles = { map: '探索地图', inventory: '物品清单', relationship: '人物关系', skill_tree: '技能树', status: '状态' };
    header.append(element('strong', '', text(payload.title || titles[type], 120)));
    if (payload.subtitle) header.append(element('small', '', text(payload.subtitle, 240)));
    root.append(header);
    return root;
}

function mapNode(raw, index = 0, depth = 0, counter = { value: 0 }) {
    if (!raw || typeof raw !== 'object' || depth > 7 || counter.value >= MAX_ITEMS) return null;
    counter.value += 1;
    const children = Array.isArray(raw.children)
        ? raw.children.map((item, childIndex) => mapNode(item, childIndex, depth + 1, counter)).filter(Boolean)
        : [];
    return {
        id: text(raw.id || `map-${depth}-${index}`, 100),
        name: text(raw.name || raw.title || `区域 ${index + 1}`, 100),
        description: text(raw.description || raw.desc, 2000),
        image: safeUrl(raw.image || raw.background, 'image'),
        x: number(raw.x, 5, 95, NaN),
        y: number(raw.y, 8, 92, NaN),
        prompt: text(raw.prompt, 500),
        children,
    };
}

function renderMap(payload) {
    const shell = componentShell(payload, 'map');
    const rootNode = mapNode(payload.root || payload.map || payload);
    if (!rootNode) return shell;
    const breadcrumbs = element('nav', 'homer-map__breadcrumbs');
    const viewport = element('div', 'homer-map__viewport');
    const description = element('p', 'homer-map__description');
    const action = element('button', 'homer-map__action', text(payload.action_label || '写入行动', 40));
    action.type = 'button';
    action.hidden = true;
    const path = [rootNode];

    const draw = () => {
        const current = path[path.length - 1];
        breadcrumbs.replaceChildren();
        path.forEach((item, index) => {
            const button = element('button', index === path.length - 1 ? 'is-current' : '', item.name);
            button.type = 'button';
            button.disabled = index === path.length - 1;
            button.addEventListener('click', () => { path.splice(index + 1); draw(); });
            breadcrumbs.append(button);
        });
        viewport.replaceChildren();
        viewport.dataset.mapNodeId = current.id;
        viewport.style.backgroundImage = current.image ? `url("${current.image.replace(/["\\\r\n]/g, '')}")` : '';
        viewport.classList.remove('is-transitioning');
        void viewport.offsetWidth;
        viewport.classList.add('is-transitioning');
        const children = current.children;
        children.forEach((child, index) => {
            const button = element('button', 'homer-map__marker');
            button.type = 'button';
            button.style.left = `${Number.isFinite(child.x) ? child.x : 14 + ((index * 29) % 72)}%`;
            button.style.top = `${Number.isFinite(child.y) ? child.y : 18 + ((index * 23) % 62)}%`;
            button.append(element('span', 'homer-map__pin', '◆'), element('strong', '', child.name));
            if (child.description) button.title = child.description;
            button.addEventListener('click', () => {
                path.push(child);
                draw();
            });
            viewport.append(button);
        });
        if (!children.length) viewport.append(element('div', 'homer-map__empty', '这里已经是最深层地点'));
        description.textContent = current.description;
        description.hidden = !current.description;
        action.hidden = !current.prompt;
        action.onclick = current.prompt
            ? () => document.dispatchEvent(new CustomEvent('card-experience-insert-text', {
                detail: { text: current.prompt, mode: 'append' },
            }))
            : null;
    };
    shell.append(breadcrumbs, viewport, description, action);
    draw();
    return shell;
}

function renderInventory(payload) {
    const shell = componentShell(payload, 'inventory');
    const tools = element('div', 'homer-inventory__tools');
    const search = document.createElement('input');
    search.type = 'search'; search.placeholder = '搜索物品'; search.setAttribute('aria-label', '搜索物品');
    const categories = document.createElement('select');
    categories.setAttribute('aria-label', '筛选分类');
    const items = (Array.isArray(payload.items) ? payload.items : []).slice(0, MAX_ITEMS).filter(item => item && typeof item === 'object');
    const values = [...new Set(items.map(item => text(item.category || item.type, 60)).filter(Boolean))];
    categories.append(new Option('全部分类', ''));
    values.forEach(value => categories.append(new Option(value, value)));
    tools.append(search, categories);
    const grid = element('div', 'homer-inventory__grid');
    const draw = () => {
        const query = search.value.trim().toLowerCase();
        const category = categories.value;
        grid.replaceChildren();
        items.filter(item => {
            const haystack = `${item.name || ''} ${item.description || item.desc || ''}`.toLowerCase();
            return (!query || haystack.includes(query)) && (!category || String(item.category || item.type || '') === category);
        }).forEach(item => {
            const card = element('article', 'homer-inventory__item');
            const iconUrl = safeUrl(item.icon || item.image, 'image');
            if (iconUrl) { const image = document.createElement('img'); image.src = iconUrl; image.alt = ''; card.append(image); }
            const copy = element('div');
            copy.append(element('strong', '', text(item.name || '未命名物品', 100)));
            if (item.description || item.desc) copy.append(element('p', '', text(item.description || item.desc, 800)));
            card.append(copy);
            if (item.quantity != null || item.qty != null) card.append(element('b', 'homer-inventory__quantity', `×${text(item.quantity ?? item.qty, 20)}`));
            if (item.rarity) card.dataset.rarity = text(item.rarity, 40);
            grid.append(card);
        });
        if (!grid.childElementCount) grid.append(element('p', 'homer-component__empty', '没有符合条件的物品'));
    };
    search.addEventListener('input', draw); categories.addEventListener('change', draw);
    shell.append(tools, grid); draw();
    return shell;
}

function renderRelationship(payload) {
    const shell = componentShell(payload, 'relationship');
    const graph = element('div', 'homer-relationship__graph');
    const detail = element('aside', 'homer-relationship__detail');
    const center = payload.center && typeof payload.center === 'object' ? payload.center : { name: payload.center || '我' };
    const nodes = (Array.isArray(payload.nodes) ? payload.nodes : Array.isArray(payload.people) ? payload.people : []).slice(0, 30).filter(item => item && typeof item === 'object');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 1000 560'); svg.setAttribute('aria-hidden', 'true');
    graph.append(svg);
    const buttons = [];
    const selectNode = (item, button) => {
        buttons.forEach(itemButton => {
            const selected = itemButton === button;
            itemButton.classList.toggle('is-selected', selected);
            itemButton.setAttribute('aria-pressed', String(selected));
        });
        detail.replaceChildren(
            element('strong', '', text(item.name || item.label || '人物', 80)),
            element('span', '', text(item.relation || item.type || '', 80)),
            element('p', '', text(item.description || item.desc || '暂无更多资料', 1200)),
        );
    };
    const centerButton = element('button', 'homer-relationship__node is-center', text(center.name || center.label || '我', 80));
    centerButton.type = 'button'; centerButton.style.left = '50%'; centerButton.style.top = '50%';
    centerButton.addEventListener('click', () => selectNode(center, centerButton));
    buttons.push(centerButton); graph.append(centerButton);
    nodes.forEach((item, index) => {
        const angle = (Math.PI * 2 * index / Math.max(nodes.length, 1)) - Math.PI / 2;
        const x = 50 + Math.cos(angle) * 38; const y = 50 + Math.sin(angle) * 37;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', '500'); line.setAttribute('y1', '280'); line.setAttribute('x2', String(x * 10)); line.setAttribute('y2', String(y * 5.6));
        line.dataset.relation = text(item.relation || item.type, 40); svg.append(line);
        const button = element('button', 'homer-relationship__node', text(item.name || item.label || `人物 ${index + 1}`, 80));
        button.type = 'button'; button.style.left = `${x}%`; button.style.top = `${y}%`;
        button.title = text(item.description || item.relation || '', 500);
        button.addEventListener('click', () => selectNode(item, button));
        buttons.push(button); graph.append(button);
    });
    shell.append(graph, detail);
    selectNode(center, centerButton);
    return shell;
}

function renderSkillTree(payload) {
    const shell = componentShell(payload, 'skill_tree');
    const tree = element('div', 'homer-skill-tree');
    const detail = element('aside', 'homer-skill-tree__detail', text(payload.hint || '点击技能查看说明', 300));
    const skills = (Array.isArray(payload.skills) ? payload.skills : Array.isArray(payload.nodes) ? payload.nodes : []).slice(0, MAX_ITEMS).filter(item => item && typeof item === 'object');
    const tiers = new Map();
    skills.forEach(item => { const tier = number(item.tier ?? item.level, 0, 20, 0); if (!tiers.has(tier)) tiers.set(tier, []); tiers.get(tier).push(item); });
    [...tiers.keys()].sort((a, b) => a - b).forEach(tier => {
        const row = element('section', 'homer-skill-tree__tier');
        row.append(element('small', '', `阶段 ${tier + 1}`));
        const nodes = element('div');
        tiers.get(tier).forEach(item => {
            const button = element('button', item.unlocked === false ? 'is-locked' : 'is-unlocked', text(item.name || '技能', 80));
            button.type = 'button'; button.addEventListener('click', () => {
                detail.textContent = text(item.description || item.desc || item.name, 1200);
                detail.dataset.state = item.unlocked === false ? 'locked' : 'unlocked';
            });
            nodes.append(button);
        });
        row.append(nodes); tree.append(row);
    });
    shell.append(tree, detail); return shell;
}

function renderStatus(payload) {
    const shell = componentShell(payload, 'status');
    const grid = element('div', 'homer-status-component__grid');
    const detail = element('aside', 'homer-status-component__detail', text(payload.hint || '选择状态查看说明', 300));
    const items = (Array.isArray(payload.items) ? payload.items : Array.isArray(payload.stats) ? payload.stats : []).slice(0, MAX_ITEMS).filter(item => item && typeof item === 'object');
    const cards = [];
    items.forEach(item => {
        const card = element('button', 'homer-status-component__item');
        card.type = 'button';
        card.setAttribute('aria-pressed', 'false');
        const top = element('div'); top.append(element('strong', '', text(item.name || item.label || '状态', 80)), element('span', '', text(item.value ?? '', 80))); card.append(top);
        if (item.max != null) {
            const track = element('div', 'homer-status-component__track'); const fill = element('i');
            fill.style.width = `${number((Number(item.value) / Math.max(Number(item.max), 1)) * 100, 0, 100, 0)}%`; track.append(fill); card.append(track);
        }
        card.addEventListener('click', () => {
            cards.forEach(itemCard => {
                const selected = itemCard === card;
                itemCard.classList.toggle('is-selected', selected);
                itemCard.setAttribute('aria-pressed', String(selected));
            });
            detail.textContent = text(item.description || item.desc || `${item.name || item.label || '状态'}：${item.value ?? ''}`, 1200);
        });
        cards.push(card);
        grid.append(card);
    });
    if (!items.length) grid.append(element('p', 'homer-component__empty', '暂无状态数据'));
    shell.append(grid, detail);
    if (cards.length) cards[0].click();
    return shell;
}

function renderComponent(block) {
    if (block.type === 'map') return renderMap(block.payload);
    if (block.type === 'inventory') return renderInventory(block.payload);
    if (block.type === 'relationship') return renderRelationship(block.payload);
    if (block.type === 'skill_tree') return renderSkillTree(block.payload);
    return renderStatus(block.payload);
}

function removeVisibleTextSequence(textRoot, sequence) {
    const needle = String(sequence || '').trim();
    if (!needle) return false;
    const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return node.parentElement?.closest('.homer-card-component')
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes = [];
    let combined = '';
    while (walker.nextNode() && combined.length <= 250_000) {
        nodes.push({ node: walker.currentNode, start: combined.length });
        combined += walker.currentNode.nodeValue || '';
    }
    const offset = combined.indexOf(needle);
    if (offset < 0) return false;
    const endOffset = offset + needle.length;
    const startEntry = [...nodes].reverse().find(entry => entry.start <= offset);
    const endEntry = [...nodes].reverse().find(entry => entry.start < endOffset);
    if (!startEntry || !endEntry) return false;
    const range = document.createRange();
    range.setStart(startEntry.node, offset - startEntry.start);
    range.setEnd(endEntry.node, endOffset - endEntry.start);
    range.deleteContents();
    return true;
}

function hideStructuredCode(textRoot, block) {
    const expected = block.json.trim();
    let removed = false;
    for (const node of [...textRoot.querySelectorAll('pre, code')]) {
        if (!node.isConnected || node.closest('.homer-card-component')) continue;
        const value = node.textContent.trim();
        if (value !== expected && !value.includes(block.raw.trim())) continue;
        const target = node.closest('pre') || node;
        target.remove();
        removed = true;
    }
    if (!removed) removed = removeVisibleTextSequence(textRoot, block.raw);
    if (!removed) removeVisibleTextSequence(textRoot, expected);
}

async function renderMessage(messageId, { consumeExperience = true } = {}) {
    const context = getContext();
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0 || id >= context.chat.length) return;
    const message = context.chat[id];
    const textRoot = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
    if (!textRoot) return;
    textRoot.querySelectorAll('.homer-card-component').forEach(node => node.remove());
    const settings = structuredSettings();
    const canRenderStructured = !message?.is_user && !message?.is_system;
    const blocks = settings.enabled && canRenderStructured ? parseStructuredBlocks(message?.mes) : [];
    for (const block of blocks) {
        if (!settings[block.type]) continue;
        hideStructuredCode(textRoot, block);
        textRoot.append(renderComponent(block));
    }
    if (!canRenderStructured || !shouldMountLegacyRuntime(experience())) return;
    const latestAssistantIndex = context.chat.findLastIndex(item => !item?.is_user && !item?.is_system);
    const runtime = await legacyRuntime();
    if (!runtime) return;
    if (consumeExperience && id === latestAssistantIndex && presentationMode(experience()) === PRESENTATION_MODE_VISUAL) {
        runtime.consumeCardExperienceText?.(message?.mes || '', { messageId: id });
    }
    if (typeof runtime.cleanCardExperienceText === 'function') {
        const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(node => {
            if (node.parentElement?.closest('.homer-card-component')) return;
            const cleaned = runtime.cleanCardExperienceText(node.nodeValue || '');
            if (cleaned !== node.nodeValue) node.nodeValue = cleaned;
        });
    }
}

async function renderAllMessages({ consumeExperience = true } = {}) {
    const context = getContext();
    for (let index = 0; index < context.chat.length; index += 1) {
        await renderMessage(index, { consumeExperience: false });
    }
    if (!consumeExperience || presentationMode(experience()) !== PRESENTATION_MODE_VISUAL || !shouldMountLegacyRuntime(experience())) return;
    const latestAssistantIndex = context.chat.findLastIndex(message => !message?.is_user && !message?.is_system);
    if (latestAssistantIndex < 0) return;
    const runtime = await legacyRuntime();
    runtime?.consumeCardExperienceText?.(context.chat[latestAssistantIndex]?.mes || '', {
        messageId: latestAssistantIndex,
    });
}

async function refreshStage() {
    const epoch = ++refreshEpoch;
    legacyRuntimeModule?.destroyCardExperience?.();
    clearStage();
    const character = currentCharacter();
    const config = experience(character);
    if (epoch !== refreshEpoch) return;
    if (!character) {
        publishSidebarCapability({});
        return;
    }
    publishSidebarCapability(config);
    if (presentationMode(config) === PRESENTATION_MODE_TAVERN) {
        requestHostOrientation('default');
        await renderAllMessages({ consumeExperience: false });
        publishPresentationMode(config);
        return;
    }
    requestHostOrientation(config?.stage?.enabled ? config.stage.orientation : 'default');
    if (config?.galgame?.enabled && config.galgame.theme === 'archive') {
        closeShellDrawersForStage();
        document.body.classList.add('homer-archive-stage-active');
    }
    applyStage(config.stage);
    if (shouldMountLegacyRuntime(config)) {
        const runtime = await legacyRuntime();
        if (epoch !== refreshEpoch) return;
        const host = element('div', 'homer-card-experience-root');
        host.id = 'homerCardExperienceRoot';
        document.body.append(host);
        runtime?.mountCardExperience?.(cardForLegacyRuntime(character), host);
    }
    await renderAllMessages();
    publishPresentationMode(config);
}

function scheduleRefresh(messageId = null) {
    window.setTimeout(() => {
        if (messageId === null || messageId === undefined || typeof messageId === 'object') void refreshStage();
        else void renderMessage(messageId);
    }, 0);
}

export function installCardStageRuntime() {
    if (installed) return;
    installed = true;
    document.addEventListener('card-experience-insert-text', composerInsert);
    document.addEventListener('card-experience-submit-text', composerSubmit);
    document.addEventListener('card-experience-generate', generateFromStage);
    document.addEventListener('card-experience-exit', exitArchiveStage);
    document.addEventListener('homer-presentation-mode-request', event => {
        void setPresentationMode(event?.detail?.mode);
    });
    document.addEventListener('homer-presentation-mode-query', () => publishPresentationMode());
    for (const event of [event_types.CHAT_CHANGED, event_types.CHAT_LOADED]) {
        eventSource.on(event, () => scheduleRefresh());
    }
    for (const event of [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
    ]) eventSource.on(event, messageId => scheduleRefresh(messageId));
    eventSource.on(event_types.MESSAGE_DELETED, () => scheduleRefresh());
    window.__homerCardStageRuntime = Object.freeze({
        version: 4,
        refresh: () => refreshStage(),
        presentationMode: () => presentationMode(),
        setPresentationMode: mode => setPresentationMode(mode),
        componentTypes: [...COMPONENT_TYPES],
        protocol: 'homer-ui-json-v1',
    });
    scheduleRefresh();
}
