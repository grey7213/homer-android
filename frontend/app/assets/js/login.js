import { api, setToken, clearAuth, isLoggedIn, ApiError } from '/app/assets/js/app-core.js?v=20260717-handoff-merge';
import { loadPublicSiteSettings } from '/app/assets/js/layout.js?v=20260901-persistent-pages';

function safeNextPath() {
  const value = new URLSearchParams(location.search).get('next') || '/app/';
  try {
    const target = new URL(value, location.origin);
    if (target.origin === location.origin && target.pathname.startsWith('/app/')) {
      return target.pathname + target.search + target.hash;
    }
  } catch {}
  return '/app/';
}

async function publicPost(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch {
    throw new ApiError('网络请求失败，请检查网络连接', 0, null);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new ApiError((data && (data.message || data.msg)) || `HTTP ${response.status}`, response.status, data);
  }
  if (data && data.result === 'failure') {
    throw new ApiError(data.message || data.msg || '请求失败', parseInt(data.code) || response.status, data);
  }
  if (data && typeof data.code === 'number' && data.code !== 0 && data.msg) {
    throw new ApiError(data.msg, data.code, data);
  }
  return data;
}

function sendPasswordResetCode(email) {
  if (typeof api?.sendPasswordResetCode === 'function') {
    return api.sendPasswordResetCode(email);
  }
  return publicPost('/console/api/password-reset/email', { email, lang: 'zh-Hans' });
}

function resetPassword(email, password, code) {
  if (typeof api?.resetPassword === 'function') {
    return api.resetPassword(email, password, code);
  }
  return publicPost('/console/api/password-reset', { email, password, code });
}

function loginPage() {
  return {
    view: 'login',
    loading: false,
    toast: null,
    toastTimer: null,
    loginForm: { email: '', password: '' },
    registerForm: { email: '', code: '', name: '', password: '' },
    resetForm: { email: '', code: '', password: '' },
    sendingCode: false,
    codeCountdown: 0,
    countdownTimer: null,
    sendingResetCode: false,
    resetCodeCountdown: 0,
    resetCountdownTimer: null,
    siteSettings: null,

    async init() {
      // 登录凭证已迁移到 HttpOnly Cookie；此处仅用非敏感登录标记做预判，
      // 再向服务端确认。若服务端不再认可（401），清理本地标记，
      // 避免登录页和 /app/ 之间循环跳转。
      if (isLoggedIn()) {
        try {
          await api.profile();
          location.replace(safeNextPath());
          return;
        } catch (error) {
          if (error instanceof ApiError && error.code === 401) clearAuth();
        }
      }
      this.loadSiteSettings();
    },

    async loadSiteSettings() {
      this.siteSettings = await loadPublicSiteSettings().catch(() => null);
    },

    authText(key, fallback = '') {
      return this.siteSettings?.auth?.[key] || fallback;
    },

    showToast(message, type = 'info', duration = 2800) {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toast = { message, type };
      this.toastTimer = setTimeout(() => { this.toast = null; }, duration);
    },

    goNext() {
      location.replace(safeNextPath());
    },

    openReset() {
      this.resetForm.email = this.loginForm.email.trim() || this.registerForm.email.trim() || this.resetForm.email;
      this.view = 'reset';
    },

    async doLogin() {
      this.loading = true;
      try {
        const r = await api.login(this.loginForm.email.trim(), this.loginForm.password);
        const token = (r && (r.data || r));
        if (typeof token !== 'string') throw new Error(this.authText('login_invalid_response_text', '登录响应无效'));
        setToken(token);
        this.showToast(this.authText('login_success_text', '登录成功'), 'success');
        setTimeout(() => this.goNext(), 600);
      } catch (err) {
        this.showToast(err.message || this.authText('login_failed_text', '登录失败'), 'error');
      } finally { this.loading = false; }
    },

    async sendCode() {
      const email = this.registerForm.email.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        this.showToast(this.authText('invalid_email_text', '请输入正确的邮箱地址'), 'error');
        return;
      }
      this.sendingCode = true;
      try {
        const response = await api.sendEmailCode(email);
        const retryAfter = Number(response?.data?.retry_after || 60);
        this.showToast(this.authText('code_sent_text', '验证码请求已提交，通常 10–60 秒到达；若未看到，请检查垃圾邮件、广告邮件或 QQ 邮箱拦截。重复发送仍使用同一个验证码。'), 'success');
        this.codeCountdown = retryAfter;
        this.countdownTimer = setInterval(() => {
          this.codeCountdown--;
          if (this.codeCountdown <= 0) clearInterval(this.countdownTimer);
        }, 1000);
      } catch (err) {
        this.showToast(err.message || this.authText('send_failed_text', '发送失败'), 'error');
      } finally { this.sendingCode = false; }
    },

    async sendResetCode() {
      const email = this.resetForm.email.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        this.showToast(this.authText('invalid_email_text', '请输入正确的邮箱地址'), 'error');
        return;
      }
      this.sendingResetCode = true;
      try {
        const response = await sendPasswordResetCode(email);
        this.showToast(this.authText('reset_code_sent_text', '重置验证码请求已提交，通常 10–60 秒到达；若未看到，请检查垃圾邮件或邮箱拦截。'), 'success');
        this.resetCodeCountdown = Number(response?.data?.retry_after || 60);
        if (this.resetCountdownTimer) clearInterval(this.resetCountdownTimer);
        this.resetCountdownTimer = setInterval(() => {
          this.resetCodeCountdown--;
          if (this.resetCodeCountdown <= 0) clearInterval(this.resetCountdownTimer);
        }, 1000);
      } catch (err) {
        this.showToast(err.message || this.authText('send_failed_text', '发送失败'), 'error');
      } finally { this.sendingResetCode = false; }
    },

    async doRegister() {
      this.loading = true;
      try {
        const r = await api.register(
          this.registerForm.email.trim(),
          this.registerForm.password,
          this.registerForm.code.trim(),
          this.registerForm.name.trim()
        );
        const token = r && (r.data || r);
        if (typeof token !== 'string') throw new Error(this.authText('register_invalid_response_text', '注册响应无效'));
        setToken(token);
        this.showToast(this.authText('register_success_text', '注册成功，欢迎来到 惑梦（Homer）'), 'success');
        setTimeout(() => this.goNext(), 700);
      } catch (err) {
        this.showToast(err.message || this.authText('register_failed_text', '注册失败'), 'error');
      } finally { this.loading = false; }
    },

    async doResetPassword() {
      this.loading = true;
      try {
        const r = await resetPassword(
          this.resetForm.email.trim(),
          this.resetForm.password,
          this.resetForm.code.trim()
        );
        const token = r && (r.data || r);
        if (typeof token !== 'string') throw new Error(this.authText('reset_invalid_response_text', '密码重置响应无效'));
        setToken(token);
        this.showToast(this.authText('reset_success_text', '密码已重置'), 'success');
        setTimeout(() => this.goNext(), 700);
      } catch (err) {
        this.showToast(err.message || this.authText('reset_failed_text', '密码重置失败'), 'error');
      } finally { this.loading = false; }
    },
  };
}

window.loginPage = loginPage;
document.addEventListener('alpine:init', () => {
  if (window.Alpine?.data) window.Alpine.data('loginPage', loginPage);
});
