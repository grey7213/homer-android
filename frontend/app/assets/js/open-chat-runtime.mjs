import { normalizeCardExperience } from './card-experience-schema.mjs?v=20260721-open-chat-runtime';

const PROTOCOL_VERSION = 1;
const MAX_INTENT_BYTES = 52000;
const MAX_MESSAGE_TEXT = 24000;
const BASE_CAPABILITIES = Object.freeze(['read_state', 'exit']);
const INTENT_CAPABILITY = Object.freeze({
  send: 'send',
  continue: 'continue',
  regenerate: 'regenerate',
  swipe: 'swipe',
  edit: 'edit',
  delete: 'delete',
  rollback: 'rollback',
  load_older: 'load_older',
  tts: 'tts',
  open_settings: 'open_settings',
  exit: 'exit',
  slash: 'slash',
  set_draft: 'set_draft',
  stop_generation: 'stop_generation',
});

const PARENT_STYLE = `
  .open-chat-runtime-root {
    position: fixed;
    inset: 0;
    z-index: 120;
    min-width: 0;
    overflow: hidden;
    background: #100d13;
    isolation: isolate;
  }
  .open-chat-runtime-root iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: #100d13;
  }
  .open-chat-runtime-exit {
    position: fixed;
    top: 50%;
    right: max(0px, env(safe-area-inset-right));
    z-index: 2;
    min-height: 92px;
    padding: 10px 8px;
    border: 1px solid rgba(255,255,255,.28);
    border-right: 0;
    border-radius: 14px 0 0 14px;
    color: #fff;
    background: rgba(15,12,18,.78);
    box-shadow: 0 10px 30px rgba(0,0,0,.28);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    font: 600 13px/1 system-ui, sans-serif;
    letter-spacing: 1px;
    writing-mode: vertical-rl;
    transform: translateY(-50%);
    cursor: pointer;
  }
  .open-chat-runtime-exit:hover { background: rgba(35,27,42,.92); }
  .open-chat-runtime-status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: rgba(255,255,255,.72);
    font: 14px/1.5 system-ui, sans-serif;
    pointer-events: none;
  }
`;

