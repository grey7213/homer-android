// 惑梦（Homer） Web App 共享核心 - 在所有 /app/*.html 顶部加载
import './notifications.js?v=20260905-notices-v1';
import { api as baseApi, getToken, setToken, clearAuth, isLoggedIn, getCachedUser, setCachedUser, formatDateTime, ApiError } from '/assets/js/api.js?v=20260905-notices-v1';

function redirectAfterUnauthorized() {
  clearAuth();
  if (location.pathname.startsWith('/app/') && !location.pathname.endsWith('/login.html')) {
    const next = location.pathname + location.search + location.hash;
    location.replace('/app/login.html?next=' + encodeURIComponent(next));
  }
}

// 扩展共享 api 实例（增加 chat / explore / conversation 方法）
async function rawRequest(path, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token && opts.auth !== false) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    // 携带 HttpOnly 登录 Cookie
    credentials: 'include',
    body: opts.body ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (res.status === 401 && opts.auth !== false) redirectAfterUnauthorized();
  if (!res.ok) throw new ApiError((data && (data.message || data.msg)) || `HTTP ${res.status}`, res.status, data);
  if (data && data.result === 'failure') throw new ApiError(data.message || data.msg || '请求失败', parseInt(data.code) || res.status, data);
  return data;
}

async function uploadCardAssetContent(upload, file) {
  const target = upload && typeof upload === 'object' ? upload : {};
  const url = new URL(String(target.url || ''), location.href);
  const sameOrigin = url.origin === location.origin;
  const headers = { ...(target.headers || {}) };
  if (!headers['Content-Type'] && file?.type) headers['Content-Type'] = file.type;
  const token = getToken();
  if (sameOrigin && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url.href, {
    method: target.method || 'PUT',
    headers,
    body: file,
    credentials: sameOrigin ? 'same-origin' : 'omit',
  });
  if (response.status === 401 && sameOrigin) redirectAfterUnauthorized();
  if (!response.ok) {
    let message = `上传失败（${response.status}）`;
    try {
      const data = await response.json();
      message = data?.message || data?.msg || message;
    } catch {}
    throw new ApiError(message, response.status);
  }
  return response;
}

async function sseRequest(path, payload, handlers = {}, options = {}) {
  const headers = { Accept: 'text/event-stream', 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, {
    method: 'POST',
    headers,
    // 携带 HttpOnly 登录 Cookie
    credentials: 'include',
    body: JSON.stringify(payload || {}),
    signal: options.signal,
  });
  if (!res.ok || !res.body) {
    if (res.status === 401) redirectAfterUnauthorized();
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      message = data?.message || data?.msg || message;
    } catch {}
    throw new ApiError(message, res.status);
  }
  const decoder = new TextDecoder('utf-8');
  const reader = res.body.getReader();
  let buffer = '';
  let finalPayload = null;
  let sawMessageEnd = false;

  const dispatch = (block) => {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    let data = dataLines.join('\n');
    try { data = JSON.parse(data); } catch {}
    if (event === 'start') handlers.onStart?.(data);
    else if (event === 'delta') handlers.onDelta?.(data?.content ?? String(data ?? ''));
    else if (event === 'message_end') {
      sawMessageEnd = true;
      finalPayload = data;
      handlers.onEnd?.(data);
    }
    else if (event === 'error') {
      const msg = data?.message || '流式生成失败';
      handlers.onError?.(msg);
      throw new ApiError(msg, 500, data);
    }
    else handlers.onEvent?.(event, data);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // SSE allows CRLF as well as LF, including separators split across reads.
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, separator.index).trim();
        buffer = buffer.slice(separator.index + separator[0].length);
        if (block) dispatch(block);
      }
      if (done) break;
    }
    const tail = buffer.trim();
    if (tail) dispatch(tail);
  } finally {
    // Stop the transport when dispatch or an onDelta handler fails.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!sawMessageEnd) {
    throw new ApiError('连接提前中断，本次回复未完成，请重试', 502, { code: 'stream_incomplete' });
  }
  return finalPayload;
}

