import { api, requireAuth, getCachedUser, setCachedUser, ApiError } from '/app/assets/js/app-core.js?v=20260720-community-versions';
import { injectLayout } from '/app/assets/js/layout.js?v=20260901-persistent-pages';

const WORK_TYPES = ['mod', 'ui_template', 'preset'];
const TYPE_LABELS = { mod: 'Mod', ui_template: 'UI 模板', preset: '预设' };
const SAFE_DEMO_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "manifest-src 'none'",
].join('; ');

const SAFE_DEMO_BOOTSTRAP = `(() => {
  'use strict';
  const deniedError = () => new Error('Homer UI demo sandbox: network capability denied');
  const deny = () => { throw deniedError(); };
  try { Object.defineProperty(window, 'fetch', { value: () => Promise.reject(deniedError()), configurable: false }); } catch {}
  for (const key of ['XMLHttpRequest', 'WebSocket', 'EventSource']) {
    try { Object.defineProperty(window, key, { value: function DeniedNetwork() { deny(); }, configurable: false }); } catch {}
  }
  try { Object.defineProperty(window, 'open', { value: deny, configurable: false }); } catch {}
  try { if (navigator.sendBeacon) Object.defineProperty(navigator, 'sendBeacon', { value: deny, configurable: false }); } catch {}
  let parentBlocked = false;
  try { void window.parent.document.body; } catch { parentBlocked = true; }
  document.documentElement.dataset.homerParentBlocked = String(parentBlocked);
  addEventListener('DOMContentLoaded', () => {
    const probe = document.createElement('button');
    probe.type = 'button';
    probe.hidden = true;
    let clicks = 0;
    probe.addEventListener('click', () => { clicks += 1; });
    document.body.appendChild(probe);
    probe.click();
    probe.remove();
    document.documentElement.dataset.homerInlineInteractive = String(clicks === 1);
    document.documentElement.dataset.homerSandboxSelftest = parentBlocked && clicks === 1 ? 'passed' : 'failed';
  }, { once: true });
})();`;

function responseData(value) {
  return value?.data ?? value ?? {};
}

