import { api, requireAuth, getCachedUser, setCachedUser, clearAuth, ApiError } from '/app/assets/js/app-core.js?v=20260905-notices-v1';
import { injectLayout, loadPublicSiteSettings } from '/app/assets/js/layout.js?v=20260905-notices-v1';
import { readPageCache, writePageCache } from './page-cache.js';

async function loadUser(ctx) {
  if (!requireAuth()) return false;
  const cached = getCachedUser();
  if (cached) ctx.user = cached;
  try {
    const [profileResult, pointsResult] = await Promise.allSettled([api.profile(), api.points()]);
    if (profileResult.status === 'rejected') throw profileResult.reason;
    const profile = profileResult.value;
    ctx.user = profile?.data || profile;
    setCachedUser(ctx.user);
    if (pointsResult.status === 'fulfilled') {
      const p = pointsResult.value;
      ctx.points = parseInt(p.points || p.data?.points || 0, 10);
    }
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 401) {
      clearAuth();
      location.replace('/app/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    }
    return false;
  }
}

async function loadSiteSettings(ctx) {
  ctx.siteSettings = await loadPublicSiteSettings().catch(() => null);
}

function siteText(ctx, section, key, fallback = '') {
  return ctx.siteSettings?.[section]?.[key] || fallback;
}

function emptyText(ctx, key, fallback = '') {
  return siteText(ctx, 'empty_states', key, fallback);
}

function appNavText(ctx, key, fallback = '') {
  return ctx.siteSettings?.app?.nav_labels?.[key] || fallback;
}

function appHomeText(ctx, key, fallback = '') {
  return siteText(ctx, 'app_home', key, fallback);
}

function myText(ctx, key, fallback = '') {
  return siteText(ctx, 'my_apps', key, fallback);
}

function chatText(ctx, key, fallback = '') {
  return siteText(ctx, 'chat', key, fallback);
}

function formatTemplate(template, values = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

export function favoritesPage() {
  return {
    user: null, points: 0, loading: false, cards: [], searchKeyword: '', siteSettings: null,
    async init() { injectLayout('favorites'); await loadSiteSettings(this); if (await loadUser(this)) await this.loadList(); },
    emptyText(key, fallback = '') { return emptyText(this, key, fallback); },
    appNavText(key, fallback = '') { return appNavText(this, key, fallback); },
    appHomeText(key, fallback = '') { return appHomeText(this, key, fallback); },
    async loadList() {
      this.loading = true;
      try {
        const r = await api.favorites({ page: 1, page_size: 60, q: this.searchKeyword });
        this.cards = r?.data?.apps || r?.data?.list || [];
      } finally { this.loading = false; }
    },
    async toggleFavorite(card, event) {
      if (event) event.preventDefault();
      const r = await api.toggleFavorite(card.id);
      if (!r?.data?.favorited) this.cards = this.cards.filter(c => c.id !== card.id);
    },
  };
}

export function historiesPage() {
  return {
    user: null, points: 0, loading: false, conversations: [], siteSettings: null,
    copyingId: '', deletingId: '', likingId: '', favoritingId: '',
    _listEpoch: 0,
    async init() {
      injectLayout('histories');
      if (!requireAuth()) return;
      this.user = getCachedUser();
      const cached = readPageCache('histories', this.user);
      if (Array.isArray(cached?.list)) this.conversations = cached.list.map(item => this.normalizeConversation(item));
      await Promise.allSettled([loadSiteSettings(this), loadUser(this), this.loadList()]);
    },
    emptyText(key, fallback = '') { return emptyText(this, key, fallback); },
    appNavText(key, fallback = '') { return appNavText(this, key, fallback); },
    chatText(key, fallback = '') { return chatText(this, key, fallback); },
    conversationHref(c) {
      const params = new URLSearchParams();
      if (c?.app_id) params.set('app_id', String(c.app_id));
      if (c?.id) params.set('conversation_id', String(c.id));
      return `/app/chat.html?${params}`;
    },
    conversationTitle(c) {
      return c?.app_name || c?.title || this.chatText('unnamed_conversation', '未命名会话');
    },
    conversationPreview(c) {
      return c?.last_message || c?.app_summary || this.chatText('continue_preview', '点击继续对话');
    },
    archiveLabel(c) {
      const count = Number(c?.archive_count || 1);
      return count > 1 ? `${count} 个存档` : '';
    },
    userTagList(c) {
      return Array.isArray(c?.user_tags) ? c.user_tags.slice(0, 4) : [];
    },
    likeLabel(c) {
      const count = Number(c?.like_count || 0);
      return `${c?.liked ? '已赞' : '点赞'}${count ? ` ${count}` : ''}`;
    },
    favoriteLabel(c) {
      return c?.favorited ? '已收藏' : '收藏';
    },
    patchConversation(id, patch) {
      const index = this.conversations.findIndex(item => item.id === id);
      if (index >= 0) this.conversations.splice(index, 1, { ...this.conversations[index], ...patch });
    },
    normalizeConversation(item) {
      return {
        ...item,
        favorited: !!item.favorited,
        liked: !!item.liked,
        like_count: Number(item.like_count || 0),
        user_tags: Array.isArray(item.user_tags) ? item.user_tags : [],
      };
    },
    groupConversations(list = []) {
      const groups = new Map();
      list.map(item => this.normalizeConversation(item)).forEach(item => {
        const key = item.app_id || item.id;
        const existing = groups.get(key);
        if (!existing) {
          groups.set(key, {
            ...item,
            archive_count: 1,
            archived_conversations: [item],
          });
          return;
        }
        existing.archive_count += 1;
        existing.archived_conversations.push(item);
        const existingTime = Number(existing.updated_at || existing.created_at || 0);
        const itemTime = Number(item.updated_at || item.created_at || 0);
        if (itemTime > existingTime) {
          groups.set(key, {
            ...existing,
            ...item,
            archive_count: existing.archive_count,
            archived_conversations: existing.archived_conversations,
          });
        }
      });
      return Array.from(groups.values());
    },
    async loadList() {
      const epoch = ++this._listEpoch;
      const owner = getCachedUser();
      this.loading = true;
      try {
        const r = await api.conversations();
        if (epoch !== this._listEpoch) return;
        this.conversations = (r?.data?.list || []).map(item => this.normalizeConversation(item));
        writePageCache('histories', owner, { list: this.conversations.slice(0, 100) });
      } finally { if (epoch === this._listEpoch) this.loading = false; }
    },
    async toggleLike(c, event) {
      if (event) event.preventDefault();
      if (!c?.app_id || this.likingId) return;
      this.likingId = c.id;
      try {
        const r = await api.toggleLike(c.app_id);
        this.patchConversation(c.id, {
          liked: !!r?.data?.liked,
          like_count: Number(r?.data?.like_count ?? c.like_count ?? 0),
        });
      } catch (err) {
        alert(err.message || '点赞失败');
      } finally {
        this.likingId = '';
      }
    },
    async toggleFavorite(c, event) {
      if (event) event.preventDefault();
      if (!c?.app_id || this.favoritingId) return;
      this.favoritingId = c.id;
      try {
        const r = await api.toggleFavorite(c.app_id);
        this.patchConversation(c.id, { favorited: !!r?.data?.favorited });
      } catch (err) {
        alert(err.message || '收藏失败');
      } finally {
        this.favoritingId = '';
      }
    },
    async copyConversation(c, event) {
      if (event) event.preventDefault();
      if (!c?.id || this.copyingId) return;
      this.copyingId = c.id;
      try {
        const r = await api.copyConversation(c.id);
        const copied = r?.data?.conversation || r?.conversation;
        await this.loadList();
        if (copied?.id) location.href = this.conversationHref(copied);
      } catch (err) {
        alert(err.message || this.chatText('copy_failed_text', '复制失败'));
      } finally {
        this.copyingId = '';
      }
    },
    async deleteConversation(c, event) {
      if (event) event.preventDefault();
      if (!c?.id || this.deletingId) return;
      if (!confirm(this.chatText('delete_conversation_confirm', '删除这个对话？聊天记录将无法恢复。'))) return;
      this.deletingId = c.id;
      try {
        await api.deleteConversation(c.id);
        await this.loadList();
      } catch (err) {
        alert(err.message || this.chatText('delete_failed_text', '删除失败'));
      } finally {
        this.deletingId = '';
      }
    },
  };
}

export function workshopPage() {
  return {
    user: null, points: 0, stats: null, myApps: [], myTotal: 0, siteSettings: null, ready: false,
    creatorLeaderboard: [], creatorContest: null,
    async init() {
      injectLayout('workshop');
      try {
        await loadSiteSettings(this);
        if (!(await loadUser(this))) return;
        const [s, m, contests, leaderboard] = await Promise.all([
          api.homeStats().catch(() => null),
          api.myApps({ page: 1, page_size: 8 }).catch(() => null),
          api.creatorContests().catch(() => null),
          api.creatorLeaderboard({ limit: 10 }).catch(() => null),
        ]);
        this.stats = s?.data || null;
        this.myApps = m?.data?.list || [];
        this.myTotal = m?.data?.total ?? this.myApps.length;
        this.creatorContest = contests?.data?.contest || contests?.contest || null;
        this.creatorLeaderboard = leaderboard?.data?.list || contests?.data?.leaderboard || [];
      } finally {
        this.ready = true;
      }
    },
    get publicCount() {
      return this.myApps.filter((a) => a?.is_public !== false).length;
    },
    get libraryTotal() {
      return (this.stats?.apps?.total || 0).toLocaleString('zh-CN');
    },
    medalClass(index) {
      return index === 0 ? 'is-gold' : index === 1 ? 'is-silver' : index === 2 ? 'is-bronze' : '';
    },
    emptyText(key, fallback = '') { return emptyText(this, key, fallback); },
    appNavText(key, fallback = '') { return appNavText(this, key, fallback); },
    myText(key, fallback = '') { return myText(this, key, fallback); },
    syncedLibraryText() {
      const prefix = this.emptyText('workshop_library_prefix', '已同步');
      const suffix = this.emptyText('workshop_library_suffix', '张卡');
      return `${prefix} ${this.stats?.apps?.total || 0} ${suffix}`;
    },
    creatorName(row) {
      return row?.user_name || '惑梦创作者';
    },
    creatorScore(row) {
      return Number(row?.score || 0).toLocaleString('zh-CN');
    },
    contestMetricText() {
      const list = Array.isArray(this.creatorContest?.metrics) ? this.creatorContest.metrics : [];
      return list.join(' / ');
    },
  };
}

export function imageChatPage() {
  return {
    user: null, points: 0, prompt: '', filename: '', previewName: '', sending: false, replies: [], siteSettings: null,
    async init() { injectLayout('image'); await loadSiteSettings(this); await loadUser(this); },
    emptyText(key, fallback = '') { return emptyText(this, key, fallback); },
    appNavText(key, fallback = '') { return appNavText(this, key, fallback); },
    pickFile(e) {
      const f = e?.target?.files?.[0];
      this.filename = f ? f.name : '';
      this.previewName = this.filename;
    },
    async send() {
      if ((!this.prompt.trim() && !this.filename) || this.sending) return;
      this.sending = true;
      try {
        const r = await api.imageChat({ prompt: this.prompt.trim(), filename: this.filename });
        this.replies.unshift(r?.data || {});
        this.prompt = '';
        this.filename = '';
        this.previewName = '';
      } finally { this.sending = false; }
    },
  };
}

export function rewardsPage() {
  const pendingOrderKey = 'homer_zpay_pending_order';
  return {
    user: null,
    points: 0,
    balance: { free_points: 0, paid_points: 0, reward_points: 0, points: 0 },
    rewards: null,
    deposit: null,
    redeemInput: '',
    redemptions: [],
    message: '',
    messageType: 'info',
    busy: false,
    selectedPlan: null,
    paymentMode: 'plan',
    customAmountInput: '',
    customAmountError: '',
    payType: '',
    currentOrder: null,
    paymentOrders: [],
    paymentOrdersTotal: 0,
    paymentOrdersPage: 1,
    paymentOrdersPageSize: 20,
    paymentOrdersLoading: false,
    showAllPaymentOrders: false,
    refreshingOrderNo: '',
    orderPollingTimer: null,
    orderPollCount: 0,
    siteSettings: null,
    async init() {
      injectLayout('rewards');
      await loadSiteSettings(this);
      if (await loadUser(this)) {
        await Promise.all([this.loadRewards(), this.loadRedemptions(), this.loadPaymentOrders()]);
        await this.restorePaymentOrder();
      }
    },
    destroy() {
      this.stopOrderPolling();
    },
    setMessage(text, type = 'info') {
      this.message = text;
      this.messageType = type;
      if (text) setTimeout(() => { if (this.message === text) this.message = ''; }, 3200);
    },
    emptyText(key, fallback = '') { return emptyText(this, key, fallback); },
    depositText(key, fallback = '') { return this.deposit?.[key] || siteText(this, 'deposit', key, fallback); },
    dashboardText(key, fallback = '') { return siteText(this, 'dashboard', key, fallback); },
    rewardsText(key, fallback = '') { return siteText(this, 'rewards', key, fallback); },
    paymentAvailable() {
      return !!(this.deposit?.payment_available && this.deposit?.mode !== 'closed');
    },
    onlinePaymentAvailable() {
      return !!(this.paymentAvailable() && this.deposit?.payment_create_url && this.availablePayTypes().some(item => item.id === 'alipay'));
    },
    safeAifadianUrl() {
      try {
        const url = new URL(String(this.deposit?.aifadian_url || ''));
        const host = url.hostname.toLowerCase();
        const allowed = host === 'ifdian.net' || host.endsWith('.ifdian.net') || host === 'afdian.com' || host.endsWith('.afdian.com');
        if (url.protocol !== 'https:' || !allowed || (url.port && url.port !== '443')) return '';
        return url.href;
      } catch {
        return '';
      }
    },
    aifadianAvailable() {
      return !!this.safeAifadianUrl();
    },
    normalizeBalance(data) {
      const b = data?.balance || data || {};
      return {
        free_points: parseInt(b.free_points || 0, 10),
        paid_points: parseInt(b.paid_points || b.normal_points || b.regular_points || 0, 10),
        reward_points: parseInt(b.reward_points || 0, 10),
        points: parseInt(b.points || b.total_points || 0, 10),
      };
    },
    async loadRewards() {
      const r = await api.rewards();
      this.rewards = r?.data || {};
      this.deposit = this.rewards.deposit || null;
      const payTypes = this.availablePayTypes();
      const requestedDefault = String(this.deposit?.default_pay_type || 'alipay').toLowerCase();
      const defaultMethod = payTypes.find(item => item.id === 'alipay')
        || payTypes.find(item => item.id === requestedDefault)
        || payTypes[0];
      if (!payTypes.some(item => item.id === this.payType)) this.payType = defaultMethod?.id || '';
      this.balance = this.normalizeBalance(this.rewards.balance || this.rewards);
      this.points = this.balance.points;
    },
    async loadRedemptions() {
      const r = await api.redemptions({ page: 1, page_size: 20 }).catch(() => null);
      this.redemptions = r?.data?.list || [];
    },
    async loadPaymentOrders(append = false) {
      if (this.paymentOrdersLoading) return;
      this.paymentOrdersLoading = true;
      try {
        const page = append ? this.paymentOrdersPage + 1 : 1;
        const response = await api.paymentOrders({ page, page_size: this.paymentOrdersPageSize });
        const data = response?.data || {};
        const incoming = Array.isArray(data.list) ? data.list.map(item => this.normalizeOrder(item, item)) : [];
        if (append) {
          const known = new Set(this.paymentOrders.map(item => item.order_no));
          this.paymentOrders.push(...incoming.filter(item => !known.has(item.order_no)));
        } else {
          this.paymentOrders = incoming;
        }
        this.paymentOrdersPage = page;
        const parsedTotal = parseInt(data.total, 10);
        this.paymentOrdersTotal = Number.isFinite(parsedTotal) ? parsedTotal : this.paymentOrders.length;
      } catch (err) {
        this.setMessage(err.message || '支付订单加载失败', 'error');
      } finally {
        this.paymentOrdersLoading = false;
      }
    },
    visiblePaymentOrders() {
      return this.showAllPaymentOrders ? this.paymentOrders : this.paymentOrders.slice(0, 5);
    },
    async toggleOrLoadMoreOrders() {
      if (!this.showAllPaymentOrders) {
        this.showAllPaymentOrders = true;
        return;
      }
      if (this.paymentOrders.length < this.paymentOrdersTotal) {
        await this.loadPaymentOrders(true);
        return;
      }
      this.showAllPaymentOrders = false;
    },
    paymentOrdersMoreText() {
      if (!this.showAllPaymentOrders) return `查看全部 ${this.paymentOrdersTotal} 笔订单`;
      if (this.paymentOrders.length < this.paymentOrdersTotal) {
        return `加载更多（已显示 ${this.paymentOrders.length}/${this.paymentOrdersTotal}）`;
      }
      return '收起订单';
    },
    focusPayment() {
      const firstPlan = (this.deposit?.packages || [])[0] || (this.deposit?.subscriptions || [])[0] || null;
      if (firstPlan && !this.selectedPlan && (this.paymentMode !== 'custom' || this.customAmountCny() === null)) {
        this.paymentMode = 'plan';
        this.selectedPlan = firstPlan;
      }
      this.$nextTick(() => document.getElementById('payment-checkout')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    },
    selectPlan(item) {
      if (!this.onlinePaymentAvailable()) {
        this.setMessage(this.paymentNote(), 'error');
        return;
      }
      this.paymentMode = 'plan';
      this.selectedPlan = item || null;
      this.customAmountError = '';
      this.focusPayment();
    },
    customAmountLimits() {
      const min = Number(this.deposit?.custom_amount_min_cny || 1);
      const max = Number(this.deposit?.custom_amount_max_cny || 5000);
      const safeMin = Number.isFinite(min) && min > 0 ? min : 1;
      return {
        min: safeMin,
        max: Number.isFinite(max) && max >= safeMin ? max : 5000,
      };
    },
    customAmountErrorText() {
      const { min, max } = this.customAmountLimits();
      return `请输入 ¥${min.toFixed(2)}～¥${max.toFixed(2)}，最多两位小数`;
    },
    customAmountRangeText() {
      const { min, max } = this.customAmountLimits();
      return `¥${min.toFixed(2)}～¥${max.toFixed(2)} · 最多两位小数`;
    },
    customAmountCny() {
      const raw = String(this.customAmountInput || '').trim();
      if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
      const amount = Number(raw);
      const { min, max } = this.customAmountLimits();
      if (!Number.isFinite(amount) || amount < min || amount > max) return null;
      return Number(amount.toFixed(2));
    },
    customPointsEstimate() {
      const amount = this.customAmountCny();
      const rate = Number(this.deposit?.points_per_cny || 1000);
      return amount === null ? 0 : Math.round(amount * (Number.isFinite(rate) && rate > 0 ? rate : 1000));
    },
    onCustomAmountInput() {
      this.paymentMode = 'custom';
      this.selectedPlan = null;
      const raw = String(this.customAmountInput || '').trim();
      this.customAmountError = raw && this.customAmountCny() === null ? this.customAmountErrorText() : '';
    },
    selectCustomAmount(scroll = true) {
      this.paymentMode = 'custom';
      this.selectedPlan = null;
      const amount = this.customAmountCny();
      if (amount === null) {
        this.customAmountError = this.customAmountErrorText();
        return false;
      }
      this.customAmountError = '';
      if (scroll) this.focusPayment();
      return true;
    },
    paymentSelectionReady() {
      return this.paymentMode === 'custom' ? this.customAmountCny() !== null : !!this.selectedPlan?.id;
    },
    paymentSelectionLabel() {
      if (this.paymentMode === 'custom') {
        const amount = this.customAmountCny();
        return amount === null ? '' : `自定义充值 · ¥${amount.toFixed(2)}`;
      }
      return this.selectedPlan ? `${this.selectedPlan.label || this.selectedPlan.id} · ¥${this.selectedPlan.price_cny}` : '';
    },
    openAifadian() {
      const url = this.safeAifadianUrl();
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else this.setMessage('爱发电购买链接暂不可用', 'error');
    },
    paymentNote() {
      if (this.onlinePaymentAvailable()) {
        return this.deposit?.payment_note_available || '在线支付宝支付成功后自动到账；爱发电卡密仍可在本页兑换。';
      }
      if (this.aifadianAvailable()) return '可前往爱发电购买卡密，并在本页兑换到账。';
      return this.deposit?.payment_note_unavailable || '充值通道暂时关闭，恢复后会重新开放购买和兑换。';
    },
    availablePayTypes() {
      const labels = { alipay: '支付宝', wxpay: '微信支付' };
      const raw = Array.isArray(this.deposit?.pay_type_options) && this.deposit.pay_type_options.length
        ? this.deposit.pay_type_options
        : (Array.isArray(this.deposit?.pay_types) ? this.deposit.pay_types : ['alipay']);
      return raw.map(item => {
        const id = String(typeof item === 'string' ? item : (item?.id || item?.type || '')).toLowerCase();
        return {
          id,
          label: typeof item === 'object' && item?.label ? String(item.label) : labels[id],
          enabled: typeof item !== 'object' || item?.enabled !== false,
        };
      }).filter(item => item.enabled && item.label && ['alipay', 'wxpay'].includes(item.id));
    },
    selectPayType(id) {
      if (this.availablePayTypes().some(item => item.id === id)) this.payType = id;
    },
    payTypeLabel(value) {
      const id = String(value || '').toLowerCase();
      return this.availablePayTypes().find(item => item.id === id)?.label
        || ({ alipay: '支付宝', wxpay: '微信支付' }[id] || '在线支付');
    },
    paymentAmountCny() {
      if (this.paymentMode === 'custom') return this.customAmountCny();
      const amount = Number(this.selectedPlan?.price_cny);
      return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : null;
    },
    paymentPointsEstimate() {
      if (this.paymentMode === 'custom') return this.customPointsEstimate();
      return Math.max(0, parseInt(this.selectedPlan?.points || 0, 10));
    },
    paymentSubmitText() {
      const amount = this.paymentAmountCny();
      return amount === null ? '确认支付' : `确认支付 ¥${amount.toFixed(2)}`;
    },
    safeZpayUrl(value) {
      try {
        const url = new URL(String(value || ''));
        if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'zpayz.cn' || (url.port && url.port !== '443')) return '';
        return url.href;
      } catch {
        return '';
      }
    },
    normalizeOrder(data = {}, base = null) {
      const prior = base || (data?.order_no && data.order_no === this.currentOrder?.order_no ? this.currentOrder : {});
      const orderNo = String(data.order_no || data.out_trade_no || prior?.order_no || '');
      return {
        ...(prior || {}),
        ...data,
        order_no: orderNo,
        status: String(data.status || prior?.status || 'pending').toLowerCase(),
        amount_cny: data.amount_cny ?? data.money ?? prior?.amount_cny ?? null,
        pay_url: this.safeZpayUrl(data.pay_url) || this.safeZpayUrl(prior?.pay_url),
      };
    },
    upsertPaymentOrder(order) {
      if (!order?.order_no) return;
      const index = this.paymentOrders.findIndex(item => item.order_no === order.order_no);
      if (index >= 0) this.paymentOrders.splice(index, 1, order);
      else {
        this.paymentOrders.unshift(order);
        this.paymentOrdersTotal += 1;
      }
    },
    orderPaid(order = this.currentOrder) {
      return ['paid', 'success', 'completed', 'trade_success'].includes(String(order?.status || '').toLowerCase());
    },
    orderPending(order = this.currentOrder) {
      return ['pending', 'created', 'paying', 'unpaid', 'waiting'].includes(String(order?.status || 'pending').toLowerCase());
    },
    orderStatusText(order = this.currentOrder) {
      const status = String(order?.status || '').toLowerCase();
      if (this.orderPaid(order)) return '支付成功，已到账';
      if (['closed', 'cancelled', 'canceled', 'failed', 'expired'].includes(status)) return '订单已关闭';
      return '等待支付';
    },
    orderStatusClass(order) {
      if (this.orderPaid(order)) return 'is-paid';
      return this.orderPending(order) ? 'is-pending' : 'is-closed';
    },
    pendingOrderStorageKey() {
      const userId = String(this.user?.id || this.user?.email || 'anonymous');
      return `${pendingOrderKey}:${userId}`;
    },
    savePendingOrder(order) {
      try { localStorage.setItem(this.pendingOrderStorageKey(), JSON.stringify(order)); } catch {}
    },
    clearPendingOrder() {
      try { localStorage.removeItem(this.pendingOrderStorageKey()); } catch {}
    },
    async createPayment() {
      if (!this.onlinePaymentAvailable() || this.busy) return;
      const isCustom = this.paymentMode === 'custom';
      const amountCny = isCustom ? this.customAmountCny() : null;
      if (isCustom && amountCny === null) {
        this.selectCustomAmount(false);
        this.setMessage(this.customAmountError, 'error');
        return;
      }
      if (!isCustom && !this.selectedPlan?.id) {
        this.setMessage('请先选择一个充值套餐', 'error');
        return;
      }
      if (!this.availablePayTypes().some(item => item.id === this.payType)) {
        this.setMessage('请选择当前可用的支付方式', 'error');
        return;
      }
      this.busy = true;
      try {
        const response = await api.createPaymentOrder(isCustom ? '' : this.selectedPlan.id, this.payType, amountCny);
        const order = this.normalizeOrder(response?.data || response || {});
        if (!order.order_no) throw new Error('支付订单创建失败：缺少订单号');
        if (!order.pay_url) throw new Error('支付地址校验失败，请稍后重试');
        this.currentOrder = order;
        this.upsertPaymentOrder(order);
        this.savePendingOrder(order);
        this.setMessage('订单已创建，正在前往安全支付页面', 'success');
        window.location.assign(order.pay_url);
      } catch (err) {
        this.setMessage(err.message || '创建支付订单失败', 'error');
      } finally {
        this.busy = false;
      }
    },
    async restorePaymentOrder() {
      const params = new URLSearchParams(location.search);
      const returnedOrderNo = params.get('order_no') || params.get('out_trade_no') || '';
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(this.pendingOrderStorageKey()) || 'null'); } catch {}
      const orderNo = returnedOrderNo || saved?.order_no || '';
      if (!orderNo) return;
      this.currentOrder = this.normalizeOrder({ ...(saved || {}), order_no: orderNo });
      const refreshed = await this.refreshPaymentOrder(true);
      if (refreshed && this.orderPending()) this.startOrderPolling();
    },
    async refreshPaymentOrder(silent = false) {
      const orderNo = this.currentOrder?.order_no;
      if (!orderNo) return;
      try {
        const response = await api.paymentOrder(orderNo);
        this.currentOrder = this.normalizeOrder(response?.data || response || {});
        this.upsertPaymentOrder(this.currentOrder);
        if (this.orderPaid()) {
          this.stopOrderPolling();
          this.clearPendingOrder();
          await Promise.all([this.loadRewards(), this.loadPaymentOrders()]);
          this.setMessage('支付成功，惑梦币已自动到账', 'success');
        } else if (this.orderPending()) {
          this.savePendingOrder(this.currentOrder);
          if (!silent) this.setMessage('订单仍在等待支付', 'info');
        } else {
          this.stopOrderPolling();
          this.clearPendingOrder();
          if (!silent) this.setMessage(this.orderStatusText(), 'error');
        }
        return true;
      } catch (err) {
        if (!silent) this.setMessage(err.message || '查询订单失败', 'error');
        return false;
      }
    },
    startOrderPolling() {
      this.stopOrderPolling();
      this.orderPollCount = 0;
      this.orderPollingTimer = setInterval(async () => {
        this.orderPollCount += 1;
        await this.refreshPaymentOrder(true);
        if (this.orderPollCount >= 20) this.stopOrderPolling();
      }, 3000);
    },
    stopOrderPolling() {
      if (this.orderPollingTimer) clearInterval(this.orderPollingTimer);
      this.orderPollingTimer = null;
    },
    continuePayment() {
      const url = this.safeZpayUrl(this.currentOrder?.pay_url);
      if (url) window.location.assign(url);
      else this.setMessage('原支付链接不可用，请重新选择套餐创建订单', 'error');
    },
    async continueOrderPayment(order) {
      if (!order?.order_no) return;
      this.currentOrder = this.normalizeOrder(order, order);
      let url = this.safeZpayUrl(this.currentOrder.pay_url);
      if (!url) {
        try {
          const response = await api.paymentOrder(order.order_no);
          this.currentOrder = this.normalizeOrder(response?.data || response || {}, this.currentOrder);
          this.upsertPaymentOrder(this.currentOrder);
          url = this.safeZpayUrl(this.currentOrder.pay_url);
        } catch (err) {
          this.setMessage(err.message || '支付订单查询失败', 'error');
          return;
        }
      }
      if (url) window.location.assign(url);
      else this.setMessage('该订单当前无法继续支付，请重新创建订单', 'error');
    },
    async refreshOrderItem(order) {
      if (!order?.order_no || this.refreshingOrderNo) return;
      this.refreshingOrderNo = order.order_no;
      this.currentOrder = this.normalizeOrder(order, order);
      try {
        await this.refreshPaymentOrder(false);
      } finally {
        this.refreshingOrderNo = '';
      }
    },
    async redeemNow() {
      if (!this.paymentAvailable()) {
        this.setMessage(this.paymentNote(), 'error');
        return;
      }
      const code = String(this.redeemInput || '').trim();
      if (!code || this.busy) {
        this.setMessage(this.dashboardText('redeem_empty_text', '请输入兑换码'), 'error');
        return;
      }
      this.busy = true;
      try {
        const r = await api.redeemCode(code);
        const data = r?.data || {};
        this.balance = this.normalizeBalance(data.balance || {});
        this.points = this.balance.points;
        this.redeemInput = '';
        this.setMessage(
          formatTemplate(this.dashboardText('redeem_success_detail_template', '兑换成功，到账 {points} 惑梦币'), { points: data.points_added || 0 }),
          'success',
        );
        await Promise.all([this.loadRewards(), this.loadRedemptions()]);
      } catch (err) {
        this.setMessage(err.message || this.dashboardText('redeem_failed_text', '兑换失败'), 'error');
      } finally {
        this.busy = false;
      }
    },
    packagePoints(pkg) {
      return Number(pkg?.points || 0).toLocaleString('zh-CN');
    },
    bestPackageId() {
      let best = null;
      for (const p of (this.deposit?.packages || [])) {
        if (Number(p?.bonus_rate || 0) > 0 && (!best || Number(p.bonus_rate) > Number(best.bonus_rate))) best = p;
      }
      return best?.id || '';
    },
    isBestPlan(pkg) {
      const id = this.bestPackageId();
      return !!id && pkg?.id === id;
    },
    dailyPoints() {
      return parseInt(this.rewards?.daily?.points || 10, 10);
    },
    dailyClaimText() {
      if (this.rewards?.daily?.claimed) return this.rewardsText('daily_claimed_text', '今日已领取');
      return formatTemplate(this.rewardsText('daily_claim_template', '领取 +{points}'), { points: this.dailyPoints() });
    },
    formatTime(ts) {
      if (!ts) return '-';
      return new Date(ts > 1e12 ? ts : ts * 1000).toLocaleString('zh-CN', { hour12: false });
    },
    async claimDaily() {
      if (this.busy) return;
      this.busy = true;
      try {
        const r = await api.claimDailyReward();
        if (r?.data?.balance) this.balance = this.normalizeBalance(r.data.balance);
        if (r?.data) this.points = parseInt(r.data.points || this.balance.points || this.points, 10);
        await this.loadRewards();
        const added = parseInt(r?.data?.points_added || 0, 10);
        this.setMessage(
          added > 0
            ? formatTemplate(this.dashboardText('checkin_reward_success_template', '今日奖励已领取，到账 {points} 惑梦币'), { points: added })
            : this.dashboardText('checkin_repeat_text', '今日已经签到过了'),
          added > 0 ? 'success' : 'info',
        );
      } catch (err) {
        this.setMessage(err.message || this.dashboardText('claim_failed_text', '领取失败'), 'error');
      } finally { this.busy = false; }
    },
  };
}

