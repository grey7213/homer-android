import {
    eventSource,
    event_types,
    sendTextareaMessage,
} from '../../../script.js';
import { executeSlashCommandsWithOptions } from '../../slash-commands.js';
import { getContext } from '../../st-context.js';

const CHANNEL = 'homer:roleplayhub:v1';
const MAX_SLASH_LENGTH = 100_000;
const MAX_FRAME_HEIGHT = 1200;
const MIN_FRAME_HEIGHT = 220;
const frames = new Map();

let installed = false;
let renderTimer = null;
let commandBusy = false;
let player = null;
let playerIndex = 0;
let playerMode = 'all';

function currentCharacter() {
    const context = getContext();
    return context.characters?.[context.characterId] || null;
}

function roleplayHubExtensions(character = currentCharacter()) {
    const extensions = character?.data?.extensions;
    return extensions && typeof extensions === 'object' ? extensions : {};
}

export function isRoleplayHubCharacter(character = currentCharacter()) {
    const extensions = roleplayHubExtensions(character);
    return Boolean(
        extensions.rp_hub_watermark
        || extensions.homer_roleplayhub?.source === 'roleplayhub'
        || Array.isArray(extensions.rp_hub_ui_templates)
        || Array.isArray(character?.data?.uiTemplates),
    );
}

function isHtmlDocument(value) {
    return /<!doctype\s+html|<html(?:\s|>)/i.test(String(value || ''));
}

function parseRegexLiteral(value, explicitFlags = '') {
    const input = String(value || '').trim();
    let pattern = input;
    let flags = String(explicitFlags || '');
    if (input.startsWith('/')) {
        let escaped = false;
        for (let index = input.length - 1; index > 0; index -= 1) {
            const character = input[index];
            if (character === '/' && !escaped) {
                const possibleFlags = input.slice(index + 1);
                if (/^[gimsuy]*$/.test(possibleFlags)) {
                    pattern = input.slice(1, index).replaceAll('\\/', '/');
                    flags = possibleFlags || flags;
                }
                break;
            }
            escaped = character === '\\' && !escaped;
            if (character !== '\\') {
                escaped = false;
            }
        }
    }
    flags = [...new Set(String(flags || '').toLowerCase().match(/[gimsuy]/g) || [])].join('');
    return { pattern, flags };
}

function regexReplacement(script) {
    if (script?.replaceString !== undefined) {
        return String(script.replaceString);
    }
    if (script?.replacement !== undefined) {
        return String(script.replacement);
    }
    return String(script?.replace || '');
}

function regexPattern(script) {
    return script?.findRegex ?? script?.regex ?? script?.find ?? script?.pattern ?? '';
}

function regexEnabledForDisplay(script, depth) {
    if (!script || script.disabled === true || script.enabled === false) {
        return false;
    }
    const placement = Array.isArray(script.placement) ? script.placement.map(Number) : [2];
    if (!placement.includes(2)) {
        return false;
    }
    if (script.promptOnly && !script.markdownOnly) {
        return false;
    }
    if (script.minDepth !== null && script.minDepth !== undefined && depth < Number(script.minDepth)) {
        return false;
    }
    if (script.maxDepth !== null && script.maxDepth !== undefined && depth > Number(script.maxDepth)) {
        return false;
    }
    return true;
}

export function applyRoleplayHubRegexes(text, scripts, depth = 0) {
    let output = String(text || '');
    for (const script of Array.isArray(scripts) ? scripts : []) {
        if (!regexEnabledForDisplay(script, depth)) {
            continue;
        }
        const replacement = regexReplacement(script);
        // Once a message has become an executable document, ordinary highlight
        // rules must not rewrite JavaScript or CSS inside it. A subsequent
        // document-producing rule may still append a companion document.
        if (isHtmlDocument(output) && !isHtmlDocument(replacement)) {
            continue;
        }
        const parsed = parseRegexLiteral(regexPattern(script), script.flags || script.regexFlags);
        if (!parsed.pattern) {
            continue;
        }
        try {
            const regex = new RegExp(parsed.pattern, parsed.flags);
            output = output.replace(regex, replacement.replace(/{{match}}/gi, '$&'));
        } catch (error) {
            console.warn('RoleplayHub Regex skipped:', script.scriptName || script.name || '', error?.message || error);
        }
    }
    return output;
}

