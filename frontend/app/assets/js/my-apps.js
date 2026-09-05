import { api, requireAuth, getCachedUser, setCachedUser, ApiError } from '/app/assets/js/app-core.js?v=20260905-notices-v1';
import { injectLayout, loadPublicSiteSettings } from '/app/assets/js/layout.js?v=20260905-notices-v1';

function myAppsPage() {
  return {
    user: null,
    points: 0,
    sidebarOpen: false,
    loading: false,
    saving: false,
    apps: [],
    toast: null,
    toastTimer: null,
    editing: null,
    siteSettings: null,

    async init() {
      injectLayout('workshop');
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
          location.replace('/app/login.html?next=' + encodeURIComponent(location.pathname));
          return;
        }
      }
      await this.loadApps();
    },

    showToast(message, type = 'info', duration = 2800) {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toast = { message, type };
      this.toastTimer = setTimeout(() => { this.toast = null; }, duration);
    },

    emptyText(key, fallback = '') {
      return this.siteSettings?.empty_states?.[key] || fallback;
    },

    myText(key, fallback = '') {
      return this.siteSettings?.my_apps?.[key] || fallback;
    },

    formatTemplate(template, values = {}) {
      return String(template || '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
    },

    async loadApps() {
      this.loading = true;
      try {
        const r = await api.myApps({ page: 1, page_size: 100 });
        const data = r?.data || r;
        this.apps = data.list || data.apps || [];
      } catch (err) {
        this.showToast(err.message || this.myText('load_failed_text', '获取角色失败'), 'error');
        this.apps = [];
      } finally {
        this.loading = false;
      }
    },

    edit(app) {
      this.editing = {
        ...app,
        tagsText: (app.tags || []).join('，'),
        versionName: '',
        versionDescription: '',
      };
    },

    async saveEdit() {
      if (!this.editing) return;
      const app = this.editing;
      if (!app.name?.trim()) {
        this.showToast(this.myText('validate_name', '请填写角色名称'), 'error');
        return;
      }
      if (!String(app.versionName || '').trim()) {
        this.showToast('请填写新版本名称', 'error');
        return;
      }
      if (!String(app.versionDescription || '').trim()) {
        this.showToast('请填写版本作者介绍或更新说明', 'error');
        return;
      }
      this.saving = true;
      try {
        const payload = {
          name: app.name.trim(),
          summary: (app.summary || '').trim(),
          description: (app.description || '').trim(),
          opening_statement: (app.opening_statement || '').trim(),
          pre_prompt: (app.pre_prompt || '').trim(),
          cover_url: (app.cover || app.cover_url || '').trim(),
          tags: String(app.tagsText || '').split(/[，,\n]/).map(s => s.trim()).filter(Boolean),
          is_public: app.is_public !== false,
          status: 'published',
        };
        await api.updateApp(app.id, payload);
        await api.publishCardVersion(app.id, {
          version_name: String(app.versionName || '').trim(),
          version_description: String(app.versionDescription || '').trim(),
        });
        this.showToast('新版本已发布，已有会话仍保持原版本', 'success');
        this.editing = null;
        await this.loadApps();
      } catch (err) {
        this.showToast(err.message || this.myText('save_failed', '保存失败'), 'error');
      } finally {
        this.saving = false;
      }
    },

    async remove(app) {
      const name = app.name || this.myText('unnamed_role', '未命名角色');
      const confirmText = this.formatTemplate(this.myText('delete_confirm_template', '删除「{name}」？'), { name });
      if (!confirm(confirmText)) return;
      try {
        await api.deleteApp(app.id);
        this.showToast(this.myText('deleted_success', '已删除'), 'success');
        await this.loadApps();
      } catch (err) {
        this.showToast(err.message || this.myText('delete_failed', '删除失败'), 'error');
      }
    },
  };
}

window.myAppsPage = myAppsPage;
document.addEventListener('alpine:init', () => {
  if (window.Alpine?.data) window.Alpine.data('myAppsPage', myAppsPage);
});
