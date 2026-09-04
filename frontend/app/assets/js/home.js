import { api, isLoggedIn, ApiError } from '/app/assets/js/app-core.js?v=20260717-handoff-merge';

const statusNode = document.querySelector('[data-resume-status]');

function updateStatus(text) {
  if (statusNode) statusNode.textContent = text;
}

function go(path) {
  location.replace(path);
}

async function resumeLatestConversation() {
  if (!isLoggedIn()) {
    go('/app/login.html?next=%2Fapp%2F');
    return;
  }

  try {
    const response = await api.conversations();
    const conversations = response?.data?.list || response?.list || [];
    let preferred = null;
    if (Array.isArray(conversations)) {
      let storedId = '';
      try { storedId = localStorage.getItem('ai_xingyue_last_conversation_id') || ''; } catch { /* ignore */ }
      preferred = conversations.find(item => item?.id === storedId)
        || conversations.find(item => item && item.id)
        || null;
    }
    if (preferred?.id) {
      go(`/app/chat.html?conv_id=${encodeURIComponent(preferred.id)}`);
      return;
    }
    updateStatus('还没有历史对话，正在前往探索…');
    go('/app/explore.html');
  } catch (error) {
    if (error instanceof ApiError && error.code === 401) {
      go('/app/login.html?next=%2Fapp%2F');
      return;
    }
    updateStatus('暂时无法读取历史，正在前往探索…');
    go('/app/explore.html');
  }
}

resumeLatestConversation();
