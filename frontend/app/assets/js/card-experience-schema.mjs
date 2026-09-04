export const CARD_EXPERIENCE_VERSION = 2;

export const MEDIA_KINDS = Object.freeze(['bgm', 'portrait', 'background', 'spine']);
export const UI_ACTIONS = Object.freeze(['open_popup', 'show_floating', 'switch_bgm', 'open_sidebar', 'set_scene']);
export const CHAT_SHELL_PERMISSIONS = Object.freeze([
  'read_state',
  'send',
  'continue',
  'regenerate',
  'swipe',
  'edit',
  'delete',
  'rollback',
  'load_older',
  'tts',
  'open_settings',
  'exit',
  'slash',
  'set_draft',
  'stop_generation',
]);
export const CHAT_SHELL_LIMITS = Object.freeze({
  name: 120,
  version: 40,
  html: 240000,
  css: 160000,
  javascript: 240000,
  permissions: CHAT_SHELL_PERMISSIONS.length,
});
export const STAGE_LAYOUTS = Object.freeze(['standard', 'landscape', 'split', 'visual_novel']);
export const STRUCTURED_COMPONENT_TYPES = Object.freeze(['map', 'inventory', 'relationship', 'skill_tree', 'status']);
export const GALGAME_MAP_LIMIT = 80;
export const ASSET_BUNDLE_LIMIT = 1000;

export const STAGE_THEME_PRESETS = Object.freeze([
  Object.freeze({ id: 'warm', name: '暖金', accent_color: '#d7b878', user_bubble_color: '#5b4635', assistant_bubble_color: '#211d19', text_color: '#fff8ed' }),
  Object.freeze({ id: 'night', name: '夜幕', accent_color: '#63d7c6', user_bubble_color: '#28465a', assistant_bubble_color: '#17252d', text_color: '#effffb' }),
  Object.freeze({ id: 'sakura', name: '绯樱', accent_color: '#ef8fa5', user_bubble_color: '#925167', assistant_bubble_color: '#382932', text_color: '#fff7fa' }),
  Object.freeze({ id: 'daylight', name: '清昼', accent_color: '#357b8c', user_bubble_color: '#d9edf0', assistant_bubble_color: '#f4f1ea', text_color: '#233038' }),
]);

export const BUBBLE_STYLE_PRESETS = Object.freeze([
  Object.freeze({ id: 'compact', name: '利落', bubble_radius: 6 }),
  Object.freeze({ id: 'soft', name: '柔和', bubble_radius: 18 }),
  Object.freeze({ id: 'round', name: '圆润', bubble_radius: 30 }),
]);

export const UI_ACTION_OPTIONS = Object.freeze([
  Object.freeze({ id: 'open_popup', name: '弹窗', hint: '在对话上方打开内容面板' }),
  Object.freeze({ id: 'show_floating', name: '悬浮窗', hint: '显示可自动关闭的轻量提示' }),
  Object.freeze({ id: 'switch_bgm', name: '切换 BGM', hint: '切换到素材库中的音乐' }),
  Object.freeze({ id: 'open_sidebar', name: '打开侧栏', hint: '打开创作者填写的公开侧栏' }),
  Object.freeze({ id: 'set_scene', name: '切换场景', hint: '触发世界书绑定的立绘、背景和 BGM' }),
]);