function htmlDocuments(value) {
    const text = String(value || '');
    if (!isHtmlDocument(text)) {
        return [];
    }
    const matches = text.match(/(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s[^>]*)?>[\s\S]*?<\/html>/gi);
    return matches?.length ? matches : [text];
}

function variableSnapshot() {
    const context = getContext();
    const source = context.chatMetadata?.variables;
    const variables = {};
    for (const [key, rawValue] of Object.entries(source && typeof source === 'object' ? source : {})) {
        try {
            variables[key] = JSON.parse(rawValue);
        } catch {
            variables[key] = rawValue;
        }
    }
    return variables;
}

function bridgeSource(token) {
    const initialVariables = JSON.stringify(variableSnapshot()).replaceAll('<', '\\u003c');
    return `
(() => {
  const channel = ${JSON.stringify(CHANNEL)};
  const token = ${JSON.stringify(token)};
  let variables = ${initialVariables};
  const post = (action, value) => parent.postMessage({ channel, token, action, value }, '*');
  window.triggerSlash = value => post('slash', String(value || ''));
  window.getVariables = options => {
    const type = String(options?.type || 'chat');
    return type === 'global' ? {} : JSON.parse(JSON.stringify(variables));
  };
  window.RoleplayHubBridge = Object.freeze({
    triggerSlash: window.triggerSlash,
    getVariables: window.getVariables,
  });
  window.TavernHelper = window.TavernHelper || window.RoleplayHubBridge;
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.channel !== channel || data.token !== token || data.action !== 'variables') return;
    variables = data.value && typeof data.value === 'object' ? data.value : {};
  });
  const resize = () => {
    const body = document.body;
    const html = document.documentElement;
    const height = Math.max(
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      html?.scrollHeight || 0,
      html?.offsetHeight || 0,
    );
    post('resize', height);
  };
  window.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', event => {
      const target = event.target?.closest?.('[data-slash]');
      const command = target?.getAttribute?.('data-slash');
      if (!command) return;
      event.preventDefault();
      window.triggerSlash(command);
    });
    resize();
    setTimeout(resize, 100);
    setTimeout(resize, 500);
  });
  window.addEventListener('load', resize);
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(resize);
    window.addEventListener('DOMContentLoaded', () => observer.observe(document.documentElement));
  }
})();
`;
}

export function repairRoleplayHubInlineScripts(source) {
    return String(source || '').replace(
        /(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi,
        (match, openTag, attributes, scriptBody, closeTag) => {
            if (/\bsrc\s*=/i.test(attributes)) {
                return match;
            }
            const repairedBody = scriptBody.replace(
                /(<[a-z][^<>]*\sstyle=)"([^"]*)"/gi,
                '$1&quot;$2&quot;',
            );
            return `${openTag}${repairedBody}${closeTag}`;
        },
    );
}

function buildSandboxDocument(source, token) {
    const policy = [
        'default-src \'none\'',
        'script-src \'unsafe-inline\' https://unpkg.com https://cdn.jsdelivr.net',
        'style-src \'unsafe-inline\' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net',
        'font-src data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net',
        'img-src data: blob: https:',
        'media-src data: blob: https://raw.githubusercontent.com https://cdn.jsdelivr.net',
        'connect-src \'none\'',
        'frame-src \'none\'',
        'object-src \'none\'',
        'base-uri \'none\'',
        'form-action \'none\'',
    ].join('; ');
    const injected = [
        '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">',
        `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
        '<style>html,body{max-width:100%;margin:0;overflow-x:hidden}*,*::before,*::after{box-sizing:border-box}img,video,canvas,svg{max-width:100%;height:auto}</style>',
        `<script>${bridgeSource(token)}</script>`,
    ].join('');
    const html = repairRoleplayHubInlineScripts(source);
    if (/<head(?:\s[^>]*)?>/i.test(html)) {
        return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${injected}`);
    }
    if (/<html(?:\s[^>]*)?>/i.test(html)) {
        return html.replace(/<html(?:\s[^>]*)?>/i, match => `${match}<head>${injected}</head>`);
    }
    return `<!doctype html><html><head>${injected}</head><body>${html}</body></html>`;
}