export const api = {
  ...baseApi,
  // 探索
  exploreSearch: (params = {}) => {
    const qs = new URLSearchParams(params);
    return rawRequest(`/go/api/explore/search?${qs}`, { auth: false });
  },
  recommendedPosts: () => rawRequest('/go/api/posts/recommended'),
  tagGroups: () => rawRequest('/go/api/explore/tag-groups'),
  installedApps: () => rawRequest('/console/api/installed-apps'),
  appDetails: (appId) => rawRequest(`/console/api/apps/${encodeURIComponent(appId)}`),
  appComments: (appId, params = {}) => {
    const qs = new URLSearchParams(params);
    const suffix = qs.toString() ? `?${qs}` : '';
    return rawRequest(`/console/api/web/apps/${encodeURIComponent(appId)}/comments${suffix}`);
  },
  createAppComment: (appId, content) => rawRequest(`/console/api/web/apps/${encodeURIComponent(appId)}/comments`, { method: 'POST', body: { content } }),
  toggleCommentLike: (commentId) => rawRequest(`/console/api/web/comments/${encodeURIComponent(commentId)}/like`, { method: 'POST', body: {} }),
  userTags: (appId) => rawRequest(`/console/api/web/apps/${encodeURIComponent(appId)}/user-tags`),
  saveUserTags: (appId, tags) => rawRequest(`/console/api/web/apps/${encodeURIComponent(appId)}/user-tags`, { method: 'POST', body: { tags } }),
  homeStats: () => rawRequest('/console/api/web/home-stats'),
  creatorLeaderboard: (params = {}) => {
    const qs = new URLSearchParams(params);
    return rawRequest(`/console/api/web/creator-leaderboard?${qs}`);
  },
  creatorContests: () => rawRequest('/console/api/web/creator-contests'),
  favorites: (params = {}) => {
    const qs = new URLSearchParams(params);
    return rawRequest(`/console/api/web/favorites?${qs}`);
  },
  toggleFavorite: (appId) => rawRequest(`/console/api/web/favorites/${encodeURIComponent(appId)}/toggle`, { method: 'POST', body: {} }),
  toggleLike: (appId) => rawRequest(`/console/api/web/apps/${encodeURIComponent(appId)}/like`, { method: 'POST', body: {} }),
  logs: (params = {}) => {
    const qs = new URLSearchParams(params);
    return rawRequest(`/console/api/web/logs?${qs}`);
  },
  credits: () => rawRequest('/console/api/user/credits'),
  depositMeta: () => rawRequest('/console/api/web/deposit-meta'),
  createPaymentOrder: (planId, payType, amountCny = null) => rawRequest('/console/api/web/payments/orders', {
    method: 'POST',
    body: {
      ...(planId ? { plan_id: planId } : {}),
      pay_type: payType,
      ...(amountCny !== null ? { amount_cny: amountCny } : {}),
    },
  }),
  paymentOrders: (params = {}) => {
    const qs = new URLSearchParams(params);
    return rawRequest(`/console/api/web/payments/orders?${qs}`);
  },
  paymentOrder: (orderNo) => rawRequest(`/console/api/web/payments/orders/${encodeURIComponent(orderNo)}`),
  redeemCode: (code) => rawRequest('/console/api/web/redeem-code', { method: 'POST', body: { code } }),
  redemptions: (params = {}) => {
    const qs = new URLSearchParams(params);
    return rawRequest(`/console/api/web/redemptions?${qs}`);
  },
  rewards: () => rawRequest('/console/api/web/rewards'),
  claimDailyReward: () => rawRequest('/console/api/web/rewards/daily', { method: 'POST', body: {} }),
  farmState: () => rawRequest('/console/api/web/farm/state'),
  farmFriends: () => rawRequest('/console/api/web/farm/friends'),
  farmPlant: (plotNo, cropKind, idempotencyKey) => rawRequest(`/console/api/web/farm/plots/${encodeURIComponent(plotNo)}/plant`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { crop_kind: cropKind },
  }),
  farmWater: (plotNo, idempotencyKey) => rawRequest(`/console/api/web/farm/plots/${encodeURIComponent(plotNo)}/water`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {},
  }),
  farmHarvest: (plotNo, idempotencyKey) => rawRequest(`/console/api/web/farm/plots/${encodeURIComponent(plotNo)}/harvest`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {},
  }),
  farmSteal: (friendId, idempotencyKey) => rawRequest(`/console/api/web/farm/friends/${encodeURIComponent(friendId)}/steal`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {},
  }),
  imageChat: (payload) => rawRequest('/console/api/web/image-chat', { method: 'POST', body: payload }),
  myApps: (params = {}) => {
    const qs = new URLSearchParams(params);
    return rawRequest(`/console/api/web/my-apps?${qs}`);
  },
  myAppsCount: () => rawRequest('/console/api/web/my-apps-count'),
  modelPresets: () => rawRequest('/console/api/web/model-presets'),
  dialogueSession: (appId = '', conversationId = '', { launchOnly = false } = {}) => {
    const qs = new URLSearchParams();
    if (appId) qs.set('app_id', appId);
    if (conversationId) qs.set('conversation_id', conversationId);
    if (launchOnly) qs.set('launch_only', '1');
    const suffix = qs.toString() ? `?${qs}` : '';
    return rawRequest(`/console/api/web/dialogue/session${suffix}`);
  },
  dialogueExtensions: () => rawRequest('/console/api/web/dialogue/extensions'),
  dialogueRuntimeState: (appId = '', conversationId = '') => {
    const qs = new URLSearchParams();
    if (appId) qs.set('app_id', appId);
    if (conversationId) qs.set('conversation_id', conversationId);
    const suffix = qs.toString() ? `?${qs}` : '';
    return rawRequest(`/console/api/web/dialogue/runtime-state${suffix}`);
  },
  saveDialogueRuntimeState: (payload) =>
    rawRequest('/console/api/web/dialogue/runtime-state', { method: 'POST', body: payload || {} }),
  creatorAccess: () => rawRequest('/console/api/web/creator-access'),
  ttsVoices: () => rawRequest('/console/api/web/tts/voices'),
  synthesizeTts: (payload) => rawRequest('/console/api/web/tts/synthesize', { method: 'POST', body: payload }),
  providerTemplates: () => rawRequest('/console/api/web/provider-templates'),
  tavoPluginRuntimeContributions: () => rawRequest('/console/api/web/tavo-plugins/runtime-contributions'),
  userModelPresets: () => rawRequest('/console/api/web/user-model-presets'),
  saveUserModelPresets: (presets) => rawRequest('/console/api/web/user-model-presets', { method: 'POST', body: { presets } }),
  updateProfile: (payload) => rawRequest('/console/api/web/profile', { method: 'POST', body: payload }),
  uploadAvatar: (image, filename = 'avatar.png') =>
    rawRequest('/console/api/web/profile/avatar', { method: 'POST', body: { image, filename } }),
  createApp: (payload) => rawRequest('/console/api/web/my-apps/create', { method: 'POST', body: payload }),
  updateApp: (appId, payload) => rawRequest(`/console/api/web/my-apps/${encodeURIComponent(appId)}/update`, { method: 'POST', body: payload }),
  deleteApp: (appId) => rawRequest(`/console/api/web/my-apps/${encodeURIComponent(appId)}/delete`, { method: 'POST', body: {} }),
  uploadCover: (image, filename = 'cover.png') =>
    rawRequest('/console/api/web/my-apps/upload-cover', { method: 'POST', body: { image, filename } }),
  createCardAssetUploadIntent: (payload) =>
    rawRequest('/console/api/web/card-assets/upload-intent', { method: 'POST', body: payload }),
  uploadCardAssetContent,
  completeCardAssetUpload: (assetId, payload = {}) =>
    rawRequest(`/console/api/web/card-assets/${encodeURIComponent(assetId)}/complete`, { method: 'POST', body: payload }),
  deleteCardAsset: (assetId) =>
    rawRequest(`/console/api/web/card-assets/${encodeURIComponent(assetId)}/delete`, { method: 'POST', body: {} }),
  // 会话
  conversations: () => rawRequest('/console/api/web/conversations'),
  messages: (convId, params = {}) => {
    const qs = new URLSearchParams(params);
    const suffix = qs.toString() ? `?${qs}` : '';
    return rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/messages${suffix}`);
  },
  conversationSummary: (convId) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/summary`),
  saveConversationSummary: (convId, payload) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/summary`, { method: 'POST', body: payload }),
  setConversationGalgame: (convId, enabled) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/galgame`, {
    method: 'POST',
    body: { enabled: !!enabled },
  }),
  setConversationGlobalPreset: (convId, enabled) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/global-preset`, {
    method: 'POST',
    body: { enabled: !!enabled },
  }),
  conversationRuntimeConfig: (convId) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/runtime-config`),
  saveConversationPresetOverrides: (convId, payload = {}) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/preset-overrides`, {
    method: 'POST',
    body: payload,
  }),
  saveConversationWorldbookOverrides: (convId, payload = {}) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/worldbook-overrides`, {
    method: 'POST',
    body: payload,
  }),
  sendChat: (payload) => rawRequest('/console/api/web/chat', { method: 'POST', body: payload }),
  sendChatStream: (payload, handlers, options) => sseRequest('/console/api/web/chat/stream', payload, handlers, options),
  continueChatStream: (payload, handlers, options) => sseRequest('/console/api/web/chat/continue/stream', payload, handlers, options),
  startConversation: (payload) => rawRequest('/console/api/web/conversations/start', { method: 'POST', body: payload }),
  copyConversation: (convId) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/copy`, { method: 'POST', body: {} }),
  deleteConversation: (convId) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(convId)}/delete`, { method: 'POST', body: {} }),
  regenerate: (convId, modelId = '') => rawRequest('/console/api/web/regenerate', { method: 'POST', body: { conversation_id: convId, model_id: modelId || '' } }),
  swipeMessage: (messageId, dir, modelId = '') => rawRequest(`/console/api/web/messages/${encodeURIComponent(messageId)}/swipe`, { method: 'POST', body: { dir, model_id: modelId || '' } }),
  editMessage: (messageId, content) => rawRequest(`/console/api/web/messages/${encodeURIComponent(messageId)}/edit`, { method: 'POST', body: { content } }),
  rollbackMessage: (messageId) => rawRequest(`/console/api/web/messages/${encodeURIComponent(messageId)}/rollback`, { method: 'POST', body: {} }),
  deleteMessage: (messageId) => rawRequest(`/console/api/web/messages/${encodeURIComponent(messageId)}/delete`, { method: 'POST', body: {} }),
  // 群聊
  groupChats: () => rawRequest('/console/api/web/group-chats'),
  createGroupChat: (payload) => rawRequest('/console/api/web/group-chats', { method: 'POST', body: payload }),
  groupChat: (groupId) => rawRequest(`/console/api/web/group-chats/${encodeURIComponent(groupId)}`),
  deleteGroupChat: (groupId) => rawRequest(`/console/api/web/group-chats/${encodeURIComponent(groupId)}/delete`, { method: 'POST', body: {} }),
  sendGroupMessage: (groupId, payload) => rawRequest(`/console/api/web/group-chats/${encodeURIComponent(groupId)}/message`, { method: 'POST', body: payload }),
  groupReply: (groupId, payload = {}) => rawRequest(`/console/api/web/group-chats/${encodeURIComponent(groupId)}/reply`, { method: 'POST', body: payload }),
  // 人设 persona
  getPersona: () => rawRequest('/console/api/web/persona'),
  setPersona: (name, description) => rawRequest('/console/api/web/persona', { method: 'POST', body: { name, description } }),
  // 长期记忆
  memories: (params = {}) => {
    const qs = new URLSearchParams(params);
    return rawRequest(`/console/api/web/memories?${qs}`);
  },
  saveMemory: (payload) => rawRequest('/console/api/web/memories', { method: 'POST', body: payload }),
  deleteMemory: (memoryId) => rawRequest(`/console/api/web/memories/${encodeURIComponent(memoryId)}/delete`, { method: 'POST', body: {} }),
  // 角色卡导入/导出（SillyTavern V2）
  importCard: (card) => rawRequest('/console/api/web/cards/import', {
    method: 'POST',
    body: card && card.card_file ? card : { card },
  }),
  exportCard: (appId) => rawRequest(`/console/api/web/my-apps/${encodeURIComponent(appId)}/export`),
  exportCardPng: (appId) => rawRequest(`/console/api/web/my-apps/${encodeURIComponent(appId)}/export-png`),
  // 社区作品：Mod、UI 模板与预设。
  communityWorks: (params = {}) => {
    const qs = new URLSearchParams(params);
    const suffix = qs.toString() ? `?${qs}` : '';
    return rawRequest(`/console/api/web/community/works${suffix}`);
  },
  communityWork: (workId) => rawRequest(`/console/api/web/community/works/${encodeURIComponent(workId)}`),
  communityWorkVersions: (workId) => rawRequest(`/console/api/web/community/works/${encodeURIComponent(workId)}/versions`),
  communityWorkVersion: (workId, versionId) => rawRequest(`/console/api/web/community/works/${encodeURIComponent(workId)}/versions/${encodeURIComponent(versionId)}`),
  createCommunityWork: (payload) => rawRequest('/console/api/web/community/works', { method: 'POST', body: payload }),
  updateCommunityWork: (workId, payload) => rawRequest(`/console/api/web/community/works/${encodeURIComponent(workId)}/update`, { method: 'POST', body: payload }),
  deleteCommunityWork: (workId) => rawRequest(`/console/api/web/community/works/${encodeURIComponent(workId)}/delete`, { method: 'POST', body: {} }),
  toggleCommunityWorkFavorite: (workId) => rawRequest(`/console/api/web/community/works/${encodeURIComponent(workId)}/favorite`, { method: 'POST', body: {} }),
  communityContests: () => rawRequest('/console/api/web/community/contests'),
  communityContest: (contestId) => rawRequest(`/console/api/web/community/contests/${encodeURIComponent(contestId)}`),
  createCommunityContest: (payload) => rawRequest('/console/api/web/community/contests', { method: 'POST', body: payload }),
  communityContestRankings: (contestId) => rawRequest(`/console/api/web/community/contests/${encodeURIComponent(contestId)}/rankings`),
  voteCommunityContest: (contestId, appId) => rawRequest(`/console/api/web/community/contests/${encodeURIComponent(contestId)}/vote`, { method: 'POST', body: { app_id: appId } }),
  // 角色卡增强信息与不可变版本。
  cardExtraFlags: (appId) => rawRequest(`/console/api/web/card-extra/flags/${encodeURIComponent(appId)}`),
  saveCardExtraFlags: (appId, payload = {}) => rawRequest(`/console/api/web/card-extra/flags/${encodeURIComponent(appId)}`, { method: 'PUT', body: payload }),
  cardVersions: (appId) => rawRequest(`/console/api/web/card-versions/${encodeURIComponent(appId)}`),
  cardVersion: (appId, versionId) => rawRequest(`/console/api/web/card-versions/${encodeURIComponent(appId)}/${encodeURIComponent(versionId)}`),
  publishCardVersion: (appId, payload = {}) => rawRequest(`/console/api/web/card-versions/${encodeURIComponent(appId)}`, { method: 'POST', body: payload }),
  // 当前会话使用的社区 Mod（保存时由服务端锁定具体不可变版本）。
  chatModLibrary: (params = {}) => {
    const qs = new URLSearchParams(params);
    const suffix = qs.toString() ? `?${qs}` : '';
    return rawRequest(`/console/api/web/chat-mods/library${suffix}`);
  },
  conversationMods: (conversationId) => rawRequest(`/console/api/web/chat-mods/conversation/${encodeURIComponent(conversationId)}`),
  conversationRuntimeCard: (conversationId) => rawRequest(`/console/api/web/conversations/${encodeURIComponent(conversationId)}/runtime-card`),
  saveConversationMods: (conversationId, mods = []) => rawRequest(`/console/api/web/chat-mods/conversation/${encodeURIComponent(conversationId)}`, {
    method: 'POST',
    body: { mods },
  }),
};

// 全局工具：要求登录否则跳转到 login
export function requireAuth() {
  // 敏感 token 已迁移到 HttpOnly Cookie，改用非敏感登录标记判断。
  if (!isLoggedIn()) {
    location.replace('/app/login.html?next=' + encodeURIComponent(location.pathname));
    return false;
  }
  return true;
}

export { getToken, setToken, clearAuth, isLoggedIn, getCachedUser, setCachedUser, formatDateTime, ApiError };

window.aiXingyueApp = { api, getToken, setToken, clearAuth, isLoggedIn, getCachedUser, setCachedUser, requireAuth, ApiError };