export const STRUCTURED_COMPONENT_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'map', name: '层级地图', fields: 'title、root；节点使用 name、description、children',
    example: { type: 'map', title: '世界地图', root: { name: '大陆', description: '选择区域继续探索', children: [{ name: '王都', description: '贸易与行政中心', children: [] }] } },
  }),
  Object.freeze({
    id: 'inventory', name: '物品清单', fields: 'title、items；物品使用 name、description、quantity、category',
    example: { type: 'inventory', title: '随身物品', items: [{ name: '旧钥匙', description: '刻着陌生纹章', quantity: 1, category: '关键物品' }] },
  }),
  Object.freeze({
    id: 'relationship', name: '人物关系', fields: 'title、nodes、edges；连线使用 source、target、label',
    example: { type: 'relationship', title: '人物关系', nodes: [{ id: 'you', name: '你' }, { id: 'guide', name: '向导' }], edges: [{ source: 'you', target: 'guide', label: '同行' }] },
  }),
  Object.freeze({
    id: 'skill_tree', name: '技能树', fields: 'title、nodes；技能使用 id、name、description、requires、unlocked',
    example: { type: 'skill_tree', title: '探索技能', nodes: [{ id: 'observe', name: '观察', description: '发现隐藏线索', requires: [], unlocked: true }] },
  }),
  Object.freeze({
    id: 'status', name: '状态面板', fields: 'title、items；状态使用 label、value，可选 max、icon',
    example: { type: 'status', title: '当前状态', items: [{ label: '体力', value: 72, max: 100 }, { label: '好感度', value: 18, max: 100 }] },
  }),
]);

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const text = (value, max = 200) => String(value == null ? '' : value).trim().slice(0, max);
const idText = (value, fallback = '') => text(value, 96).replace(/[^\w:.-]/g, '-') || fallback;
const sourceText = (value, max) => (typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : '');
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function normalizeBgmMap(raw) {
  const output = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return output;
  for (const [rawKey, rawValue] of Object.entries(raw).slice(0, GALGAME_MAP_LIMIT)) {
    const key = text(rawKey, 80).toLowerCase();
    const target = idText(rawValue);
    if (!key || !target || UNSAFE_OBJECT_KEYS.has(key)) continue;
    output[key] = target;
  }
  return output;
}

export function newStableId(prefix = 'item') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultCardExperience() {
  return {
    version: CARD_EXPERIENCE_VERSION,
    stage: defaultStage(),
    structured_components: defaultStructuredComponents(),
    bgm: {
      enabled: false,
      default_asset_id: '',
      autoplay: 'after-interaction',
      volume: 0.45,
      loop: true,
      show_floating_player: true,
    },
    ui_rules: [],
    sidebars: [],
    galgame: defaultGalgame(),
    asset_bundle: defaultAssetBundle(),
    chat_shell: defaultChatShell(),
  };
}

export function defaultAssetBundle() {
  return {
    enabled: false,
    manifest_url: '',
    expected_id: '',
    default_background_id: '',
    default_portrait_id: '',
    default_bgm_id: '',
  };
}

export function normalizeAssetBundle(raw) {
  const fallback = defaultAssetBundle();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const manifestUrl = text(raw.manifest_url, 2048);
  return {
    enabled: !!raw.enabled && !!manifestUrl,
    manifest_url: manifestUrl,
    expected_id: idText(raw.expected_id),
    default_background_id: idText(raw.default_background_id),
    default_portrait_id: idText(raw.default_portrait_id),
    default_bgm_id: idText(raw.default_bgm_id),
  };
}

export function defaultChatShell() {
  return {
    enabled: false,
    name: '',
    version: '1',
    html: '',
    css: '',
    javascript: '',
    permissions: [],
    fallback: 'default',
  };
}

export function normalizeChatShell(raw) {
  const fallback = defaultChatShell();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const allowed = new Set(CHAT_SHELL_PERMISSIONS);
  const permissions = [];
  for (const permission of Array.isArray(raw.permissions) ? raw.permissions : []) {
    const value = String(permission == null ? '' : permission).trim();
    if (!allowed.has(value) || permissions.includes(value)) continue;
    permissions.push(value);
    if (permissions.length >= CHAT_SHELL_LIMITS.permissions) break;
  }
  return {
    enabled: !!raw.enabled,
    name: text(raw.name, CHAT_SHELL_LIMITS.name),
    version: text(raw.version || fallback.version, CHAT_SHELL_LIMITS.version),
    html: sourceText(raw.html, CHAT_SHELL_LIMITS.html),
    css: sourceText(raw.css, CHAT_SHELL_LIMITS.css),
    javascript: sourceText(raw.javascript, CHAT_SHELL_LIMITS.javascript),
    permissions,
    fallback: 'default',
  };
}

export function defaultStage() {
  return {
    enabled: false,
    layout: 'standard',
    orientation: 'default', // default | landscape
    chat_width: 72,
    background_asset_id: '',
    portrait_asset_id: '',
    show_portrait: true,
    portrait_position: 'right',
    portrait_width: 43,
    portrait_opacity: 1,
    show_avatars: true,
    avatar_position: 'split',
    accent_color: '#d7b878',
    user_bubble_color: '#5b4635',
    assistant_bubble_color: '#211d19',
    text_color: '#fff8ed',
    bubble_radius: 18,
    font_scale: 1,
    input_style: 'dock',
    input_background_color: '#211d19',
    input_text_color: '#fff8ed',
    input_border_color: '#d7b878',
  };
}

