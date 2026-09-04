// Public site settings hydrator. Static HTML stays usable if this request fails.
import { api } from '/assets/js/api.js?v=20260717-handoff-merge';

function getPath(obj, path) {
  return String(path || '').split('.').reduce((cur, key) => (
    cur && Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : undefined
  ), obj);
}

function safeHref(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('/') || text.startsWith('#') || text.startsWith('https://') || text.startsWith('http://')) {
    return text;
  }
  return '';
}

function applyTrustRow(node, value) {
  const text = String(value || '').trim();
  if (!text) return;
  const parts = text.split(/[·|]/).map(item => item.trim()).filter(Boolean);
  if (!parts.length) return;
  node.textContent = '';
  parts.forEach((part, index) => {
    if (index > 0) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      node.appendChild(dot);
    }
    const span = document.createElement('span');
    span.textContent = part;
    node.appendChild(span);
  });
}

const FEATURE_ICON_PATHS = [
  'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-9a4 4 0 11-8 0 4 4 0 018 0zM21 12a4 4 0 11-8 0 4 4 0 018 0z',
  'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
  'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  'M13 10V3L4 14h7v7l9-11h-7z',
  'M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18',
  'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
];

const FEATURE_TONES = [
  ['from-violet-500/30', 'to-indigo-500/30', 'text-violet-300'],
  ['from-fuchsia-500/30', 'to-purple-500/30', 'text-fuchsia-300'],
  ['from-blue-500/30', 'to-cyan-500/30', 'text-blue-300'],
  ['from-emerald-500/30', 'to-teal-500/30', 'text-emerald-300'],
  ['from-amber-500/30', 'to-orange-500/30', 'text-amber-300'],
  ['from-pink-500/30', 'to-rose-500/30', 'text-pink-300'],
];

function renderFeatureCards(node, items) {
  if (!Array.isArray(items) || !items.length) return;
  node.textContent = '';
  items.forEach((item, index) => {
    const title = String(item?.title || '').trim();
    const description = String(item?.description || '').trim();
    if (!title && !description) return;
    const tone = FEATURE_TONES[index % FEATURE_TONES.length];
    const card = document.createElement('div');
    card.className = 'xy-glass xy-glass-hover p-8';

    const iconWrap = document.createElement('div');
    iconWrap.className = `w-14 h-14 rounded-2xl bg-gradient-to-br ${tone[0]} ${tone[1]} flex items-center justify-center mb-5`;
    iconWrap.innerHTML = `<svg class="w-7 h-7 ${tone[2]}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${FEATURE_ICON_PATHS[index % FEATURE_ICON_PATHS.length]}"/></svg>`;

    const titleEl = document.createElement('h3');
    titleEl.className = 'text-xl font-bold mb-2';
    titleEl.textContent = title;
    const descEl = document.createElement('p');
    descEl.className = 'text-slate-400 leading-relaxed';
    descEl.textContent = description;

    card.appendChild(iconWrap);
    card.appendChild(titleEl);
    card.appendChild(descEl);
    node.appendChild(card);
  });
}

function renderDownloadFacts(node, items) {
  if (!Array.isArray(items) || !items.length) return;
  node.textContent = '';
  items.forEach((item) => {
    const label = String(item?.label || '').trim();
    const value = String(item?.value || '').trim();
    if (!label && !value) return;
    const card = document.createElement('div');
    card.className = 'px-4 py-3 rounded-lg bg-white/5';
    const labelEl = document.createElement('div');
    labelEl.className = 'text-slate-400 mb-1';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'font-semibold';
    valueEl.textContent = value;
    card.appendChild(labelEl);
    card.appendChild(valueEl);
    node.appendChild(card);
  });
}

function renderFaqItems(node, items) {
  if (!Array.isArray(items) || !items.length) return;
  node.textContent = '';
  items.forEach((item, index) => {
    const question = String(item?.q || '').trim();
    const answer = String(item?.a || '').trim();
    if (!question && !answer) return;
    const panel = document.createElement('div');
    panel.className = 'xy-glass overflow-hidden';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'w-full flex items-center justify-between p-5 text-left';
    const questionEl = document.createElement('span');
    questionEl.className = 'font-medium';
    questionEl.textContent = question;
    const icon = document.createElement('span');
    icon.className = 'text-slate-400 transition-transform';
    icon.textContent = '⌄';
    button.appendChild(questionEl);
    button.appendChild(icon);

    const answerEl = document.createElement('div');
    answerEl.className = 'px-5 pb-5 text-slate-300 leading-relaxed text-sm';
    answerEl.textContent = answer;
    answerEl.hidden = index !== 0;
    button.addEventListener('click', () => {
      const nextHidden = !answerEl.hidden;
      node.querySelectorAll('[data-site-faq-answer]').forEach((el) => { el.hidden = true; });
      answerEl.hidden = nextHidden;
    });
    answerEl.setAttribute('data-site-faq-answer', '1');

    panel.appendChild(button);
    panel.appendChild(answerEl);
    node.appendChild(panel);
  });
}

function applySettings(settings) {
  document.querySelectorAll('[data-site-text]').forEach((node) => {
    const value = getPath(settings, node.getAttribute('data-site-text'));
    if (value !== undefined && value !== null && String(value).trim()) {
      node.textContent = String(value);
    }
  });

  document.querySelectorAll('[data-site-href]').forEach((node) => {
    const href = safeHref(getPath(settings, node.getAttribute('data-site-href')));
    if (href) node.setAttribute('href', href);
  });

  document.querySelectorAll('[data-site-trust]').forEach((node) => {
    applyTrustRow(node, getPath(settings, node.getAttribute('data-site-trust')));
  });

  document.querySelectorAll('[data-site-feature-list]').forEach((node) => {
    renderFeatureCards(node, getPath(settings, node.getAttribute('data-site-feature-list')));
  });

  document.querySelectorAll('[data-site-download-facts]').forEach((node) => {
    renderDownloadFacts(node, getPath(settings, node.getAttribute('data-site-download-facts')));
  });

  document.querySelectorAll('[data-site-faq-list]').forEach((node) => {
    renderFaqItems(node, getPath(settings, node.getAttribute('data-site-faq-list')));
  });
}

async function init() {
  try {
    const response = await api.siteSettings();
    applySettings(response?.data || response || {});
  } catch (err) {
    // Keep the static page copy.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
