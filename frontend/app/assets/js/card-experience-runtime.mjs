import {
  normalizeCardExperience,
  normalizeMediaAssets,
  normalizeMediaAssetsWithLimit,
  normalizeMediaBindings,
  parseGalgameDirectives,
  safeRegExp,
  stripExperienceDirectives,
} from './card-experience-schema.mjs?v=20260821-chatarchive-bundle-v1';
import { SpinePortraitLayer, spineManifestOf } from './spine-portrait.mjs?v=20260802-stage-shell';

const BLOCKED_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'BASE', 'FORM', 'META', 'LINK']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'poster']);
const REGEX_WORKER_URL = new URL('./card-experience-regex-worker.mjs?v=20260815-persistent-worker', import.meta.url);
const BUNDLE_ASSET_LIMIT = 1000;
const BUNDLE_PATH_PREFIX = '/media-cache/card-assets/ready/';
let regexWorker = null;

function sameOriginBundleUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(BUNDLE_PATH_PREFIX)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function resolveBundleAsset(raw, manifestUrl) {
  if (!raw || typeof raw !== 'object') return null;
  const resolveUrl = (value) => sameOriginBundleUrl(new URL(String(value || ''), manifestUrl).href);
  const url = resolveUrl(raw.url || raw.public_url);
  if (!url) return null;
  const metadata = raw.metadata && typeof raw.metadata === 'object'
    ? JSON.parse(JSON.stringify(raw.metadata))
    : {};
  if (metadata.spine && typeof metadata.spine === 'object') {
    const source = metadata.spine;
    metadata.spine = {
      ...source,
      manifest_url: source.manifest_url ? resolveUrl(source.manifest_url) : '',
      skeleton_url: source.skeleton_url ? resolveUrl(source.skeleton_url) : '',
      atlas_url: source.atlas_url ? resolveUrl(source.atlas_url) : '',
      textures: (Array.isArray(source.textures) ? source.textures : []).map(resolveUrl).filter(Boolean).slice(0, 96),
      preview_texture: source.preview_texture ? resolveUrl(source.preview_texture) : '',
    };
  }
  return { ...raw, url, public_url: url, metadata, status: 'ready' };
}
let regexWorkerIsCold = false;
let regexRequestId = 0;
const regexPending = new Map();

function stopRegexWorker() {
  regexWorker?.terminate();
  regexWorker = null;
  regexWorkerIsCold = false;
  for (const pending of regexPending.values()) pending.finish([]);
  regexPending.clear();
}

function ensureRegexWorker() {
  if (regexWorker) return regexWorker;
  regexWorker = new Worker(REGEX_WORKER_URL, { type: 'module', name: 'homer-card-experience-regex' });
  regexWorkerIsCold = true;
  regexWorker.onmessage = (event) => {
    const id = Number(event?.data?.id);
    const pending = regexPending.get(id);
    if (!pending) return;
    regexWorkerIsCold = false;
    pending.finish(event?.data?.matches);
  };
  regexWorker.onerror = () => stopRegexWorker();
  return regexWorker;
}

function timedRegexMatches(patterns, input, timeoutMs = 250) {
  const safePatterns = Array.isArray(patterns) ? patterns.slice(0, 60) : [];
  if (!safePatterns.length) return Promise.resolve([]);
  if (typeof Worker === 'undefined') {
    return Promise.resolve(safePatterns.map((item) => {
      const regex = safeRegExp(item?.pattern, item?.flags);
      return !!(regex && regex.test(String(input || '').slice(-4096)));
    }));
  }
  return new Promise((resolve) => {
    let worker;
    try {
      worker = ensureRegexWorker();
    } catch {
      resolve(safePatterns.map((item) => {
        const regex = safeRegExp(item?.pattern, item?.flags);
        return !!(regex && regex.test(String(input || '').slice(-4096)));
      }));
      return;
    }
    const requestId = ++regexRequestId;
    let finished = false;
    const finish = (matches) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      regexPending.delete(requestId);
      resolve(Array.isArray(matches) ? matches : safePatterns.map(() => false));
    };
    regexPending.set(requestId, { finish });
    const timer = setTimeout(() => {
      finish([]);
      stopRegexWorker();
    }, regexWorkerIsCold ? Math.max(timeoutMs, 1_000) : timeoutMs);
    worker.postMessage({ id: requestId, patterns: safePatterns, input: String(input || '').slice(-8192) });
  });
}

function safeUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.startsWith('/') && !input.startsWith('//')) return input;
  if (/^https:\/\//i.test(input)) return input;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(input)) return input;
  return '';
}

function normalizeLegacyRpHub(value) {
  if (!value || typeof value !== 'object') return { bgm_playlist: [] };
  const seen = new Set();
  const bgmPlaylist = (Array.isArray(value.bgm_playlist) ? value.bgm_playlist : []).slice(0, 20).map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    const url = String(item.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'raw.githubusercontent.com' || !/\.(?:mp3|ogg|wav|m4a)$/i.test(parsed.pathname)) return null;
    if (seen.has(url)) return null;
    seen.add(url);
    return {
      id: `legacy-rp-bgm-${index + 1}`,
      kind: 'bgm',
      name: String(item.title || item.name || `BGM ${index + 1}`).trim().slice(0, 120),
      url,
      mime_type: parsed.pathname.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/*',
      status: 'ready',
      metadata: { source: 'legacy-rp-hub' },
    };
  }).filter(Boolean);
  return { bgm_playlist: bgmPlaylist };
}

export function sanitizeCardHtml(html) {
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(`<div id="card-root">${String(html || '').slice(0, 50000)}</div>`, 'text/html');
  const root = doc.getElementById('card-root');
  if (!root) return '';
  for (const element of [...root.querySelectorAll('*')]) {
    if (BLOCKED_ELEMENTS.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
        element.removeAttribute(attr.name);
      } else if (URL_ATTRIBUTES.has(name)) {
        const url = safeUrl(attr.value);
        if (url) element.setAttribute(attr.name, url);
        else element.removeAttribute(attr.name);
      }
    }
    if (element.tagName === 'A') {
      element.setAttribute('rel', 'noopener noreferrer');
      element.setAttribute('target', '_blank');
    }
  }
  return root.innerHTML;
}

export function sanitizeScopedCss(css) {
  let output = String(css || '').slice(0, 30000);
  output = output.replace(/@(?:import|charset|namespace)[^;]*;/gi, '');
  output = output.replace(/@font-face\s*\{[\s\S]*?\}/gi, '');
  output = output.replace(/url\s*\([^)]*\)/gi, 'none');
  output = output.replace(/(?:expression|behavior|-moz-binding)\s*:[^;}]*/gi, '');
  output = output.replace(/<\/style/gi, '<\\/style');
  return output;
}

function template(value, context) {
  const data = {
    message: context.message || '',
    character: context.card?.name || '',
    'world.name': context.world?.name || '',
    // Worldbook prose never enters author-visible panels. Cards can bind a
    // public label or a media scene ID, but protected prompt text stays out.
    'world.content': '',
  };
  return String(value || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => escapeText(data[key] ?? ''));
}