export function defaultStructuredComponents() {
  return {
    enabled: true,
    map: true,
    inventory: true,
    relationship: true,
    skill_tree: true,
    status: true,
  };
}

function color(value, fallback) {
  const candidate = text(value, 32);
  return /^(?:#[0-9a-f]{3,8}|rgba?\([^)]{1,28}\)|hsla?\([^)]{1,28}\))$/i.test(candidate) ? candidate : fallback;
}

export function normalizeStage(raw) {
  const fallback = defaultStage();
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    enabled: !!raw.enabled,
    layout: STAGE_LAYOUTS.includes(raw.layout) ? raw.layout : fallback.layout,
    orientation: raw.orientation === 'landscape' ? 'landscape' : 'default',
    chat_width: Math.round(clamp(raw.chat_width, 35, 100, fallback.chat_width)),
    background_asset_id: idText(raw.background_asset_id),
    portrait_asset_id: idText(raw.portrait_asset_id),
    show_portrait: raw.show_portrait !== false,
    portrait_position: ['left', 'center', 'right'].includes(raw.portrait_position) ? raw.portrait_position : fallback.portrait_position,
    portrait_width: Math.round(clamp(raw.portrait_width, 18, 70, fallback.portrait_width)),
    portrait_opacity: clamp(raw.portrait_opacity, 0.2, 1, fallback.portrait_opacity),
    show_avatars: raw.show_avatars !== false,
    avatar_position: ['split', 'left', 'right'].includes(raw.avatar_position) ? raw.avatar_position : fallback.avatar_position,
    accent_color: color(raw.accent_color, fallback.accent_color),
    user_bubble_color: color(raw.user_bubble_color, fallback.user_bubble_color),
    assistant_bubble_color: color(raw.assistant_bubble_color, fallback.assistant_bubble_color),
    text_color: color(raw.text_color, fallback.text_color),
    bubble_radius: Math.round(clamp(raw.bubble_radius, 0, 36, fallback.bubble_radius)),
    font_scale: clamp(raw.font_scale, 0.8, 1.35, fallback.font_scale),
    input_style: raw.input_style === 'floating' ? 'floating' : 'dock',
    input_background_color: color(raw.input_background_color, fallback.input_background_color),
    input_text_color: color(raw.input_text_color, fallback.input_text_color),
    input_border_color: color(raw.input_border_color, fallback.input_border_color),
  };
}

export function applyStageTheme(stage, presetId) {
  const preset = STAGE_THEME_PRESETS.find(item => item.id === presetId);
  if (!preset) return normalizeStage(stage);
  return normalizeStage({
    ...(stage && typeof stage === 'object' ? stage : {}),
    accent_color: preset.accent_color,
    user_bubble_color: preset.user_bubble_color,
    assistant_bubble_color: preset.assistant_bubble_color,
    text_color: preset.text_color,
    input_background_color: preset.assistant_bubble_color,
    input_text_color: preset.text_color,
    input_border_color: preset.accent_color,
  });
}

export function applyBubbleStyle(stage, presetId) {
  const preset = BUBBLE_STYLE_PRESETS.find(item => item.id === presetId);
  return normalizeStage({
    ...(stage && typeof stage === 'object' ? stage : {}),
    ...(preset ? { bubble_radius: preset.bubble_radius } : {}),
  });
}

export function normalizeStructuredComponents(raw) {
  const fallback = defaultStructuredComponents();
  if (!raw || typeof raw !== 'object') return fallback;
  return STRUCTURED_COMPONENT_TYPES.reduce((output, type) => {
    output[type] = raw[type] !== false;
    return output;
  }, { enabled: raw.enabled !== false });
}