function safeDemoDocument(source) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(source || ''), 'text/html');

  doc.querySelectorAll('iframe,frame,frameset,form,object,embed,applet,base,link,portal').forEach(node => node.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach(node => node.remove());
  doc.querySelectorAll('script').forEach(script => {
    const type = String(script.getAttribute('type') || '').trim().toLowerCase();
    const source = String(script.textContent || '');
    const hasModuleSyntax = /(^|[;\n]\s*)import\s*(?:[({*]|[\w$]+\s+from\s+)|\bimport\s*\(|(^|[;\n]\s*)export\s+/m.test(source);
    if (script.hasAttribute('src') || type === 'module' || type === 'importmap' || hasModuleSyntax) script.remove();
  });

  for (const element of doc.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      const value = String(attr.value || '').trim();
      if (['srcdoc', 'srcset', 'ping', 'action', 'formaction'].includes(name)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (['href', 'xlink:href'].includes(name)) {
        if (!value.startsWith('#')) element.removeAttribute(attr.name);
        continue;
      }
      if (['src', 'poster', 'data'].includes(name)) {
        const allowEmbeddedImage = element.tagName === 'IMG' && /^data:image\/(?:png|gif|jpe?g|webp|svg\+xml);/i.test(value);
        if (!allowEmbeddedImage) element.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        element.setAttribute('style', value
          .replace(/@import[\s\S]*?(?:;|$)/gi, '')
          .replace(/url\(\s*(['"]?)(?!data:image\/)[^)]+\1\s*\)/gi, 'none')
          .replace(/expression\s*\([^)]*\)/gi, ''));
      }
    }
  }

  doc.querySelectorAll('style').forEach(style => {
    style.textContent = String(style.textContent || '')
      .replace(/@import[\s\S]*?(?:;|$)/gi, '')
      .replace(/url\(\s*(['"]?)(?!data:image\/)[^)]+\1\s*\)/gi, 'none')
      .replace(/expression\s*\([^)]*\)/gi, '');
  });

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', SAFE_DEMO_CSP);
  doc.head.prepend(csp);
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width,initial-scale=1';
  doc.head.insertBefore(viewport, csp.nextSibling);
  const bootstrap = doc.createElement('script');
  bootstrap.textContent = SAFE_DEMO_BOOTSTRAP;
  doc.head.insertBefore(bootstrap, viewport.nextSibling);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function emptyWorkForm(type = 'mod') {
  return {
    type,
    name: '',
    summary: '',
    cover_url: '',
    demo_html: '',
    content_text: '',
    is_public: true,
    is_open_source: false,
    version_name: '',
    version_description: '',
  };
}

function communityPage() {
  return {
    user: null,
    points: 0,
    isAdmin: false,
    tab: 'mod',
    scope: 'public',
    search: '',
    works: [],
    loading: false,
    notice: '',
    detailOpen: false,
    detail: null,
    createOpen: false,
    editingWorkId: '',
    form: emptyWorkForm(),
    saving: false,
    contests: [],
    contest: null,
    rankings: [],
    contestCreateOpen: false,
    contestForm: { title: '', content: '', reward: '', start_at: '', end_at: '' },

    async init() {
      injectLayout('workshop');
      if (!requireAuth()) return;
      const cached = getCachedUser();
      if (cached) this.applyUser(cached);
      try {
        const profile = responseData(await api.profile());
        this.applyUser(profile);
        setCachedUser(profile);
      } catch {}

      const params = new URLSearchParams(location.search);
      const requested = params.get('tab');
      if (WORK_TYPES.includes(requested)) this.tab = requested;
      else if (requested === 'contest' || requested === 'contests') this.tab = 'contests';
      await (this.tab === 'contests' ? this.loadContests() : this.loadWorks());
      if (params.get('new') === '1' && WORK_TYPES.includes(this.tab)) {
        this.openCreate(this.tab);
        params.delete('new');
        const next = new URL(location.href);
        next.search = params.toString();
        history.replaceState(null, '', next);
      }
    },

    applyUser(user) {
      this.user = user || null;
      this.points = Number(user?.points || user?.total_points || 0);
      this.isAdmin = !!(user?.is_admin || user?.is_env_admin || user?.role === 'admin');
    },

    typeLabel(type) { return TYPE_LABELS[type] || '作品'; },
    formatTime(value) { return value ? new Date(Number(value)).toLocaleString('zh-CN') : '—'; },
    showNotice(message) {
      this.notice = String(message || '操作失败');
      window.setTimeout(() => { if (this.notice === message) this.notice = ''; }, 3200);
    },

    switchTab(tab) {
      if (![...WORK_TYPES, 'contests'].includes(tab)) return;
      this.tab = tab;
      this.detailOpen = false;
      const url = new URL(location.href);
      url.searchParams.set('tab', tab);
      history.replaceState(null, '', url);
      if (tab === 'contests') this.loadContests();
      else this.loadWorks();
    },

    async loadWorks() {
      if (!WORK_TYPES.includes(this.tab)) return;
      this.loading = true;
      try {
        const data = responseData(await api.communityWorks({ type: this.tab, scope: this.scope, q: this.search.trim() }));
        this.works = Array.isArray(data.list) ? data.list : [];
      } catch (error) {
        this.works = [];
        if (!(error instanceof ApiError && error.code === 401)) this.showNotice(error?.message || '社区作品加载失败');
      } finally {
        this.loading = false;
      }
    },

    async openDetail(workId) {
      try {
        const detail = responseData(await api.communityWork(workId));
        detail.safe_demo_html = detail.work_type === 'ui_template' && detail.demo_html
          ? safeDemoDocument(detail.demo_html)
          : '';
        detail.versions = Array.isArray(detail.versions) ? detail.versions : [];
        this.detail = detail;
        this.detailOpen = true;
      } catch (error) {
        this.showNotice(error?.message || '无法打开作品详情');
      }
    },

    closeDetail() {
      this.detailOpen = false;
      this.detail = null;
    },

    prettyContent(value) {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    },

    async toggleFavorite() {
      if (!this.detail?.id) return;
      try {
        const data = responseData(await api.toggleCommunityWorkFavorite(this.detail.id));
        const favorited = !!data.favorited;
        this.detail.is_favorited = favorited;
        this.detail.favorite_count = Math.max(0, Number(this.detail.favorite_count || 0) + (favorited ? 1 : -1));
        this.works = this.works.map(work => work.id === this.detail.id
          ? { ...work, favorite_count: this.detail.favorite_count }
          : work);
        if (this.scope === 'favorites' && !favorited) await this.loadWorks();
      } catch (error) {
        this.showNotice(error?.message || '收藏操作失败');
      }
    },

    openCreate(type = this.tab) {
      const workType = WORK_TYPES.includes(type) ? type : 'mod';
      this.editingWorkId = '';
      this.form = emptyWorkForm(workType);
      this.createOpen = true;
    },

    openVersionEditor() {
      if (!this.detail?.is_owner) return;
      this.editingWorkId = this.detail.id;
      this.form = {
        ...emptyWorkForm(this.detail.work_type),
        name: this.detail.name || '',
        summary: this.detail.summary || '',
        cover_url: this.detail.cover_url || '',
        demo_html: this.detail.demo_html || '',
        content_text: this.prettyContent(this.detail.content),
        is_public: this.detail.is_public !== false,
        is_open_source: !!this.detail.is_open_source,
      };
      this.createOpen = true;
    },

    parseContent() {
      const raw = this.form.content_text.trim();
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    },

    parseStructuredEntries(type) {
      const raw = this.form.content_text.trim();
      if (!raw) throw new Error(`${this.typeLabel(type)}至少需要一个条目`);
      let value;
      try { value = JSON.parse(raw); }
      catch (error) { throw new Error(`${this.typeLabel(type)}内容必须是可解析 JSON：${error.message || error}`); }
      const candidates = type === 'mod'
        ? [Array.isArray(value) ? value : null, value?.entries, value?.world_info, value?.items, value?.character_book?.entries, value?.data?.character_book?.entries]
        : [Array.isArray(value) ? value : null, value?.entries, value?.prompts, value?.blocks, value?.items, value?.preset?.prompts, value?.data?.prompts];
      const entries = candidates.find(candidate => Array.isArray(candidate) || (candidate && typeof candidate === 'object'));
      const count = Array.isArray(entries) ? entries.length : (entries ? Object.keys(entries).length : 0);
      if (!count) throw new Error(`${this.typeLabel(type)}至少需要一个 entries / 条目`);
      return value;
    },

    async submitWork() {
      if (this.saving || !this.form.name.trim()) return;
      if (this.editingWorkId && !this.form.version_name.trim()) {
        this.showNotice('发布新版本前请填写版本名称');
        return;
      }
      if (this.editingWorkId && !this.form.version_description.trim()) {
        this.showNotice('发布新版本前请填写本版作者介绍');
        return;
      }
      this.saving = true;
      try {
        const content = ['mod', 'preset'].includes(this.form.type)
          ? this.parseStructuredEntries(this.form.type)
          : this.parseContent();
        const payload = {
          work_type: this.form.type,
          name: this.form.name.trim(),
          summary: this.form.summary.trim(),
          cover_url: this.form.cover_url.trim(),
          demo_html: this.form.type === 'ui_template' ? this.form.demo_html : '',
          content,
          is_public: !!this.form.is_public,
          is_open_source: !!this.form.is_open_source,
          version_name: this.form.version_name.trim(),
          version_description: this.form.version_description.trim(),
        };
        if (this.editingWorkId) await api.updateCommunityWork(this.editingWorkId, payload);
        else await api.createCommunityWork(payload);
        const workId = this.editingWorkId;
        this.createOpen = false;
        this.closeDetail();
        this.tab = this.form.type;
        this.scope = 'mine';
        await this.loadWorks();
        if (workId) await this.openDetail(workId);
      } catch (error) {
        this.showNotice(error?.message || '作品发布失败');
      } finally {
        this.saving = false;
      }
    },

    async deleteWork() {
      if (!this.detail?.is_owner || !confirm(`确认删除「${this.detail.name}」？`)) return;
      try {
        await api.deleteCommunityWork(this.detail.id);
        this.closeDetail();
        await this.loadWorks();
      } catch (error) {
        this.showNotice(error?.message || '删除失败');
      }
    },

    async loadContests() {
      this.loading = true;
      try {
        const data = responseData(await api.communityContests());
        this.contests = Array.isArray(data.list) ? data.list : [];
        this.contest = data.active || this.contests.find(item => item.phase === 'active') || this.contests[0] || null;
        if (this.contest?.id) {
          const rankData = responseData(await api.communityContestRankings(this.contest.id));
          this.rankings = Array.isArray(rankData.list) ? rankData.list : [];
        } else {
          this.rankings = [];
        }
      } catch (error) {
        this.contests = [];
        this.contest = null;
        this.rankings = [];
        this.showNotice(error?.message || '赛事加载失败');
      } finally {
        this.loading = false;
      }
    },

    async vote(row) {
      if (!this.contest?.id || !row?.app_id) return;
      try {
        const data = responseData(await api.voteCommunityContest(this.contest.id, row.app_id));
        row.voted = !!data.voted;
        row.votes = Number(data.votes ?? row.votes ?? 0);
        await this.loadContests();
      } catch (error) {
        this.showNotice(error?.message || '投票失败');
      }
    },

    openContestCreate() {
      this.contestForm = { title: '', content: '', reward: '', start_at: '', end_at: '' };
      this.contestCreateOpen = true;
    },

    async submitContest() {
      if (this.saving || !this.contestForm.title.trim()) return;
      const startAt = new Date(this.contestForm.start_at).getTime();
      const endAt = new Date(this.contestForm.end_at).getTime();
      if (!startAt || !endAt || endAt <= startAt) {
        this.showNotice('请填写有效的赛事起止时间');
        return;
      }
      this.saving = true;
      try {
        await api.createCommunityContest({
          title: this.contestForm.title.trim(),
          content: this.contestForm.content.trim(),
          reward: this.contestForm.reward.trim(),
          start_at: startAt,
          end_at: endAt,
        });
        this.contestCreateOpen = false;
        await this.loadContests();
      } catch (error) {
        this.showNotice(error?.message || '赛事发布失败');
      } finally {
        this.saving = false;
      }
    },
  };
}

window.communityPage = communityPage;
document.addEventListener('alpine:init', () => {
  if (window.Alpine?.data) window.Alpine.data('communityPage', communityPage);
});