function randomToken() {
  const bytes = new Uint8Array(24);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeText(value, max = MAX_MESSAGE_TEXT) {
  return String(value == null ? '' : value).slice(0, max);
}

function hashText(value) {
  const input = String(value == null ? '' : value);
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function serializableClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function iframeBootstrap(channel, encodedConfig) {
  'use strict';

  const decode = (input) => {
    const binary = atob(input);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };
  const config = JSON.parse(decode(encodedConfig));
  const root = document.getElementById('homer-runtime-root');
  const state = { current: null };
  const subscriptions = new Set();
  const events = new Map();
  const pending = new Map();
  let port = null;
  let requestSeq = 0;

  const emit = (name, ...args) => {
    const handlers = events.get(String(name)) || [];
    for (const handler of [...handlers]) {
      try { handler(...args); } catch (error) { console.error(error); }
    }
  };
  const eventOn = (name, handler) => {
    if (typeof handler !== 'function') return () => {};
    const key = String(name);
    const list = events.get(key) || [];
    list.push(handler);
    events.set(key, list);
    return () => {
      const next = (events.get(key) || []).filter(item => item !== handler);
      if (next.length) events.set(key, next);
      else events.delete(key);
    };
  };
  const eventOnce = (name, handler) => {
    const off = eventOn(name, (...args) => { off(); handler(...args); });
    return off;
  };
  const eventClear = (name) => {
    if (name == null) events.clear();
    else events.delete(String(name));
  };

  const callHost = (intent, payload = {}) => new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error('Homer Chat Host 尚未连接'));
      return;
    }
    const requestId = `req-${Date.now().toString(36)}-${++requestSeq}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Homer Chat Host 请求超时'));
    }, 30000);
    pending.set(requestId, { resolve, reject, timer });
    port.postMessage({ protocol: 1, channel, type: 'intent', intent, requestId, payload });
  });

  const messageList = () => Array.isArray(state.current?.messages) ? state.current.messages : [];
  const compatMessages = () => messageList().map((message, index) => ({
    message_id: message.id,
    id: message.id,
    index,
    role: message.role,
    name: message.role === 'user' ? state.current?.user?.name : state.current?.character?.name,
    message: message.content,
    content: message.content,
    swipes: Array.isArray(message.swipes) ? [...message.swipes] : [],
    swipe_id: Number(message.swipe_index || 0),
    is_user: message.role === 'user',
    is_system: message.role === 'system',
    data: {},
  }));
  const findMessage = (id) => messageList().find(message => String(message.id) === String(id));
  const lastAssistant = () => [...messageList()].reverse().find(message => message.role === 'assistant');

  const slash = async (input) => {
    const source = String(input == null ? '' : input).trim();
    if (!source.startsWith('/')) return callHost('send', { text: source });
    const match = source.match(/^\/([^\s]+)\s*([\s\S]*)$/);
    const command = String(match?.[1] || '').toLowerCase();
    const rest = String(match?.[2] || '').trim();
    if (['send', 'say'].includes(command)) return callHost('send', { text: rest });
    if (['continue', '续写'].includes(command)) return callHost('continue', { message_id: rest || lastAssistant()?.id || '' });
    if (['regenerate', 'regen', '重生成'].includes(command)) return callHost('regenerate', { message_id: rest || lastAssistant()?.id || '' });
    if (command === 'swipe') {
      const [direction = 'next', messageId = ''] = rest.split(/\s+/, 2);
      return callHost('swipe', { direction, message_id: messageId || lastAssistant()?.id || '' });
    }
    if (command === 'delete') return callHost('delete', { message_id: rest });
    if (command === 'rollback') return callHost('rollback', { message_id: rest });
    if (['tts', 'speak'].includes(command)) return callHost('tts', { message_id: rest || lastAssistant()?.id || '' });
    if (['setinput', 'draft'].includes(command)) return callHost('set_draft', { text: rest });
    if (['stop', 'abort'].includes(command)) return callHost('stop_generation');
    if (['settings', 'setting'].includes(command)) return callHost('open_settings');
    throw new Error(`暂不支持 Slash 命令：/${command}`);
  };

  const api = {
    version: 1,
    getState: () => state.current,
    getChatMessages: () => compatMessages(),
    subscribe(handler) {
      if (typeof handler !== 'function') return () => {};
      subscriptions.add(handler);
      if (state.current) handler(state.current);
      return () => subscriptions.delete(handler);
    },
    send: text => callHost('send', { text }),
    continue: messageId => callHost('continue', { message_id: messageId || lastAssistant()?.id || '' }),
    regenerate: messageId => callHost('regenerate', { message_id: messageId || lastAssistant()?.id || '' }),
    swipe: (messageId, direction = 'next') => callHost('swipe', { message_id: messageId || lastAssistant()?.id || '', direction }),
    edit: (messageId, text) => callHost('edit', { message_id: messageId, text }),
    delete: messageId => callHost('delete', { message_id: messageId }),
    rollback: messageId => callHost('rollback', { message_id: messageId }),
    loadOlder: () => callHost('load_older'),
    tts: messageId => callHost('tts', { message_id: messageId || lastAssistant()?.id || '' }),
    setDraft: text => callHost('set_draft', { text }),
    stopGeneration: () => callHost('stop_generation'),
    openSettings: () => callHost('open_settings'),
    exit: () => callHost('exit'),
    triggerSlash: slash,
    executeSlashCommands: slash,
    eventOn,
    eventOnce,
    eventEmit: emit,
    eventClear,
  };

  const variables = { global: {}, preset: {}, character: {}, chat: {}, message: {}, script: {}, extension: {} };
  const variableScope = options => String(options?.type || options?.scope || 'chat').toLowerCase();
  const getVariables = options => ({ ...(variables[variableScope(options)] || variables.chat) });
  const replaceVariables = (value, options) => {
    const key = variableScope(options);
    variables[key] = value && typeof value === 'object' ? { ...value } : {};
    return getVariables(options);
  };
  const updateVariablesWith = (updater, options) => {
    const current = getVariables(options);
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...(updater || {}) };
    return replaceVariables(next, options);
  };
  const substituteMacros = (input) => String(input == null ? '' : input)
    .replace(/\{\{user\}\}/gi, state.current?.user?.name || 'User')
    .replace(/\{\{char(?:acter)?\}\}/gi, state.current?.character?.name || 'Character')
    .replace(/\{\{lastMessage\}\}/gi, messageList().at(-1)?.content || '');

  const tavernHelper = {
    ...api,
    getChatMessages: api.getChatMessages,
    setChatMessage: (messageId, message) => api.edit(messageId, typeof message === 'string' ? message : message?.message || message?.content || ''),
    setChatMessages: async (items) => {
      const list = Array.isArray(items) ? items : [];
      for (const item of list) await api.edit(item.message_id || item.id, item.message || item.content || '');
      return api.getChatMessages();
    },
    createChatMessages: async (items) => {
      const list = Array.isArray(items) ? items : [items];
      for (const item of list) {
        const role = item?.role || (item?.is_user ? 'user' : 'assistant');
        if (role !== 'user') throw new Error('v1 只允许通过生成流程创建 assistant 消息');
        await api.send(item?.message || item?.content || '');
      }
      return api.getChatMessages();
    },
    deleteChatMessages: async (ids) => {
      for (const id of (Array.isArray(ids) ? ids : [ids])) await api.delete(id);
      return true;
    },
    getVariables,
    replaceVariables,
    updateVariablesWith,
    substituteMacros,
    getCharacter: () => state.current?.character || null,
    getCurrentCharacterName: () => state.current?.character?.name || '',
    generate: options => options?.user_input ? api.send(options.user_input) : api.continue(),
    generateRaw: options => options?.user_input ? api.send(options.user_input) : api.continue(),
    stopAllGeneration: api.stopGeneration,
  };

  const getContext = () => ({
    chat: compatMessages(),
    name1: state.current?.user?.name || 'User',
    name2: state.current?.character?.name || 'Character',
    characterId: state.current?.character?.id || '',
    chatId: state.current?.conversation?.id || '',
    eventSource: { on: eventOn, once: eventOnce, emit },
    event_types: {
      APP_READY: 'APP_READY', CHAT_CHANGED: 'CHAT_CHANGED', MESSAGE_SENT: 'MESSAGE_SENT',
      MESSAGE_RECEIVED: 'MESSAGE_RECEIVED', MESSAGE_UPDATED: 'MESSAGE_UPDATED',
      MESSAGE_DELETED: 'MESSAGE_DELETED', MESSAGE_SWIPED: 'MESSAGE_SWIPED',
      GENERATION_STARTED: 'GENERATION_STARTED', GENERATION_ENDED: 'GENERATION_ENDED',
    },
    getContext,
  });

  window.HomerChat = api;
  window.TavernHelper = tavernHelper;
  window.SillyTavern = { getContext };
  window.getChatMessages = tavernHelper.getChatMessages;
  window.triggerSlash = api.triggerSlash;
  window.executeSlashCommands = api.executeSlashCommands;
  window.eventOn = eventOn;
  window.eventOnce = eventOnce;
  window.eventEmit = emit;
  window.eventClear = eventClear;
  window.getVariables = getVariables;
  window.replaceVariables = replaceVariables;
  window.updateVariablesWith = updateVariablesWith;
  window.substituteMacros = substituteMacros;

  const defaultMarkup = `
    <main class="homer-default" data-homer-default>
      <header><div><strong data-role-name>惑梦角色</strong><small data-status>正在连接对话…</small></div></header>
      <section id="chat" class="homer-default__messages" data-message-list></section>
      <form class="homer-default__composer" data-composer>
        <textarea rows="1" placeholder="说点什么…" data-draft></textarea>
        <button type="submit">发送</button>
      </form>
    </main>`;
  const defaultStyle = `
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body, #homer-runtime-root { width: 100%; height: 100%; margin: 0; }
    body { overflow: hidden; color: #fff; background: radial-gradient(circle at top left,#433057,#16111d 46%,#0b090d); }
    button, textarea { font: inherit; }
    .homer-default { height: 100%; display: grid; grid-template-rows: auto 1fr auto; }
    .homer-default header { padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,.12); background: rgba(18,14,23,.7); backdrop-filter: blur(18px); }
    .homer-default header div { display: grid; gap: 4px; }
    .homer-default header strong { font-size: 18px; }
    .homer-default header small { color: rgba(255,255,255,.58); }
    .homer-default__messages { overflow: auto; display: flex; flex-direction: column; gap: 14px; padding: 22px max(18px,calc((100vw - 980px)/2)); }
    .homer-default__message { width: min(82%,760px); padding: 13px 16px; border: 1px solid rgba(255,255,255,.13); border-radius: 18px; white-space: pre-wrap; word-break: break-word; background: rgba(255,255,255,.09); box-shadow: 0 14px 35px rgba(0,0,0,.16); }
    .homer-default__message.user { align-self: flex-end; color: #24152b; background: linear-gradient(135deg,#ffc6df,#f6a8d0); }
    .homer-default__message.typing { opacity: .66; }
    .homer-default__message menu { display: flex; gap: 7px; margin: 9px 0 -5px; padding: 0; }
    .homer-default__message menu button { border: 0; border-radius: 999px; padding: 5px 9px; color: inherit; background: rgba(0,0,0,.14); cursor: pointer; }
    .homer-default__composer { display: flex; gap: 10px; padding: 14px max(14px,calc((100vw - 980px)/2)); padding-bottom: max(14px,env(safe-area-inset-bottom)); border-top: 1px solid rgba(255,255,255,.12); background: rgba(18,14,23,.82); backdrop-filter: blur(18px); }
    .homer-default__composer textarea { flex: 1; min-width: 0; max-height: 150px; resize: none; border: 1px solid rgba(255,255,255,.18); border-radius: 15px; padding: 12px 14px; color: #fff; outline: 0; background: rgba(255,255,255,.08); }
    .homer-default__composer button { border: 0; border-radius: 15px; padding: 0 20px; color: #251427; background: #ffb5d6; font-weight: 700; cursor: pointer; }
    @media (max-width: 640px) { .homer-default__message { width: 94%; } .homer-default__messages { padding: 74px 12px 16px; } }
  `;

  const installMarkup = (markup) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(markup || defaultMarkup), 'text/html');
    const scripts = [...doc.querySelectorAll('script')]
      .filter(script => !script.src)
      .map(script => script.textContent || '');
    doc.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv="refresh"]').forEach(node => node.remove());
    for (const style of [...doc.head.querySelectorAll('style')]) {
      const element = document.createElement('style');
      element.textContent = style.textContent || '';
      document.head.appendChild(element);
    }
    root.innerHTML = doc.body.innerHTML || defaultMarkup;
    return scripts;
  };

  const baseStyle = document.createElement('style');
  baseStyle.textContent = defaultStyle;
  document.head.appendChild(baseStyle);
  const customStyle = document.createElement('style');
  customStyle.textContent = String(config.shell?.css || '');
  document.head.appendChild(customStyle);
  const inlineScripts = installMarkup(config.shell?.html);

  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const renderDefault = snapshot => {
    const shell = document.querySelector('[data-homer-default]');
    if (!shell) return;
    const name = shell.querySelector('[data-role-name]');
    const status = shell.querySelector('[data-status]');
    const list = shell.querySelector('[data-message-list]');
    const draft = shell.querySelector('[data-draft]');
    if (name) name.textContent = snapshot.character?.name || '惑梦角色';
    if (status) status.textContent = snapshot.generation?.active
      ? `${snapshot.generation.label || '生成中'} · ${snapshot.generation.elapsed || 0} 秒`
      : `${snapshot.messages?.length || 0} 条消息`;
    if (draft && document.activeElement !== draft) draft.value = snapshot.composer?.draft || '';
    if (list) {
      list.innerHTML = (snapshot.messages || []).map(message => `
        <article class="homer-default__message ${message.role === 'user' ? 'user' : 'assistant'} ${message.typing ? 'typing' : ''}" data-message-id="${escapeHtml(message.id)}">
          <div>${escapeHtml(message.content || (message.typing ? '正在生成…' : ''))}</div>
          <menu>${message.role === 'assistant' ? '<button data-action="continue">续写</button><button data-action="regenerate">重生成</button><button data-action="swipe-prev">‹</button><button data-action="swipe-next">›</button>' : ''}<button data-action="rollback">回溯</button></menu>
        </article>`).join('');
      list.scrollTop = list.scrollHeight;
    }
  };

  root.addEventListener('submit', event => {
    const form = event.target.closest?.('[data-composer]');
    if (!form) return;
    event.preventDefault();
    const field = form.querySelector('[data-draft]');
    const text = String(field?.value || '').trim();
    if (!text) return;
    api.send(text).then(() => { if (field) field.value = ''; }).catch(error => console.error(error));
  });
  root.addEventListener('keydown', event => {
    const field = event.target.closest?.('[data-draft]');
    if (!field || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    field.closest('form')?.requestSubmit();
  });
  root.addEventListener('input', event => {
    if (event.target.matches?.('[data-draft]')) api.setDraft(event.target.value).catch(() => {});
  });
  root.addEventListener('click', event => {
    const button = event.target.closest?.('[data-action]');
    const article = button?.closest?.('[data-message-id]');
    if (!button || !article) return;
    const id = article.dataset.messageId;
    const action = button.dataset.action;
    const task = action === 'continue' ? api.continue(id)
      : action === 'regenerate' ? api.regenerate(id)
      : action === 'swipe-prev' ? api.swipe(id, 'prev')
      : action === 'swipe-next' ? api.swipe(id, 'next')
      : action === 'rollback' ? api.rollback(id) : null;
    task?.catch?.(error => console.error(error));
  });

  const runScript = (source, label) => {
    const code = String(source || '').trim();
    if (!code) return;
    try {
      const runner = new Function(`${code}\n//# sourceURL=${label}`);
      runner.call(window);
    } catch (error) {
      setTimeout(() => { throw error; }, 0);
    }
  };
  inlineScripts.forEach((source, index) => runScript(source, `homer-card-inline-${index + 1}.js`));
  runScript(config.shell?.javascript, 'homer-card-shell.js');

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window.parent || message?.type !== 'homer.open-chat.connect' || message?.channel !== channel || !event.ports?.[0]) return;
    port = event.ports[0];
    port.onmessage = portEvent => {
      const payload = portEvent.data;
      if (!payload || payload.channel !== channel || payload.protocol !== 1) return;
      if (payload.type === 'state.replace') {
        const previous = state.current;
        state.current = payload.state;
        renderDefault(state.current || {});
        subscriptions.forEach(handler => { try { handler(state.current); } catch (error) { console.error(error); } });
        emit('STATE_CHANGED', state.current, previous);
        if (!previous) emit('APP_READY', state.current);
        else {
          if (previous.conversation?.id !== state.current?.conversation?.id) emit('CHAT_CHANGED', state.current?.conversation?.id);
          if (!previous.generation?.active && state.current?.generation?.active) emit('GENERATION_STARTED', state.current.generation);
          if (previous.generation?.active && !state.current?.generation?.active) emit('GENERATION_ENDED', state.current.generation);
        }
      } else if (payload.type === 'intent.result') {
        const item = pending.get(payload.requestId);
        if (!item) return;
        pending.delete(payload.requestId);
        clearTimeout(item.timer);
        if (payload.ok) item.resolve(payload.result);
        else item.reject(new Error(payload.error || 'Host intent failed'));
      }
    };
    port.start?.();
    port.postMessage({ protocol: 1, channel, type: 'runtime.ready' });
  });

  const reportError = error => {
    try {
      port?.postMessage({ protocol: 1, channel, type: 'runtime.error', error: String(error?.message || error || 'runtime error').slice(0, 500) });
    } catch { /* host will also time out */ }
  };
  window.addEventListener('error', event => reportError(event.error || event.message));
  window.addEventListener('unhandledrejection', event => reportError(event.reason));
  window.parent.postMessage({ protocol: 1, channel, type: 'homer.open-chat.bootstrap-ready' }, '*');
}