export function defaultGalgame() {
  return {
    enabled: false,
    theme: 'standard', // standard | archive
    dialogue_position: 'bottom', // bottom | top
    portrait_layout: 'center', // center | left | right | dual
    default_portrait_id: '',
    default_background_id: '',
    // 情绪切换：AI 回复里出现 pattern（默认 [立绘:xxx]）时，按标签匹配立绘素材的 metadata.emotion。
    portrait_directive: '\\[(?:立绘|portrait|图)[:：]\\s*([^\\]]+)\\]',
    background_directive: '\\[(?:背景|bg|scene)[:：]\\s*([^\\]]+)\\]',
    speaker_directive: '\\[(?:说话者|speaker|角色)[:：]\\s*([^\\]]+)\\]',
    affiliation_directive: '\\[(?:身份|affiliation|组织)[:：]\\s*([^\\]]+)\\]',
    mood_directive: '\\[(?:气氛|mood|情绪)[:：]\\s*([^\\]]+)\\]',
    bgm_directive: '\\[(?:BGM|音乐|music)[:：]\\s*([^\\]]+)\\]',
    scene_bgm_map: Object.create(null),
    mood_bgm_map: Object.create(null),
    show_stage_actions: true,
    hide_bubble_avatar: true,
    typewriter: true,
  };
}

export function normalizeGalgame(raw) {
  const fallback = defaultGalgame();
  if (!raw || typeof raw !== 'object') return fallback;
  const dialoguePosition = raw.dialogue_position === 'top' ? 'top' : 'bottom';
  const layouts = ['center', 'left', 'right', 'dual'];
  const portraitLayout = layouts.includes(raw.portrait_layout) ? raw.portrait_layout : 'center';
  return {
    enabled: !!raw.enabled,
    theme: raw.theme === 'archive' ? 'archive' : 'standard',
    dialogue_position: dialoguePosition,
    portrait_layout: portraitLayout,
    default_portrait_id: idText(raw.default_portrait_id),
    default_background_id: idText(raw.default_background_id),
    portrait_directive: text(raw.portrait_directive || fallback.portrait_directive, 500),
    background_directive: text(raw.background_directive || fallback.background_directive, 500),
    speaker_directive: text(raw.speaker_directive || fallback.speaker_directive, 500),
    affiliation_directive: text(raw.affiliation_directive || fallback.affiliation_directive, 500),
    mood_directive: text(raw.mood_directive || fallback.mood_directive, 500),
    bgm_directive: text(raw.bgm_directive || fallback.bgm_directive, 500),
    scene_bgm_map: normalizeBgmMap(raw.scene_bgm_map),
    mood_bgm_map: normalizeBgmMap(raw.mood_bgm_map),
    show_stage_actions: raw.show_stage_actions !== false,
    hide_bubble_avatar: raw.hide_bubble_avatar !== false,
    typewriter: raw.typewriter !== false,
  };
}

export function normalizeMediaAsset(raw, index = 0) {

  if (!raw || typeof raw !== 'object') return null;
  const kind = MEDIA_KINDS.includes(raw.kind) ? raw.kind : '';
  const id = idText(raw.id || raw.asset_id, `asset-${index + 1}`);
  const url = text(raw.url || raw.public_url, 2048);
  if (!kind || !id || !url) return null;
  return {
    id,
    kind,
    name: text(raw.name || raw.filename || `${kind}-${index + 1}`, 120),
    url,
    mime_type: text(raw.mime_type || raw.content_type, 100),
    size_bytes: Math.round(clamp(raw.size_bytes, 0, 80 * 1024 * 1024, 0)),
    sha256: text(raw.sha256, 64).toLowerCase(),
    status: raw.status === 'pending' ? 'pending' : 'ready',
    metadata: normalizeAssetMetadata(raw.metadata, raw),
  };
}

// 立绘情绪/姿态标签：既可写在 metadata.emotion，也兼容顶层 emotion 字段。
export function normalizeAssetMetadata(metadata, raw = {}) {
  const meta = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  const emotion = text(meta.emotion || raw.emotion, 40);
  if (emotion) meta.emotion = emotion;
  else delete meta.emotion;
  return meta;
}


export function normalizeMediaAssets(value) {
  return normalizeMediaAssetsWithLimit(value, 200);
}

export function normalizeMediaAssetsWithLimit(value, maximum = 200) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const limit = Math.max(1, Math.min(ASSET_BUNDLE_LIMIT, Number(maximum) || 200));
  return value.slice(0, limit).map(normalizeMediaAsset).filter((asset) => {
    if (!asset || seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  });
}

export function normalizeMediaBinding(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = MEDIA_KINDS.includes(raw.kind) ? raw.kind : '';
  const assetId = idText(raw.asset_id);
  if (!kind || !assetId) return null;
  return {
    id: idText(raw.id, `binding-${index + 1}`),
    kind,
    asset_id: assetId,
    label: text(raw.label, 80),
    activation: ['entry', 'regex', 'manual'].includes(raw.activation) ? raw.activation : 'entry',
  };
}