function unregisterFrame(iframe) {
    for (const [token, record] of frames.entries()) {
        if (record.iframe === iframe) {
            frames.delete(token);
        }
    }
}

function createSandboxFrame(documentSource, messageId, documentIndex) {
    const token = crypto.randomUUID();
    const iframe = document.createElement('iframe');
    iframe.className = 'homer-roleplayhub-frame';
    iframe.title = `RoleplayHub 互动内容 ${documentIndex + 1}`;
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('allow', 'autoplay');
    iframe.dataset.messageId = String(messageId);
    iframe.style.height = `${MIN_FRAME_HEIGHT}px`;
    iframe.srcdoc = buildSandboxDocument(documentSource, token);
    iframe.addEventListener('load', () => {
        iframe.contentWindow?.postMessage({
            channel: CHANNEL,
            token,
            action: 'variables',
            value: variableSnapshot(),
        }, '*');
    });
    iframe.addEventListener('DOMNodeRemoved', () => unregisterFrame(iframe), { once: true });
    frames.set(token, { iframe, messageId });
    return iframe;
}

function messageElement(messageId) {
    return document.querySelector(`.mes[mesid="${CSS.escape(String(messageId))}"]`);
}

export function renderRoleplayHubMessage(messageId) {
    const character = currentCharacter();
    if (!isRoleplayHubCharacter(character)) {
        return false;
    }
    const context = getContext();
    const message = context.chat?.[Number(messageId)];
    if (!message || message.is_user || message.is_system) {
        return false;
    }
    const raw = String(message.mes || '');
    const scripts = roleplayHubExtensions(character).regex_scripts;
    const depth = Math.max(0, context.chat.length - 1 - Number(messageId));
    const transformed = isHtmlDocument(raw)
        ? raw
        : applyRoleplayHubRegexes(raw, scripts, depth);
    const documents = htmlDocuments(transformed).filter(documentSource => {
        // RoleplayHub sometimes emits a hidden document whose only job is to
        // mutate parent.document. The isolated host player below replaces that
        // unsafe behavior using the server-validated playlist.
        return !/(?:window\.)?parent\.document|window\.parent\.(?:document|top)/i.test(documentSource);
    });
    if (!documents.length) {
        return false;
    }
    const element = messageElement(messageId);
    const text = element?.querySelector('.mes_text');
    if (!(text instanceof HTMLElement)) {
        return false;
    }
    const signature = `${raw.length}:${raw.slice(0, 80)}:${documents.length}`;
    if (text.dataset.homerRoleplayhubSignature === signature) {
        return true;
    }
    for (const iframe of text.querySelectorAll('iframe.homer-roleplayhub-frame')) {
        unregisterFrame(iframe);
    }
    text.replaceChildren();
    const container = document.createElement('div');
    container.className = 'homer-roleplayhub-documents';
    documents.forEach((documentSource, index) => {
        container.appendChild(createSandboxFrame(documentSource, messageId, index));
    });
    text.appendChild(container);
    text.dataset.homerRoleplayhubSignature = signature;
    element?.classList.add('homer-roleplayhub-message');
    return true;
}

function scheduleRender(messageId = null) {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
        renderTimer = null;
        if (!isRoleplayHubCharacter()) {
            removePlayer();
            return;
        }
        if (messageId !== null && messageId !== undefined) {
            renderRoleplayHubMessage(Number(messageId));
        } else {
            document.querySelectorAll('.mes[mesid]').forEach(element => {
                renderRoleplayHubMessage(Number(element.getAttribute('mesid')));
            });
        }
        syncPlayer();
    }, 50);
}

