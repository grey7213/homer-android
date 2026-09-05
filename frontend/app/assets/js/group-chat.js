import { api, requireAuth, getCachedUser } from '/app/assets/js/app-core.js?v=20260905-notices-v1';
import { injectLayout, loadPublicSiteSettings } from '/app/assets/js/layout.js?v=20260905-notices-v1';

function groupChatPage() {
  return {
    user: null,
    points: 0,
    groups: [],
    current: null,
    messages: [],
    candidates: [],
    selected: [],
    query: '',
    groupName: '',
    draft: '',
    busy: false,
    toast: null,
    siteSettings: null,

    async init() {
      if (!requireAuth()) return;
      injectLayout('group');
      this.siteSettings = await loadPublicSiteSettings().catch(() => null);
      this.user = getCachedUser();
      try {
        const credits = await api.credits();
        const data = credits?.data || credits || {};
        this.points = Number(data.points || data.total_points || 0);
      } catch {}
      await Promise.all([this.loadGroups(), this.searchRoles()]);
    },

    showToast(message, type = 'info') {
      this.toast = { message, type };
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toast = null; }, 2600);
    },

    groupText(key, fallback = '') {
      return this.siteSettings?.group_chat?.[key] || fallback;
    },

    async loadGroups() {
      const r = await api.groupChats();
      const data = r?.data || r || {};
      this.groups = data.list || [];
      if (!this.current && this.groups.length) await this.openGroup(this.groups[0]);
    },

    async searchRoles() {
      const r = await api.exploreSearch({ q: this.query || '', page: 1, page_size: 24 });
      const data = r?.data || r || {};
      this.candidates = data.list || data.apps || data.items || [];
    },

    addRole(card) {
      if (!card?.id || this.selected.some(x => x.id === card.id)) return;
      if (this.selected.length >= 8) return this.showToast(this.groupText('max_roles_error', '一个群最多 8 个角色'), 'error');
      this.selected.push(card);
    },

    removeRole(id) {
      this.selected = this.selected.filter(x => x.id !== id);
    },

    async createGroup() {
      if (this.selected.length < 2) return this.showToast(this.groupText('min_roles_error', '至少选择 2 个角色'), 'error');
      this.busy = true;
      try {
        const r = await api.createGroupChat({
          name: this.groupName || this.selected.slice(0, 3).map(x => x.name).join('、'),
          app_ids: this.selected.map(x => x.id),
        });
        const data = r?.data || r || {};
        this.groups.unshift(data.group);
        this.selected = [];
        this.groupName = '';
        await this.openGroup(data.group);
        this.showToast(this.groupText('create_success', '群聊已创建'), 'success');
      } catch (err) {
        this.showToast(err.message || this.groupText('create_failed', '创建失败'), 'error');
      } finally {
        this.busy = false;
      }
    },

    async openGroup(group) {
      if (!group?.id) return;
      const r = await api.groupChat(group.id);
      const data = r?.data || r || {};
      this.current = data.group;
      this.messages = data.messages || [];
      this.$nextTick(() => this.scrollBottom());
    },

    async deleteGroup(group) {
      const tpl = this.groupText('delete_confirm_template', '删除群聊「{name}」？');
      if (!group?.id || !confirm(tpl.replace('{name}', group.name || ''))) return;
      await api.deleteGroupChat(group.id);
      this.groups = this.groups.filter(x => x.id !== group.id);
      if (this.current?.id === group.id) {
        this.current = null;
        this.messages = [];
      }
      this.showToast(this.groupText('delete_success', '已删除'), 'success');
    },

    async send() {
      if (!this.current?.id || !this.draft.trim() || this.busy) return;
      const content = this.draft.trim();
      this.draft = '';
      this.busy = true;
      try {
        const r = await api.sendGroupMessage(this.current.id, { content, auto_reply: true });
        const data = r?.data || r || {};
        this.current = data.group || this.current;
        this.messages = data.messages || this.messages;
        await this.loadGroups();
        this.$nextTick(() => this.scrollBottom());
      } catch (err) {
        this.showToast(err.message || this.groupText('send_failed', '发送失败'), 'error');
      } finally {
        this.busy = false;
      }
    },

    async replyAs(member) {
      if (!this.current?.id || !member?.app_id || this.busy) return;
      this.busy = true;
      try {
        const r = await api.groupReply(this.current.id, { app_id: member.app_id });
        const data = r?.data || r || {};
        this.current = data.group || this.current;
        this.messages = data.messages || this.messages;
        await this.loadGroups();
        this.$nextTick(() => this.scrollBottom());
      } catch (err) {
        this.showToast(err.message || this.groupText('reply_failed', '回复失败'), 'error');
      } finally {
        this.busy = false;
      }
    },

    scrollBottom() {
      const el = this.$refs.messages;
      if (el) el.scrollTop = el.scrollHeight;
    },
  };
}

window.groupChatPage = groupChatPage;
document.addEventListener('alpine:init', () => {
  if (window.Alpine?.data) window.Alpine.data('groupChatPage', groupChatPage);
});
