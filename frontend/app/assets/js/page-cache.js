const CACHE_PREFIX = 'homer.page-cache.v1';

function userIdentity(user) {
  return String(user?.id || user?.user_id || user?.email || '').trim().slice(0, 160);
}

function cacheKey(scope, user) {
  const identity = userIdentity(user);
  const cleanScope = String(scope || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 80);
  return identity && cleanScope ? `${CACHE_PREFIX}.${cleanScope}.${identity}` : '';
}

export function readPageCache(scope, user, { maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const key = cacheKey(scope, user);
  if (!key) return null;
  try {
    const envelope = JSON.parse(localStorage.getItem(key) || 'null');
    if (!envelope || typeof envelope !== 'object') return null;
    const savedAt = Number(envelope.savedAt || 0);
    if (!savedAt || Date.now() - savedAt > maxAgeMs) {
      localStorage.removeItem(key);
      return null;
    }
    return envelope.value && typeof envelope.value === 'object' ? envelope.value : null;
  } catch {
    return null;
  }
}

export function writePageCache(scope, user, value) {
  const key = cacheKey(scope, user);
  if (!key || !value || typeof value !== 'object') return false;
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }));
    return true;
  } catch {
    return false;
  }
}

export function clearPageCache(scope, user) {
  const key = cacheKey(scope, user);
  if (!key) return;
  try { localStorage.removeItem(key); } catch { /* storage can be unavailable */ }
}

