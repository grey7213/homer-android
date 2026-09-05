import { api, requireAuth, getCachedUser, setCachedUser, formatDateTime, ApiError } from '/app/assets/js/app-core.js?v=20260905-notices-v1';
import { injectLayout, loadPublicSiteSettings } from '/app/assets/js/layout.js?v=20260905-notices-v1';

const FIELD_LABELS = {
  name: '姓名',
  name_romaji: '罗马音',
  nickname: '昵称',
  age: '年龄',
  gender: '性别',
  school: '学校',
  grade: '年级',
  occupation: '身份',
  role: '身份',
  species: '种族',
  birthday: '生日',
  height: '身高',
  relationship: '关系',
  description: '角色介绍',
  profile: '角色介绍',
  personality: '性格',
  scenario: '场景',
  background: '背景',
  setting: '设定',
  appearance: '外貌',
  likes: '喜好',
  dislikes: '雷点',
  first_mes: '开场白',
  greeting: '开场白',
  mes_example: '对话示例',
};

const BASIC_FIELDS = ['name', 'name_romaji', 'nickname', 'age', 'gender', 'school', 'grade', 'occupation', 'role', 'species', 'birthday', 'height', 'relationship'];
const LONG_FIELDS = ['description', 'profile', 'summary', 'personality', 'scenario', 'background', 'setting', 'first_mes', 'greeting', 'mes_example'];

