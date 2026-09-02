(() => {
  'use strict';

  const title = document.querySelector('#title');
  const messages = document.querySelector('#messages');
  const connectionState = document.querySelector('#connection-state');
  const historyTitle = document.querySelector('#history-title');
  const historyLast = document.querySelector('#history-last');
  const historyAvatar = document.querySelector('#history-avatar');
  const composer = document.querySelector('#composer');
  const draft = document.querySelector('#draft');
  const menuButton = document.querySelector('#menu-button');
  const settingsButton = document.querySelector('#settings-button');
  const statusPanel = document.querySelector('#status-panel');
  const statusTitle = document.querySelector('#status-title');
  const statusDetail = document.querySelector('#status-detail');
  const retry = document.querySelector('#retry');
  const scrim = document.querySelector('#scrim');

  function readSnapshot() {
    try {
      return JSON.parse(window.HomerNative?.getSnapshot?.() || '{}');
    } catch (_) {
      return {};
    }
  }

  function render() {
    const snapshot = readSnapshot();
    const roleName = String(snapshot.title || '角色对话').trim().slice(0, 120) || '角色对话';
    title.textContent = roleName;
    historyTitle.textContent = roleName;
    historyAvatar.innerHTML = '<img src="img/default-avatar.png" alt="">';
    document.title = `${roleName} · 惑梦`;
    messages.replaceChildren();
    const list = Array.isArray(snapshot.messages) ? snapshot.messages.slice(-80) : [];
    for (const item of list) {
      const text = String(item?.text || '').trim();
      if (!text) continue;
      const bubble = document.createElement('article');
      bubble.className = `message${item?.role === 'user' ? ' is-user' : ''}`;
      bubble.textContent = text;
      messages.append(bubble);
    }
    if (!messages.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.innerHTML = '<img src="img/empty-state.png" alt=""><strong>最近会话会保存在这里</strong><span>登录并打开一段对话后，即使网络暂时不可用，也能先看到本机记录。</span>';
      messages.append(empty);
      historyLast.textContent = '还没有本机会话';
    } else {
      historyLast.textContent = String(list.at(-1)?.text || '本机最近会话').slice(0, 42);
    }
    requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
  }

  function setConnectionState(online, connecting) {
    if (!online) {
      connectionState.textContent = '离线记录';
      statusTitle.textContent = '当前未连接网络';
      statusDetail.textContent = '可以继续阅读本机记录，发送和生成会在重新连接后可用。';
      return;
    }
    connectionState.textContent = connecting ? '正在恢复完整功能' : '本机记录';
    statusTitle.textContent = connecting ? '正在接入完整对话' : '连接正常';
    statusDetail.textContent = connecting
      ? '当前内容已经可以阅读，完整交互会在后台准备好后直接接管。'
      : '完整对话已经可以使用。';
  }

  function closeMenu() {
    document.body.classList.remove('is-menu-open');
    scrim.hidden = true;
  }

  menuButton.addEventListener('click', () => {
    statusPanel.hidden = true;
    const open = document.body.classList.toggle('is-menu-open');
    scrim.hidden = !open;
  });
  scrim.addEventListener('click', closeMenu);
  settingsButton.addEventListener('click', () => {
    closeMenu();
    statusPanel.hidden = !statusPanel.hidden;
  });
  retry.addEventListener('click', () => {
    statusPanel.hidden = true;
    setConnectionState(true, true);
    window.HomerNative?.retryConnection?.();
  });
  composer.addEventListener('submit', event => {
    event.preventDefault();
    const content = draft.value.trim();
    if (!content) return;
    setConnectionState(true, true);
    window.HomerNative?.submitDraft?.(content);
    draft.value = '';
  });
  draft.addEventListener('input', () => {
    draft.style.height = 'auto';
    draft.style.height = `${Math.min(132, draft.scrollHeight)}px`;
  });

  window.HomerSnapshot = { setConnectionState };
  render();
})();
