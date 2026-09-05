import { api, requireAuth, getCachedUser, setCachedUser, ApiError } from '/app/assets/js/app-core.js?v=20260905-notices-v1';
import { injectLayout, loadPublicSiteSettings } from '/app/assets/js/layout.js?v=20260905-notices-v1';
import {
  applyBubbleStyle,
  applyStageTheme,
  BUBBLE_STYLE_PRESETS,
  createSidebarTemplate,
  createUiRuleTemplate,
  defaultCardExperience,
  newStableId,
  normalizeCardExperience,
  normalizeMediaAssets,
  normalizeMediaBindings,
  safeRegExp,
  STAGE_THEME_PRESETS,
  STRUCTURED_COMPONENT_OPTIONS,
  UI_ACTION_OPTIONS,
} from '/app/assets/js/card-experience-schema.mjs?v=20260820-archive-stage';
import {
  buildCardPackMediaUpdate,
  isCardPackFilename,
  parseCardPack,
} from '/app/assets/js/card-pack-import.mjs?v=20260820-archive-stage';

const emptyCardPromptPreset = () => ({ version: 1, enabled: false, name: '', format: 'sillytavern', source_file: '', prompts: [], prompt_order: [], blocks: [], stats: { entry_count: 0, enabled_count: 0 } });
const TAVERN_HELPER_SCRIPT_MAX_ENTRIES = 100;
const TAVERN_HELPER_SCRIPT_MAX_JSON_BYTES = 4 * 1024 * 1024;
const TAVERN_HELPER_FOLDER_DRAFT_KEY = '__homer_folder_scripts_json';
const TAVERN_HELPER_FOLDER_ERROR_KEY = '__homer_folder_scripts_error';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function prepareTavernHelperEditorItem(value, index = 0) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? cloneJson(value) : {};
  item.type = String(item.type || (Array.isArray(item.scripts) ? 'folder' : 'script')).toLowerCase() === 'folder' ? 'folder' : 'script';
  item.id = String(item.id || `${item.type}-${index + 1}`);
  item.name = String(item.name || (item.type === 'folder' ? `脚本文件夹 ${index + 1}` : `脚本 ${index + 1}`));
  item.content = String(item.content || '');
  item.enabled = 'enabled' in item ? item.enabled !== false : !item.disabled;
  item.disabled = !item.enabled;
  if (item.type === 'folder') {
    item.scripts = Array.isArray(item.scripts) ? item.scripts : [];
    item[TAVERN_HELPER_FOLDER_DRAFT_KEY] = JSON.stringify(item.scripts, null, 2);
    item[TAVERN_HELPER_FOLDER_ERROR_KEY] = '';
  }
  return item;
}

function normalizeTavernHelperNode(value, path, state, enforceLimits = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`TavernHelper 脚本 ${path} 必须是对象`);
  const item = cloneJson(value);
  const folderDraft = item[TAVERN_HELPER_FOLDER_DRAFT_KEY];
  delete item[TAVERN_HELPER_FOLDER_DRAFT_KEY];
  delete item[TAVERN_HELPER_FOLDER_ERROR_KEY];
  state.count += 1;
  if (enforceLimits && state.count > TAVERN_HELPER_SCRIPT_MAX_ENTRIES) {
    throw new Error(`TavernHelper 脚本最多 ${TAVERN_HELPER_SCRIPT_MAX_ENTRIES} 条`);
  }
  const type = String(item.type || (Array.isArray(item.scripts) ? 'folder' : 'script')).trim().toLowerCase();
  if (!['script', 'folder'].includes(type)) throw new Error(`TavernHelper 脚本 ${path} 的类型只能是 script 或 folder`);
  item.type = type;
  item.id = String(item.id || `${type}-${state.count}`).trim() || `${type}-${state.count}`;
  item.name = String(item.name || (type === 'folder' ? `脚本文件夹 ${state.count}` : `脚本 ${state.count}`)).trim();
  item.content = String(item.content || '');
  item.enabled = 'enabled' in item ? item.enabled !== false : !item.disabled;
  item.disabled = !item.enabled;
  if (type === 'folder') {
    let children = item.scripts;
    if (typeof folderDraft === 'string') {
      try { children = JSON.parse(folderDraft); }
      catch { throw new Error(`TavernHelper 文件夹「${item.name || path}」中的脚本 JSON 无效`); }
    }
    if (!Array.isArray(children)) throw new Error(`TavernHelper 文件夹「${item.name || path}」的 scripts 必须是数组`);
    item.scripts = children.map((child, index) => normalizeTavernHelperNode(child, `${path}.scripts[${index}]`, state, enforceLimits));
  }
  return item;
}

function normalizeTavernHelperScripts(value, enforceLimits = true) {
  if (!Array.isArray(value)) throw new Error('TavernHelper 脚本必须是数组');
  const state = { count: 0 };
  const scripts = value.map((item, index) => normalizeTavernHelperNode(item, `[${index}]`, state, enforceLimits));
  const bytes = new TextEncoder().encode(JSON.stringify(scripts)).byteLength;
  if (enforceLimits && bytes > TAVERN_HELPER_SCRIPT_MAX_JSON_BYTES) throw new Error('TavernHelper 脚本总大小不能超过 4 MiB');
  return { scripts, count: state.count, bytes };
}

function extractTavernHelperScripts(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') throw new Error('导入文件不包含 TavernHelper 脚本数组');
  if (Array.isArray(value.scripts)) return value.scripts;
  if (value.type === 'script' || value.type === 'folder') return [value];
  const data = value.data && typeof value.data === 'object' ? value.data : value;
  const extensions = data.extensions && typeof data.extensions === 'object' ? data.extensions : value.extensions;
  if (extensions?.tavern_helper && Array.isArray(extensions.tavern_helper.scripts)) return extensions.tavern_helper.scripts;
  throw new Error('导入文件不包含 extensions.tavern_helper.scripts');
}

function formatByteSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const emptyForm = () => ({
  name: '',
  summary: '',
  description: '',
  opening_statement: '',
  pre_prompt: '',
  personality: '',
  scenario: '',
  mes_example: '',
  post_history_instructions: '',
  prompt_blocks: [],
  quick_replies: [],
  regex_scripts: [],
  tavern_helper_scripts: [],
  alternate_greetings: [],
  world_info: [],
  media_assets: [],
  card_experience: defaultCardExperience(),
  card_prompt_preset: emptyCardPromptPreset(),
  tts_voice_id: 'zh-CN-XiaoxiaoNeural',
  tagsText: '',
  llm_model: '',
  is_public: true,
  is_open_source: false,
  contest_opt_in: false,
  applied_preset_id: '',
  applied_preset_version_id: '',
  applied_ui_template_ids: [],
  applied_ui_template_version_ids: [],
  cover_url: '',
  bg_url: '',
  nsfw: false,
  protected_prompt: false,
  anonymous: false,
  sampling: {
    temperature: 1,
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    history_length: 12,
  },
});

