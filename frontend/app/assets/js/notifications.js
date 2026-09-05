// Startup notices are fetched independently of page/data/runtime readiness.
const PREFIX = 'homer.notice.v1.';
let dialog, pending = false;
const memory = new Map();
function read(key) { try { return localStorage.getItem(key) || ''; } catch { return memory.get(key) || ''; } }
function write(key, value) { memory.set(key, value); try { localStorage.setItem(key, value); } catch {} }
function owner() {
  try { const u = JSON.parse(localStorage.getItem('ai_xingyue_user') || 'null'); return String(u?.id || u?.user_id || u?.email || 'guest'); }
  catch { return 'guest'; }
}
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
}
function visit() {
  try { const id = window.HomerNative?.getAppVisitId?.(); if (id) return String(id); } catch {}
  try {
    let id = sessionStorage.getItem(PREFIX + 'visit');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(PREFIX + 'visit', id); }
    return id;
  } catch { return 'document'; }
}
function key(suffix, user = owner()) { return PREFIX + encodeURIComponent(user) + '.' + suffix; }
function show(notices, user, visitId) {
  if (dialog?.open) return;
  if (!document.querySelector('#homer-notice-style')) {
    const style = document.createElement('style');
    style.id = 'homer-notice-style';
    style.textContent = `.homer-notice{box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 48px);padding:0;border:0;border-radius:22px;background:#fff;color:#25252b;box-shadow:0 20px 80px #0005;font:16px/1.6 system-ui,sans-serif;overflow:auto}.homer-notice::backdrop{background:#1119}.homer-notice header{padding:22px 24px 10px;font-size:20px;font-weight:700}.homer-notice section{padding:8px 24px 20px;overflow-wrap:anywhere}.homer-notice h3{font-size:17px;margin:8px 0}.homer-notice p{white-space:pre-wrap;margin:8px 0}.homer-notice article+article{border-top:1px solid #eee;padding-top:12px}.homer-notice footer{position:sticky;bottom:0;background:#fff;padding:12px 20px 20px;display:flex;gap:10px;flex-wrap:wrap}.homer-notice button{flex:1;min-width:120px;min-height:44px;border:0;border-radius:12px;padding:10px;color:#555;background:#f2f2f6;font:inherit;cursor:pointer}.homer-notice button:last-child{background:#ff3472;color:#fff}.homer-notice button:focus-visible{outline:3px solid #9052ff;outline-offset:2px}`;
    document.head.append(style);
  }
  dialog = document.createElement('dialog');
  dialog.className = 'homer-notice';
  dialog.setAttribute('aria-labelledby', 'homer-notice-title');
  const header = document.createElement('header');
  header.id = 'homer-notice-title'; header.textContent = '站内通知';
  const content = document.createElement('section');
  for (const item of notices) {
    const article = document.createElement('article');
    const title = document.createElement('h3'); title.textContent = item.title;
    const text = document.createElement('p'); text.textContent = item.content;
    article.append(title, text); content.append(article);
  }
  const footer = document.createElement('footer');
  const mute = document.createElement('button'); mute.type = 'button'; mute.textContent = '今日不再弹出';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '我知道了';
  mute.onclick = () => { write(key('muted', user), localDay()); dialog.close(); };
  close.onclick = () => dialog.close();
  footer.append(mute, close); dialog.append(header, content, footer);
  dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; }, {once:true});
  document.body.append(dialog);
  dialog.showModal();
  write(key('shown', user), visitId + ':' + localDay());
}
export async function checkStartupNotifications() {
  if (window.top !== window || !location.pathname.startsWith('/app/')
      || document.visibilityState === 'hidden' || pending || dialog?.open) return;
  const user = owner(), visitId = visit();
  if (read(key('muted', user)) === localDay() || read(key('shown', user)) === visitId + ':' + localDay()) return;
  pending = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/console/api/public/notifications', {credentials:'include', cache:'no-store', signal:controller.signal});
    if (!response.ok) return;
    const body = await response.json();
    const list = (body?.data?.list || body?.list || []).filter(n => n && n.enabled !== false && typeof n.title === 'string' && typeof n.content === 'string');
    if (user !== owner() || visitId !== visit() || document.visibilityState === 'hidden') return;
    if (read(key('muted', user)) === localDay() || read(key('shown', user)) === visitId + ':' + localDay()) return;
    if (list.length) show(list, user, visitId);
  } catch { /* A missing/offline notice service must never block the app. */ }
  finally { clearTimeout(timeout); pending = false; }
}
if (!window.__homerNoticesInstalled) {
  window.__homerNoticesInstalled = true;
  window.addEventListener('homer:app-enter', () => void checkStartupNotifications());
  document.addEventListener('visibilitychange', () => void checkStartupNotifications());
  window.addEventListener('homer-account-cleared', () => dialog?.close());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void checkStartupNotifications(), {once:true});
  else setTimeout(() => void checkStartupNotifications(), 0);
}