function buildSrcdoc(shell, card, channel) {
  const origin = location.origin.replace(/["'<>\s]/g, '');
  const allowedMedia = `${origin}/media-cache/ ${origin}/assets/ ${origin}/app/assets/`;
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${allowedMedia}`,
    `media-src data: blob: ${origin}/media-cache/`,
    `font-src data: ${origin}/assets/ ${origin}/app/assets/`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const payload = encodeBase64Utf8(JSON.stringify({
    protocol: PROTOCOL_VERSION,
    shell,
    character: {
      id: safeText(card?.id || card?.app_id, 160),
      name: safeText(card?.name || card?.app_name, 200),
    },
  }));
  const bootstrap = `(${iframeBootstrap.toString()})(${JSON.stringify(channel)},${JSON.stringify(payload)});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}"><title>${safeText(shell.name || 'Homer Chat Shell', 120)}</title></head><body><div id="homer-runtime-root"></div><script>${bootstrap}<\/script></body></html>`;
}

class OpenChatRuntimeHost {
  constructor() {
    this.root = null;
    this.frame = null;
    this.port = null;
    this.controller = null;
    this.card = null;
    this.shell = null;
    this.channel = '';
    this.ready = false;
    this.lastStateSignature = '';
    this.syncTimer = null;
    this.readyTimer = null;
    this.messageHandler = event => this.onWindowMessage(event);
    this.onExit = null;
  }

  ensureParentStyle() {
    if (document.getElementById('open-chat-runtime-style')) return;
    const style = document.createElement('style');
    style.id = 'open-chat-runtime-style';
    style.textContent = PARENT_STYLE;
    document.head.appendChild(style);
  }

  mount(card, controller, options = {}) {
    const experience = normalizeCardExperience(card?.card_experience);
    const shell = experience.chat_shell;
    if (!shell?.enabled || !controller) {
      this.destroy('disabled');
      return false;
    }
    this.destroy('remount');
    this.ensureParentStyle();
    this.controller = controller;
    this.card = card && typeof card === 'object' ? card : {};
    this.shell = shell;
    this.channel = randomToken();
    this.onExit = typeof options.onExit === 'function' ? options.onExit : null;

    const root = document.createElement('section');
    root.className = 'open-chat-runtime-root';
    root.setAttribute('aria-label', shell.name || '角色卡聊天界面');
    const status = document.createElement('div');
    status.className = 'open-chat-runtime-status';
    status.textContent = '正在载入角色卡界面…';
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.className = 'open-chat-runtime-exit';
    exit.textContent = '退出卡片界面';
    exit.addEventListener('click', () => this.exit('user'));
    const frame = document.createElement('iframe');
    frame.className = 'open-chat-runtime-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', shell.name || '角色卡聊天界面');
    root.append(status, frame, exit);
    this.root = root;
    this.frame = frame;
    window.addEventListener('message', this.messageHandler);
    document.body.appendChild(root);
    frame.srcdoc = buildSrcdoc(shell, this.card, this.channel);
    this.readyTimer = setTimeout(() => this.fail('角色卡界面启动超时'), 3500);
    this.syncTimer = setInterval(() => this.syncState(), 180);
    return true;
  }

  onWindowMessage(event) {
    const message = event.data;
    if (!this.frame || event.source !== this.frame.contentWindow || message?.channel !== this.channel) return;
    if (message?.type !== 'homer.open-chat.bootstrap-ready') return;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = portEvent => this.onPortMessage(portEvent.data);
    this.port.start?.();
    this.frame.contentWindow.postMessage({
      protocol: PROTOCOL_VERSION,
      channel: this.channel,
      type: 'homer.open-chat.connect',
    }, '*', [channel.port2]);
  }

  onPortMessage(message) {
    if (!message || message.channel !== this.channel || message.protocol !== PROTOCOL_VERSION) return;
    if (message.type === 'runtime.ready') {
      this.ready = true;
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.root?.querySelector('.open-chat-runtime-status')?.remove();
      this.syncState(true);
      return;
    }
    if (message.type === 'runtime.error') {
      this.fail(message.error || '角色卡界面脚本异常');
      return;
    }
    if (message.type === 'intent') this.handleIntent(message);
  }

  capabilities() {
    const declared = Array.isArray(this.shell?.permissions) ? this.shell.permissions : [];
    return [...new Set([...BASE_CAPABILITIES, ...declared])];
  }

  buildState() {
    const controller = this.controller || {};
    const messages = (Array.isArray(controller.messages) ? controller.messages : []).map((message, index) => ({
      id: safeText(message?.id || message?._localKey, 180),
      index,
      role: ['user', 'assistant', 'system'].includes(message?.role) ? message.role : 'assistant',
      content: String(message?.content || ''),
      created_at: message?.created_at || null,
      swipes: Array.isArray(message?.swipes) ? message.swipes.map(item => String(item == null ? '' : item)) : [],
      swipe_index: Number.isFinite(Number(message?.swipe_index)) ? Number(message.swipe_index) : 0,
      typing: !!message?._typing,
    }));
    const user = controller.user || {};
    return {
      protocol: PROTOCOL_VERSION,
      capabilities: this.capabilities(),
      conversation: controller.conversation ? {
        id: safeText(controller.conversation.id, 180),
        app_id: safeText(controller.conversation.app_id || controller.appId, 180),
        version_id: safeText(controller.conversation.version_id, 180),
        title: safeText(controller.conversation.title, 240),
        has_older_messages: !!controller.hasOlderMessages,
        message_total: Number(controller.messageTotal || messages.length),
      } : null,
      character: {
        id: safeText(controller.appId || this.card?.id || this.card?.app_id, 180),
        name: safeText(controller.appName || this.card?.name || this.card?.app_name, 240),
        description: safeText(controller.appDesc || this.card?.description || this.card?.summary, 1200),
        avatar: safeText(controller.appIcon || this.card?.icon || this.card?.cover, 2048),
        background: safeText(controller.appHero || this.card?.bg_url || this.card?.cover, 2048),
      },
      user: {
        name: safeText(user.nickname || user.name || user.username || user.email || 'User', 240),
        avatar: safeText(user.avatar || user.avatar_url, 2048),
      },
      messages,
      composer: {
        draft: String(controller.draft || ''),
        disabled: !!controller.replying || !controller.appId,
      },
      generation: {
        active: !!controller.replying,
        mode: safeText(controller.generationMode, 40),
        phase: safeText(controller.generationPhase, 40),
        elapsed: Number(controller.generationElapsedSeconds || 0),
        label: typeof controller.generationStatusLabel === 'function' ? safeText(controller.generationStatusLabel(), 240) : '',
      },
      model: { current_id: safeText(controller.currentModelId, 180) },
      points: Number(controller.points || 0),
    };
  }

  stateSignature(state) {
    const messageSignature = state.messages.map(message => [
      message.id, message.role, hashText(message.content), message.swipe_index,
      message.swipes.length, message.typing ? 1 : 0,
    ].join(':')).join('|');
    return [
      state.conversation?.id || '', state.conversation?.message_total || 0,
      hashText(messageSignature), hashText(state.composer.draft),
      state.generation.active ? 1 : 0, state.generation.mode, state.generation.phase,
      state.generation.elapsed, state.points,
    ].join('~');
  }

  syncState(force = false) {
    if (!this.ready || !this.port || !this.controller) return;
    const state = this.buildState();
    const signature = this.stateSignature(state);
    if (!force && signature === this.lastStateSignature) return;
    this.lastStateSignature = signature;
    this.port.postMessage({
      protocol: PROTOCOL_VERSION,
      channel: this.channel,
      type: 'state.replace',
      state,
    });
  }

  findMessage(messageId, { assistant = false, persisted = false } = {}) {
    const messages = Array.isArray(this.controller?.messages) ? this.controller.messages : [];
    let message = messages.find(item => String(item?.id) === String(messageId));
    if (!message && assistant) message = [...messages].reverse().find(item => item?.role === 'assistant');
    if (!message) throw new Error('消息不存在或已切换会话');
    if (persisted && (message._typing || String(message.id || '').startsWith('stream-') || String(message.id || '').startsWith('tmp-'))) {
      throw new Error('消息尚未完成保存');
    }
    return message;
  }

  assertIntent(message) {
    const raw = serializableClone(message);
    if (!raw) throw new Error('无效请求');
    if (JSON.stringify(raw).length > MAX_INTENT_BYTES) throw new Error('请求内容过长');
    const capability = INTENT_CAPABILITY[message.intent];
    if (!capability || !this.capabilities().includes(capability)) throw new Error('角色卡未声明此项能力');
  }

  async routeIntent(intent, payload = {}) {
    const controller = this.controller;
    if (!controller) throw new Error('聊天控制器不可用');
    if (intent === 'send') {
      const text = safeText(payload.text).trim();
      if (!text) throw new Error('发送内容不能为空');
      await controller.sendMessage(text);
    } else if (intent === 'continue') {
      await controller.continueMessage(this.findMessage(payload.message_id, { assistant: true, persisted: true }));
    } else if (intent === 'regenerate') {
      await controller.regenerate(this.findMessage(payload.message_id, { assistant: true, persisted: true }));
    } else if (intent === 'swipe') {
      const message = this.findMessage(payload.message_id, { assistant: true, persisted: true });
      if (String(payload.direction).toLowerCase() === 'prev') await controller.swipePrev(message);
      else await controller.swipeNext(message);
    } else if (intent === 'edit') {
      const message = this.findMessage(payload.message_id, { persisted: true });
      const text = safeText(payload.text).trim();
      if (!text) throw new Error('消息内容不能为空');
      controller.editingId = message.id;
      controller.editingText = text;
      await controller.saveEdit(message);
    } else if (intent === 'delete') {
      await controller.deleteMessage(this.findMessage(payload.message_id, { persisted: true }));
    } else if (intent === 'rollback') {
      await controller.rollbackMessage(this.findMessage(payload.message_id, { persisted: true }));
    } else if (intent === 'load_older') {
      await controller.loadOlderMessages();
    } else if (intent === 'tts') {
      await controller.speakMessage(this.findMessage(payload.message_id, { assistant: true, persisted: true }));
    } else if (intent === 'set_draft') {
      controller.draft = safeText(payload.text);
    } else if (intent === 'stop_generation') {
      controller.cancelActiveGeneration();
    } else if (intent === 'open_settings') {
      this.exit('settings');
      setTimeout(() => { controller.rightMenuOpen = true; controller.listOpen = false; }, 0);
    } else if (intent === 'exit') {
      this.exit('runtime');
    } else if (intent === 'slash') {
      throw new Error('Slash 命令应由 iframe 兼容层解析后调用具体能力');
    } else {
      throw new Error('未知运行时请求');
    }
    return { ok: true };
  }

  async handleIntent(message) {
    const requestId = safeText(message.requestId, 180);
    try {
      this.assertIntent(message);
      const result = await this.routeIntent(message.intent, message.payload || {});
      this.port?.postMessage({ protocol: 1, channel: this.channel, type: 'intent.result', requestId, ok: true, result });
      this.syncState(true);
    } catch (error) {
      this.port?.postMessage({
        protocol: 1, channel: this.channel, type: 'intent.result', requestId, ok: false,
        error: safeText(error?.message || error || '操作失败', 500),
      });
    }
  }

  fail(reason) {
    console.warn('[OpenChatRuntime] fallback:', reason);
    this.destroy('error');
  }

  exit(reason = 'exit') {
    const callback = this.onExit;
    this.destroy(reason);
    try { callback?.(reason); } catch { /* noop */ }
  }

  destroy(reason = 'destroy') {
    clearInterval(this.syncTimer);
    clearTimeout(this.readyTimer);
    this.syncTimer = null;
    this.readyTimer = null;
    window.removeEventListener('message', this.messageHandler);
    try { this.port?.close(); } catch { /* noop */ }
    this.port = null;
    this.frame?.remove();
    this.root?.remove();
    this.root = null;
    this.frame = null;
    this.ready = false;
    this.lastStateSignature = '';
    this.controller = null;
    this.card = null;
    this.shell = null;
    this.channel = '';
    if (reason !== 'remount') this.onExit = null;
  }
}

const runtime = new OpenChatRuntimeHost();

export function mountOpenChatRuntime(card, controller, options) {
  return runtime.mount(card, controller, options);
}

export function syncOpenChatRuntime(force = false) {
  runtime.syncState(force);
}

export function destroyOpenChatRuntime(reason = 'destroy') {
  runtime.destroy(reason);
}

export function openChatRuntimeDebugState() {
  return {
    mounted: !!runtime.root,
    ready: runtime.ready,
    channel: runtime.channel ? '[active]' : '',
    sandbox: runtime.frame?.getAttribute('sandbox') || '',
    capabilities: runtime.capabilities(),
  };
}

if (typeof window !== 'undefined') {
  window.__xyOpenChatRuntime = {
    mount: mountOpenChatRuntime,
    sync: syncOpenChatRuntime,
    destroy: destroyOpenChatRuntime,
    debug: openChatRuntimeDebugState,
  };
}
