import { api, requireAuth, getCachedUser, setCachedUser, ApiError } from '/app/assets/js/app-core.js?v=20260905-notices-v1';
import { injectLayout, loadPublicSiteSettings } from '/app/assets/js/layout.js?v=20260905-notices-v1';
import { readPageCache, writePageCache } from '/app/assets/js/page-cache.js?v=20260905-notices-v1';

const DEFAULT_PAGE_SIZE = 12;
const INITIAL_RANDOM_SEED = Math.floor(Math.random() * 2147483647);
const BROWSE_STATE_KEY = 'ai_xingyue_home_browse_state';
const BROWSE_RESTORE_KEY = 'ai_xingyue_home_restore_once';
const EXPLORE_CACHE_SCOPE = 'explore';

async function fetchExplorePage(params, signal) {
  const response = await fetch(`/go/api/explore/search?${new URLSearchParams(params)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new ApiError(data?.message || data?.msg || `HTTP ${response.status}`, response.status, data);
  }
  if (data?.result === 'failure') {
    throw new ApiError(data.message || data.msg || '请求失败', parseInt(data.code, 10) || response.status, data);
  }
  return data;
}

function explorePage() {
  return {
    activeNav: 'explore',
    user: null,
    points: 0,
    stats: null,
    sidebarOpen: false,
    loading: false,
    hasMore: true,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: 0,
    searchKeyword: '',
    cards: [],
    featuredPool: [],
    activeCategory: 'all',
    activeSort: 'random',
    activeRank: 'daily',
    activeZone: 'clean',
    randomSeed: INITIAL_RANDOM_SEED,
    pictureless: false,
    siteSettings: null,
    advancedOpen: false,
    advancedForm: {
      keyword: '',
      category: 'all',
      sort: 'random',
      rank: 'daily',
      zone: 'clean',
      pictureless: false,
      pageSize: DEFAULT_PAGE_SIZE,
    },
    categories: [
      { key: 'all', label: '全部' },
      { key: '恋爱', label: '恋爱' },
      { key: '二次元', label: '二次元' },
      { key: '游戏', label: '游戏' },
      { key: 'urban', label: '都市' },
      { key: 'history', label: '历史' },
      { key: 'fantasy', label: '玄幻' },
      { key: 'scifi', label: '科幻' },
      { key: 'mystery', label: '悬疑' },
    ],
    rankOptions: [
      { key: 'daily', label: '日榜' },
      { key: 'weekly', label: '周榜' },
      { key: 'monthly', label: '月榜' },
      { key: 'overall', label: '总榜' },
    ],
    sortOptions: [
      { key: 'random', label: '随机' },
      { key: 'popular', label: '热门' },
      { key: 'latest', label: '最新' },
      { key: 'updated', label: '更新' },
    ],
    zoneOptions: [
      { key: 'clean', label: '纯净区' },
      { key: 'all', label: '全库' },
    ],
    _browsePageshowBound: false,
    _listEpoch: 0,
    _listAbortController: null,

    async init() {
      injectLayout(this.activeNav);
      this.bindBrowseRestoreEvents();
      const restoredBrowseState = this.restoreBrowseState();
      const settingsPromise = loadPublicSiteSettings()
        .then(settings => {
          this.siteSettings = settings;
          this.applyAppHomeLabels();
          return settings;
        })
        .catch(() => null);
      if (!requireAuth()) return;
      const cached = getCachedUser();
      if (cached) this.user = cached;
      const restoredPersistentState = !restoredBrowseState && this.restorePersistentState(cached);

      const accountPromise = (async () => {
        try {
          const [profileResult, pointsResult, statsResult] = await Promise.allSettled([
            api.profile(),
            api.points(),
            api.homeStats(),
          ]);
          if (profileResult.status === 'fulfilled') {
            this.user = profileResult.value;
            setCachedUser(profileResult.value);
          } else if (profileResult.reason instanceof ApiError && profileResult.reason.code === 401) {
            location.replace('/app/login.html?next=' + encodeURIComponent(location.pathname));
            return;
          }
          if (pointsResult.status === 'fulfilled') {
            const p = pointsResult.value;
            this.points = parseInt(p.points || p.data?.points || 0, 10);
          }
          if (statsResult.status === 'fulfilled') this.stats = statsResult.value?.data || null;
        } catch (err) {
          if (err instanceof ApiError && err.code === 401) {
            location.replace('/app/login.html?next=' + encodeURIComponent(location.pathname));
          }
        }
      })();
      const listPromise = restoredBrowseState
        ? Promise.resolve()
        : this.loadList(true, { keepVisible: restoredPersistentState });
      await Promise.allSettled([settingsPromise, listPromise, accountPromise]);
      if (restoredBrowseState) this.restoreBrowseScroll(restoredBrowseState.scrollY, restoredBrowseState.clickedId);
    },

    setCategory(k) { this.activeCategory = k; this.syncAdvancedForm(); this.loadList(true); },
    setSort(k) { this.activeSort = k; this.syncAdvancedForm(); this.loadList(true); },
    setRank(k) { this.activeRank = k; this.syncAdvancedForm(); this.loadList(true); },
    setZone(k) { this.activeZone = k === 'all' ? 'all' : 'clean'; this.syncAdvancedForm(); this.loadList(true); },
    togglePictureless() { this.pictureless = !this.pictureless; this.syncAdvancedForm(); this.loadList(true); },
    shuffleRandom() {
      try {
        sessionStorage.removeItem(BROWSE_RESTORE_KEY);
        sessionStorage.removeItem(BROWSE_STATE_KEY);
      } catch { /* ignore private mode storage errors */ }
      this.activeSort = 'random';
      this.syncAdvancedForm();
      this.loadList(true);
    },

    syncAdvancedForm() {
      this.advancedForm = {
        keyword: this.searchKeyword || '',
        category: this.activeCategory || 'all',
        sort: this.activeSort || 'random',
        rank: this.activeRank || 'daily',
        zone: this.activeZone || 'clean',
        pictureless: !!this.pictureless,
        pageSize: Number(this.pageSize) || DEFAULT_PAGE_SIZE,
      };
    },

    toggleAdvancedSearch() {
      if (!this.advancedOpen) this.syncAdvancedForm();
      this.advancedOpen = !this.advancedOpen;
    },

    async applyAdvancedSearch() {
      this.searchKeyword = String(this.advancedForm.keyword || '').trim();
      this.activeCategory = this.advancedForm.category || 'all';
      this.activeSort = this.advancedForm.sort || 'random';
      this.activeRank = this.advancedForm.rank || 'daily';
      this.activeZone = this.advancedForm.zone === 'all' ? 'all' : 'clean';
      this.pictureless = !!this.advancedForm.pictureless;
      this.pageSize = Number(this.advancedForm.pageSize) || DEFAULT_PAGE_SIZE;
      await this.searchOrJump(true);
    },

    async searchOrJump(reset = true) {
      const keyword = String(this.searchKeyword || '').trim();
      if (keyword && looksLikeCardId(keyword)) {
        try {
          const r = await api.appDetails(keyword);
          const id = r?.data?.id || r?.id || '';
          if (id) {
            location.href = `/app/character.html?id=${encodeURIComponent(id)}`;
            return;
          }
        } catch {}
      }
      await this.loadList(reset);
    },

    resetAdvancedSearch() {
      this.advancedForm = {
        keyword: '',
        category: 'all',
        sort: 'random',
        rank: 'daily',
        zone: 'clean',
        pictureless: false,
        pageSize: DEFAULT_PAGE_SIZE,
      };
      this.applyAdvancedSearch();
    },

    appHomeText(key, fallback = '') {
      return this.siteSettings?.app_home?.[key] || fallback;
    },

    homeSearchPlaceholder() {
      const configured = this.appHomeText('search_placeholder', '');
      if (configured && configured !== '搜索角色') return configured;
      return '搜索关键词/作者/标签/ID';
    },

    appHomeMapText(mapKey, key, fallback = '') {
      return this.siteSettings?.app_home?.[mapKey]?.[key] || fallback;
    },

    applyAppHomeLabels() {
      this.categories = this.categories.map(item => ({
        ...item,
        label: this.appHomeMapText('category_labels', item.key, item.label),
      }));
      this.rankOptions = this.rankOptions.map(item => ({
        ...item,
        label: this.appHomeMapText('rank_labels', item.key, item.label),
      }));
      this.sortOptions = this.sortOptions.map(item => ({
        ...item,
        label: this.appHomeMapText('sort_labels', item.key, item.label),
      }));
      this.zoneOptions = this.zoneOptions.map(item => ({
        ...item,
        label: item.key === 'clean'
          ? this.appHomeText('zone_clean_label', item.label)
          : this.appHomeText('zone_all_label', item.label),
      }));
    },

    async loadList(reset = false, { keepVisible = false } = {}) {
      if (!reset && (this.loading || !this.hasMore)) return;
      if (reset) {
        this._listEpoch += 1;
        this._listAbortController?.abort();
        this.page = 1;
        if (!keepVisible) {
          this.cards = [];
          this.featuredPool = [];
          this.hasMore = true;
          this.total = 0;
        }
        if (this.activeSort === 'random') this.randomSeed = Math.floor(Math.random() * 2147483647);
      }
      if (this._listEpoch === 0) this._listEpoch = 1;
      const requestEpoch = this._listEpoch;
      const requestPage = this.page;
      const requestController = new AbortController();
      this._listAbortController = requestController;
      this.loading = true;
      try {
        const params = {
          page: requestPage,
          page_size: this.pageSize,
          sort: this.activeSort,
          rank: this.activeRank,
        };
        if (this.activeSort === 'random') params.seed = this.randomSeed;
        if (this.activeCategory !== 'all') params.tag = this.activeCategory;
        if (this.searchKeyword) params.q = this.searchKeyword;
        if (this.activeZone === 'all') params.zone = 'all';
        else if (!this.searchKeyword) params.zone = 'clean';
        if (this.pictureless) params.pictureless = 'true';
        const r = await fetchExplorePage(params, requestController.signal);
        if (requestEpoch !== this._listEpoch) return;
        const data = r?.data || {};
        const list = data.apps || data.list || data.items || [];
        if (requestPage === 1) {
          const featured = Array.isArray(data.featured_apps) ? data.featured_apps : [];
          this.featuredPool = featured
            .map((raw, index) => normalizeCard(raw, this.siteSettings?.app_home || {}, index))
            .filter(Boolean);
        }
        const baseCards = requestPage === 1 ? [] : this.cards;
        const seen = new Set(baseCards.map(card => card.id));
        const normalized = list
          .map((raw, index) => normalizeCard(raw, this.siteSettings?.app_home || {}, index))
          .filter(card => card && !seen.has(card.id));
        this.cards = [...baseCards, ...normalized];
        const total = parseInt(data.total ?? this.cards.length, 10);
        this.total = Number.isNaN(total) ? this.cards.length : total;
        const receivedCount = Array.isArray(list) ? list.length : 0;
        this.hasMore = this.cards.length < this.total && receivedCount > 0;
        this.page = requestPage + 1;
        this.persistState();
      } catch (err) {
        // 上游不可达时静默
        if (err?.name !== 'AbortError' && requestEpoch === this._listEpoch && !this.cards.length) this.hasMore = false;
      } finally {
        if (requestEpoch === this._listEpoch && this._listAbortController === requestController) {
          this._listAbortController = null;
          this.loading = false;
        }
      }
    },

    loadMore() { this.loadList(false); },

    featuredCards() {
      return this.featuredPool.length ? this.featuredPool.slice(0, 2) : this.cards.slice(0, 2);
    },

    recommendedCards() {
      const featuredIds = new Set(this.featuredCards().map(card => card.id));
      return this.cards.filter(card => !card.official_recommended && !featuredIds.has(card.id));
    },

    emptyText(key, fallback = '') {
      return this.siteSettings?.empty_states?.[key] || fallback;
    },

    async toggleFavorite(card, event) {
      if (event) event.preventDefault();
      if (event) event.stopPropagation();
      try {
        const r = await api.toggleFavorite(card.id);
        card.favorited = !!r?.data?.favorited;
      } catch {}
    },

    rememberBrowsePosition(card = null) {
      try {
        sessionStorage.setItem(BROWSE_RESTORE_KEY, '1');
        sessionStorage.setItem(BROWSE_STATE_KEY, JSON.stringify({
          savedAt: Date.now(),
          scrollY: window.scrollY || document.documentElement.scrollTop || 0,
          page: this.page,
          pageSize: this.pageSize,
          total: this.total,
          hasMore: this.hasMore,
          searchKeyword: this.searchKeyword,
          activeCategory: this.activeCategory,
          activeSort: this.activeSort,
          activeRank: this.activeRank,
          activeZone: this.activeZone,
          randomSeed: this.randomSeed,
          pictureless: this.pictureless,
          cards: this.cards.slice(0, 80),
          featuredPool: this.featuredPool.slice(0, 2),
          clickedId: card?.id || '',
        }));
      } catch {}
      this.persistState();
    },

    bindBrowseRestoreEvents() {
      if (this._browsePageshowBound) return;
      this._browsePageshowBound = true;
      document.addEventListener('click', (event) => {
        const link = event.target?.closest?.('a[href*="/app/character.html?id="]');
        if (!link) return;
        try {
          const id = new URL(link.href, location.origin).searchParams.get('id') || '';
          this.rememberBrowsePosition({ id });
        } catch {
          this.rememberBrowsePosition();
        }
      }, true);
      const restore = () => {
        const state = this.restoreBrowseState();
        if (state) this.restoreBrowseScroll(state.scrollY, state.clickedId);
      };
      window.addEventListener('pageshow', () => setTimeout(restore, 0));
      window.addEventListener('popstate', () => setTimeout(restore, 0));
      window.addEventListener('focus', () => setTimeout(restore, 40));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') setTimeout(restore, 40);
        else this.persistState();
      });
      window.addEventListener('pagehide', () => this.persistState());
    },

    restoreBrowseState() {
      try {
        if (sessionStorage.getItem(BROWSE_RESTORE_KEY) !== '1') return null;
        const raw = sessionStorage.getItem(BROWSE_STATE_KEY);
        const state = raw ? JSON.parse(raw) : null;
        if (!state || Date.now() - Number(state.savedAt || 0) > 20 * 60 * 1000) return null;
        this.page = Number(state.page) || 1;
        this.pageSize = Number(state.pageSize) || DEFAULT_PAGE_SIZE;
        this.total = Number(state.total) || 0;
        this.hasMore = state.hasMore !== false;
        this.searchKeyword = String(state.searchKeyword || '');
        this.activeCategory = state.activeCategory || 'all';
        this.activeSort = state.activeSort || 'random';
        this.activeRank = state.activeRank || 'daily';
        this.activeZone = state.activeZone === 'all' ? 'all' : 'clean';
        this.randomSeed = Number(state.randomSeed) || this.randomSeed;
        this.pictureless = !!state.pictureless;
        this.cards = Array.isArray(state.cards) ? state.cards : [];
        this.featuredPool = Array.isArray(state.featuredPool) ? state.featuredPool : [];
        this.syncAdvancedForm();
        return state;
      } catch {
        return null;
      }
    },

    restoreBrowseScroll(scrollY = 0, clickedId = '') {
      const target = Math.max(0, Number(scrollY) || 0);
      this.$nextTick(() => {
        const apply = () => {
          const id = String(clickedId || '').replace(/"/g, '\\"');
          const clicked = id ? document.querySelector(`a[href*="${id}"]`) : null;
          if (clicked) {
            clicked.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
            return;
          }
          window.scrollTo({ top: target, left: 0, behavior: 'auto' });
        };
        requestAnimationFrame(() => {
          apply();
          setTimeout(apply, 120);
          setTimeout(apply, 360);
          setTimeout(() => {
            try { sessionStorage.removeItem(BROWSE_RESTORE_KEY); } catch {}
          }, 520);
        });
      });
    },

    restorePersistentState(user = this.user) {
      const state = readPageCache(EXPLORE_CACHE_SCOPE, user);
      if (!state || !Array.isArray(state.cards) || !state.cards.length) return false;
      this.page = Number(state.page) || 2;
      this.pageSize = Number(state.pageSize) || DEFAULT_PAGE_SIZE;
      this.total = Number(state.total) || state.cards.length;
      this.hasMore = state.hasMore !== false;
      this.searchKeyword = String(state.searchKeyword || '');
      this.activeCategory = state.activeCategory || 'all';
      this.activeSort = state.activeSort || 'random';
      this.activeRank = state.activeRank || 'daily';
      this.activeZone = state.activeZone === 'all' ? 'all' : 'clean';
      this.randomSeed = Number(state.randomSeed) || this.randomSeed;
      this.pictureless = !!state.pictureless;
      this.cards = state.cards.slice(0, 80);
      this.featuredPool = Array.isArray(state.featuredPool) ? state.featuredPool.slice(0, 2) : [];
      this.syncAdvancedForm();
      return true;
    },

    persistState() {
      if (!this.user || !this.cards.length) return;
      writePageCache(EXPLORE_CACHE_SCOPE, this.user, {
        page: this.page,
        pageSize: this.pageSize,
        total: this.total,
        hasMore: this.hasMore,
        searchKeyword: this.searchKeyword,
        activeCategory: this.activeCategory,
        activeSort: this.activeSort,
        activeRank: this.activeRank,
        activeZone: this.activeZone,
        randomSeed: this.randomSeed,
        pictureless: this.pictureless,
        cards: this.cards.slice(0, 80),
        featuredPool: this.featuredPool.slice(0, 2),
      });
    },
  };
}

function compactPreview(value) {
  let text = String(value || '').replace(/\r/g, '').trim();
  if (!text) return '';
  if (/^[{[]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        text = String(parsed.description || parsed.summary || parsed.profile || parsed.personality || '');
      }
    } catch {}
  }
  text = text
    .replace(/<\/?(?:CoreIdentity|CharacterProfile|StatusPlaceHolderImpl|prologue\d*)\b[^>]*>/gi, ' ')
    .replace(/<[^>]{0,120}>/g, ' ')
    .replace(/\{\{[^}]{1,120}\}\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bulletCount = (text.match(/(?:^|\s)-\s+/g) || []).length;
  const quotedKeyCount = (text.match(/["']?[A-Za-z_][A-Za-z0-9_]*["']?\s*[:：]/g) || []).length;
  if (
    !text
    || /^(?:system|assistant|user|prompt|json)\s*[:：]/i.test(text)
    || bulletCount >= 3
    || quotedKeyCount >= 4
    || /\b(?:import\s+[A-Za-z_]|from\s+[A-Za-z_.]+\s+import|class\s+[A-Za-z_]|def\s+[A-Za-z_]|__init__|collections\.)\b/.test(text)
  ) return '';
  return text.length > 150 ? `${text.slice(0, 150).trim()}…` : text;
}

function firstCleanPreview(...values) {
  for (const value of values) {
    const clean = compactPreview(value);
    if (clean) return clean;
  }
  return '';
}

function normalizeCard(raw, copy = {}, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.app_id || raw.appId || raw.installed_app_id;
  if (!id) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags : (Array.isArray(raw.category) ? raw.category : []);
  const description = firstCleanPreview(raw.summary, raw.intro, raw.subtitle, raw.description)
    || copy.summary_fallback
    || '点击查看角色设定';
  const flags = raw.feature_flags && typeof raw.feature_flags === 'object' ? raw.feature_flags : {};
  return {
    id: String(id),
    displayId: String(raw.display_id || raw.card_no || raw.short_id || raw.public_id || id),
    name: raw.name || raw.app_name || raw.title || copy.unnamed_role || '未命名角色',
    description,
    author: raw.author || raw.creator || raw.publisher || raw.user_name || raw.created_by || copy.official_author || '',
    cover: raw.cover || raw.cover_url || raw.image || raw.icon_url || raw.banner || '',
    icon: raw.icon || raw.icon_url || raw.avatar || '',
    tags,
    likeCount: Number(raw.like_count || raw.likes || 0),
    playersCount: Number(raw.players_count || raw.players || raw.chat_count || 0),
    hasOpening: raw.has_opening != null ? !!raw.has_opening : !!flags.opening,
    hasWorldInfo: raw.has_world_info != null ? !!raw.has_world_info : !!flags.world_info,
    hasRegex: raw.has_regex != null ? !!raw.has_regex : !!flags.regex,
    favorited: !!raw.favorited,
    pictureless: !!raw.pictureless,
  };
}

function looksLikeCardId(value) {
  let text = String(value || '').trim();
  if (text.startsWith('#')) text = text.slice(1).trim();
  if (text.toLowerCase().startsWith('id:')) text = text.slice(3).trim();
  if (!text || /\s/.test(text)) return false;
  if (/^\d{4,}$/.test(text)) return true;
  if (text.length < 8) return false;
  if (/^(admin|user|upstream|local|app|role|card)-[A-Za-z0-9_.:-]{6,}$/i.test(text)) return true;
  if (/^[A-Za-z0-9]+-[A-Za-z0-9_.:-]{8,}$/.test(text)) return true;
  return /^[0-9a-f]{16,}$/i.test(text);
}

window.explorePage = explorePage;
document.addEventListener('alpine:init', () => {
  if (window.Alpine?.data) window.Alpine.data('explorePage', explorePage);
});