const BASE_STYLE = `
  :host { position: fixed; inset: 0; display: block; width: 100vw; height: 100dvh; --ce-z: 70; font-family: inherit; color-scheme: dark; pointer-events: none; }
  *, *::before, *::after { box-sizing: border-box; }
  .ce-stage { position: absolute; inset: 0; width: 100%; height: 100%; min-height: 100%; z-index: var(--ce-z); pointer-events: none; }
  .ce-background { position: absolute; inset: 0; z-index: -2; background-position: center; background-size: cover; opacity: 0; transition: opacity .45s ease, background-image .45s ease; }
  .ce-background.is-visible { opacity: 1; }
  .ce-background::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(13,9,20,.08), rgba(13,9,20,.3)); }
  .ce-portrait { position: absolute; bottom: 0; left: 50%; z-index: -1; width: min(52vw, 620px); height: min(82vh, 940px); object-fit: contain; object-position: bottom center; transform: translateX(-50%); opacity: 0; transition: opacity .35s ease, transform .35s ease; }
  .ce-portrait.is-visible { opacity: 1; transform: translateX(-50%) translateY(0); }
  .ce-edge { position: absolute; top: 26%; display: grid; gap: 8px; pointer-events: auto; }
  .ce-edge.left { left: max(6px, env(safe-area-inset-left)); }
  .ce-edge.right { right: max(6px, env(safe-area-inset-right)); }
  .ce-edge button, .ce-player { border: 1px solid rgba(255,255,255,.25); color: #fff; background: rgba(24,17,38,.8); box-shadow: 0 10px 28px rgba(0,0,0,.24); backdrop-filter: blur(14px); }
  .ce-edge button { max-width: 38px; min-height: 76px; border-radius: 12px; padding: 10px 8px; writing-mode: vertical-rl; letter-spacing: 2px; cursor: pointer; }
  .ce-sidebar { position: absolute; top: 0; bottom: 0; z-index: 4; overflow: auto; pointer-events: auto; background: rgba(20,14,31,.94); box-shadow: 0 0 44px rgba(0,0,0,.38); backdrop-filter: blur(20px); transition: transform .24s ease; }
  .ce-sidebar.left { left: 0; transform: translateX(-105%); }
  .ce-sidebar.right { right: 0; transform: translateX(105%); }
  .ce-sidebar.is-open { transform: translateX(0); }
  .ce-sidebar__bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; background: rgba(20,14,31,.96); border-bottom: 1px solid rgba(255,255,255,.12); }
  .ce-sidebar__close, .ce-popup__close { border: 0; color: #fff; background: transparent; font-size: 25px; line-height: 1; cursor: pointer; }
  .ce-sidebar__tabs { position: sticky; top: 57px; z-index: 1; display: flex; gap: 6px; padding: 8px 10px; overflow-x: auto; background: rgba(20,14,31,.94); border-bottom: 1px solid rgba(255,255,255,.08); scrollbar-width: thin; }
  .ce-sidebar__tabs[hidden] { display: none; }
  .ce-sidebar__tab { flex: 0 0 auto; min-height: 34px; padding: 6px 11px; cursor: pointer; border: 1px solid rgba(255,255,255,.12); border-radius: 6px; color: rgba(255,255,255,.72); background: rgba(255,255,255,.05); }
  .ce-sidebar__tab[aria-selected=true] { border-color: rgba(255,255,255,.44); color: #fff; background: rgba(255,255,255,.15); }
  .ce-sidebar__content { min-height: calc(100% - 104px); }
  .ce-backdrop { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; padding: 18px; pointer-events: auto; background: rgba(8,5,14,.58); opacity: 0; visibility: hidden; transition: .2s; }
  .ce-backdrop.is-open { opacity: 1; visibility: visible; }
  .ce-popup { position: relative; width: min(640px, 94vw); max-height: min(82vh, 820px); overflow: auto; }
  .ce-popup__close { position: absolute; top: 10px; right: 12px; z-index: 2; width: 34px; height: 34px; border-radius: 50%; background: rgba(0,0,0,.35); }
  .ce-floats { position: fixed; z-index: 6; inset: 0; overflow: hidden; pointer-events: none; }
  .ce-float { position: absolute; top: max(74px, env(safe-area-inset-top)); left: 50%; width: min(460px, calc(100vw - 32px)); transform: translateX(-50%); border: 1px solid rgba(255,255,255,.2); border-radius: 16px; background: rgba(24,17,38,.92); box-shadow: 0 16px 42px rgba(0,0,0,.34); overflow: hidden; pointer-events: auto; animation: ce-in .22s ease both; }
  .ce-float__bar { display: flex; align-items: center; justify-content: flex-end; min-height: 34px; padding: 3px 5px; border-bottom: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.035); }
  .ce-float__drag, .ce-float__close { display: grid; place-items: center; width: 30px; height: 28px; padding: 0; border: 0; color: rgba(255,255,255,.82); background: transparent; }
  .ce-float__drag { margin-right: auto; cursor: grab; touch-action: none; }
  .ce-float__drag:active { cursor: grabbing; }
  .ce-float__close { cursor: pointer; font-size: 20px; }
  .ce-float__content { max-height: min(68vh, 620px); overflow: auto; }
  .ce-float.is-dragging { animation: none; user-select: none; }
  .ce-float:focus-within { border-color: rgba(255,255,255,.45); }
  .ce-player { position: absolute; right: max(14px, env(safe-area-inset-right)); bottom: max(82px, env(safe-area-inset-bottom)); z-index: 3; display: flex; align-items: center; gap: 8px; min-height: 42px; max-width: min(360px, calc(100vw - 28px)); padding: 8px 12px; border-radius: 999px; pointer-events: auto; }
  .ce-player[hidden] { display: none !important; }
  .ce-player button { flex: 0 0 auto; width: 28px; height: 28px; border: 0; border-radius: 50%; color: #21162f; background: #fff; cursor: pointer; }
  .ce-player span { overflow: hidden; font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
  .ce-player select { max-width: 130px; min-width: 72px; border: 0; border-radius: 8px; padding: 3px 6px; font-size: 12px; color: #21162f; background: #fff; cursor: pointer; }
  .ce-player input[type=range] { flex: 0 0 auto; width: 62px; accent-color: #b984ff; cursor: pointer; }
  .ce-player__vol-btn { position: relative; }

  @keyframes ce-in { from { opacity: 0; transform: translateY(-10px); } }
  /* galgame 横板模式 */
  :host(.ce-galgame-on) { --ce-z: 60; }
  .ce-stage.is-galgame { background: #05030a; pointer-events: auto; }
  .ce-stage.is-galgame .ce-background { z-index: 0; opacity: 1; }
  .ce-stage.is-galgame .ce-portrait { z-index: 1; }
  .ce-stage.is-galgame.layout-left .ce-portrait { left: 26%; }
  .ce-stage.is-galgame.layout-right .ce-portrait { left: 74%; }
  .ce-galgame { position: absolute; left: 50%; z-index: 8; width: min(1080px, calc(100vw - 32px)); transform: translateX(-50%); pointer-events: auto; }
  .ce-galgame.pos-bottom { bottom: max(18px, env(safe-area-inset-bottom)); }
  .ce-galgame.pos-top { top: max(18px, env(safe-area-inset-top)); }
  .ce-galgame__box { position: relative; padding: 18px 22px 20px; border: 1px solid rgba(255,255,255,.18); border-radius: 18px; color: #f6f1ff; background: linear-gradient(160deg, rgba(24,16,40,.92), rgba(12,8,22,.94)); box-shadow: 0 20px 54px rgba(0,0,0,.46); backdrop-filter: blur(16px); }
  .ce-galgame__identity { position: absolute; top: -16px; left: 20px; display: flex; align-items: baseline; gap: 10px; }
  .ce-galgame__name { padding: 4px 16px; font-size: 14px; font-weight: 700; letter-spacing: 1px; color: #fff; background: linear-gradient(135deg, #7c5cff, #b984ff); border-radius: 999px; box-shadow: 0 8px 20px rgba(124,92,255,.42); }
  .ce-galgame__affiliation { color: #a9dcff; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-shadow: 0 1px 2px rgba(0,0,0,.55); }
  .ce-galgame__text { margin: 6px 0 0; max-height: 34vh; overflow: auto; font-size: 16px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
  .ce-galgame__hint { position: absolute; right: 16px; bottom: 10px; font-size: 12px; opacity: .55; animation: ce-blink 1.4s ease infinite; }
  .ce-galgame__actions { position: absolute; top: 26%; right: max(12px, env(safe-area-inset-right)); z-index: 10; display: grid; gap: 12px; pointer-events: auto; }
  .ce-galgame__actions[hidden] { display: none; }
  .ce-galgame__action { display: grid; place-items: center; width: 74px; min-height: 68px; padding: 8px 6px; border: 1px solid rgba(255,255,255,.7); border-radius: 8px; color: #eafbff; background: rgba(238,249,255,.9); box-shadow: 0 8px 20px rgba(8,30,50,.22); cursor: pointer; }
  .ce-galgame__action strong { color: #244c6b; font-size: 22px; line-height: 1; }
  .ce-galgame__action span { color: #2076a2; font-size: 11px; font-weight: 700; }
  .ce-composer { position: absolute; z-index: 12; top: var(--homer-chat-content-top, 68px); right: 0; bottom: 0; left: 0; width: 100%; height: auto; min-height: 0; display: grid; grid-template-rows: 1fr auto; gap: 14px; padding: 16px max(16px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); pointer-events: auto; background: rgba(231,242,247,.76); backdrop-filter: blur(2px); }
  .ce-composer[hidden] { display: none; }
  .ce-composer textarea { width: min(920px, calc(100vw - 130px)); min-height: 42vh; margin-inline: auto; padding: 20px; resize: none; border: 0; border-radius: 12px; color: #263d52; background: rgba(255,255,255,.42); box-shadow: inset 0 -2px 0 rgba(37,64,85,.38); font: 600 clamp(16px,2.2vw,24px)/1.6 inherit; outline: none; }
  .ce-composer__buttons { display: flex; justify-content: center; gap: clamp(18px,16vw,220px); }
  .ce-composer__buttons button { min-width: min(280px, 34vw); min-height: 58px; border: 0; border-radius: 7px; color: #25445f; background: #fff; box-shadow: 0 5px 0 rgba(25,43,58,.18); font: 800 clamp(16px,2vw,22px)/1 inherit; cursor: pointer; }
  .ce-composer__buttons button[type=submit] { color: #22506a; background: linear-gradient(135deg,#56dcff,#31c1eb); }
  .ce-stage.is-galgame.theme-archive { --archive-cyan: #36d8ff; --archive-ink: #183b5d; background: #102637; isolation: isolate; }
  .ce-stage.is-galgame.theme-archive::after { content: ''; position: absolute; inset: 0; z-index: 2; pointer-events: none; background: linear-gradient(180deg,transparent 0 70%,rgba(4,20,35,.16) 100%); }
  .ce-stage.is-galgame.theme-archive .ce-background { filter: none; transform: none; animation: ce-archive-bg-in .28s ease both; }
  .ce-stage.is-galgame.theme-archive .ce-background::after { background: none; }
  .ce-stage.is-galgame.theme-archive .ce-portrait { bottom: 0; z-index: 3; width: min(73vw,920px); height: 96%; object-position: bottom center; filter: drop-shadow(0 16px 22px rgba(8,19,35,.24)); animation: ce-archive-portrait-in .28s cubic-bezier(.2,.78,.25,1) both; }
  .ce-stage.is-galgame.theme-archive .ce-galgame { bottom: 0; z-index: 8; width: 100vw; }
  .ce-stage.is-galgame.theme-archive .ce-galgame__box { min-height: clamp(150px,25.8vh,264px); padding: clamp(18px,2.8vh,28px) max(9vw,78px) clamp(22px,3.8vh,38px) max(8.5vw,72px); border: 0; border-top: 1px solid #4f8eaa; border-radius: 0; color: #fff; background: #0b263e; box-shadow: inset 0 1px 0 rgba(222,249,255,.12); backdrop-filter: none; }
  .ce-stage.is-galgame.theme-archive .ce-galgame__box::before { content: ''; position: absolute; top: 61px; right: max(8.5vw,76px); left: max(8.5vw,72px); height: 1px; background: linear-gradient(90deg,rgba(109,210,242,.45),rgba(109,210,242,.2) 72%,transparent); }
  .ce-stage.is-galgame.theme-archive .ce-galgame__identity { position: static; min-height: 32px; margin-bottom: clamp(18px,2.6vh,26px); gap: 16px; }
  .ce-stage.is-galgame.theme-archive .ce-galgame__name { padding: 0; color: #fff; background: none; border-radius: 0; box-shadow: none; font-size: clamp(20px,2vw,28px); font-weight: 900; letter-spacing: .03em; text-shadow: 0 2px 4px rgba(0,0,0,.7); }
  .ce-stage.is-galgame.theme-archive .ce-galgame__affiliation { color: var(--archive-cyan); font-size: clamp(13px,1.25vw,17px); font-weight: 900; letter-spacing: .04em; }
  .ce-stage.is-galgame.theme-archive .ce-galgame__text { margin: 0; max-height: 17vh; padding-right: 48px; overflow: auto; font-size: clamp(16px,1.52vw,22px); font-weight: 650; line-height: 1.62; letter-spacing: .02em; text-shadow: 0 2px 4px rgba(0,0,0,.68); scrollbar-width: thin; scrollbar-color: rgba(87,216,246,.48) transparent; }
  .ce-stage.is-galgame.theme-archive .ce-galgame__hint { right: max(7.5vw,64px); bottom: 17px; width: 22px; height: 14px; overflow: hidden; color: transparent; background: center/contain no-repeat url('/app/assets/img/chatarchive/next-arrow.png'); opacity: .9; filter: drop-shadow(0 2px 2px rgba(0,0,0,.55)); }
  .ce-stage.is-galgame.theme-archive .ce-galgame__actions { top: 22%; right: max(10px,env(safe-area-inset-right)); gap: 10px; }
  .ce-stage.is-galgame.theme-archive .ce-galgame__action { position: relative; display: grid; place-items: center; width: 92px; min-height: 82px; padding: 8px 2px 2px; overflow: visible; border: 0; border-radius: 0; background: center/contain no-repeat url('/app/assets/img/chatarchive/action-button.png'); box-shadow: none; image-rendering: auto; transform: none; transition: transform .12s ease,filter .12s ease; }
  .ce-stage.is-galgame.theme-archive .ce-galgame__action:hover { filter: brightness(1.04); transform: translateY(-2px); }
  .ce-stage.is-galgame.theme-archive .ce-galgame__action:active { transform: translateY(1px); }
  .ce-stage.is-galgame.theme-archive .ce-galgame__action img { width: 42px; height: 42px; object-fit: contain; filter: brightness(0) saturate(100%) invert(22%) sepia(22%) saturate(1289%) hue-rotate(168deg) brightness(91%); }
  .ce-stage.is-galgame.theme-archive .ce-galgame__action span { margin-top: -3px; color: #1684ad; font-size: 14px; font-weight: 900; text-shadow: 0 2px #fff, 0 0 3px #fff; }
  .ce-stage.is-galgame.theme-archive .ce-composer { grid-template: 1fr auto / 126px 1fr; gap: 0 20px; padding: 16px max(6.5vw,72px) max(27px,env(safe-area-inset-bottom)) 6px; background: #dfeef3; backdrop-filter: none; }
  .ce-stage.is-galgame.theme-archive .ce-composer__speaker { display: flex; grid-row: 1; grid-column: 1; align-items: flex-start; justify-content: center; padding-top: 34px; border: 1px solid #5f8299; border-radius: 4px; color: #1c536f; background: #f2f8fa; font-size: 20px; font-weight: 900; text-shadow: 0 2px #fff; }
  .ce-stage.is-galgame.theme-archive .ce-composer textarea { grid-row: 1; grid-column: 2; width: 100%; min-height: 55vh; max-height: 66vh; margin: 0; padding: 18px 24px; border: 1px solid #b8ccd6; border-radius: 0 0 46px 0; color: #183d58; background: #f8fcfd; box-shadow: inset 0 -3px 0 rgba(37,64,85,.24); font-weight: 750; }
  .ce-stage.is-galgame.theme-archive .ce-composer textarea::placeholder { color: rgba(20,54,77,.42); }
  .ce-stage.is-galgame.theme-archive .ce-composer__buttons { grid-row: 2; grid-column: 1 / 3; padding-top: 28px; }
  .ce-stage.is-galgame.theme-archive .ce-composer__buttons button { min-width: min(330px,34vw); min-height: 58px; overflow: hidden; border: 0; border-radius: 0; color: #25445f; background-color: #fff; background-image: linear-gradient(158deg,#fff 0 47%,#f8fbfc 47% 100%); box-shadow: none; filter: drop-shadow(0 3px 0 rgba(37,64,85,.22)); clip-path: polygon(5.5% 0,100% 0,86% 100%,0 100%); font-style: italic; }
  .ce-stage.is-galgame.theme-archive .ce-composer__buttons button[type=submit] { color: #123f58; background-color: #3ec9eb; background-image: linear-gradient(116deg,#56dcf5 0 23%,#43cceb 23% 58%,#37c3e6 58% 82%,#31badd 82% 100%); clip-path: polygon(14% 0,100% 0,94.5% 100%,0 100%); }
  @keyframes ce-archive-bg-in { from { opacity: .3; transform: scale(1.02); } }
  @keyframes ce-archive-portrait-in { from { opacity: 0; transform: translateX(-50%) translateY(18px); } }
  @keyframes ce-blink { 50% { opacity: .1; } }
  @media (max-width: 640px) {
    .ce-edge { top: 22%; }
    .ce-edge button { min-height: 62px; max-width: 34px; font-size: 12px; }
    .ce-sidebar { max-width: calc(100vw - 34px); }
    .ce-portrait { width: min(92vw, 620px); height: 68vh; }
    .ce-stage.is-galgame.layout-left .ce-portrait,
    .ce-stage.is-galgame.layout-right .ce-portrait { left: 50%; }
    .ce-galgame__text { font-size: 15px; max-height: 40vh; }
    .ce-galgame__actions { top: auto; right: 8px; bottom: 26vh; display: flex; }
    .ce-galgame__action { width: 58px; min-height: 52px; }
    .ce-galgame__action span { display: none; }
    .ce-composer textarea { width: 100%; min-height: 50vh; }
    .ce-composer__buttons button { min-width: 38vw; }
    .ce-stage.is-galgame.theme-archive .ce-portrait { width: min(86vw,700px); height: 82%; }
    .ce-stage.is-galgame.theme-archive .ce-galgame__box { min-height: 30vh; padding: 18px 18px 24px; }
    .ce-stage.is-galgame.theme-archive .ce-galgame__box::before { top: 55px; right: 18px; left: 18px; }
    .ce-stage.is-galgame.theme-archive .ce-galgame__identity { margin-bottom: 18px; }
    .ce-stage.is-galgame.theme-archive .ce-galgame__text { max-height: 21vh; padding-right: 22px; }
    .ce-stage.is-galgame.theme-archive .ce-galgame__hint { right: 18px; bottom: 12px; }
    .ce-stage.is-galgame.theme-archive .ce-composer { grid-template: 1fr auto / 78px 1fr; gap: 0 8px; padding: 12px 8px 14px 4px; }
    .ce-stage.is-galgame.theme-archive .ce-composer__speaker { padding-top: 22px; font-size: 15px; }
    .ce-stage.is-galgame.theme-archive .ce-composer textarea { width: 100%; min-height: 54vh; }
  }
`;


