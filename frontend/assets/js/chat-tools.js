// Shared tools for the local snapshot and the live message list. Only rendered
// messages are inspected: no character settings, worldbook or preset source.
export function openChatTool(kind, { container, selector, isUser, title }) {
  document.querySelector('#homer-chat-tool')?.remove();
  const messages = [...container.querySelectorAll(selector)];
  const dialog = document.createElement('dialog');
  dialog.id = 'homer-chat-tool'; dialog.className = 'homer-chat-tool';
  dialog.setAttribute('aria-label', kind === 'search' ? '搜索本次对话' : '本次对话统计');
  const head = document.createElement('header');
  const heading = document.createElement('h2'); heading.textContent = kind === 'search' ? '搜索本次对话' : '本次对话统计';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', () => dialog.close()); head.append(heading, close); dialog.append(head);
  const note = document.createElement('p'); note.textContent = `${title || '当前对话'} · 仅包含当前已加载的消息`; dialog.append(note);
  const entries = messages.map((element, index) => ({ element, index, user: isUser(element), text: (element.querySelector('.mes_text') || element).innerText.trim() }));
  if (kind === 'search') {
    const input = document.createElement('input'); input.type = 'search'; input.placeholder = '输入关键词'; input.setAttribute('aria-label', '搜索消息');
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const list = document.createElement('div'); list.className = 'homer-chat-tool__results';
    const render = () => {
      list.replaceChildren(); const query = input.value.trim().toLocaleLowerCase();
      const found = query ? entries.filter(entry => entry.text.toLocaleLowerCase().includes(query)) : [];
      status.textContent = query ? (found.length ? `找到 ${found.length} 条消息` : '没有找到相关消息') : '按关键词查找，点击结果定位原消息';
      for (const entry of found) {
        const button = document.createElement('button'); button.type = 'button';
        const label = document.createElement('strong'); label.textContent = `${entry.user ? '我' : '角色'} · 第 ${entry.index + 1} 条`;
        const excerpt = document.createElement('span');
        const start = Math.max(0, entry.text.toLocaleLowerCase().indexOf(query) - 30);
        excerpt.textContent = (start ? '…' : '') + entry.text.slice(start, start + 140);
        button.append(label, excerpt);
        button.addEventListener('click', () => {
          dialog.close();
          entry.element.scrollIntoView({ block: 'center', behavior: 'instant' });
          entry.element.classList.add('homer-search-hit');
          setTimeout(() => entry.element.classList.remove('homer-search-hit'), 1800);
        }); list.append(button);
      }
    };
    input.addEventListener('input', render); dialog.append(input, status, list); render();
  } else {
    const list = document.createElement('dl'); list.className = 'homer-chat-tool__stats';
    for (const [label, value] of [['消息总数', entries.length], ['我的消息', entries.filter(entry => entry.user).length], ['角色及其他消息', entries.filter(entry => !entry.user).length], ['可见文字字数', entries.reduce((sum, entry) => sum + Array.from(entry.text.replace(/\s/g, '')).length, 0)]]) {
      const item = document.createElement('div'); const term = document.createElement('dt'); const count = document.createElement('dd');
      term.textContent = label; count.textContent = value.toLocaleString('zh-CN'); item.append(term, count); list.append(item);
    } dialog.append(list);
  }
  const previous = document.activeElement;
  dialog.addEventListener('close', () => { dialog.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }, { once: true });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
  document.body.append(dialog); dialog.showModal(); close.focus();
}