function stripJsonFence(text) {
  const value = String(text || '').trim();
  const match = value.match(/^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : value;
}

function tryParseJsonLike(text) {
  const value = stripJsonFence(text);
  if (!value || !/^[\[{]/.test(value)) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function looksStructuredNoise(text) {
  const value = stripJsonFence(text);
  if (!value) return false;
  if (tryParseJsonLike(value)) return true;
  if (/^\s*[\[{]/.test(value) && value.length > 60) return true;
  return /(^|[\n,{])\s*["']?(name_romaji|first_mes|mes_example|scenario|personality|character_book|extensions|creator_notes|alternate_greetings)["']?\s*:/i.test(value);
}

function valueToText(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) {
    return value.map(valueToText).filter(Boolean).join('、');
  }
  if (typeof value === 'object') {
    const pairs = Object.entries(value)
      .filter(([, v]) => v != null && v !== '')
      .slice(0, 12)
      .map(([k, v]) => `${FIELD_LABELS[k] || k}：${valueToText(v)}`);
    return pairs.join('\n');
  }
  return String(value).replace(/\uFFFD/g, '').trim();
}

function plainDisplayText(value) {
  const raw = String(value || '').replace(/\r/g, '').trim();
  if (!raw) return '';
  const visualOnly = /<(?:img|video|audio|iframe|style|script)\b/i.test(raw);
  const stripped = raw
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:基本信息|角色设定|开场白|CoreIdentity)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  const decoder = document.createElement('textarea');
  decoder.innerHTML = stripped;
  const text = String(decoder.value || '')
    .replace(/\{\{\s*(?:char|user)\s*\}\}/gi, match => match.toLowerCase().includes('char') ? '角色' : '你')
    .replace(/(?:^|\s)-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (visualOnly && text.length < 12) return '';
  return text;
}

function compactText(value, limit = 160) {
  const text = plainDisplayText(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function objectSource(parsed) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) return parsed.data;
    if (parsed.character && typeof parsed.character === 'object' && !Array.isArray(parsed.character)) return parsed.character;
    return parsed;
  }
  return null;
}

function structuredDetail(rawText) {
  const raw = String(rawText || '').trim();
  const parsed = tryParseJsonLike(raw);
  const source = objectSource(parsed);
  if (!source) {
    const plain = plainDisplayText(raw);
    return { structured: false, raw, summary: compactText(plain), plain, sections: [] };
  }

  const sections = [];
  const basics = BASIC_FIELDS
    .map(key => ({ key, label: FIELD_LABELS[key] || key, value: valueToText(source[key]) }))
    .filter(item => item.value);
  if (basics.length) sections.push({ title: '基础信息', items: basics });

  for (const key of LONG_FIELDS) {
    const text = valueToText(source[key]);
    if (!text) continue;
    const title = FIELD_LABELS[key] || key;
    sections.push({ title, body: text });
  }

  const used = new Set([...BASIC_FIELDS, ...LONG_FIELDS, 'creator_notes', 'extensions', 'character_book', 'alternate_greetings']);
  const extraItems = Object.entries(source)
    .filter(([key, value]) => !used.has(key) && value != null && value !== '' && typeof value !== 'object')
    .slice(0, 10)
    .map(([key, value]) => ({ key, label: FIELD_LABELS[key] || key, value: valueToText(value) }))
    .filter(item => item.value);
  if (extraItems.length) sections.push({ title: '其他信息', items: extraItems });

  const summarySource = valueToText(source.description || source.profile || source.summary)
    || basics.filter(item => item.key !== 'name_romaji').map(item => `${item.label}：${item.value}`).join('，')
    || raw;
  return {
    structured: sections.length > 0,
    raw,
    summary: compactText(summarySource),
    plain: sections.length ? '' : raw,
    sections,
  };
}

function normalizeCard(raw) {
  const data = raw?.data || raw || {};
  const summary = data.summary || data.intro || '';
  const description = data.description || data.prompt || '';
  const opening = data.opening_statement || data.opening || '';
  const flags = data.feature_flags && typeof data.feature_flags === 'object' ? data.feature_flags : {};
  const worldInfo = Array.isArray(data.world_info) ? data.world_info : [];
  const regexScripts = Array.isArray(data.regex_scripts) ? data.regex_scripts : [];
  const summaryDetail = structuredDetail(summary);
  const descriptionDetail = structuredDetail(description);
  const openingDetail = structuredDetail(opening);
  if (/<(?:img|video|iframe)\b|background-image\s*:/i.test(opening)) {
    openingDetail.summary = '已配置视觉化开场，进入聊天后可查看完整效果。';
  }
  return {
    id: String(data.id || data.app_id || ''),
    displayId: String(data.display_id || data.card_no || data.short_id || data.public_id || data.id || data.app_id || ''),
    name: data.name || data.app_name || data.title || '',
    summary,
    summary_detail: summaryDetail,
    description,
    description_detail: descriptionDetail,
    opening_statement: opening,
    opening_detail: openingDetail,
    cover: data.cover || data.cover_url || data.image || data.icon_url || '',
    icon: data.icon || data.icon_url || data.avatar || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    user_tags: Array.isArray(data.user_tags) ? data.user_tags : [],
    source: data.source || 'upstream',
    favorited: !!data.favorited,
    liked: !!data.liked,
    like_count: Number(data.like_count || 0),
    currentVersionId: String(data.current_version_id || ''),
    hasOpening: data.has_opening != null ? !!data.has_opening : (flags.opening != null ? !!flags.opening : !!String(opening).trim()),
    hasWorldInfo: data.has_world_info != null ? !!data.has_world_info : (flags.world_info != null ? !!flags.world_info : worldInfo.length > 0),
    hasRegex: data.has_regex != null ? !!data.has_regex : (flags.regex != null ? !!flags.regex : regexScripts.length > 0),
  };
}

function characterPage() {
  return {
    user: null,
    points: 0,
    loading: false,
    card: null,
    loadError: '',
    siteSettings: null,
    comments: [],
    commentsTotal: 0,
    commentsHasMore: false,
    commentsExpanded: false,
    commentsLoading: false,
    commentDraft: '',
    commentSubmitting: false,
    commentLikingId: '',
    userTagDraft: '',
    userTagSaving: false,
    extraFlags: {
      is_open_source: false,
      contest_opt_in: false,
      contest_id: '',
      votes: 0,
      voted: false,
      open_source_entries: [],
    },
    versions: [],
    currentVersionId: '',
    contest: null,
    versionPickerOpen: false,
    selectedVersionId: '',
    startingVersion: false,
    startError: '',

    async init() {
      injectLayout('explore');
      this.siteSettings = await loadPublicSiteSettings().catch(() => null);
      if (!requireAuth()) return;
      const cached = getCachedUser();
      if (cached) this.user = cached;
      try {
        const profile = await api.profile();
        this.user = profile;
        setCachedUser(profile);
        const p = await api.points();
        this.points = parseInt(p.points || p.data?.points || 0, 10);
      } catch (err) {
        if (err instanceof ApiError && err.code === 401) {
          location.replace('/app/login.html?next=' + encodeURIComponent(location.pathname + location.search));
          return;
        }
      }
      const id = new URLSearchParams(location.search).get('id');
      if (!id) return;
      await this.loadCard(id);
    },

    async loadCard(id) {
      this.loading = true;
      this.loadError = '';
      try {
        const r = await api.appDetails(id);
        const card = normalizeCard(r);
        this.card = card.id ? card : null;
        if (this.card?.id) {
          this.userTagDraft = (this.card.user_tags || []).join('，');
          await Promise.all([this.loadComments(false), this.loadExtendedDetails()]);
        }
      } catch (err) {
        this.card = null;
        this.comments = [];
        this.loadError = err?.code === 404 ? '这个角色不存在或已经下架' : '角色加载失败，请稍后重试';
      } finally {
        this.loading = false;
      }
    },

    async loadExtendedDetails() {
      if (!this.card?.id) return;
      const [flagsResult, versionsResult, contestsResult] = await Promise.allSettled([
        api.cardExtraFlags(this.card.id),
        api.cardVersions(this.card.id),
        api.communityContests(),
      ]);
      if (flagsResult.status === 'fulfilled') {
        const flags = flagsResult.value?.data || flagsResult.value || {};
        this.extraFlags = {
          ...this.extraFlags,
          ...flags,
          votes: Number(flags.votes || 0),
          voted: !!flags.voted,
          open_source_entries: Array.isArray(flags.open_source_entries) ? flags.open_source_entries : [],
        };
      }
      if (versionsResult.status === 'fulfilled') {
        const data = versionsResult.value?.data || versionsResult.value || {};
        this.versions = Array.isArray(data.list) ? data.list : [];
        this.currentVersionId = String(data.current_version_id || this.card.currentVersionId || this.versions[0]?.id || '');
      } else {
        this.versions = [];
        this.currentVersionId = this.card.currentVersionId || '';
      }
      if (contestsResult.status === 'fulfilled') {
        const data = contestsResult.value?.data || contestsResult.value || {};
        const contests = Array.isArray(data.list) ? data.list : [];
        this.contest = contests.find(item => String(item.id) === String(this.extraFlags.contest_id))
          || (data.active && String(data.active.id) === String(this.extraFlags.contest_id) ? data.active : null);
      }
    },

    characterText(key, fallback = '') {
      return this.siteSettings?.character?.[key] || fallback;
    },

    goBack() {
      if (document.referrer && new URL(document.referrer, location.origin).origin === location.origin && history.length > 1) {
        history.back();
        return;
      }
      location.href = '/app/explore.html';
    },

    likeLabel() {
      const count = Number(this.card?.like_count || 0);
      return `${this.card?.liked ? '已赞' : '点赞'}${count ? ` ${count}` : ''}`;
    },

    favoriteLabel() {
      return this.card?.favorited ? '已收藏' : '收藏';
    },

    voteLabel() {
      const votes = Number(this.extraFlags?.votes || 0);
      return `${this.extraFlags?.voted ? '已投票' : '投票'}${votes ? ` ${votes}` : ''}`;
    },

    async toggleContestVote() {
      if (!this.card?.id || !this.extraFlags?.contest_id) return;
      try {
        const result = await api.voteCommunityContest(this.extraFlags.contest_id, this.card.id);
        const data = result?.data || result || {};
        this.extraFlags = {
          ...this.extraFlags,
          voted: !!data.voted,
          votes: Number(data.votes ?? this.extraFlags.votes ?? 0),
        };
      } catch (error) {
        this.startError = error?.message || '投票失败，请稍后重试';
      }
    },

    openVersionPicker(preferredVersionId = '') {
      if (!this.card?.id) return;
      this.startError = '';
      this.selectedVersionId = String(preferredVersionId || this.currentVersionId || this.versions[0]?.id || '');
      this.versionPickerOpen = true;
    },

    versionName(version) {
      return version?.version_name || version?.label || `v${version?.version_no || '?'}`;
    },

    isCurrentVersion(version) {
      return !!version?.id && String(version.id) === String(this.currentVersionId);
    },

    async startSelectedVersion() {
      if (!this.card?.id || this.startingVersion) return;
      this.startingVersion = true;
      this.startError = '';
      try {
        const result = await api.startConversation({
          app_id: this.card.id,
          app_name: this.card.name,
          app_icon: this.card.icon || this.card.cover || '',
          version_id: this.selectedVersionId || this.currentVersionId || '',
        });
        const data = result?.data || result || {};
        if (!data.conversation_id) throw new Error('未能创建会话');
        const params = new URLSearchParams({
          app_id: String(data.app_id || this.card.id),
          conversation_id: String(data.conversation_id),
        });
        location.href = `/app/chat.html?${params}`;
      } catch (error) {
        this.startError = error?.message || '创建版本会话失败，请稍后重试';
      } finally {
        this.startingVersion = false;
      }
    },

    async copyCardId() {
      if (!this.card?.id) return;
      const text = this.card.displayId || this.card.id;
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        const input = document.createElement('textarea');
        input.value = text;
        input.setAttribute('readonly', 'readonly');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        try { document.execCommand('copy'); } catch {}
        input.remove();
      }
    },

    formatTime(ts) {
      return ts ? formatDateTime(ts) : '';
    },

    async loadComments(expanded = this.commentsExpanded) {
      if (!this.card?.id) return;
      this.commentsLoading = true;
      try {
        const r = await api.appComments(this.card.id, { limit: expanded ? 50 : 3, expanded: expanded ? 1 : 0 });
        const data = r?.data || r || {};
        this.comments = Array.isArray(data.list) ? data.list : [];
        this.commentsTotal = Number(data.total || this.comments.length || 0);
        this.commentsHasMore = !!data.has_more;
        this.commentsExpanded = !!expanded;
      } catch {
        this.comments = [];
        this.commentsTotal = 0;
        this.commentsHasMore = false;
      } finally {
        this.commentsLoading = false;
      }
    },

    async submitComment() {
      if (!this.card?.id || this.commentSubmitting) return;
      const content = this.commentDraft.trim();
      if (!content) return;
      this.commentSubmitting = true;
      try {
        await api.createAppComment(this.card.id, content);
        this.commentDraft = '';
        await this.loadComments(this.commentsExpanded);
      } finally {
        this.commentSubmitting = false;
      }
    },

    async toggleCommentsExpanded() {
      await this.loadComments(!this.commentsExpanded);
    },

    commentLikeLabel(comment) {
      const count = Number(comment?.like_count || 0);
      return `${comment?.liked ? '已赞' : '点赞'}${count ? ` ${count}` : ''}`;
    },

    async toggleCommentLike(comment) {
      if (!comment?.id || this.commentLikingId) return;
      this.commentLikingId = comment.id;
      try {
        const r = await api.toggleCommentLike(comment.id);
        const updated = r?.data || r || {};
        this.comments = this.comments.map(item => item.id === comment.id ? { ...item, ...updated } : item);
      } finally {
        this.commentLikingId = '';
      }
    },

    async toggleLike(event) {
      if (event) event.preventDefault();
      if (!this.card?.id) return;
      const r = await api.toggleLike(this.card.id);
      this.card = {
        ...this.card,
        liked: !!r?.data?.liked,
        like_count: Number(r?.data?.like_count ?? this.card.like_count ?? 0),
      };
    },

    async toggleFavorite(event) {
      if (event) event.preventDefault();
      if (!this.card?.id) return;
      const r = await api.toggleFavorite(this.card.id);
      this.card = { ...this.card, favorited: !!r?.data?.favorited };
    },

    async saveUserTags() {
      if (!this.card?.id || this.userTagSaving) return;
      const tags = this.userTagDraft
        .split(/[，,\n]/)
        .map(s => s.trim())
        .filter(Boolean);
      this.userTagSaving = true;
      try {
        const r = await api.saveUserTags(this.card.id, tags);
        const next = r?.data?.user_tags || r?.data?.tags || tags;
        this.card = { ...this.card, user_tags: Array.isArray(next) ? next : [] };
        this.userTagDraft = this.card.user_tags.join('，');
      } finally {
        this.userTagSaving = false;
      }
    },

    cardSummary() {
      if (!this.card) return '';
      const parsedSummary = this.card.summary_detail?.structured ? this.card.summary_detail.summary : '';
      const plainSummary = looksStructuredNoise(this.card.summary) ? '' : compactText(this.card.summary);
      const descriptionSummary = this.card.description_detail?.structured || !looksStructuredNoise(this.card.description)
        ? this.card.description_detail?.summary
        : '';
      return parsedSummary
        || descriptionSummary
        || plainSummary
        || this.characterText('summary_fallback', '点击开始对话。');
    },
  };
}

window.characterPage = characterPage;
document.addEventListener('alpine:init', () => {
  if (window.Alpine?.data) window.Alpine.data('characterPage', characterPage);
});