export function logsPage() {
  return {
    user: null, points: 0, loading: false, logs: [], siteSettings: null,
    async init() { injectLayout('logs'); await loadSiteSettings(this); if (await loadUser(this)) await this.loadList(); },
    emptyText(key, fallback = '') { return emptyText(this, key, fallback); },
    appNavText(key, fallback = '') { return appNavText(this, key, fallback); },
    dashboardText(key, fallback = '') { return siteText(this, 'dashboard', key, fallback); },
    async loadList() {
      this.loading = true;
      try {
        const r = await api.logs({ page: 1, page_size: 80 });
        this.logs = r?.data?.list || [];
      } finally { this.loading = false; }
    },
  };
}

export function infoPage() {
  return {
    user: null, points: 0, stats: null, siteSettings: null, ready: false,
    async init() {
      injectLayout('info');
      try {
        if (!(await loadUser(this))) return;
        const [s, settings] = await Promise.all([
          api.homeStats().catch(() => null),
          loadPublicSiteSettings().catch(() => null),
        ]);
        this.stats = s?.data || null;
        this.siteSettings = settings || null;
      } finally {
        this.ready = true;
      }
    },
    infoValue(key, fallback = '') {
      return this.siteSettings?.app?.[key] || fallback;
    },
  };
}

window.favoritesPage = favoritesPage;
window.historiesPage = historiesPage;
window.workshopPage = workshopPage;
window.imageChatPage = imageChatPage;
window.rewardsPage = rewardsPage;
window.logsPage = logsPage;
window.infoPage = infoPage;