class CardExperienceRuntime {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.card = {};
    this.config = normalizeCardExperience({});
    this.assets = [];
    this.world = [];
    this.audio = null;
    this.currentAssetId = '';
    this.bgmSwitchEpoch = 0;
    this.bundleEpoch = 0;
    this.lastMessageSignature = '';
    this.lastRawMessage = '';
    this.lastCleanMessage = '';
    this.stageState = { speaker: '', affiliation: '', portrait: '', background: '', mood: '' };
    this.spineLayer = null;
    this.floatTimers = new Set();
    this.userGestureHandler = () => this.tryAutoplay();
  }

  mount(card, host = document.getElementById('card-experience-root')) {
    if (!host) return;
    this.destroy();
    this.card = card && typeof card === 'object' ? card : {};
    this.config = normalizeCardExperience(this.card.card_experience);
    this.assets = normalizeMediaAssets(this.card.media_assets).filter((asset) => asset.status === 'ready');
    const legacyRpHub = normalizeLegacyRpHub(this.card.legacy_rp_hub);
    if (!this.config.bgm.enabled && legacyRpHub.bgm_playlist.length) {
      this.assets = [...this.assets, ...legacyRpHub.bgm_playlist];
      this.config.bgm = {
        ...this.config.bgm,
        enabled: true,
        default_asset_id: legacyRpHub.bgm_playlist[0].id,
        autoplay: 'after-interaction',
        volume: 0.45,
        loop: true,
        show_floating_player: true,
      };
    }
    this.world = Array.isArray(this.card.world_info) ? this.card.world_info : [];
    this.host = host;
    this.shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = `<style>${BASE_STYLE}</style><div class="ce-stage">
      <div class="ce-background"></div><img class="ce-portrait" alt="" referrerpolicy="no-referrer">
      <div class="ce-edge left"></div><div class="ce-edge right"></div>
      <div class="ce-sidebar-slot"></div>
      <div class="ce-backdrop"><div class="ce-popup"><button class="ce-popup__close" type="button" aria-label="关闭">×</button><div class="ce-popup__content"></div></div></div>
      <div class="ce-floats" aria-live="polite"></div>
      <div class="ce-player" hidden><button class="ce-player__toggle" type="button" aria-label="播放或暂停">▶</button><span class="ce-player__title">BGM</span><select class="ce-player__list" aria-label="切换曲目" hidden></select><input class="ce-player__vol" type="range" min="0" max="1" step="0.01" aria-label="音量"></div>
      <div class="ce-galgame" hidden>
        <div class="ce-galgame__box"><div class="ce-galgame__identity"><span class="ce-galgame__name"></span><span class="ce-galgame__affiliation"></span></div><div class="ce-galgame__text"></div><span class="ce-galgame__hint">▼</span></div>
      </div>
      <nav class="ce-galgame__actions" aria-label="场景对话操作" hidden><button class="ce-galgame__action" data-stage-action="continue" type="button"><img src="/app/assets/img/chatarchive/back-arrow.png" alt=""><span>继续对话</span></button><button class="ce-galgame__action" data-stage-action="input" type="button"><img src="/app/assets/img/chatarchive/input-pencil.png" alt=""><span>输入对话</span></button></nav>
      <form class="ce-composer" hidden><aside class="ce-composer__speaker">老师</aside><textarea maxlength="10000" aria-label="输入对话" placeholder="请输入文本…"></textarea><div class="ce-composer__buttons"><button data-stage-action="cancel-input" type="button">取消</button><button type="submit">确定</button></div></form>
    </div>`;
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.audio.loop = this.config.bgm.loop;
    this.audio.volume = this.config.bgm.volume;
    this.bindBaseEvents();
    this.renderSidebarTriggers();
    this.setupGalgame();
    if (this.config.bgm.enabled && this.config.bgm.default_asset_id) this.switchBgm(this.config.bgm.default_asset_id, false);
    void this.loadAssetBundle();
  }

  async loadAssetBundle() {
    const bundle = this.config.asset_bundle;
    const manifestUrl = bundle?.enabled ? sameOriginBundleUrl(bundle.manifest_url) : '';
    if (!manifestUrl) return false;
    const epoch = ++this.bundleEpoch;
    try {
      const response = await fetch(manifestUrl, { credentials: 'same-origin', cache: 'force-cache' });
      if (!response.ok) throw new Error(`resource bundle manifest failed (${response.status})`);
      const payload = await response.json();
      if (epoch !== this.bundleEpoch || !this.shadow) return false;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.assets)) throw new Error('resource bundle manifest is invalid');
      if (bundle.expected_id && String(payload.id || '') !== bundle.expected_id) throw new Error('resource bundle identity mismatch');
      const resolved = payload.assets.slice(0, BUNDLE_ASSET_LIMIT)
        .map((asset) => resolveBundleAsset(asset, manifestUrl)).filter(Boolean);
      const bundled = normalizeMediaAssetsWithLimit(resolved, BUNDLE_ASSET_LIMIT);
      const merged = new Map(this.assets.map((asset) => [asset.id, asset]));
      for (const asset of bundled) merged.set(asset.id, asset);
      this.assets = [...merged.values()];
      if (!this.config.galgame.default_background_id) this.config.galgame.default_background_id = bundle.default_background_id;
      if (!this.config.galgame.default_portrait_id) this.config.galgame.default_portrait_id = bundle.default_portrait_id;
      if (!this.config.bgm.default_asset_id) this.config.bgm.default_asset_id = bundle.default_bgm_id;
      this.renderBgmPlayer();
      this.setupGalgame();
      if (this.config.bgm.enabled && this.config.bgm.default_asset_id) this.switchBgm(this.config.bgm.default_asset_id, false);
      document.dispatchEvent(new CustomEvent('card-experience-assets-ready', {
        detail: { bundleId: String(payload.id || ''), assetCount: bundled.length },
      }));
      return true;
    } catch (error) {
      if (epoch === this.bundleEpoch) console.warn('[card-experience] resource bundle unavailable:', error?.message || error);
      return false;
    }
  }

  get galgameEnabled() {
    return !!this.config.galgame?.enabled;
  }

  setupGalgame() {
    const stage = this.shadow.querySelector('.ce-stage');
    const box = this.shadow.querySelector('.ce-galgame');
    const actions = this.shadow.querySelector('.ce-galgame__actions');
    if (!stage || !box) return;
    if (!this.galgameEnabled) {
      box.hidden = true;
      if (actions) actions.hidden = true;
      this.host?.classList.remove('ce-galgame-on');
      return;
    }
    const galgame = this.config.galgame;
    this.host?.classList.add('ce-galgame-on');
    stage.classList.add('is-galgame', `layout-${galgame.portrait_layout}`, `theme-${galgame.theme}`);
    box.hidden = false;
    box.classList.remove('pos-top', 'pos-bottom');
    box.classList.add(galgame.dialogue_position === 'top' ? 'pos-top' : 'pos-bottom');
    const nameEl = box.querySelector('.ce-galgame__name');
    // A card/conversation title is not a speaker name. Keep the identity blank
    // until the reply supplies an explicit speaker directive.
    if (nameEl) nameEl.textContent = '';
    if (actions) actions.hidden = !galgame.show_stage_actions;
    this.spineLayer?.dispose();
    this.spineLayer = new SpinePortraitLayer(stage);
    // 默认背景 / 立绘
    const bg = this.findAsset(galgame.default_background_id, 'background');
    if (bg) this.applyBackground(bg);
    const portrait = this.findAsset(galgame.default_portrait_id)
      || this.assets.find((asset) => asset.kind === 'portrait' || asset.kind === 'spine');
    if (portrait) this.applyPortrait(portrait);
  }

  applyBackground(asset) {
    if (!asset) return;
    const el = this.shadow.querySelector('.ce-background');
    if (!el) return;
    el.style.backgroundImage = `url("${String(asset.url).replace(/["\\\n\r]/g, '')}")`;
    el.classList.add('is-visible');
  }

  applyPortrait(asset) {
    if (!asset) return;
    const el = this.shadow.querySelector('.ce-portrait');
    if (asset.kind === 'spine' || spineManifestOf(asset)) {
      void this.spineLayer?.show(asset);
      return;
    }
    this.spineLayer?.hide();
    if (!el) return;
    el.src = asset.url;
    el.alt = asset.name || this.card.name || '';
    el.classList.add('is-visible');
  }

  // 按情绪标签切换立绘：匹配 metadata.emotion（大小写不敏感）。
  switchPortraitByEmotion(emotion) {
    const tag = String(emotion || '').trim().toLowerCase();
    if (!tag) return false;
    const isPortrait = (asset) => asset.kind === 'portrait' || asset.kind === 'spine';
    const asset = this.assets.find((a) => isPortrait(a) && String(a.metadata?.emotion || '').trim().toLowerCase() === tag)
      || this.assets.find((a) => isPortrait(a) && String(a.name || '').trim().toLowerCase().includes(tag));
    if (!asset) return false;
    this.applyPortrait(asset);
    return true;
  }

  switchBackgroundByTag(tag) {
    const key = String(tag || '').trim().toLowerCase();
    if (!key) return false;
    const asset = this.assets.find((a) => a.kind === 'background' && String(a.metadata?.scene || a.metadata?.emotion || a.name || '').trim().toLowerCase().includes(key));
    if (!asset) return false;
    this.applyBackground(asset);
    this.stageState.background = key;
    return true;
  }

  switchPortraitByState(speaker, portrait) {
    const speakerKey = String(speaker || '').trim().toLowerCase();
    const portraitKey = String(portrait || '').trim().toLowerCase();
    const isPortrait = (asset) => asset.kind === 'portrait' || asset.kind === 'spine';
    const candidates = this.assets.filter(isPortrait);
    const exact = candidates.find((asset) => {
      const assetSpeaker = String(asset.metadata?.speaker || '').trim().toLowerCase();
      const emotion = String(asset.metadata?.emotion || '').trim().toLowerCase();
      return (!speakerKey || assetSpeaker === speakerKey) && (!portraitKey || emotion === portraitKey);
    });
    if (exact) { this.applyPortrait(exact); return true; }
    return portraitKey ? this.switchPortraitByEmotion(portraitKey) : false;
  }

  switchBgmByTag(tag, play = true) {
    const key = String(tag || '').trim().toLowerCase();
    if (!key) return false;
    const asset = this.assets.find((item) => item.kind === 'bgm' && (
      String(item.id || '').toLowerCase() === key
      || String(item.name || '').trim().toLowerCase() === key
      || String(item.metadata?.tag || '').trim().toLowerCase() === key
    ));
    return asset ? this.switchBgm(asset.id, play) : false;
  }

  mappedBgm(mapping, key) {
    const normalized = String(key || '').trim().toLowerCase();
    return normalized && mapping && typeof mapping === 'object' ? String(mapping[normalized] || '') : '';
  }

  applyMappedBgm(play = true) {
    if (!this.config.bgm.enabled) return false;
    const moodTrack = this.mappedBgm(this.config.galgame.mood_bgm_map, this.stageState.mood);
    const sceneTrack = this.mappedBgm(this.config.galgame.scene_bgm_map, this.stageState.background);
    const target = moodTrack || sceneTrack || this.config.bgm.default_asset_id;
    return target ? this.switchBgm(target, play) : false;
  }

  // 把最新一条 AI 文本呈现到对话栏，同时依据指令切换立绘/背景。
  showGalgameDialogue(rawText) {
    if (!this.galgameEnabled) return;
    const box = this.shadow.querySelector('.ce-galgame');
    const textEl = this.shadow.querySelector('.ce-galgame__text');
    if (!box || !textEl) return;
    const directives = parseGalgameDirectives(String(rawText || ''), this.config.galgame);
    this.stageState = { ...this.stageState, ...Object.fromEntries(Object.entries(directives).filter(([, value]) => value)) };
    if (directives.speaker) {
      const nameEl = box.querySelector('.ce-galgame__name');
      if (nameEl) nameEl.textContent = directives.speaker;
    }
    if (directives.affiliation) {
      const affiliationEl = box.querySelector('.ce-galgame__affiliation');
      if (affiliationEl) affiliationEl.textContent = directives.affiliation;
    }
    if (directives.portrait || directives.speaker) this.switchPortraitByState(this.stageState.speaker, this.stageState.portrait);
    if (directives.background) this.switchBackgroundByTag(directives.background);
    if (directives.bgm) this.switchBgmByTag(directives.bgm, true);
    // A reply-level BGM directive is the most specific state.  Do not let an
    // empty scene/mood mapping immediately replace it with the card default.
    if (!directives.bgm && (directives.background || directives.mood)) this.applyMappedBgm(true);
    const clean = stripExperienceDirectives(rawText, this.config);
    box.hidden = false;
    if (this.config.galgame.typewriter) this.typewrite(textEl, clean);
    else textEl.textContent = clean;
  }

  typewrite(el, text) {
    if (this._typeTimer) { clearInterval(this._typeTimer); this._typeTimer = null; }
    const full = String(text || '');
    el.textContent = '';
    let index = 0;
    const step = Math.max(1, Math.round(full.length / 240));
    this._typeTimer = setInterval(() => {
      index += step;
      el.textContent = full.slice(0, index);
      if (index >= full.length) {
        clearInterval(this._typeTimer);
        this._typeTimer = null;
      }
    }, 16);
  }


  bindBaseEvents() {
    this.shadow.querySelector('.ce-popup__close')?.addEventListener('click', () => this.closePopup());
    this.shadow.querySelector('.ce-backdrop')?.addEventListener('click', (event) => {
      if (event.target.classList.contains('ce-backdrop')) this.closePopup();
    });
    this.shadow.querySelector('.ce-player__toggle')?.addEventListener('click', () => this.toggleAudio());
    const list = this.shadow.querySelector('.ce-player__list');
    if (list) list.addEventListener('change', () => { if (list.value) this.switchBgm(list.value, true); });
    const vol = this.shadow.querySelector('.ce-player__vol');
    if (vol) {
      vol.value = String(this.config.bgm.volume);
      vol.addEventListener('input', () => {
        const level = Math.min(1, Math.max(0, Number(vol.value) || 0));
        this.config.bgm.volume = level;
        if (this.audio) this.audio.volume = level;
      });
    }
    this.renderBgmPlayer();
    this.shadow.querySelector('[data-stage-action="continue"]')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('card-experience-generate', { detail: { type: 'continue' } }));
    });
    this.shadow.querySelector('[data-stage-action="input"]')?.addEventListener('click', () => this.openComposer());
    this.shadow.querySelector('[data-stage-action="cancel-input"]')?.addEventListener('click', () => this.closeComposer());
    this.shadow.querySelector('.ce-composer')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const textarea = event.currentTarget.querySelector('textarea');
      const value = String(textarea?.value || '').trim();
      if (!value) return;
      document.dispatchEvent(new CustomEvent('card-experience-submit-text', { detail: { text: value } }));
      textarea.value = '';
      this.closeComposer();
    });
    document.removeEventListener('pointerdown', this.userGestureHandler);
    document.addEventListener('pointerdown', this.userGestureHandler, { once: true, passive: true });
  }

  openComposer() {
    const form = this.shadow?.querySelector('.ce-composer');
    if (!form) return;
    form.hidden = false;
    window.setTimeout(() => form.querySelector('textarea')?.focus(), 0);
  }

  closeComposer() {
    const form = this.shadow?.querySelector('.ce-composer');
    if (form) form.hidden = true;
  }

  // 用媒体库里的全部 bgm 资源填充悬浮播放器的曲目下拉框。单曲时隐藏下拉。
  renderBgmPlayer() {
    const list = this.shadow.querySelector('.ce-player__list');
    if (!list) return;
    const tracks = this.assets.filter((asset) => asset.kind === 'bgm');
    list.replaceChildren();
    for (const track of tracks) {
      const option = document.createElement('option');
      option.value = track.id;
      option.textContent = track.name || 'BGM';
      list.append(option);
    }
    list.hidden = tracks.length < 2;
    if (this.currentAssetId) list.value = this.currentAssetId;
  }


  renderSidebarTriggers() {
    for (const position of ['left', 'right']) {
      const dock = this.shadow.querySelector(`.ce-edge.${position}`);
      dock.replaceChildren();
      for (const sidebar of this.config.sidebars.filter((item) => item.enabled && item.position === position)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = sidebar.trigger_label || sidebar.name;
        button.addEventListener('click', () => this.openSidebar(sidebar.id));
        dock.append(button);
      }
    }
  }

  findAsset(id, kind = '') {
    return this.assets.find((asset) => asset.id === id && (!kind || asset.kind === kind));
  }

  async switchBgm(assetId, play = true) {
    const asset = this.findAsset(assetId, 'bgm');
    if (!asset || !this.audio) return false;
    const changed = this.currentAssetId !== asset.id;
    const epoch = ++this.bgmSwitchEpoch;
    if (changed && play && !this.audio.paused) {
      await this.fadeAudio(0, 160, epoch);
      if (epoch !== this.bgmSwitchEpoch || !this.audio) return false;
    }
    if (changed) {
      this.currentAssetId = asset.id;
      this.audio.src = asset.url;
      this.audio.loop = this.config.bgm.loop;
      this.audio.volume = play ? 0 : this.config.bgm.volume;
      const player = this.shadow?.querySelector('.ce-player');
      if (player) {
        player.hidden = !this.config.bgm.show_floating_player;
        const title = player.querySelector('.ce-player__title');
        if (title) title.textContent = asset.name || 'BGM';
        const list = player.querySelector('.ce-player__list');
        if (list && list.value !== asset.id) list.value = asset.id;
      }
    }
    if (play) {
      const started = await this.tryAutoplay();
      if (started && changed) await this.fadeAudio(this.config.bgm.volume, 240, epoch);
      return started;
    }

    return true;
  }

  async fadeAudio(target, duration, epoch = this.bgmSwitchEpoch) {
    if (!this.audio) return false;
    const start = this.audio.volume;
    const end = Math.max(0, Math.min(1, Number(target) || 0));
    const steps = Math.max(1, Math.round(duration / 30));
    for (let index = 1; index <= steps; index += 1) {
      if (!this.audio || epoch !== this.bgmSwitchEpoch) return false;
      this.audio.volume = start + (end - start) * (index / steps);
      await new Promise((resolve) => window.setTimeout(resolve, duration / steps));
    }
    return true;
  }

  async tryAutoplay() {
    if (!this.audio?.src || !this.config.bgm.enabled) return false;
    try {
      await this.audio.play();
      const button = this.shadow?.querySelector('.ce-player button');
      if (button) button.textContent = 'Ⅱ';
      return true;
    } catch {
      const player = this.shadow?.querySelector('.ce-player');
      if (player) player.hidden = !this.config.bgm.show_floating_player;
      return false;
    }
  }

  toggleAudio() {
    if (!this.audio?.src) return;
    if (this.audio.paused) this.tryAutoplay();
    else {
      this.audio.pause();
      const button = this.shadow?.querySelector('.ce-player button');
      if (button) button.textContent = '▶';
    }
  }

  openPopup(rule, context) {
    const backdrop = this.shadow.querySelector('.ce-backdrop');
    const popup = this.shadow.querySelector('.ce-popup');
    const content = this.shadow.querySelector('.ce-popup__content');
    popup.querySelectorAll('style[data-author]').forEach((node) => node.remove());
    const style = document.createElement('style');
    style.dataset.author = '1';
    style.textContent = sanitizeScopedCss(rule.scoped_css);
    popup.prepend(style);
    content.innerHTML = sanitizeCardHtml(template(rule.template_html, context));
    this.bindDeclarativeActions(content);
    this.syncLiveElements(content);
    backdrop.classList.add('is-open');
  }


  closePopup() {
    this.shadow?.querySelector('.ce-backdrop')?.classList.remove('is-open');
  }

  showFloating(rule, context) {
    const container = this.shadow.querySelector('.ce-floats');
    if (!container) return;
    const existing = [...container.querySelectorAll('.ce-float')];
    if (existing.length >= 6) existing[0].remove();
    const card = document.createElement('div');
    card.className = 'ce-float';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', rule.name || '角色悬浮窗');
    const index = Math.min(existing.length, 5);
    card.style.top = `max(${74 + index * 18}px, env(safe-area-inset-top))`;
    const bar = document.createElement('div');
    bar.className = 'ce-float__bar';
    const drag = document.createElement('button');
    drag.className = 'ce-float__drag';
    drag.type = 'button';
    drag.textContent = '⠿';
    drag.setAttribute('aria-label', '移动悬浮窗');
    const close = document.createElement('button');
    close.className = 'ce-float__close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭悬浮窗');
    bar.append(drag, close);
    const style = document.createElement('style');
    style.textContent = sanitizeScopedCss(rule.scoped_css);
    const content = document.createElement('div');
    content.className = 'ce-float__content';
    content.innerHTML = sanitizeCardHtml(template(rule.template_html, context));
    card.append(style, bar, content);
    this.bindDeclarativeActions(card);
    container.append(card);
    this.makeDraggable(card, drag);
    let timer = null;
    const remove = () => {
      if (timer !== null) {
        clearTimeout(timer);
        this.floatTimers.delete(timer);
      }
      card.remove();
    };
    close.addEventListener('click', remove);
    if (rule.duration_ms > 0) {
      timer = setTimeout(remove, rule.duration_ms);
      this.floatTimers.add(timer);
    }
  }

  makeDraggable(node, handle) {
    if (!node || !handle) return;
    const stage = this.shadow?.querySelector('.ce-stage');
    const clampPosition = (left, top) => {
      const bounds = stage?.getBoundingClientRect() || { left: 0, top: 0, width: innerWidth, height: innerHeight };
      const rect = node.getBoundingClientRect();
      return {
        left: Math.max(bounds.left + 8, Math.min(left, bounds.left + bounds.width - rect.width - 8)),
        top: Math.max(bounds.top + 8, Math.min(top, bounds.top + bounds.height - rect.height - 8)),
      };
    };
    const settle = () => {
      const rect = node.getBoundingClientRect();
      const next = clampPosition(rect.left, rect.top);
      node.style.left = `${next.left}px`;
      node.style.top = `${next.top}px`;
      node.style.transform = 'none';
    };
    settle();
    let dragState = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = node.getBoundingClientRect();
      dragState = { pointerId: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
      handle.setPointerCapture?.(event.pointerId);
      node.classList.add('is-dragging');
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const next = clampPosition(event.clientX - dragState.x, event.clientY - dragState.y);
      node.style.left = `${next.left}px`;
      node.style.top = `${next.top}px`;
      node.style.transform = 'none';
    });
    const finish = event => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      dragState = null;
      node.classList.remove('is-dragging');
      try { handle.releasePointerCapture?.(event.pointerId); } catch { /* capture already released */ }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('keydown', event => {
      const delta = event.shiftKey ? 24 : 8;
      const movement = {
        ArrowLeft: [-delta, 0], ArrowRight: [delta, 0],
        ArrowUp: [0, -delta], ArrowDown: [0, delta],
      }[event.key];
      if (!movement) return;
      const rect = node.getBoundingClientRect();
      const next = clampPosition(rect.left + movement[0], rect.top + movement[1]);
      node.style.left = `${next.left}px`;
      node.style.top = `${next.top}px`;
      node.style.transform = 'none';
      event.preventDefault();
    });
  }

  insertComposerText(text, mode = 'append') {
    const clean = String(text || '').slice(0, 2000);
    if (!clean) return;
    document.dispatchEvent(new CustomEvent('card-experience-insert-text', {
      detail: { text: clean, mode: mode === 'replace' ? 'replace' : 'append' },
    }));
  }

  openSidebar(sidebarId, context = {}) {
    const sidebar = this.config.sidebars.find((item) => item.enabled && item.id === sidebarId);
    if (!sidebar) return;
    const sidebars = this.config.sidebars.filter(item => item.enabled && item.position === sidebar.position);
    const slot = this.shadow.querySelector('.ce-sidebar-slot');
    slot.replaceChildren();
    const panel = document.createElement('aside');
    panel.className = `ce-sidebar ${sidebar.position}`;
    const bar = document.createElement('div');
    bar.className = 'ce-sidebar__bar';
    const title = document.createElement('strong');
    const close = document.createElement('button');
    close.className = 'ce-sidebar__close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭');
    bar.append(title, close);
    const tabs = document.createElement('div');
    tabs.className = 'ce-sidebar__tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '角色面板');
    tabs.hidden = sidebars.length < 2;
    const content = document.createElement('div');
    content.className = 'ce-sidebar__content';
    content.setAttribute('role', 'tabpanel');
    panel.append(bar, tabs, content);
    const tabButtons = new Map();
    const renderTab = active => {
      panel.style.width = `${active.width}px`;
      title.textContent = active.name;
      for (const [item, button] of tabButtons) {
        const selected = item === active;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
      const world = this.world.find(entry => entry.id === active.world_entry_id);
      const publicWorld = world ? { ...world, content: '' } : null;
      const rawContent = active.content_mode === 'worldbook' && !active.content_html
        ? `<article class="worldbook-content"><h3>${escapeText(publicWorld?.name || active.name)}</h3></article>`
        : template(active.content_html, { ...context, card: this.card, world: publicWorld });
      const authorStyle = document.createElement('style');
      authorStyle.dataset.author = '1';
      authorStyle.textContent = sanitizeScopedCss(active.scoped_css);
      const body = document.createElement('div');
      body.className = 'ce-sidebar__panel';
      body.innerHTML = sanitizeCardHtml(rawContent);
      content.replaceChildren(authorStyle, body);
      this.bindCardSearchFilter(body);
      this.syncLiveElements(content);
    };
    for (const item of sidebars) {
      const button = document.createElement('button');
      button.className = 'ce-sidebar__tab';
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.textContent = item.trigger_label || item.name;
      button.addEventListener('click', () => renderTab(item));
      tabButtons.set(item, button);
      tabs.append(button);
    }
    close.addEventListener('click', () => panel.classList.remove('is-open'));
    this.bindDeclarativeActions(panel, { panel });
    slot.append(panel);
    renderTab(sidebar);
    requestAnimationFrame(() => panel.classList.add('is-open'));
  }

  // 声明式「实时数据同步」（mmd 架构思路）：把最新一条 AI 回复同步到独立界面
  // （侧边栏 / 弹窗 / 图鉴等）里带 data-card-live 的元素，让这些界面始终反映最新回复。
  // - <span data-card-live>：填入清洗后的最新回复全文（默认）。
  // - <span data-card-live="raw">：填入未清洗的原始回复。
  // - <span data-card-live data-live-pattern="HP[:：]\s*(\d+)" data-live-group="1">：
  //   用正则从回复中提取字段（取捕获组，默认第 1 组），提取失败则保留原内容。
  syncLiveElements(scope) {
    const root = scope || this.shadow;
    if (!root) return;
    const nodes = [...root.querySelectorAll('[data-card-live]')];
    if (!nodes.length) return;
    const raw = this.lastRawMessage || '';
    const clean = this.lastCleanMessage || '';
    for (const node of nodes) {
      const mode = String(node.dataset.cardLive || '').trim().toLowerCase();
      const source = mode === 'raw' ? raw : clean;
      const patternText = node.dataset.livePattern;
      if (patternText) {
        const regex = safeRegExp(patternText, node.dataset.liveFlags || '');
        if (!regex) continue;
        const match = regex.exec(source);
        if (match) {
          const groupIndex = Number(node.dataset.liveGroup || 1);
          const value = match[Number.isFinite(groupIndex) ? groupIndex : 1] ?? match[0];
          node.textContent = String(value ?? '').slice(0, 2000);
        }
        continue;
      }
      node.textContent = source.slice(0, 8000);
    }
  }


  setScene(worldEntryId) {
    const world = this.world.find((entry) => entry.id === worldEntryId);
    if (!world) return;
    const bindings = normalizeMediaBindings(world.media_bindings);
    const background = this.findAsset(bindings.find((item) => item.kind === 'background')?.asset_id, 'background');
    const portraitBinding = bindings.find((item) => item.kind === 'portrait' || item.kind === 'spine');
    const portrait = this.findAsset(portraitBinding?.asset_id);
    const bgm = this.findAsset(bindings.find((item) => item.kind === 'bgm')?.asset_id, 'bgm');
    const backgroundEl = this.shadow.querySelector('.ce-background');
    const portraitEl = this.shadow.querySelector('.ce-portrait');
    if (background) {
      backgroundEl.style.backgroundImage = `url("${background.url.replace(/["\\\n\r]/g, '')}")`;
      backgroundEl.classList.add('is-visible');
    }
    if (portrait) this.applyPortrait(portrait);
    if (bgm) this.switchBgm(bgm.id, true);
  }

  bindDeclarativeActions(container, options = {}) {
    container.addEventListener('click', (event) => {
      const control = event.target.closest?.('[data-card-action]');
      if (!control || !container.contains(control)) return;
      const action = String(control.dataset.cardAction || '');
      const targetId = String(control.dataset.assetId || control.dataset.targetId || '');
      if (action === 'play-bgm') {
        if (targetId) this.switchBgm(targetId, true);
        else this.tryAutoplay();
      } else if (action === 'pause-bgm') {
        this.audio?.pause();
        const button = this.shadow.querySelector('.ce-player button');
        if (button) button.textContent = '▶';
      } else if (action === 'toggle-bgm') {
        this.toggleAudio();
      } else if (action === 'switch-bgm' && targetId) {
        this.switchBgm(targetId, true);
      } else if (action === 'insert-text') {
        const text = String(control.dataset.text || control.textContent || '').trim();
        if (text) this.insertComposerText(text, control.dataset.insertMode === 'replace' ? 'replace' : 'append');
      } else if (action === 'open-sidebar' && targetId) {

        this.openSidebar(targetId);
      } else if (action === 'set-scene' && targetId) {
        this.setScene(targetId);
      } else if (action === 'close-popup') {
        this.closePopup();
      } else if (action === 'close-sidebar') {
        options.panel?.classList.remove('is-open');
      }
    });
    this.bindCardSearchFilter(container);
  }

  // 声明式「卡内搜索 / 筛选」：作者只写带 data-* 的 HTML，运行时接管显隐逻辑。
  // - 搜索框：<input data-card-search>（可选 data-search-target 指定条目选择器，默认 [data-card-item]）
  // - 条目：<div data-card-item data-name data-desc data-type data-rank ...>
  // - 筛选按钮：<button data-card-filter data-filter-key="type" data-filter-value="god">
  //   同一 data-filter-key 视为一组，单选；data-filter-value="all" 表示不限。
  bindCardSearchFilter(container) {
    const searchInputs = [...container.querySelectorAll('[data-card-search]')];
    const filterButtons = [...container.querySelectorAll('[data-card-filter]')];
    if (!searchInputs.length && !filterButtons.length) return;
    const state = { query: '', filters: {} };
    const itemSelector = searchInputs[0]?.dataset.searchTarget || '[data-card-item]';
    let itemNodes;
    try {
      itemNodes = [...container.querySelectorAll(itemSelector)];
    } catch {
      itemNodes = [];
    }
    if (!itemNodes.length && itemSelector !== '[data-card-item]') {
      itemNodes = [...container.querySelectorAll('[data-card-item]')];
    }
    const items = () => itemNodes;
    const apply = () => {
      const q = state.query.trim().toLowerCase();
      for (const item of items()) {
        const haystack = [
          item.dataset.name, item.dataset.desc, item.dataset.searchText,
          item.getAttribute('aria-label'), item.textContent,
        ].filter(Boolean).join(' ').toLowerCase();
        const textOk = !q || haystack.includes(q);
        let filterOk = true;
        for (const [key, value] of Object.entries(state.filters)) {
          if (!value || value === 'all') continue;
          const raw = String(item.dataset[key] || '').toLowerCase();
          const set = raw.split(/[\s,]+/).filter(Boolean);
          if (!set.includes(value.toLowerCase())) { filterOk = false; break; }
        }
        const show = textOk && filterOk;
        item.style.display = show ? '' : 'none';
        item.toggleAttribute('hidden', !show);
      }
    };
    for (const input of searchInputs) {
      input.addEventListener('input', () => { state.query = input.value || ''; apply(); });
    }
    for (const btn of filterButtons) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const key = btn.dataset.filterKey || 'type';
        const value = btn.dataset.filterValue || 'all';
        state.filters[key] = value;
        for (const el of filterButtons) {
          if ((el.dataset.filterKey || 'type') === key) el.classList.toggle('is-active', el === btn);
        }
        apply();
      });
    }
    apply();
  }


  async consume(message, options = {}) {
    const input = String(message || '').slice(-8192);
    const signature = `${options.messageId || ''}:${input}`;
    if (!input || signature === this.lastMessageSignature) return;
    this.lastMessageSignature = signature;
    this.lastRawMessage = input;
    this.lastCleanMessage = this.clean(input);
    this.syncLiveElements();
    if (this.galgameEnabled) this.showGalgameDialogue(input);
    const context = { message: input, card: this.card, world: null };

    const rules = this.config.ui_rules.filter((rule) => rule.enabled);
    const sidebars = this.config.sidebars.filter((sidebar) => sidebar.enabled && sidebar.open_pattern);
    const matches = await timedRegexMatches(
      [
        ...rules.map((rule) => ({ pattern: rule.pattern, flags: rule.flags })),
        ...sidebars.map((sidebar) => ({ pattern: sidebar.open_pattern, flags: sidebar.flags })),
      ],
      input,
    );
    if (this.lastMessageSignature !== signature) return;
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      if (!matches[index]) continue;
      if (rule.action === 'open_popup') this.openPopup(rule, context);
      if (rule.action === 'show_floating') this.showFloating(rule, context);
      if (rule.action === 'switch_bgm') this.switchBgm(rule.target_id, true);
      if (rule.action === 'open_sidebar') this.openSidebar(rule.target_id, context);
      if (rule.action === 'set_scene') this.setScene(rule.target_id);
    }
    for (let index = 0; index < sidebars.length; index += 1) {
      if (matches[rules.length + index]) this.openSidebar(sidebars[index].id, context);
    }
  }

  clean(message) {
    return stripExperienceDirectives(message, this.config);
  }

  destroy() {
    document.removeEventListener('pointerdown', this.userGestureHandler);
    for (const timer of this.floatTimers) clearTimeout(timer);
    this.floatTimers.clear();
    if (this._typeTimer) { clearInterval(this._typeTimer); this._typeTimer = null; }
    if (this.spineLayer) {
      try { this.spineLayer.dispose(); } catch { /* renderer already unavailable */ }
      this.spineLayer = null;
    }
    this.host?.classList.remove('ce-galgame-on');
    this.audio?.pause();

    if (this.audio) {
      this.audio.removeAttribute('src');
      try { this.audio.load(); } catch { /* ignore */ }
    }
    this.audio = null;
    this.bgmSwitchEpoch += 1;
    this.bundleEpoch += 1;
    this.spineLayer?.dispose();
    this.spineLayer = null;
    this.shadow?.replaceChildren();
    this.host = null;
    this.shadow = null;
    this.card = {};
    this.config = normalizeCardExperience({});
    this.assets = [];
    this.world = [];
    this.currentAssetId = '';
    this.lastMessageSignature = '';
    this.lastRawMessage = '';
    this.lastCleanMessage = '';
    this.stageState = { speaker: '', affiliation: '', portrait: '', background: '', mood: '' };
  }
}

function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const cardExperienceRuntime = new CardExperienceRuntime();

export function mountCardExperience(card, host) {
  cardExperienceRuntime.mount(card, host);
}

export function consumeCardExperienceText(text, options) {
  void cardExperienceRuntime.consume(text, options);
}

export function cleanCardExperienceText(text) {
  return cardExperienceRuntime.clean(text);
}

export function isCardGalgameEnabled() {
  return cardExperienceRuntime.galgameEnabled;
}

export function showGalgameDialogue(text) {
  cardExperienceRuntime.showGalgameDialogue(text);
}

export function destroyCardExperience() {
  cardExperienceRuntime.destroy();
}