function createPage() {
  return {
    user: null,
    points: 0,
    sidebarOpen: false,
    loading: false,
    uploading: false,
    uploadingBg: false,
    uploadingMedia: false,
    mediaDraftId: newStableId('draft'),
    toast: null,
    toastTimer: null,
    modelPresets: [],
    ttsVoices: [],
    defaultModelPresetId: '',
    favoritePresets: [],
    favoriteUiTemplates: [],
    communityFavLoading: false,
    form: emptyForm(),
    stageThemePresets: STAGE_THEME_PRESETS,
    bubbleStylePresets: BUBBLE_STYLE_PRESETS,
    uiActionOptions: UI_ACTION_OPTIONS,
    structuredComponentOptions: STRUCTURED_COMPONENT_OPTIONS,
    structuredExampleType: 'map',
    legacySidebarMigrationCount: 0,
    editingId: '',  // empty = create, set = edit existing app
    cardVersions: [],
    cardVersionsLoading: false,
    publishDialogOpen: false,
    versionName: '',
    versionDescription: '',
    expand: { persona: false, advanced: false, promptManager: false, greetings: false, worldinfo: false, communityFav: false, experience: false, sampling: false, voice: false, share: false, versions: false },
    importing: false,
    pendingCardPackImport: null,
    siteSettings: null,
    previewOpen: false,
    activeSection: 'creator-basic',
    platformWorldbookApplied: true,
    advancedCreationAccess: { allowed: false, source: 'none', farm_unlocked: false, admin_override: false, streak_days: 0, unlocked_plots: 0, required_days: 49 },
    tavernHelperScriptsLoaded: false,
    tavernHelperScriptsDirty: false,
    tavernHelperScriptCount: 0,
    tavernHelperScriptSource: 'none',

    async init() {
      injectLayout('workshop');
      this.siteSettings = await loadPublicSiteSettings().catch(() => null);
      if (!requireAuth()) return;
      // Edit mode? read ?id=
      const params = new URLSearchParams(location.search);
      this.editingId = params.get('id') || '';
      const cached = getCachedUser();
      if (cached) this.user = cached;
      try {
        const profile = await api.profile();
        this.user = profile;
        setCachedUser(profile);
        const p = await api.points();
        this.points = parseInt(p.points || p.data?.points || 0, 10);
        await this.loadCreatorAccess();
        if (!this.editingId) this.tavernHelperScriptsLoaded = true;
        await this.loadModelPresets();
        await this.loadTtsVoices();
        await this.loadCommunityFavorites();
        if (this.editingId) {
          await this.loadExisting();
          await Promise.all([this.loadCardExtraFlags(), this.loadCardVersions()]);
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 401) {
          location.replace('/app/login.html?next=' + encodeURIComponent(location.pathname + location.search));
        }
      }
    },

    async loadCommunityFavorites() {
      this.communityFavLoading = true;
      try {
        const [presets, templates] = await Promise.all([
          api.communityWorks({ type: 'preset', scope: 'favorites' }).catch(() => null),
          api.communityWorks({ type: 'ui_template', scope: 'favorites' }).catch(() => null),
        ]);
        this.favoritePresets = presets?.data?.list || [];
        this.favoriteUiTemplates = templates?.data?.list || [];
      } finally {
        this.communityFavLoading = false;
      }
    },

    async loadCardExtraFlags() {
      if (!this.editingId) return;
      try {
        const result = await api.cardExtraFlags(this.editingId);
        const flags = result?.data || {};
        this.form.is_open_source = flags.is_open_source === true;
        this.form.contest_opt_in = flags.contest_opt_in === true;
        this.form.applied_preset_id = String(flags.used_preset_work_id || flags.applied_preset_id || '');
        this.form.applied_preset_version_id = String(flags.used_preset_version_id || flags.applied_preset_version_id || '');
        this.form.applied_ui_template_ids = Array.isArray(flags.used_ui_template_work_ids)
          ? [...flags.used_ui_template_work_ids]
          : (Array.isArray(flags.applied_ui_template_ids) ? [...flags.applied_ui_template_ids] : []);
        this.form.applied_ui_template_version_ids = Array.isArray(flags.used_ui_template_version_ids)
          ? [...flags.used_ui_template_version_ids]
          : (Array.isArray(flags.applied_ui_template_version_ids) ? [...flags.applied_ui_template_version_ids] : []);
      } catch { /* 旧卡或接口不可用时保持默认值 */ }
    },

    async loadCardVersions() {
      if (!this.editingId) return;
      this.cardVersionsLoading = true;
      try {
        const result = await api.cardVersions(this.editingId);
        this.cardVersions = result?.data?.list || [];
      } catch {
        this.cardVersions = [];
      } finally {
        this.cardVersionsLoading = false;
      }
    },

    selectAppliedPreset(id) {
      const value = String(id || '');
      if (this.form.applied_preset_id === value) {
        this.form.applied_preset_id = '';
        this.form.applied_preset_version_id = '';
        this.showToast('已取消预设引用；此前手工填写的内容不会被改动', 'success');
        return;
      }
      const work = this.favoritePresets.find(item => String(item.id) === value);
      const versionId = String(work?.current_version_id || work?.version_id || '');
      if (!versionId) {
        this.showToast('该预设尚无可锁定版本，请稍后重试', 'error');
        return;
      }
      this.form.applied_preset_id = value;
      this.form.applied_preset_version_id = versionId;
      this.showToast('预设已应用并锁定版本；发布后由服务端注入，不会覆盖手工内容', 'success');
    },

    toggleAppliedUiTemplate(id) {
      const value = String(id || '');
      const ids = [...(this.form.applied_ui_template_ids || [])];
      const versions = [...(this.form.applied_ui_template_version_ids || [])];
      const index = ids.indexOf(value);
      if (index >= 0) {
        ids.splice(index, 1);
        versions.splice(index, 1);
        this.showToast('已取消 UI 模板引用；现有手工界面配置保持不变', 'success');
      } else {
        const work = this.favoriteUiTemplates.find(item => String(item.id) === value);
        const versionId = String(work?.current_version_id || work?.version_id || '');
        if (!versionId) {
          this.showToast('该 UI 模板尚无可锁定版本，请稍后重试', 'error');
          return;
        }
        ids.push(value);
        versions.push(versionId);
        this.showToast('UI 模板已应用并锁定版本；运行时由服务端安全合并', 'success');
      }
      this.form.applied_ui_template_ids = ids;
      this.form.applied_ui_template_version_ids = versions;
    },

    appliedPresetName() {
      return this.favoritePresets.find(item => String(item.id) === String(this.form.applied_preset_id))?.name || '';
    },

    creatorText(key, fallback = '') {
      const legacyByokKeys = new Set(['tip_text', 'model_hint', 'bottom_note', 'user_model_prefix', 'user_model_group_label']);
      const value = this.siteSettings?.creator?.[key] || fallback;
      if (!legacyByokKeys.has(key)) return value;
      return String(value || fallback)
        .replace(/可使用站点模型，也可在“我的”页配置[^。]+。/g, '模型由平台统一接入。')
        .replace(/可以使用站点模型，也可以选择你在“我的”页保存的[^。]+。/g, '只能选择站点模型，API Key 由后台统一管理。')
        .replace(/如选择[^。]+。/g, 'API Key 由后台统一管理。')
        .replace('我的：', '')
        .replace('我的模型', '站点模型');
    },

    async loadTtsVoices() {
      try { const r = await api.ttsVoices(); const d = r?.data || r || {}; this.ttsVoices = Array.isArray(d.list) ? d.list : []; if (!this.form.tts_voice_id) this.form.tts_voice_id = d.default_voice || this.ttsVoices[0]?.id || ''; } catch { this.ttsVoices = []; }
    },

    async loadCreatorAccess() {
      try {
        const result = await api.creatorAccess();
        this.advancedCreationAccess = { ...this.advancedCreationAccess, ...(result?.data || result || {}) };
      } catch { /* keep locked */ }
    },

    canUseAdvancedCreation() { return this.advancedCreationAccess?.allowed === true; },

    advancedCreationHint() {
      if (this.advancedCreationAccess?.source === 'admin') return '管理员已为当前账号开放高级创作';
      if (this.advancedCreationAccess?.source === 'farm') return '惑梦农场已全解锁，高级创作已开放';
      return `高级创作需农场 8 块土地全部解锁：当前 ${this.advancedCreationAccess?.unlocked_plots || 0}/8，连续活跃 ${this.advancedCreationAccess?.streak_days || 0}/${this.advancedCreationAccess?.required_days || 49} 天`;
    },

    previewTags() {
      return String(this.form.tagsText || '')
        .split(/[，,\n]/)
        .map(tag => tag.trim())
        .filter(Boolean)
        .slice(0, 6);
    },

    scrollToSection(id) {
      const target = document.getElementById(id);
      if (!target) return;
      this.activeSection = id;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    async loadExisting() {
      try {
        const r = await api.appDetails(this.editingId);
        const app = r?.data || r;
        if (!app || !app.id) return;
        this.form.name = app.name || '';
        this.form.summary = app.summary || '';
        this.form.description = app.description || '';
        this.form.opening_statement = app.opening_statement || '';
        this.form.pre_prompt = app.pre_prompt || '';
        this.form.personality = app.personality || '';
        this.form.scenario = app.scenario || '';
        this.form.mes_example = app.mes_example || '';
        this.form.post_history_instructions = app.post_history_instructions || '';
        this.form.tts_voice_id = app.tts_voice_id || this.form.tts_voice_id;
        this.form.prompt_blocks = Array.isArray(app.prompt_blocks)
          ? app.prompt_blocks.map((b, idx) => ({
              id: b.id || ('prompt-' + (idx + 1)),
              name: b.name || `${this.creatorText('prompt_block_name_prefix', '提示词块')} ${idx + 1}`,
              position: b.position || 'system_after',
              order: typeof b.order === 'number' ? b.order : idx + 1,
              enabled: b.enabled !== false,
              content: b.content || '',
            }))
          : [];
        this.form.quick_replies = Array.isArray(app.quick_replies)
          ? app.quick_replies.map((q, idx) => ({
              id: q.id || ('quick-' + (idx + 1)),
              label: q.label || q.name || `${this.creatorText('quick_reply_name_prefix', '快捷回复')} ${idx + 1}`,
              message: q.message || q.content || '',
              enabled: q.enabled !== false,
              order: typeof q.order === 'number' ? q.order : idx + 1,
            }))
          : [];
        this.form.regex_scripts = Array.isArray(app.regex_scripts)
          ? app.regex_scripts.map((s, idx) => ({
              id: s.id || ('regex-' + (idx + 1)),
              name: s.name || `${this.creatorText('regex_name_prefix', 'Regex')} ${idx + 1}`,
              find: s.find || s.pattern || '',
              replace: s.replace || s.replacement || '',
              flags: s.flags || '',
              enabled: s.enabled !== false,
              order: typeof s.order === 'number' ? s.order : idx + 1,
            }))
          : [];
        const tavernHelperScripts = Array.isArray(app.tavern_helper_scripts) ? app.tavern_helper_scripts : [];
        this.tavernHelperScriptCount = Number.isFinite(Number(app.tavern_helper_script_count))
          ? Number(app.tavern_helper_script_count)
          : normalizeTavernHelperScripts(tavernHelperScripts, false).count;
        this.tavernHelperScriptSource = String(app.tavern_helper_script_source || (tavernHelperScripts.length ? 'sillytavern_card' : 'none'));
        this.form.tavern_helper_scripts = this.canUseAdvancedCreation()
          ? tavernHelperScripts.map((item, index) => prepareTavernHelperEditorItem(item, index))
          : [];
        this.tavernHelperScriptsLoaded = true;
        this.tavernHelperScriptsDirty = false;
        this.form.alternate_greetings = Array.isArray(app.alternate_greetings) ? [...app.alternate_greetings] : [];
        this.form.world_info = Array.isArray(app.world_info)
          ? app.world_info.map(e => ({
              id: e.id || '',
              name: e.name || '',
              keysText: Array.isArray(e.keys) ? e.keys.join('，') : (e.keys || ''),
              secondaryKeysText: Array.isArray(e.secondary_keys) ? e.secondary_keys.join('，') : (e.secondary_keys || ''),
              content: e.content || '',
              enabled: e.enabled !== false,
              constant: !!e.constant,
              selective: !!e.selective,
              position: e.position || 'system',
              depth: typeof e.depth === 'number' ? e.depth : 4,
              priority: typeof e.priority === 'number' ? e.priority : 100,
              order: typeof e.order === 'number' ? e.order : 100,
              probability: typeof e.probability === 'number' ? e.probability : 100,
              recursive: !!e.recursive,
              case_sensitive: !!e.case_sensitive,
              match_whole_words: !!e.match_whole_words,
              selective_logic: e.selective_logic || 'and_any',
              role: e.role || 'system',
              scan_depth: typeof e.scan_depth === 'number' ? e.scan_depth : 2,
              sticky: typeof e.sticky === 'number' ? e.sticky : 0,
              cooldown: typeof e.cooldown === 'number' ? e.cooldown : 0,
              delay: typeof e.delay === 'number' ? e.delay : 0,
              media_bindings: normalizeMediaBindings(e.media_bindings),
            }))
          : [];
        this.form.media_assets = normalizeMediaAssets(app.media_assets);
        this.form.card_experience = normalizeCardExperience(app.card_experience);
        const legacyWorldbookSidebars = this.form.card_experience.sidebars.filter(bar => bar.content_mode === 'worldbook');
        this.legacySidebarMigrationCount = legacyWorldbookSidebars.length;
        for (const bar of legacyWorldbookSidebars) {
          // 世界书正文不会进入用户端。旧侧栏只保留作者原本明确填写的公开 HTML。
          bar.content_mode = 'static';
          bar.world_entry_id = '';
        }
        this.form.card_prompt_preset = app.card_prompt_preset && typeof app.card_prompt_preset === 'object'
          ? { ...emptyCardPromptPreset(), ...app.card_prompt_preset, enabled: app.card_prompt_preset.enabled === true }
          : emptyCardPromptPreset();
        this.platformWorldbookApplied = app.platform_worldbook_applied !== false;
        this.form.tagsText = Array.isArray(app.tags) ? app.tags.join('，') : (app.tags || '');
        this.form.llm_model = String(app.llm_model || '').startsWith('user:')
          ? (this.defaultModelPresetId || '')
          : (app.llm_model || this.defaultModelPresetId || '');
        this.form.is_public = app.is_public !== false;
        this.form.cover_url = app.cover || app.cover_url || '';
        this.form.bg_url = app.bg_url || '';
        this.form.nsfw = !!app.nsfw;
        this.form.protected_prompt = !!app.protected_prompt;
        this.form.anonymous = !!app.anonymous;
        const s = app.sampling || {};
        this.form.sampling = {
          temperature: typeof s.temperature === 'number' ? s.temperature : 1,
          top_p: typeof s.top_p === 'number' ? s.top_p : 1,
          presence_penalty: typeof s.presence_penalty === 'number' ? s.presence_penalty : 0,
          frequency_penalty: typeof s.frequency_penalty === 'number' ? s.frequency_penalty : 0,
          history_length: typeof s.history_length === 'number' ? s.history_length : 12,
        };
      } catch (err) {
        this.showToast(this.creatorText('load_existing_failed', err.message || '读取角色失败'), 'error');
      }
    },

    async loadModelPresets() {
      try {
        const siteResult = await api.modelPresets();
        const siteData = siteResult?.data || siteResult || {};
        const sitePresets = (siteData.list || []).map(p => ({ ...p, label: p.model || p.name || p.id, group: p.name || this.creatorText('site_model_group_label', '站点模型'), price_label: p.price_label || siteData.price_label || '50 惑梦币/次' }));
        this.modelPresets = sitePresets;
        this.defaultModelPresetId = siteData.default_id || this.modelPresets[0]?.id || '';
        if (String(this.form.llm_model || '').startsWith('user:')) {
          this.form.llm_model = this.defaultModelPresetId || '';
        }
        if (!this.form.llm_model && this.defaultModelPresetId) {
          this.form.llm_model = this.defaultModelPresetId;
        }
      } catch (err) {
        this.modelPresets = [];
      }
    },

    modelPresetGroups() {
      const groups = [];
      for (const preset of this.modelPresets) {
        const key = preset.preset_id || preset.group || preset.id;
        let group = groups.find(item => item.key === key);
        if (!group) {
          group = { key, label: preset.group || preset.name || '站点模型', list: [] };
          groups.push(group);
        }
        group.list.push(preset);
      }
      return groups;
    },

    showToast(message, type = 'info', duration = 2800) {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toast = { message, type };
      this.toastTimer = setTimeout(() => { this.toast = null; }, duration);
    },

    async onCoverChange(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.uploading = true;
      try {
        const dataUrl = await fileToDataUrl(file);
        const r = await api.uploadCover(dataUrl, file.name);
        const data = r?.data || r;
        this.form.cover_url = data.url || data.path || '';
        this.showToast(this.creatorText('cover_uploaded', '封面已上传'), 'success');
      } catch (err) {
        this.showToast(err.message || this.creatorText('cover_upload_failed', '封面上传失败'), 'error');
      } finally {
        this.uploading = false;
      }
    },

    async onBgChange(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.uploadingBg = true;
      try {
        const dataUrl = await fileToDataUrl(file);
        const r = await api.uploadCover(dataUrl, file.name);
        const data = r?.data || r;
        this.form.bg_url = data.url || data.path || '';
        this.showToast(this.creatorText('bg_uploaded', '背景已上传'), 'success');
      } catch (err) {
        this.showToast(err.message || this.creatorText('bg_upload_failed', '背景上传失败'), 'error');
      } finally {
        this.uploadingBg = false;
      }
    },

    assetLabel(assetId) {
      return this.form.media_assets.find(asset => asset.id === assetId)?.name || assetId || '未选择';
    },

    assetsByKind(kind) {
      return this.form.media_assets.filter(asset => asset.kind === kind && asset.status !== 'pending');
    },

    applyStageThemePreset(presetId) {
      this.form.card_experience.stage = applyStageTheme(this.form.card_experience.stage, presetId);
    },

    stageThemeIsActive(preset) {
      const stage = this.form.card_experience.stage;
      return ['accent_color', 'user_bubble_color', 'assistant_bubble_color', 'text_color']
        .every(key => String(stage[key] || '').toLowerCase() === String(preset[key] || '').toLowerCase());
    },

    applyBubbleStylePreset(presetId) {
      this.form.card_experience.stage = applyBubbleStyle(this.form.card_experience.stage, presetId);
    },

    bubbleStyleIsActive(preset) {
      return Number(this.form.card_experience.stage.bubble_radius) === Number(preset.bubble_radius);
    },

    stagePreviewStyle() {
      const stage = this.form.card_experience.stage;
      const asset = this.form.media_assets.find(item => item.id === stage.background_asset_id);
      const style = {
        '--experience-preview-accent': stage.accent_color,
        '--experience-preview-user': stage.user_bubble_color,
        '--experience-preview-assistant': stage.assistant_bubble_color,
        '--experience-preview-text': stage.text_color,
        '--experience-preview-radius': `${stage.bubble_radius}px`,
        '--experience-preview-font-scale': stage.font_scale,
        '--experience-preview-input-bg': stage.input_background_color,
        '--experience-preview-input-text': stage.input_text_color,
        '--experience-preview-input-border': stage.input_border_color,
      };
      if (asset?.url && !String(asset.mime_type || '').startsWith('video/')) {
        style.backgroundImage = `linear-gradient(rgba(10, 9, 8, .28), rgba(10, 9, 8, .5)), url("${String(asset.url).replace(/["\\]/g, '\\$&')}")`;
      }
      return style;
    },

    stagePortraitPreview() {
      const stage = this.form.card_experience.stage;
      if (!stage.show_portrait) return '';
      return this.form.media_assets.find(item => item.id === stage.portrait_asset_id && item.kind === 'portrait')?.url || '';
    },

    stagePortraitPreviewStyle() {
      const stage = this.form.card_experience.stage;
      return {
        width: `${stage.portrait_width}%`,
        opacity: stage.portrait_opacity,
        left: stage.portrait_position === 'left' ? '2%' : (stage.portrait_position === 'center' ? '50%' : 'auto'),
        right: stage.portrait_position === 'right' ? '2%' : 'auto',
        transform: stage.portrait_position === 'center' ? 'translateX(-50%)' : 'none',
      };
    },

    worldAssetBindings(worldIndex) {
      const bindings = normalizeMediaBindings(this.form.world_info[worldIndex]?.media_bindings);
      return bindings.map(binding => ({ ...binding, asset: this.form.media_assets.find(asset => asset.id === binding.asset_id) })).filter(item => item.asset);
    },

    async uploadCardAsset(file, kind) {
      if (!this.canUseAdvancedCreation() && kind !== 'spine') throw new Error(this.advancedCreationHint());
      const rules = {
        bgm: { max: 30 * 1024 * 1024, accept: ['audio/mpeg', 'audio/mp3', 'audio/ogg'] },
        portrait: { max: 20 * 1024 * 1024, accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
        background: { max: 80 * 1024 * 1024, accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'] },
        spine: { max: 60 * 1024 * 1024, accept: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream', ''] },
      };
      const rule = rules[kind];
      const validSpineName = kind !== 'spine' || /\.spine\.zip$/i.test(file.name);
      if (!rule || !validSpineName || !rule.accept.includes(file.type) || file.size <= 0 || file.size > rule.max) {
        if (kind === 'spine') throw new Error('仅支持 60MB 内、文件名以 .spine.zip 结尾的 Spine 资源包');
        throw new Error(kind === 'bgm'
          ? '仅支持 30MB 内的 MP3 文件'
          : '仅支持 20MB 内图片或 80MB 内 MP4 / WebM 场景视频');
      }
      // Chromium/Windows may expose ZIP files as application/octet-stream or
      // with an empty File.type.  The package has already been constrained by
      // its .spine.zip name and is verified again server-side by ZIP magic,
      // declared size and SHA-256, so use the canonical accepted MIME here.
      const uploadMime = kind === 'spine' && !['application/zip', 'application/x-zip-compressed'].includes(file.type)
        ? 'application/zip'
        : file.type;
      const digest = await sha256File(file);
      const intentResult = await api.createCardAssetUploadIntent({
        app_id: this.editingId || '', draft_id: this.mediaDraftId, kind,
        filename: file.name, mime_type: uploadMime, size_bytes: file.size, sha256: digest,
      });
      const intent = intentResult?.data || intentResult || {};
      const asset = intent.asset || intent;
      const upload = intent.upload || {};
      if (!asset?.id || !upload?.url) throw new Error('服务器没有返回有效上传地址');
      await api.uploadCardAssetContent(upload, file);
      const completedResult = await api.completeCardAssetUpload(asset.id, { sha256: digest, size_bytes: file.size });
      const completed = completedResult?.data?.asset || completedResult?.asset || completedResult?.data || completedResult;
      const normalized = normalizeMediaAssets([{ ...asset, ...completed, status: 'ready' }])[0];
      if (!normalized) throw new Error('服务器返回的素材信息无效');
      const existing = this.form.media_assets.findIndex(item => item.id === normalized.id);
      if (existing >= 0) this.form.media_assets.splice(existing, 1, normalized);
      else this.form.media_assets.push(normalized);
      return normalized;
    },

    async onAssetLibraryChange(event, kind) {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      this.uploadingMedia = true;
      try {
        const asset = await this.uploadCardAsset(file, kind);
        if (kind === 'bgm' && !this.form.card_experience.bgm.default_asset_id) {
          this.form.card_experience.bgm.default_asset_id = asset.id;
          this.form.card_experience.bgm.enabled = true;
        }
        if (kind === 'background' && !this.form.card_experience.stage.background_asset_id) {
          this.form.card_experience.stage.background_asset_id = asset.id;
        }
        this.showToast(`${asset.name} 已上传并绑定当前角色卡`, 'success');
      } catch (err) { this.showToast(err.message || '素材上传失败', 'error'); }
      finally { this.uploadingMedia = false; }
    },

    async onWorldAssetChange(event, worldIndex, kind) {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file || !this.form.world_info[worldIndex]) return;
      this.uploadingMedia = true;
      try {
        const asset = await this.uploadCardAsset(file, kind);
        this.bindAssetToWorld(worldIndex, kind, asset.id);
        this.showToast(`${asset.name} 已关联到世界书条目`, 'success');
      } catch (err) { this.showToast(err.message || '素材上传失败', 'error'); }
      finally { this.uploadingMedia = false; }
    },

    bindAssetToWorld(worldIndex, kind, assetId) {
      const entry = this.form.world_info[worldIndex];
      if (!entry || !assetId) return;
      const bindings = normalizeMediaBindings(entry.media_bindings);
      const existing = bindings.findIndex(binding => binding.kind === kind);
      const binding = { id: newStableId('binding'), kind, asset_id: assetId, label: this.assetLabel(assetId), activation: 'entry' };
      if (existing >= 0) bindings.splice(existing, 1, binding); else bindings.push(binding);
      entry.media_bindings = bindings;
    },

    removeWorldAssetBinding(worldIndex, bindingId) {
      const entry = this.form.world_info[worldIndex];
      if (entry) entry.media_bindings = normalizeMediaBindings(entry.media_bindings).filter(binding => binding.id !== bindingId);
    },

    async removeMediaAsset(assetId) {
      try {
        await api.deleteCardAsset(assetId);
        this.form.media_assets = this.form.media_assets.filter(asset => asset.id !== assetId);
        for (const entry of this.form.world_info) entry.media_bindings = normalizeMediaBindings(entry.media_bindings).filter(binding => binding.asset_id !== assetId);
        if (this.form.card_experience.bgm.default_asset_id === assetId) this.form.card_experience.bgm.default_asset_id = '';
        if (this.form.card_experience.stage.background_asset_id === assetId) this.form.card_experience.stage.background_asset_id = '';
        if (this.form.card_experience.stage.portrait_asset_id === assetId) this.form.card_experience.stage.portrait_asset_id = '';
        if (this.form.card_experience.galgame.default_portrait_id === assetId) this.form.card_experience.galgame.default_portrait_id = '';
        if (this.form.card_experience.galgame.default_background_id === assetId) this.form.card_experience.galgame.default_background_id = '';
        for (const rule of this.form.card_experience.ui_rules) {
          if (rule.action === 'switch_bgm' && rule.target_id === assetId) {
            rule.target_id = '';
            rule.enabled = false;
          }
        }
        this.showToast('素材已移除', 'success');
      } catch (err) { this.showToast(err.message || '素材删除失败', 'error'); }
    },

    setAssetEmotion(assetId, value) {
      const asset = this.form.media_assets.find(item => item.id === assetId);
      if (!asset) return;
      const emotion = String(value || '').trim().slice(0, 40);
      asset.metadata = { ...(asset.metadata || {}) };
      if (emotion) asset.metadata.emotion = emotion;
      else delete asset.metadata.emotion;
    },

    galgamePortraitOptions() {
      return [...this.assetsByKind('portrait'), ...this.assetsByKind('spine')];
    },

    galgameBackgroundOptions() {
      return this.assetsByKind('background').filter(asset => !String(asset.mime_type || '').startsWith('video/'));
    },

    stageBackgroundOptions() {
      return this.assetsByKind('background');
    },

    toggleVisibility() {
      this.form.is_public = !this.form.is_public;
    },


    bumpSampling(key, delta, lo, hi, decimals = 1) {
      let v = Number(this.form.sampling[key]) || 0;
      v = Math.round((v + delta) * 100) / 100;
      if (lo !== null && v < lo) v = lo;
      if (hi !== null && v > hi) v = hi;
      this.form.sampling[key] = v;
    },

    payload() {
      const payload = {
        name: this.form.name.trim(),
        summary: this.form.summary.trim(),
        description: this.form.description.trim(),
        opening_statement: this.form.opening_statement.trim(),
        pre_prompt: this.form.pre_prompt.trim(),
        personality: this.form.personality.trim(),
        scenario: this.form.scenario.trim(),
        mes_example: this.form.mes_example.trim(),
        post_history_instructions: this.form.post_history_instructions.trim(),
        prompt_blocks: this.form.prompt_blocks
          .map((b, idx) => ({
            id: b.id || ('prompt-' + (idx + 1)),
            name: (b.name || `${this.creatorText('prompt_block_name_prefix', '提示词块')} ${idx + 1}`).trim(),
            position: b.position || 'system_after',
            order: Number.isFinite(Number(b.order)) ? Number(b.order) : idx + 1,
            enabled: b.enabled !== false,
            content: (b.content || '').trim(),
          }))
          .filter(b => b.content),
        quick_replies: this.form.quick_replies
          .map((q, idx) => ({
            id: q.id || ('quick-' + (idx + 1)),
            label: (q.label || `${this.creatorText('quick_reply_name_prefix', '快捷回复')} ${idx + 1}`).trim(),
            message: (q.message || '').trim(),
            enabled: q.enabled !== false,
            order: Number.isFinite(Number(q.order)) ? Number(q.order) : idx + 1,
          }))
          .filter(q => q.message),
        regex_scripts: this.form.regex_scripts
          .map((s, idx) => ({
            id: s.id || ('regex-' + (idx + 1)),
            name: (s.name || `${this.creatorText('regex_name_prefix', 'Regex')} ${idx + 1}`).trim(),
            find: (s.find || '').trim(),
            replace: s.replace || '',
            flags: (s.flags || '').trim(),
            enabled: s.enabled !== false,
            order: Number.isFinite(Number(s.order)) ? Number(s.order) : idx + 1,
          }))
          .filter(s => s.find),
        alternate_greetings: this.form.alternate_greetings.map(s => (s || '').trim()).filter(Boolean),
        world_info: this.form.world_info
          .map((e, idx) => ({
            id: e.id || ('world-' + (idx + 1)),
            name: (e.name || `${this.creatorText('world_entry_name_prefix', '世界书条目')} ${idx + 1}`).trim(),
            keys: (e.keysText || '').split(/[，,\n]/).map(s => s.trim()).filter(Boolean),
            secondary_keys: (e.secondaryKeysText || '').split(/[，,\n]/).map(s => s.trim()).filter(Boolean),
            content: (e.content || '').trim(),
            enabled: e.enabled !== false,
            constant: !!e.constant,
            selective: !!e.selective,
            position: e.position || 'system',
            depth: Number.isFinite(Number(e.depth)) ? Number(e.depth) : 4,
            priority: Number.isFinite(Number(e.priority)) ? Number(e.priority) : 100,
            order: Number.isFinite(Number(e.order)) ? Number(e.order) : idx + 1,
            probability: Number.isFinite(Number(e.probability)) ? Number(e.probability) : 100,
            recursive: !!e.recursive,
            case_sensitive: !!e.case_sensitive,
            match_whole_words: !!e.match_whole_words,
            selective_logic: e.selective_logic || 'and_any',
            role: e.role || 'system',
            scan_depth: Number.isFinite(Number(e.scan_depth)) ? Number(e.scan_depth) : 2,
            sticky: Number.isFinite(Number(e.sticky)) ? Number(e.sticky) : 0,
            cooldown: Number.isFinite(Number(e.cooldown)) ? Number(e.cooldown) : 0,
            delay: Number.isFinite(Number(e.delay)) ? Number(e.delay) : 0,
            media_bindings: normalizeMediaBindings(e.media_bindings),
          }))
          .filter(e => e.content || e.media_bindings.length),
        media_assets: normalizeMediaAssets(this.form.media_assets),
        media_draft_id: this.mediaDraftId,
        card_experience: normalizeCardExperience(this.form.card_experience),
        card_prompt_preset: { ...this.form.card_prompt_preset, enabled: this.form.card_prompt_preset.enabled === true },
        tts_voice_id: this.form.tts_voice_id || '',
        tags: this.form.tagsText.split(/[，,\n]/).map(s => s.trim()).filter(Boolean),
        llm_model: this.form.llm_model.trim(),
        cover_url: this.form.cover_url.trim(),
        bg_url: this.form.bg_url.trim(),
        nsfw: !!this.form.nsfw,
        protected: !!this.form.protected_prompt,
        protected_prompt: !!this.form.protected_prompt,
        anonymous: !!this.form.anonymous,
        is_public: !!this.form.is_public,
        is_open_source: !!this.form.is_open_source,
        contest_opt_in: !!this.form.contest_opt_in,
        applied_preset_id: String(this.form.applied_preset_id || ''),
        applied_preset_version_id: String(this.form.applied_preset_version_id || ''),
        applied_ui_template_ids: Array.isArray(this.form.applied_ui_template_ids) ? [...this.form.applied_ui_template_ids] : [],
        applied_ui_template_version_ids: Array.isArray(this.form.applied_ui_template_version_ids) ? [...this.form.applied_ui_template_version_ids] : [],
        status: 'published',
        sampling: { ...this.form.sampling },
      };
      if (this.canUseAdvancedCreation() && this.tavernHelperScriptsDirty) {
        payload.tavern_helper_scripts = normalizeTavernHelperScripts(this.form.tavern_helper_scripts).scripts;
      }
      if (!this.canUseAdvancedCreation()) {
        const spineAssets = normalizeMediaAssets(this.form.media_assets).filter(asset => asset.kind === 'spine');
        if (spineAssets.length) payload.media_assets = spineAssets;
        else delete payload.media_assets;
        if (!spineAssets.length) delete payload.media_draft_id;
        if (!spineAssets.length) delete payload.card_experience;
        delete payload.card_prompt_preset;
        payload.world_info = payload.world_info.map(entry => ({
          ...entry,
          media_bindings: normalizeMediaBindings(entry.media_bindings).filter(binding => binding.kind === 'spine'),
        }));
      }
      return payload;
    },

    // ---- 备用开场白 ----
    addGreeting() { this.form.alternate_greetings.push(''); this.expand.greetings = true; },
    removeGreeting(i) { this.form.alternate_greetings.splice(i, 1); },

    // ---- 世界书 ----
    addWorldEntry() {
      const next = this.form.world_info.length + 1;
      this.form.world_info.push({
        id: 'world-' + Date.now() + '-' + next,
        name: `${this.creatorText('world_entry_name_prefix', '世界书条目')} ${next}`,
        keysText: '',
        secondaryKeysText: '',
        content: '',
        enabled: true,
        constant: false,
        selective: false,
        position: 'system',
        depth: 4,
        priority: 100,
        order: next,
        probability: 100,
        recursive: false,
        case_sensitive: false,
        match_whole_words: false,
        selective_logic: 'and_any',
        role: 'system',
        scan_depth: 2,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        media_bindings: [],
      });
      this.expand.worldinfo = true;
    },
    removeWorldEntry(i) {
      const entryId = this.form.world_info[i]?.id;
      this.form.world_info.splice(i, 1);
      if (!entryId) return;
      for (const rule of this.form.card_experience.ui_rules) {
        if (rule.action === 'set_scene' && rule.target_id === entryId) {
          rule.target_id = '';
          rule.enabled = false;
        }
      }
    },
    duplicateWorldEntry(i) {
      const source = this.form.world_info[i];
      if (!source) return;
      this.form.world_info.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(source)), id: 'world-' + Date.now(), name: `${source.name || '世界书条目'} 副本`, order: i + 2 });
    },

    // ---- Prompt Manager ----
    addPromptBlock(position = 'system_after') {
      const next = this.form.prompt_blocks.length + 1;
      this.form.prompt_blocks.push({
        id: 'prompt-' + Date.now().toString(36) + '-' + next,
        name: `${this.creatorText('prompt_block_name_prefix', '提示词块')} ${next}`,
        position,
        order: next,
        enabled: true,
        content: '',
      });
      this.expand.promptManager = true;
    },
    removePromptBlock(i) { this.form.prompt_blocks.splice(i, 1); },

    // ---- 扩展：快捷回复 / Regex ----
    addQuickReply() {
      const next = this.form.quick_replies.length + 1;
      this.form.quick_replies.push({
        id: 'quick-' + Date.now().toString(36) + '-' + next,
        label: `${this.creatorText('quick_reply_name_prefix', '快捷回复')} ${next}`,
        message: '',
        enabled: true,
        order: next,
      });
      this.expand.advanced = true;
    },
    removeQuickReply(i) { this.form.quick_replies.splice(i, 1); },
    addRegexScript() {
      const next = this.form.regex_scripts.length + 1;
      this.form.regex_scripts.push({
        id: 'regex-' + Date.now().toString(36) + '-' + next,
        name: `${this.creatorText('regex_name_prefix', 'Regex')} ${next}`,
        find: '',
        replace: '',
        flags: '',
        enabled: true,
        order: next,
      });
      this.expand.advanced = true;
    },
    removeRegexScript(i) { this.form.regex_scripts.splice(i, 1); },

    // ---- TavernHelper 卡内脚本（高级创作） ----
    tavernHelperSourceLabel() {
      if (this.tavernHelperScriptSource === 'extensions') return '当前角色扩展';
      if (this.tavernHelperScriptSource === 'sillytavern_card') return '原始 SillyTavern 卡片快照';
      return '未配置';
    },
    tavernHelperDraftStatus() {
      if (!this.canUseAdvancedCreation()) return { count: this.tavernHelperScriptCount, bytes: 0, error: '' };
      try {
        const value = normalizeTavernHelperScripts(this.form.tavern_helper_scripts, false);
        let error = '';
        if (value.count > TAVERN_HELPER_SCRIPT_MAX_ENTRIES) error = `超过 ${TAVERN_HELPER_SCRIPT_MAX_ENTRIES} 条限制`;
        else if (value.bytes > TAVERN_HELPER_SCRIPT_MAX_JSON_BYTES) error = '超过 4 MiB 限制';
        return { count: value.count, bytes: value.bytes, error };
      } catch (err) {
        return { count: this.tavernHelperScriptCount, bytes: 0, error: err.message || '脚本数据无效' };
      }
    },
    tavernHelperSizeLabel() {
      return formatByteSize(this.tavernHelperDraftStatus().bytes || 0);
    },
    markTavernHelperDirty(recount = false) {
      if (!this.canUseAdvancedCreation()) return;
      this.tavernHelperScriptsDirty = true;
      if (recount) this.tavernHelperScriptCount = this.tavernHelperDraftStatus().count;
    },
    addTavernHelperScript(type = 'script') {
      if (!this.canUseAdvancedCreation()) { this.showToast(this.advancedCreationHint(), 'error'); return; }
      const next = this.form.tavern_helper_scripts.length + 1;
      const item = prepareTavernHelperEditorItem({
        type: type === 'folder' ? 'folder' : 'script',
        id: newStableId(type === 'folder' ? 'th-folder' : 'th-script'),
        name: type === 'folder' ? `脚本文件夹 ${next}` : `脚本 ${next}`,
        content: '',
        enabled: true,
        scripts: type === 'folder' ? [] : undefined,
      }, next - 1);
      this.form.tavern_helper_scripts.push(item);
      this.markTavernHelperDirty(true);
      this.expand.advanced = true;
    },
    changeTavernHelperType(index) {
      const item = this.form.tavern_helper_scripts[index];
      if (!item) return;
      item.type = item.type === 'folder' ? 'folder' : 'script';
      if (item.type === 'folder') {
        item.scripts = Array.isArray(item.scripts) ? item.scripts : [];
        item[TAVERN_HELPER_FOLDER_DRAFT_KEY] = JSON.stringify(item.scripts, null, 2);
        item[TAVERN_HELPER_FOLDER_ERROR_KEY] = '';
      } else {
        delete item.scripts;
        delete item[TAVERN_HELPER_FOLDER_DRAFT_KEY];
        delete item[TAVERN_HELPER_FOLDER_ERROR_KEY];
      }
      this.markTavernHelperDirty(true);
    },
    validateTavernHelperFolder(index) {
      const item = this.form.tavern_helper_scripts[index];
      if (!item || item.type !== 'folder') return true;
      try {
        const parsed = JSON.parse(String(item[TAVERN_HELPER_FOLDER_DRAFT_KEY] || '[]'));
        if (!Array.isArray(parsed)) throw new Error('scripts 必须是数组');
        item.scripts = parsed;
        item[TAVERN_HELPER_FOLDER_ERROR_KEY] = '';
        this.markTavernHelperDirty(true);
        return true;
      } catch (err) {
        item[TAVERN_HELPER_FOLDER_ERROR_KEY] = err.message || '脚本 JSON 无效';
        this.tavernHelperScriptsDirty = true;
        return false;
      }
    },
    removeTavernHelperScript(index) {
      this.form.tavern_helper_scripts.splice(index, 1);
      this.markTavernHelperDirty(true);
    },
    moveTavernHelperScript(index, delta) {
      const next = index + delta;
      if (next < 0 || next >= this.form.tavern_helper_scripts.length) return;
      const [item] = this.form.tavern_helper_scripts.splice(index, 1);
      this.form.tavern_helper_scripts.splice(next, 0, item);
      this.markTavernHelperDirty();
    },
    duplicateTavernHelperScript(index) {
      const source = this.form.tavern_helper_scripts[index];
      if (!source) return;
      let normalized;
      try { normalized = normalizeTavernHelperScripts([source], false).scripts[0]; }
      catch (err) { this.showToast(err.message || '请先修正脚本 JSON', 'error'); return; }
      const copy = prepareTavernHelperEditorItem(normalized, index + 1);
      copy.id = newStableId(copy.type === 'folder' ? 'th-folder' : 'th-script');
      copy.name = `${copy.name || '脚本'} 副本`;
      this.form.tavern_helper_scripts.splice(index + 1, 0, copy);
      this.markTavernHelperDirty(true);
    },
    async copyTavernHelperScript(index) {
      const item = this.form.tavern_helper_scripts[index];
      if (!item) return;
      try {
        const normalized = normalizeTavernHelperScripts([item], false).scripts[0];
        await copyText(JSON.stringify(normalized, null, 2));
        this.showToast('脚本 JSON 已复制', 'success', 1000);
      } catch (err) {
        this.showToast(err.message || '复制失败', 'error');
      }
    },
    triggerTavernHelperImport() {
      if (!this.canUseAdvancedCreation()) { this.showToast(this.advancedCreationHint(), 'error'); return; }
      this.$refs.tavernHelperImport?.click();
    },
    async onTavernHelperImport(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const imported = normalizeTavernHelperScripts(extractTavernHelperScripts(parsed));
        if (this.form.tavern_helper_scripts.length && !confirm('导入会替换当前 TavernHelper 脚本，是否继续？')) return;
        this.form.tavern_helper_scripts = imported.scripts.map((item, index) => prepareTavernHelperEditorItem(item, index));
        this.tavernHelperScriptsDirty = true;
        this.tavernHelperScriptCount = imported.count;
        this.showToast(`已导入 ${imported.count} 条 TavernHelper 脚本`, 'success', 1400);
      } catch (err) {
        this.showToast(err.message || 'TavernHelper 脚本导入失败', 'error', 4000);
      }
    },
    exportTavernHelperScripts() {
      if (!this.canUseAdvancedCreation()) { this.showToast(this.advancedCreationHint(), 'error'); return; }
      try {
        const normalized = normalizeTavernHelperScripts(this.form.tavern_helper_scripts);
        downloadJson({ format: 'homer-tavern-helper-scripts-v1', scripts: normalized.scripts }, `${this.form.name || 'character'}-tavern-helper-scripts.json`);
        this.showToast(`已导出 ${normalized.count} 条脚本`, 'success', 1200);
      } catch (err) {
        this.showToast(err.message || 'TavernHelper 脚本导出失败', 'error');
      }
    },
    clearTavernHelperScripts() {
      if (!this.form.tavern_helper_scripts.length || confirm('确定清空本角色的 TavernHelper 脚本？保存角色后生效。')) {
        this.form.tavern_helper_scripts = [];
        this.markTavernHelperDirty(true);
      }
    },

    addUiRule(action = 'open_popup') {
      this.form.card_experience.ui_rules.push(createUiRuleTemplate(action, this.form.card_experience.ui_rules.length));
      this.expand.experience = true;
    },
    removeUiRule(i) { this.form.card_experience.ui_rules.splice(i, 1); },
    onUiRuleActionChange(rule) {
      rule.target_id = '';
      if (rule.action === 'show_floating' && Number(rule.duration_ms) <= 0) rule.duration_ms = 5000;
    },
    uiRuleTemplateOptions(action) {
      const templates = {
        open_popup: [
          { id: 'notice', name: '剧情提示' },
          { id: 'choice', name: '快捷选择' },
        ],
        show_floating: [
          { id: 'status', name: '状态变化' },
          { id: 'achievement', name: '成就提示' },
        ],
      };
      return templates[action] || [];
    },
    applyUiRuleTemplate(rule, templateId) {
      const templates = {
        notice: {
          name: '剧情提示', pattern: '\\[POPUP:notice\\]',
          template_html: '<section class="card-notice"><h3>剧情提示</h3><p>{{message}}</p><button data-card-action="close-popup">知道了</button></section>',
          scoped_css: '.card-notice{padding:22px;color:#fff;background:#241f2c;border:1px solid #d7b878;border-radius:12px}.card-notice h3{margin:0 0 10px}.card-notice button{margin-top:14px;padding:8px 14px;border:0;border-radius:7px;background:#d7b878;color:#241f2c}',
        },
        choice: {
          name: '快捷选择', pattern: '\\[POPUP:choice\\]',
          template_html: '<section class="card-choice"><h3>接下来怎么做？</h3><div><button data-card-action="insert-text" data-text="调查周围">调查周围</button><button data-card-action="insert-text" data-text="继续前进">继续前进</button></div><button data-card-action="close-popup">关闭</button></section>',
          scoped_css: '.card-choice{padding:22px;color:#fff;background:#1c2730;border-radius:12px}.card-choice div{display:grid;gap:8px;margin:14px 0}.card-choice button{padding:9px 12px;border:1px solid #63d7c6;border-radius:7px;color:#effffb;background:#28465a}',
        },
        status: {
          name: '状态变化', pattern: '\\[FLOAT:status\\]', duration_ms: 5000,
          template_html: '<div class="card-status"><strong>状态已更新</strong><span>{{message}}</span></div>',
          scoped_css: '.card-status{display:grid;gap:3px;padding:12px 16px;color:#effffb;background:#17252d;border-left:3px solid #63d7c6;border-radius:8px}',
        },
        achievement: {
          name: '成就提示', pattern: '\\[FLOAT:achievement\\]', duration_ms: 6500,
          template_html: '<div class="card-achievement"><strong>新记录</strong><span>{{message}}</span></div>',
          scoped_css: '.card-achievement{display:grid;gap:3px;padding:12px 16px;color:#fff8ed;background:#211d19;border:1px solid #d7b878;border-radius:8px}',
        },
      };
      const template = templates[templateId];
      if (!template) return;
      Object.assign(rule, template);
    },
    addExperienceSidebar() {
      this.form.card_experience.sidebars.push(createSidebarTemplate(this.form.card_experience.sidebars.length));
      this.expand.experience = true;
    },
    removeExperienceSidebar(i) {
      const sidebarId = this.form.card_experience.sidebars[i]?.id;
      this.form.card_experience.sidebars.splice(i, 1);
      if (!sidebarId) return;
      for (const rule of this.form.card_experience.ui_rules) {
        if (rule.action === 'open_sidebar' && rule.target_id === sidebarId) {
          rule.target_id = '';
          rule.enabled = false;
        }
      }
    },
    sidebarTemplateOptions() {
      return [{ id: 'profile', name: '角色资料' }, { id: 'catalog', name: '可搜索图鉴' }, { id: 'journal', name: '剧情记录' }];
    },
    applySidebarTemplate(bar, templateId) {
      const templates = {
        profile: {
          content_html: '<article class="card-profile"><p class="eyebrow">角色资料</p><h3>{{character}}</h3><p>在这里填写允许向玩家公开的角色介绍。</p></article>',
          scoped_css: '.card-profile{padding:22px;color:#fff8ed}.card-profile .eyebrow{color:#d7b878;font-size:12px}.card-profile h3{margin:6px 0 12px;font-size:22px}',
        },
        catalog: {
          content_html: '<section class="card-catalog"><input data-card-search placeholder="搜索条目"><div data-card-item data-name="示例条目" data-type="地点"><strong>示例条目</strong><p>替换为允许公开的图鉴内容。</p></div></section>',
          scoped_css: '.card-catalog{display:grid;gap:10px;padding:18px;color:#effffb}.card-catalog input{padding:9px;border:1px solid #63d7c6;border-radius:7px;background:#17252d;color:inherit}.card-catalog [data-card-item]{padding:12px;border-radius:8px;background:#28465a}',
        },
        journal: {
          content_html: '<article class="card-journal"><h3>剧情记录</h3><ol><li><strong>第一章</strong><span>在这里填写允许公开的摘要。</span></li></ol></article>',
          scoped_css: '.card-journal{padding:20px;color:#fff7fa}.card-journal ol{display:grid;gap:10px;padding-left:20px}.card-journal li span{display:block;margin-top:3px;color:#d9c9d0}',
        },
      };
      const template = templates[templateId];
      if (template) Object.assign(bar, template, { content_mode: 'static', world_entry_id: '' });
    },

    structuredComponentExample() {
      return this.structuredComponentOptions.find(item => item.id === this.structuredExampleType)
        || this.structuredComponentOptions[0];
    },
    structuredExampleCode() {
      const example = this.structuredComponentExample()?.example || {};
      return `\`\`\`homer-ui\n${JSON.stringify(example, null, 2)}\n\`\`\``;
    },
    async copyStructuredExample() {
      try {
        await navigator.clipboard.writeText(this.structuredExampleCode());
        this.showToast('组件示例已复制', 'success', 1200);
      } catch {
        this.showToast('浏览器未允许复制，请手动选择示例内容', 'error');
      }
    },

    experienceFeatureCount() {
      const experience = this.form.card_experience;
      return Number(!!experience.stage.enabled)
        + Number(!!experience.bgm.enabled)
        + Number(!!experience.galgame.enabled)
        + experience.ui_rules.filter(item => item.enabled !== false).length
        + experience.sidebars.filter(item => item.enabled !== false).length
        + Object.entries(experience.structured_components).filter(([key, value]) => key !== 'enabled' && value).length;
    },

    validateCardExperience() {
      if (!this.canUseAdvancedCreation()) return true;
      const experience = this.form.card_experience;
      const assets = new Map(this.form.media_assets.filter(item => item.status !== 'pending').map(item => [item.id, item.kind]));
      const worldIds = new Set(this.form.world_info.map(item => item.id).filter(Boolean));
      const sidebarIds = new Set(experience.sidebars.map(item => item.id));
      const stage = experience.stage;
      let message = '';
      if (stage.background_asset_id && assets.get(stage.background_asset_id) !== 'background') message = '专属舞台引用的背景素材已经不存在';
      else if (stage.portrait_asset_id && !['portrait', 'spine'].includes(assets.get(stage.portrait_asset_id))) message = '专属舞台引用的立绘素材已经不存在';
      else if (experience.bgm.default_asset_id && assets.get(experience.bgm.default_asset_id) !== 'bgm') message = '默认 BGM 素材已经不存在';
      else if (experience.galgame.default_portrait_id && !['portrait', 'spine'].includes(assets.get(experience.galgame.default_portrait_id))) message = 'galgame 默认立绘已经不存在';
      else if (experience.galgame.default_background_id && assets.get(experience.galgame.default_background_id) !== 'background') message = 'galgame 默认背景已经不存在';
      for (let index = 0; !message && index < experience.ui_rules.length; index += 1) {
        const rule = experience.ui_rules[index];
        if (rule.enabled === false) continue;
        const label = rule.name || `界面规则 ${index + 1}`;
        if (!String(rule.pattern || '').trim()) message = `「${label}」缺少触发正则`;
        else if (!safeRegExp(rule.pattern, rule.flags)) message = `「${label}」的触发正则无效或复杂度过高`;
        else if (rule.action === 'switch_bgm' && assets.get(rule.target_id) !== 'bgm') message = `「${label}」需要选择 BGM`;
        else if (rule.action === 'open_sidebar' && !sidebarIds.has(rule.target_id)) message = `「${label}」需要选择侧栏`;
        else if (rule.action === 'set_scene' && !worldIds.has(rule.target_id)) message = `「${label}」需要选择世界书场景`;
      }
      for (let index = 0; !message && index < experience.sidebars.length; index += 1) {
        const bar = experience.sidebars[index];
        if (bar.enabled === false) continue;
        const label = bar.name || `侧栏 ${index + 1}`;
        if (!String(bar.content_html || '').trim()) message = `「${label}」需要填写向玩家公开的内容`;
        else if (bar.open_pattern && !safeRegExp(bar.open_pattern, bar.flags)) message = `「${label}」的打开正则无效或复杂度过高`;
      }
      if (!message) return true;
      this.expand.experience = true;
      this.showToast(message, 'error', 3200);
      requestAnimationFrame(() => document.getElementById('creator-experience')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return false;
    },

    triggerCardPresetImport() { this.$refs.cardPresetInput?.click(); },
    async onCardPresetImport(event) {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      if (!this.canUseAdvancedCreation()) { this.showToast(this.advancedCreationHint(), 'error'); return; }
      try {
        const parsed = JSON.parse(await file.text());
        const preset = parsed?.data?.extensions?.homer_card_prompt_preset || parsed?.extensions?.homer_card_prompt_preset || parsed;
        if (!preset || typeof preset !== 'object' || (!Array.isArray(preset.prompts) && !Array.isArray(preset.blocks))) throw new Error('请选择 SillyTavern Prompt Preset JSON');
        this.form.card_prompt_preset = { ...preset, version: 1, enabled: false, name: preset.name || preset.preset_name || file.name.replace(/\.json$/i, ''), source_file: file.name };
        this.showToast('本卡预设已导入，请确认后开启', 'success');
      } catch (err) { this.showToast(err.message || '本卡预设导入失败', 'error'); }
    },
    clearCardPromptPreset() { this.form.card_prompt_preset = emptyCardPromptPreset(); },
    cardPresetEntryCount() { return Number(this.form.card_prompt_preset?.stats?.entry_count || this.form.card_prompt_preset?.prompts?.length || this.form.card_prompt_preset?.blocks?.length || 0); },

    // ---- 导入 SillyTavern 角色卡 ----
    triggerImport() {
      if (this.pendingCardPackImport) {
        this.retryPendingCardPackImport();
        return;
      }
      if (this.$refs.importInput) this.$refs.importInput.click();
    },

    async beginCardPackImport(file) {
      if (!this.canUseAdvancedCreation()) throw new Error(this.advancedCreationHint());
      const pack = await parseCardPack(file);
      const importedResult = await api.importCard(pack.card);
      const app = importedResult?.data || importedResult;
      if (!app?.id) throw new Error('服务器已接收资源包，但没有返回有效卡片 ID');
      const packedData = pack.card?.data && typeof pack.card.data === 'object' ? pack.card.data : pack.card;
      const packedExperience = packedData?.extensions?.homer_card_experience
        || packedData?.card_experience
        || pack.card?.card_experience;
      if (packedExperience && typeof packedExperience === 'object' && !Array.isArray(packedExperience)) {
        // The base import intentionally strips unresolved asset IDs. Restore
        // the package declaration in memory so buildCardPackMediaUpdate can
        // remap every reference to the newly uploaded, owned asset IDs.
        app.card_experience = cloneJson(packedExperience);
      }
      this.editingId = app.id;
      this.pendingCardPackImport = { app, pack, uploaded: [], next_asset: 0 };
      await this.continueCardPackImport();
    },

    async continueCardPackImport() {
      const task = this.pendingCardPackImport;
      if (!task?.app?.id || !task.pack) throw new Error('没有可恢复的资源包导入任务');
      const total = task.pack.assets.length;
      while (task.next_asset < total) {
        const source = task.pack.assets[task.next_asset];
        this.showToast(`正在导入资源 ${task.next_asset + 1}/${total}：${source.name || source.file.name}`, 'info', 3000);
        const asset = await this.uploadCardAsset(source.file, source.kind);
        asset.pack_index = source.pack_index;
        asset.filename = source.file.name;
        asset.kind = source.kind;
        asset.metadata = { ...(asset.metadata || {}) };
        if (source.emotion) asset.metadata.emotion = source.emotion;
        task.uploaded.push(asset);
        task.next_asset += 1;
      }

      const { payload, report } = buildCardPackMediaUpdate({
        importedApp: task.app,
        uploadedAssets: task.uploaded,
        sourceAssets: task.pack.assets,
        mediaDraftId: this.mediaDraftId,
        idFactory: newStableId,
      });
      await api.updateApp(task.app.id, payload);
      await api.publishCardVersion(task.app.id, {
        version_name: '资源包导入',
        version_description: `导入 ${task.pack?.file?.name || '完整角色资源包'} 后的素材与设定版本`,
      });
      const unmatchedText = report.unmatched.length ? `；${report.unmatched.length} 个素材未匹配世界书，已保留在素材库` : '';
      this.pendingCardPackImport = null;
      this.showToast(`资源包导入完成：${report.asset_count} 个素材、${report.world_binding_count} 个世界书绑定${unmatchedText}`, 'success', 2200);
      setTimeout(() => { location.href = `/app/create.html?id=${encodeURIComponent(task.app.id)}`; }, 700);
    },

    async retryPendingCardPackImport() {
      if (!this.pendingCardPackImport || this.importing) return;
      this.importing = true;
      try {
        await this.continueCardPackImport();
      } catch (err) {
        const cardId = this.pendingCardPackImport?.app?.id || '';
        this.showToast(`卡片 ${cardId} 已创建，自动绑定尚未完成；修复问题后点击“重试绑定”。${err.message || ''}`, 'error', 6000);
      } finally {
        this.importing = false;
      }
    },

    async onImportFile(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      this.importing = true;
      try {
        if (isCardPackFilename(file.name)) {
          await this.beginCardPackImport(file);
          return;
        }
        let r;
        if (file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')) {
          const cardFile = await fileToDataUrl(file);
          r = await api.importCard({ card_file: cardFile, filename: file.name });
        } else {
          const text = await file.text();
          let card;
          try { card = JSON.parse(text); }
          catch { throw new Error(this.creatorText('import_invalid_file', '文件不是有效的 JSON/PNG 角色卡或 ZIP/TGP/TPG 资源包')); }
          r = await api.importCard(card);
        }
        const app = r?.data || r;
        this.showToast(this.creatorText('import_success', '导入成功，正在打开…'), 'success', 1200);
        setTimeout(() => { location.href = `/app/create.html?id=${encodeURIComponent(app.id)}`; }, 500);
      } catch (err) {
        if (this.pendingCardPackImport?.app?.id) {
          this.showToast(`卡片 ${this.pendingCardPackImport.app.id} 已创建，自动绑定尚未完成；点击“重试绑定”可从断点继续。${err.message || ''}`, 'error', 6000);
        } else {
          this.showToast(err.message || this.creatorText('import_failed', '导入失败'), 'error');
        }
      } finally {
        this.importing = false;
      }
    },

    // ---- 导出当前角色卡为标准 V2 JSON ----
    async exportCard() {
      if (!this.editingId) return;
      try {
        const r = await api.exportCard(this.editingId);
        const card = r?.data || r;
        const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(this.form.name || 'character').replace(/[^\w一-龥-]+/g, '_')}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        this.showToast(this.creatorText('export_success', '已导出'), 'success', 1200);
      } catch (err) {
        this.showToast(err.message || this.creatorText('export_failed', '导出失败'), 'error');
      }
    },

    async exportCardPng() {
      if (!this.editingId) return;
      try {
        const r = await api.exportCardPng(this.editingId);
        const data = r?.data || r;
        const a = document.createElement('a');
        a.href = data.data_url;
        a.download = data.filename || `${(this.form.name || 'character').replace(/[^\w一-龥-]+/g, '_')}.png`;
        document.body.appendChild(a); a.click(); a.remove();
        this.showToast(this.creatorText('png_export_success', 'PNG 角色卡已导出'), 'success', 1200);
      } catch (err) {
        this.showToast(err.message || this.creatorText('png_export_failed', 'PNG 导出失败'), 'error');
      }
    },

    validatePayload(payload) {
      if (!payload.name) {
        this.showToast(this.creatorText('validate_name', '请填写角色名称'), 'error');
        return false;
      }
      if (!payload.summary && !payload.description) {
        this.showToast(this.creatorText('validate_summary', '请填写一句简介或角色设定'), 'error');
        return false;
      }
      return true;
    },

    async submit() {
      if (!this.validateCardExperience()) return;
      let payload;
      try { payload = this.payload(); }
      catch (err) { this.showToast(err.message || '角色数据校验失败', 'error', 4000); return; }
      if (!this.validatePayload(payload)) return;
      if (this.editingId) {
        this.publishDialogOpen = true;
        if (!this.versionName) this.versionName = `v${Math.max(1, this.cardVersions.length + 1)}`;
        return;
      }
      this.loading = true;
      try {
        const r = await api.createApp(payload);
        const app = r?.data || r;
        this.showToast(this.creatorText('created_success', '角色已创建'), 'success', 1200);
        setTimeout(() => {
          location.href = `/app/chat.html?app_id=${encodeURIComponent(app.id)}`;
        }, 450);
      } catch (err) {
        this.showToast(err.message || this.creatorText('save_failed', '保存失败'), 'error');
      } finally {
        this.loading = false;
      }
    },

    async publishEditedVersion() {
      if (!this.validateCardExperience()) return;
      let payload;
      try { payload = this.payload(); }
      catch (err) { this.showToast(err.message || '角色数据校验失败', 'error', 4000); return; }
      if (!this.validatePayload(payload)) return;
      const versionName = String(this.versionName || '').trim();
      const versionDescription = String(this.versionDescription || '').trim();
      if (!versionName) {
        this.showToast('请填写新版本名称', 'error');
        return;
      }
      if (!versionDescription) {
        this.showToast('请填写这个版本的作者介绍或更新说明', 'error');
        return;
      }
      this.loading = true;
      try {
        await api.updateApp(this.editingId, payload);
        await api.publishCardVersion(this.editingId, {
          version_name: versionName,
          version_description: versionDescription,
        });
        this.publishDialogOpen = false;
        this.versionName = '';
        this.versionDescription = '';
        await this.loadCardVersions();
        this.showToast('新版本已发布；已有会话仍保持原版本', 'success', 1800);
        setTimeout(() => { location.href = `/app/character.html?id=${encodeURIComponent(this.editingId)}`; }, 650);
      } catch (err) {
        this.showToast(err.message || '版本发布失败，草稿已保留，可重试发布', 'error', 5000);
      } finally {
        this.loading = false;
      }
    },

    async remove() {
      if (!this.editingId) return;
      if (!confirm(this.creatorText('delete_confirm', '确定删除这个角色？此操作无法撤销。'))) return;
      this.loading = true;
      try {
        await api.deleteApp(this.editingId);
        this.showToast(this.creatorText('delete_success', '已删除'), 'success', 1000);
        setTimeout(() => { location.href = '/app/my-apps.html'; }, 350);
      } catch (err) {
        this.showToast(err.message || this.creatorText('delete_failed', '删除失败'), 'error');
      } finally {
        this.loading = false;
      }
    },
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read file failed'));
    reader.readAsDataURL(file);
  });
}

async function sha256File(file) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全文件校验，请升级浏览器后重试');
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(String(value || ''));
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = String(value || '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('浏览器不允许复制到剪贴板');
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = String(filename || 'tavern-helper-scripts.json').replace(/[\\/:*?"<>|]+/g, '_');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

window.createPage = createPage;
document.addEventListener('alpine:init', () => {
  if (window.Alpine?.data) window.Alpine.data('createPage', createPage);
});