export function normalizeMediaBindings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map(normalizeMediaBinding).filter(Boolean);
}

export function normalizeUiRule(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const action = UI_ACTIONS.includes(raw.action) ? raw.action : 'open_popup';
  const pattern = text(raw.pattern || raw.find, 500);
  if (!pattern) return null;
  return {
    id: idText(raw.id, `ui-rule-${index + 1}`),
    name: text(raw.name || `界面规则 ${index + 1}`, 80),
    enabled: raw.enabled !== false,
    pattern,
    flags: text(raw.flags || 'i', 8).replace(/[^gimsuy]/g, ''),
    action,
    target_id: idText(raw.target_id),
    template_html: String(raw.template_html || raw.html || '').slice(0, 30000),
    scoped_css: String(raw.scoped_css || raw.css || '').slice(0, 30000),
    duration_ms: Math.round(clamp(raw.duration_ms, 0, 120000, action === 'show_floating' ? 5000 : 0)),
    order: Math.round(clamp(raw.order, -10000, 10000, index + 1)),
    remove_match: raw.remove_match !== false,
  };
}

export function normalizeSidebar(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: idText(raw.id, `sidebar-${index + 1}`),
    name: text(raw.name || `侧栏 ${index + 1}`, 80),
    enabled: raw.enabled !== false,
    position: raw.position === 'left' ? 'left' : 'right',
    width: Math.round(clamp(raw.width, 240, 720, 340)),
    order: Math.round(clamp(raw.order, -10000, 10000, index + 1)),
    trigger_label: text(raw.trigger_label || raw.name || `侧栏 ${index + 1}`, 24),
    open_pattern: text(raw.open_pattern, 500),
    flags: text(raw.flags || 'i', 8).replace(/[^gimsuy]/g, ''),
    content_mode: raw.content_mode === 'worldbook' ? 'worldbook' : 'static',
    world_entry_id: idText(raw.world_entry_id),
    content_html: String(raw.content_html || '').slice(0, 50000),
    scoped_css: String(raw.scoped_css || '').slice(0, 30000),
  };
}

export function normalizeCardExperience(raw) {
  const fallback = defaultCardExperience();
  if (!raw || typeof raw !== 'object') return fallback;
  const bgm = raw.bgm && typeof raw.bgm === 'object' ? raw.bgm : {};
  return {
    version: CARD_EXPERIENCE_VERSION,
    stage: normalizeStage(raw.stage),
    structured_components: normalizeStructuredComponents(raw.structured_components),
    bgm: {
      enabled: !!bgm.enabled,
      default_asset_id: idText(bgm.default_asset_id),
      autoplay: 'after-interaction',
      volume: clamp(bgm.volume, 0, 1, 0.45),
      loop: bgm.loop !== false,
      show_floating_player: bgm.show_floating_player !== false,
    },
    ui_rules: (Array.isArray(raw.ui_rules) ? raw.ui_rules : []).slice(0, 40).map(normalizeUiRule).filter(Boolean).sort((a, b) => a.order - b.order),
    sidebars: (Array.isArray(raw.sidebars) ? raw.sidebars : []).slice(0, 20).map(normalizeSidebar).filter(Boolean).sort((a, b) => a.order - b.order),
    galgame: normalizeGalgame(raw.galgame),
    asset_bundle: normalizeAssetBundle(raw.asset_bundle),
    chat_shell: normalizeChatShell(raw.chat_shell),
  };
}


export function normalizeWorldEntryMedia(entry) {
  return { ...entry, media_bindings: normalizeMediaBindings(entry?.media_bindings) };
}

export function createUiRuleTemplate(action = 'open_popup', index = 0) {
  const examples = {
    open_popup: ['弹窗', '\\[POPUP:notice\\]', '<section class="notice"><h3>提示</h3><p>{{message}}</p><button data-card-action="close-popup">知道了</button></section>'],
    show_floating: ['悬浮提示', '\\[FLOAT:notice\\]', '<div class="toast-card">剧情提示</div>'],
    switch_bgm: ['切换 BGM', '\\[BGM:main\\]', ''],
    open_sidebar: ['打开侧栏', '\\[SIDEBAR:info\\]', ''],
    set_scene: ['切换场景', '\\[SCENE:room\\]', ''],
  };
  const sample = examples[action] || examples.open_popup;
  return normalizeUiRule({
    id: newStableId('ui-rule'),
    name: `${sample[0]} ${index + 1}`,
    pattern: sample[1],
    flags: 'i',
    action,
    template_html: sample[2],
    scoped_css: action === 'open_popup' ? '.notice { padding: 24px; color: #fff; background: #241b35; border-radius: 18px; }' : '',
    duration_ms: action === 'show_floating' ? 5000 : 0,
    order: index + 1,
    enabled: true,
  }, index);
}