async function handleSlashPayload(value) {
    const input = String(value || '').slice(0, MAX_SLASH_LENGTH);
    if (!input.trim() || commandBusy || !isRoleplayHubCharacter()) {
        return;
    }
    commandBusy = true;
    try {
        const visible = [];
        for (const rawLine of input.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            if (/^\/setvar(?:\s|$)/i.test(line)) {
                await executeSlashCommandsWithOptions(line, { handleParserErrors: true });
                continue;
            }
            const visibleCommand = line.match(/^\/(?:ooc|send|echo)\s+([\s\S]*)$/i);
            if (visibleCommand) {
                visible.push(visibleCommand[1]);
                continue;
            }
            const sendAs = line.match(/^\/sendas(?:\s+\S+)?\s+([\s\S]*)$/i);
            if (sendAs) {
                visible.push(sendAs[1]);
                continue;
            }
            if (!line.startsWith('/')) {
                visible.push(rawLine);
            }
        }
        const message = visible.join('\n').trim();
        broadcastVariables();
        if (!message) {
            return;
        }
        const textarea = document.querySelector('#send_textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) {
            throw new Error('对话输入框尚未就绪');
        }
        textarea.value = message;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await sendTextareaMessage();
    } catch (error) {
        console.warn('RoleplayHub command bridge failed:', error?.message || error);
        window.toastr?.warning?.('角色卡操作未能完成，请稍后再试');
    } finally {
        commandBusy = false;
    }
}

function broadcastVariables() {
    const value = variableSnapshot();
    for (const [token, record] of frames.entries()) {
        record.iframe.contentWindow?.postMessage({
            channel: CHANNEL,
            token,
            action: 'variables',
            value,
        }, '*');
    }
}

function onBridgeMessage(event) {
    const data = event.data;
    if (!data || data.channel !== CHANNEL || typeof data.token !== 'string') {
        return;
    }
    const record = frames.get(data.token);
    if (!record || record.iframe.contentWindow !== event.source || !isRoleplayHubCharacter()) {
        return;
    }
    if (data.action === 'resize') {
        const height = Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Number(data.value) || MIN_FRAME_HEIGHT));
        record.iframe.style.height = `${Math.ceil(height)}px`;
        record.iframe.classList.toggle('is-scrollable', Number(data.value) > MAX_FRAME_HEIGHT);
        return;
    }
    if (data.action === 'slash') {
        void handleSlashPayload(data.value);
    }
}

function playlist() {
    const profile = roleplayHubExtensions().homer_roleplayhub;
    const items = Array.isArray(profile?.media_playlist) ? profile.media_playlist : [];
    return items.filter(item => item && typeof item.url === 'string' && item.url.startsWith('https://'));
}

function removePlayer() {
    if (!player) {
        return;
    }
    player.audio.pause();
    player.root.remove();
    player = null;
    playerIndex = 0;
}

function updatePlayerTrack(autoplay = false) {
    if (!player) {
        return;
    }
    const items = playlist();
    if (!items.length) {
        removePlayer();
        return;
    }
    playerIndex = ((playerIndex % items.length) + items.length) % items.length;
    const track = items[playerIndex];
    player.title.textContent = String(track.title || `BGM ${playerIndex + 1}`);
    player.counter.textContent = `${playerIndex + 1} / ${items.length}`;
    player.audio.src = track.url;
    player.audio.loop = playerMode === 'one';
    if (autoplay) {
        void player.audio.play().catch(() => {
            player.play.textContent = '播放';
        });
    }
}

function advancePlayer(direction = 1, autoplay = true) {
    const items = playlist();
    if (!items.length) {
        return;
    }
    if (playerMode === 'shuffle' && items.length > 1) {
        let next = playerIndex;
        while (next === playerIndex) {
            next = Math.floor(Math.random() * items.length);
        }
        playerIndex = next;
    } else {
        playerIndex += direction;
    }
    updatePlayerTrack(autoplay);
}

