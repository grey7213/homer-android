// 惑梦（Homer） 用户面板 Alpine.js 应用
import { api, getToken, setToken, clearAuth, isLoggedIn, getCachedUser, setCachedUser, formatDateTime, ApiError } from '/assets/js/api.js?v=20260905-notices-v1';

function dashboard() {
  return {
    view: 'login',
    loading: false,
    toast: null,
    toastTimer: null,
    loggedIn: false,
    user: null,
    points: null,
    balance: { free_points: 0, paid_points: 0, reward_points: 0, points: 0 },
    deposit: null,
    lastRefreshed: null,
    isAdmin: false,
    loginForm: { email: '', password: '' },
    registerForm: { email: '', code: '', name: '', password: '' },
    redeemCode: '',
    sendingCode: false,
    codeCountdown: 0,
    countdownTimer: null,
    siteSettings: null,

    async init() {
      await this.loadSiteSettings();
      // 登录凭证已迁移到 HttpOnly Cookie，改用非敏感登录标记判断。
      if (isLoggedIn()) {
        const cached = getCachedUser();
        if (cached) this.user = cached;
        await this.loadProfile();
      }
    },

    async loadSiteSettings() {
      try {
        const r = await api.siteSettings();
        this.siteSettings = r?.data || r || null;
        this.applyStaticDashboardCopy();
      } catch {
        this.siteSettings = null;
      }
    },

    applyStaticDashboardCopy() {
      if (!this.siteSettings || typeof document === 'undefined') return;
      document.querySelectorAll('[data-dashboard-text]').forEach(el => {
        const path = String(el.getAttribute('data-dashboard-text') || '').split('.');
        if (path.length !== 2) return;
        const value = this.siteSettings?.[path[0]]?.[path[1]];
        if (value) el.textContent = value;
      });
    },

    siteText(section, key, fallback = '') {
      return this.siteSettings?.[section]?.[key] || fallback;
    },

    authText(key, fallback = '') {
      return this.siteText('auth', key, fallback);
    },

    dashboardText(key, fallback = '') {
      return this.siteText('dashboard', key, fallback);
    },

    depositText(key, fallback = '') {
      return this.deposit?.[key] || this.siteText('deposit', key, fallback);
    },

    paymentAvailable() {
      return !!(this.deposit?.payment_available && this.deposit?.mode !== 'closed');
    },

    formatTemplate(template, values = {}) {
      return String(template || '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
    },

    paymentNote() {
      return this.paymentAvailable()
        ? this.depositText('payment_note_available', '兑换码只能使用一次，请确认当前登录账号。')
        : this.depositText('payment_note_unavailable', '充值通道暂时关闭，恢复后会重新开放购买和兑换。');
    },

    showToast(message, type = 'info', duration = 2800) {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toast = { message, type };
      this.toastTimer = setTimeout(() => { this.toast = null; }, duration);
    },

    formatDate(ts) {
      if (!ts) return '-';
      return formatDateTime(ts).split(' ')[0];
    },

    formatTime(ts) {
      if (!ts) return '-';
      return formatDateTime(ts);
    },

    async loadProfile() {
      try {
        const profile = await api.profile();
        this.user = profile;
        setCachedUser(profile);
        this.loggedIn = true;
        await this.refreshPoints();
        await this.checkAdmin();
      } catch (err) {
        if (err instanceof ApiError && err.code === 401) {
          clearAuth();
          this.loggedIn = false;
          this.isAdmin = false;
          this.syncStore();
        } else {
          this.showToast(err.message || '加载用户信息失败', 'error');
        }
      }
    },

    async checkAdmin() {
      // 静默探测 - 普通用户会得到 403，不显示报错
      try {
        await api.admin.whoami();
        this.isAdmin = true;
      } catch (err) {
        this.isAdmin = false;
      }
      this.syncStore();
    },

    syncStore() {
      // 同步管理员状态到 Alpine 全局 store，供顶栏读取
      if (window.Alpine && window.Alpine.store) {
        const profileAdmin = !!(this.user?.is_admin || this.user?.is_env_admin || this.user?.role === 'admin');
        window.Alpine.store('user', { isAdmin: this.isAdmin || profileAdmin, loggedIn: this.loggedIn });
      }
    },

    async refreshPoints() {
      try {
        const result = await api.credits().catch(() => api.points());
        const data = result.data || result;
        this.balance = this.normalizeBalance(data.balance || data);
        this.deposit = data.deposit || this.deposit;
        this.points = this.balance.points;
        this.lastRefreshed = Date.now();
      } catch (err) {
        this.showToast(this.dashboardText('points_failed_text', '获取积分失败'), 'error');
      }
    },

    normalizeBalance(data) {
      const b = data || {};
      return {
        free_points: parseInt(b.free_points || 0, 10),
        paid_points: parseInt(b.paid_points || b.normal_points || b.regular_points || 0, 10),
        reward_points: parseInt(b.reward_points || 0, 10),
        points: parseInt(b.points || b.total_points || 0, 10),
      };
    },

    openPayments() {
      if (this.paymentAvailable()) {
        window.location.href = '/app/rewards.html';
      } else {
        this.showToast(this.depositText('support_text', this.dashboardText('payment_missing_text', '充值通道暂时关闭')), 'error');
      }
    },

    async doLogin() {
      this.loading = true;
      try {
        const result = await api.login(this.loginForm.email.trim(), this.loginForm.password);
        const token = result.data || result;
        if (typeof token !== 'string') throw new Error(this.authText('login_invalid_response_text', '登录响应无效'));
        setToken(token);
        this.showToast(this.authText('login_success_text', '登录成功'), 'success');
        await this.loadProfile();
      } catch (err) {
        this.showToast(err.message || this.authText('login_failed_text', '登录失败'), 'error');
      } finally {
        this.loading = false;
      }
    },

    async sendCode() {
      const email = this.registerForm.email.trim();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        this.showToast(this.authText('invalid_email_text', '请输入正确的邮箱地址'), 'error');
        return;
      }
      this.sendingCode = true;
      try {
        await api.sendEmailCode(email);
        this.showToast(this.authText('code_sent_text', '验证码已发送，请查收邮件'), 'success');
        this.codeCountdown = 60;
        this.countdownTimer = setInterval(() => {
          this.codeCountdown--;
          if (this.codeCountdown <= 0) clearInterval(this.countdownTimer);
        }, 1000);
      } catch (err) {
        this.showToast(err.message || this.authText('send_failed_text', '发送失败'), 'error');
      } finally {
        this.sendingCode = false;
      }
    },

    async doRegister() {
      this.loading = true;
      try {
        const result = await api.register(
          this.registerForm.email.trim(),
          this.registerForm.password,
          this.registerForm.code.trim(),
          this.registerForm.name.trim(),
        );
        const token = result.data || result;
        if (typeof token !== 'string') throw new Error(this.authText('register_invalid_response_text', '注册响应无效'));
        setToken(token);
        this.showToast(this.authText('register_success_text', '注册成功，欢迎来到 惑梦（Homer）'), 'success');
        await this.loadProfile();
      } catch (err) {
        this.showToast(err.message || this.authText('register_failed_text', '注册失败'), 'error');
      } finally {
        this.loading = false;
      }
    },

    async doLogout() {
      // 先请求后端清除 HttpOnly 登录 Cookie，再清理本地标记
      try { await api.logout(); } catch {}
      clearAuth();
      this.loggedIn = false;
      this.user = null;
      this.points = null;
      this.isAdmin = false;
      this.syncStore();
      this.loginForm = { email: '', password: '' };
      this.showToast(this.dashboardText('logout_success_text', '已退出登录'), 'info');
    },

    async redeemNow() {
      if (!this.paymentAvailable()) {
        this.showToast(this.paymentNote(), 'error');
        return;
      }
      const code = String(this.redeemCode || '').trim();
      if (!code) {
        this.showToast(this.dashboardText('redeem_empty_text', '请输入兑换码'), 'error');
        return;
      }
      this.loading = true;
      try {
        const result = await api.redeemCode(code);
        const data = result.data || result;
        this.balance = this.normalizeBalance(data.balance || {});
        this.points = this.balance.points;
        this.redeemCode = '';
        this.lastRefreshed = Date.now();
        this.showToast(this.formatTemplate(this.dashboardText('redeem_success_template', '兑换成功 +{points} 惑梦币'), { points: data.points_added || 0 }), 'success');
      } catch (err) {
        this.showToast(err.message || this.dashboardText('redeem_failed_text', '兑换失败'), 'error');
      } finally {
        this.loading = false;
      }
    },

  };
}

window.dashboard = dashboard;

// Alpine.js 在 init 事件中正式启动前注册数据函数
document.addEventListener('alpine:init', () => {
  if (window.Alpine && typeof window.Alpine.data === 'function') {
    window.Alpine.data('dashboard', dashboard);
  }
  if (window.Alpine && typeof window.Alpine.store === 'function') {
    // 默认未登录、非管理员，loadProfile/checkAdmin 会通过 syncStore() 更新
    window.Alpine.store('user', { isAdmin: false, loggedIn: false });
  }
});