export function createSidebarTemplate(index = 0) {
  return normalizeSidebar({
    id: newStableId('sidebar'),
    name: `资料栏 ${index + 1}`,
    trigger_label: `资料 ${index + 1}`,
    position: index % 2 ? 'left' : 'right',
    width: 340,
    order: index + 1,
    open_pattern: `\\[SIDEBAR:info${index + 1}\\]`,
    flags: 'i',
    content_html: '<article class="info-panel"><h3>资料栏</h3><p>在这里填写图鉴、图片库、助手或其他内容。</p></article>',
    scoped_css: '.info-panel { padding: 20px; color: #f8f4ff; }',
  }, index);
}

export function safeRegExp(pattern, flags = 'i') {
  const source = text(pattern, 240);
  if (!source) return null;
  // Keep the author regex subset deliberately conservative; runtime matching also runs in a timed Worker.
  if (/\((?:[^()]|\\.)*[+*](?:[^()]|\\.)*\)[+*{]/.test(source)) return null;
  if (/\((?:[^()]|\\.)*\|(?:[^()]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(source)) return null;
  if (/\\[1-9]|\(\?[=!<]/.test(source)) return null;
  if ((source.match(/(?<!\\)\|/g) || []).length > 8) return null;
  try {
    const uniqueFlags = [...new Set(String(flags).replace(/[^gimsuy]/g, ''))].join('');
    return new RegExp(source, uniqueFlags);
  } catch {
    return null;
  }
}

export function stripExperienceDirectives(input, experience) {
  let output = String(input == null ? '' : input);
  const config = normalizeCardExperience(experience);
  for (const rule of config.ui_rules) {
    if (!rule.enabled || !rule.remove_match) continue;
    const regex = safeRegExp(rule.pattern, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`);
    if (regex) output = output.replace(regex, '');
  }
  for (const sidebar of config.sidebars) {
    if (!sidebar.enabled || !sidebar.open_pattern) continue;
    const regex = safeRegExp(sidebar.open_pattern, sidebar.flags.includes('g') ? sidebar.flags : `${sidebar.flags}g`);
    if (regex) output = output.replace(regex, '');
  }
  // galgame 舞台状态指令标记不应显示在正文里。
  if (config.galgame?.enabled) {
    for (const directive of [
      config.galgame.portrait_directive,
      config.galgame.background_directive,
      config.galgame.speaker_directive,
      config.galgame.affiliation_directive,
      config.galgame.mood_directive,
      config.galgame.bgm_directive,
    ]) {
      const regex = safeRegExp(directive, 'ig');
      if (regex) output = output.replace(regex, '');
    }
  }
  return output.replace(/\n{3,}/g, '\n\n').trim();
}

// 从一段文本里解析 galgame 指令，返回最后一组完整舞台标签。
export function parseGalgameDirectives(input, galgame) {
  const result = { portrait: '', background: '', speaker: '', affiliation: '', mood: '', bgm: '' };
  if (!galgame || !galgame.enabled) return result;
  const grab = (pattern) => {
    const regex = safeRegExp(pattern, 'ig');
    if (!regex) return '';
    let last = '';
    let match;
    let guard = 0;
    while ((match = regex.exec(input)) && guard < 40) {
      guard += 1;
      if (match[1] != null) last = String(match[1]).trim();
      if (match.index === regex.lastIndex) regex.lastIndex += 1;
    }
    return last;
  };
  result.portrait = grab(galgame.portrait_directive);
  result.background = grab(galgame.background_directive);
  result.speaker = grab(galgame.speaker_directive);
  result.affiliation = grab(galgame.affiliation_directive);
  result.mood = grab(galgame.mood_directive);
  result.bgm = grab(galgame.bgm_directive);
  return result;
}