function createPlayer() {
    const root = document.createElement('section');
    root.id = 'homerRoleplayHubPlayer';
    root.className = 'homer-roleplayhub-player';
    root.innerHTML = `
      <button id="homerRoleplayHubBall" class="homer-roleplayhub-player__ball" type="button" aria-label="打开角色卡音乐播放器" aria-expanded="false">♫</button>
      <div id="homerRoleplayHubMenu" class="homer-roleplayhub-player__menu" hidden>
        <div class="homer-roleplayhub-player__heading">
          <span>角色卡音乐</span>
          <small id="homerRoleplayHubCounter"></small>
        </div>
        <strong id="homerRoleplayHubTitle"></strong>
        <div class="homer-roleplayhub-player__controls">
          <button id="homerRoleplayHubPrev" type="button" aria-label="上一首">‹</button>
          <button id="homerRoleplayHubPlay" type="button">播放</button>
          <button id="homerRoleplayHubNext" type="button" aria-label="下一首">›</button>
          <button id="homerRoleplayHubMode" type="button">顺序</button>
        </div>
      </div>
      <audio id="homerRoleplayHubAudio" preload="none"></audio>
    `;
    document.body.appendChild(root);
    const result = {
        root,
        ball: root.querySelector('#homerRoleplayHubBall'),
        menu: root.querySelector('#homerRoleplayHubMenu'),
        title: root.querySelector('#homerRoleplayHubTitle'),
        counter: root.querySelector('#homerRoleplayHubCounter'),
        play: root.querySelector('#homerRoleplayHubPlay'),
        audio: root.querySelector('#homerRoleplayHubAudio'),
    };
    result.ball.addEventListener('click', () => {
        const open = result.menu.hidden;
        result.menu.hidden = !open;
        result.ball.setAttribute('aria-expanded', String(open));
    });
    root.querySelector('#homerRoleplayHubPrev').addEventListener('click', () => advancePlayer(-1));
    root.querySelector('#homerRoleplayHubNext').addEventListener('click', () => advancePlayer(1));
    result.play.addEventListener('click', () => {
        if (result.audio.paused) {
            void result.audio.play().then(() => {
                result.play.textContent = '暂停';
            }).catch(() => {
                result.play.textContent = '播放';
            });
        } else {
            result.audio.pause();
            result.play.textContent = '播放';
        }
    });
    root.querySelector('#homerRoleplayHubMode').addEventListener('click', event => {
        const modes = ['all', 'one', 'shuffle'];
        playerMode = modes[(modes.indexOf(playerMode) + 1) % modes.length];
        event.currentTarget.textContent = { all: '顺序', one: '单曲', shuffle: '随机' }[playerMode];
        result.audio.loop = playerMode === 'one';
    });
    result.audio.addEventListener('pause', () => {
        result.play.textContent = '播放';
    });
    result.audio.addEventListener('play', () => {
        result.play.textContent = '暂停';
    });
    result.audio.addEventListener('ended', () => {
        if (playerMode !== 'one') {
            advancePlayer(1);
        }
    });
    return result;
}

function syncPlayer() {
    if (!isRoleplayHubCharacter() || !playlist().length) {
        removePlayer();
        return;
    }
    if (!player) {
        player = createPlayer();
        playerIndex = 0;
        updatePlayerTrack(false);
    }
}

export function installRoleplayHubCompatibility() {
    if (installed) {
        return;
    }
    installed = true;
    window.addEventListener('message', onBridgeMessage);
    const renderEvents = [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
    ];
    renderEvents.forEach(event => eventSource.on(event, messageId => scheduleRender(messageId)));
    [event_types.CHAT_LOADED, event_types.CHAT_CHANGED].forEach(event => {
        eventSource.on(event, () => scheduleRender());
    });
    window.__homerRoleplayHubCompatibility = {
        version: 1,
        refresh: () => scheduleRender(),
        isActive: () => isRoleplayHubCharacter(),
        sandbox: 'allow-scripts',
    };
    scheduleRender();
}
