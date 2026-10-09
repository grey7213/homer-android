import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTimelineBuilder, anchorFor, resolveAnchor } from '../../frontend/app/assets/js/visual-novel-core.mjs';

const source = readFileSync(new URL('../../frontend/app/assets/js/visual-novel-runtime.mjs', import.meta.url), 'utf8');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };

// Shipping reader methods in a minimal synthetic DOM, not a visual/browser test.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attributes = new Map(); this.listeners = new Map();
    this.hidden = false; this.disabled = false; this._text = ''; this._classes = new Set(); this.style = { setProperty() {} };
    this.classList = { add: (...items) => items.forEach(item => this._classes.add(item)),
      remove: (...items) => items.forEach(item => this._classes.delete(item)), contains: item => this._classes.has(item),
      toggle: (item, force) => { const next = force ?? !this._classes.has(item); next ? this._classes.add(item) : this._classes.delete(item); return next; } };
  }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  get isConnected() { return this.tagName === 'BODY' || this.parent?.isConnected === true; }
  append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { for (const item of this.children) item.parent = null; this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
  attachShadow() { const shadow = new Element('shadow'); shadow.parent = this; shadow.activeElement = null; return shadow; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(name, handler) { const values = this.listeners.get(name) || []; values.push(handler); this.listeners.set(name, values); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(value => value !== handler)); }
  focus() {}
  matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName.toLowerCase() === selector.toLowerCase(); }
  querySelectorAll(selector) { const parts = selector.split(','), found = [];
    const visit = item => { for (const child of item.children) { if (parts.some(part => child.matches(part))) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture({ messages = [{ id: 'm1', name: 'Synthetic', mes: 'First paragraph.\n\nSecond paragraph.' }], actions = {}, loadGate = null, spineGate = null,
  assetGate = null, voiceGate = null, saveGate = null, hostVisible = true, isCurrent = () => true } = {}) {
  const calls = { saves: [], close: 0, speak: 0, audio: [], cacheResolves: [], releases: [], cancelFrames: 0 }, frames = new Map(), timers = new Map();
  let sequence = 0;
  const document = new Element('document'); document.body = new Element('body'); document.hidden = false;
  document.createElement = tag => new Element(tag); document.createElementNS = (ns, tag) => { const item = new Element(tag); item.namespaceURI = ns; return item; };
  const root = new Element('div'); document.body.append(root);
  const store = { async load() { return loadGate ? loadGate.promise : null; }, async save(scope, state) { calls.saves.push(state); if (saveGate) await saveGate.promise; }, close() { calls.close++; },
    async listSaves() { return []; } };
  const window = new Element('window');
  const sandbox = { document, window, location: { href: 'https://synthetic.invalid/reader', origin: 'https://synthetic.invalid' }, URL,
    performance: { now: () => 0 }, AbortController, console,
    createTimelineBuilder, anchorFor, resolveAnchor, createPresentationStore: () => store, createVisualNovelServices: () => ({}),
    createVisualNovelAssetCache: () => ({ async resolve(asset) { calls.cacheResolves.push(asset); if (assetGate) await assetGate.promise; return { url: asset.url }; },
      release(url) { calls.releases.push(url); }, destroy() {} }),
    async loadSpineModule() { return { SpinePortraitLayer: class { async show() { if (spineGate) await spineGate.promise; } dispose() {} } }; },
    requestAnimationFrame: callback => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => { calls.cancelFrames++; frames.delete(id); },
    setTimeout: callback => { const id = ++sequence; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    Audio: class { constructor(url) { this.url = url; this.paused = true; this.plays = 0; calls.audio.push(this); }
      async play() { this.plays++; this.paused = false; } pause() { this.paused = true; }
      getAttribute(name) { return name === 'src' ? this.url : null; } removeAttribute(name) { if (name === 'src') this.url = ''; } load() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    .replace("import('./spine-portrait.mjs')", 'loadSpineModule()') + '\nglobalThis.Reader = VisualNovelReader;', sandbox);
  const reader = new sandbox.Reader({ root, scope: { owner: 'synthetic-owner', appId: 'synthetic-card', conversationId: 'synthetic-story' }, messages, actions, hostVisible, isCurrent,
    services: { async speak() { calls.speak++; if (voiceGate) await voiceGate.promise; return { url: 'https://synthetic.invalid/audio.wav' }; } } });
  return { reader, calls, frames, timers, store, document, root,
    finishFrames() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(100000); } } };
}

test('initial presentation restore never overrides a user reading interaction completed during its await', async () => {
  const gate = defer(), h = fixture({ loadGate: gate });
  const restoring = h.reader.restore();
  h.reader.settings.typewriter = false; h.reader.show({ instant: true }); h.reader.advance();
  assert.equal(h.reader.index, 1);
  gate.resolve({ cursor: anchorFor(h.reader.timeline[0]), settings: { fontSize: 24 } }); await restoring;
  assert.equal(h.reader.index, 1);
  assert.equal(h.reader.settings.fontSize, 18);
  h.reader.destroy();
});

test('the visible stop action remains usable while continue is awaiting actual generation', async () => {
  const gate = defer(), operations = [], h = fixture({ actions: { continue: () => { operations.push('continue'); return gate.promise; }, stop: async () => operations.push('stop') } });
  const generating = h.reader.run('continue'); h.reader.setBusy(true);
  await h.reader.run('stop'); gate.resolve(); await generating;
  h.reader.destroy();
  assert.deepEqual(operations, ['continue', 'stop']);
});

test('a refused host submit is not reported as an accepted operation', async () => {
  const h = fixture({ actions: { submit: async () => false } });
  try { await assert.rejects(h.reader.run('submit', 'Synthetic refused draft')); } finally { h.reader.destroy(); }
});

test('game request rejection preserves its actionable explanation instead of a generic network error', async () => {
  const h = fixture(); h.reader.gameId = 'synthetic-game';
  h.reader.actions.submit = async () => {
    h.reader.notice('当前预设无法隔离游戏上下文，本次请求已阻止。', true);
    throw Object.assign(new Error('Synthetic guard rejected'), { code: 'VN_GAME_PROMPT' });
  };
  await assert.rejects(h.reader.run('submit', 'Synthetic input'), /VN_ACTION_FAILED/);
  assert.match(h.reader.status.textContent, /本次请求已阻止/);
  assert.doesNotMatch(h.reader.status.textContent, /联网状态/);
  h.reader.destroy();
});

test('ordinary request failure keeps existing generic error feedback', async () => {
  const h = fixture({ actions: { submit: async () => { throw Object.assign(new Error('Synthetic error'), { code: 'ANY_CODE' }); } } });
  await assert.rejects(h.reader.run('submit', 'Synthetic input'), /VN_ACTION_FAILED/);
  assert.match(h.reader.status.textContent, /联网状态或模型/);
  h.reader.destroy();
});

test('identical stream updates do not restart text reveal or a playing scene', async () => {
  const h = fixture(); h.reader.revealed = 5;
  const animation = h.reader.animation, mediaEpoch = h.reader.mediaEpoch;
  h.reader.update([{ id: 'm1', name: 'Synthetic', mes: 'First paragraph.\n\nSecond paragraph.' }]);
  assert.equal(h.reader.revealed, 5);
  assert.equal(h.reader.animation, animation);
  assert.equal(h.reader.mediaEpoch, mediaEpoch);
  h.reader.destroy();
});

test('an earlier canonical edit refreshes private chat even when the currently-read and last messages are unchanged', () => {
  const messages = [{ id: 'm1', mes: 'Original early message' }, { id: 'm2', mes: 'Unchanged latest message' }];
  const h = fixture({ messages }); h.reader.setView('talk');
  h.reader.update([{ ...messages[0], mes: 'Edited early message' }, messages[1]]);
  const text = h.reader.thread.textContent; h.reader.destroy();
  assert.match(text, /Edited early message/);
  assert.doesNotMatch(text, /Original early message/);
});

test('private-chat history provides the complete older text or an explicit older-page control', () => {
  const h = fixture({ messages: Array.from({ length: 90 }, (_, index) => ({ id: `m${index}`, mes: `Synthetic private message ${index}.` })) });
  h.reader.setView('talk');
  const text = h.reader.thread.textContent, older = h.reader.thread.querySelectorAll('button').some(node => /更早|较早|earlier/i.test(node.textContent));
  h.reader.destroy();
  assert.ok(text.includes('Synthetic private message 0.') || older, 'All earlier private chat must remain reachable, not disappear at -80');
});

test('new host messages do not jump a user who is replaying an older paragraph', () => {
  const messages = [{ id: 'm1', mes: 'Old remembered paragraph' }, { id: 'm2', mes: 'Latest paragraph' }];
  const h = fixture({ messages }); h.reader.index = 0; h.reader.show({ instant: true });
  h.reader.update([...messages, { id: 'm3', mes: 'New canonical paragraph' }]);
  const index = h.reader.index; h.reader.destroy();
  assert.equal(index, 0);
});

test('switching to private chat cancels hidden-stage typewriter and voice activity', async () => {
  const h = fixture(); h.reader.settings.voice = true; h.reader.settings.muted = false;
  h.reader.show(); h.reader.setView('talk'); h.finishFrames(); await tick();
  const requests = h.calls.speak; h.reader.destroy();
  assert.equal(requests, 0);
});

test('private chat keeps unmute settings from loading a hidden scene or starting its music', async () => {
  const h = fixture(); await tick(); h.reader.setView('talk');
  h.reader.card = { card_experience: { bgm: { default_asset_id: 'music' }, stage: { background_asset_id: 'room' } },
    media_assets: [{ id: 'music', kind: 'bgm', url: 'https://synthetic.invalid/bgm.wav' },
      { id: 'room', kind: 'background', url: 'https://synthetic.invalid/room.png' }] };
  h.reader.readerSettings();
  const mute = h.reader.panel.body.querySelectorAll('label').find(node => node.textContent === '静音').querySelector('input');
  mute.checked = false; mute.listeners.get('change')[0]({ target: mute }); await tick();
  const count = h.calls.cacheResolves.length, audio = h.calls.audio.length; h.reader.destroy();
  assert.equal(count, 0, 'Private chat settings must not fetch hidden stage media'); assert.equal(audio, 0);
});

test('switching from an audible stage to private chat pauses the existing background music', async () => {
  const h = fixture(); await tick();
  h.reader.card = { media_assets: [{ id: 'music', kind: 'bgm', url: 'https://synthetic.invalid/bgm.wav' }] };
  h.reader.settings.muted = false; await h.reader.applyScene({ bgm: 'music' });
  assert.equal(h.calls.audio.length, 1); assert.equal(h.calls.audio[0].paused, false);
  h.reader.setView('talk'); assert.equal(h.calls.audio[0].paused, true); h.reader.destroy();
});

test('replacing an open panel does not restart voice behind the next panel', async () => {
  const h = fixture(); h.reader.settings.voice = true; h.reader.settings.muted = false;
  h.reader.openPanel('First panel'); h.reader.openPanel('Second panel'); await tick();
  const requests = h.calls.speak; h.reader.destroy();
  assert.equal(requests, 0);
});

test('reading before initial storage load and then leaving retains the user position', async () => {
  const gate = defer(), h = fixture({ loadGate: gate });
  const restoring = h.reader.restore(); h.reader.settings.typewriter = false;
  h.reader.show({ instant: true }); h.reader.advance(); const expected = anchorFor(h.reader.timeline[1]);
  h.reader.destroy(); gate.resolve(null); await restoring; await h.reader.saveQueue;
  assert.ok(h.calls.saves.some(state => state.cursor?.segmentIndex === expected.segmentIndex), 'Pending initialization must not discard a captured user reading position on leave');
});

test('destroy cancels scheduled auto paging and service activity without invoking generation', async () => {
  const operations = [], h = fixture({ actions: { continue: async () => operations.push('continue') } });
  h.reader.settings.typewriter = false; h.reader.show({ instant: true }); h.reader.toggleAuto();
  assert.ok(h.timers.size > 0); h.reader.destroy();
  for (const callback of h.timers.values()) callback(); await tick();
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0); assert.deepEqual(operations, []);
});

test('late Spine scene completion cannot create new music after the reader has been destroyed', async () => {
  const gate = defer(), h = fixture({ spineGate: gate });
  h.reader.card = { media_assets: [{ id: 'spine', kind: 'spine', url: 'https://synthetic.invalid/spine.png' },
    { id: 'music', kind: 'bgm', url: 'https://synthetic.invalid/bgm.wav' }] };
  h.reader.settings.muted = false;
  const painting = h.reader.applyScene({ portrait: 'spine', bgm: 'music' });
  await tick(); h.reader.destroy(); gate.resolve(); await painting;
  assert.equal(h.calls.audio.length, 0, 'A retired scene may not restart audio after its Spine await');
});

test('closed story panel ignores a cancelled pending restore without moving a later user reading position', async () => {
  const gate = defer(), requests = [], h = fixture({ actions: { listStories: async () => [{ id: 'synthetic-save', name: 'Saved plot', messageCount: 1, createdAt: 1 }],
    loadStory: id => { requests.push(id); return gate.promise; } } });
  await h.reader.restore(); await h.reader.storySaves();
  const panel = h.reader.panel, restore = panel.body.querySelectorAll('button').find(node => node.textContent === '恢复');
  restore.listeners.get('click')[0]({ target: restore }); await tick();
  assert.equal(h.reader.storyPending, true);
  h.reader.closeTopOverlay(); h.reader.advance(); const index = h.reader.index;
  gate.resolve(false); await tick();
  assert.equal(h.reader.storyPending, false); assert.equal(h.reader.panel, null);
  assert.equal(h.reader.index, index); assert.deepEqual(requests, ['synthetic-save']);
  h.reader.destroy();
});

test('a captured reading position queued after initialization survives immediate reader exit', async () => {
  const h = fixture(); await h.reader.restore(); h.reader.settings.typewriter = false;
  h.reader.show({ instant: true }); h.reader.advance(); const target = anchorFor(h.reader.timeline[h.reader.index]);
  h.reader.destroy(); await h.reader.saveQueue; await tick();
  assert.equal(h.calls.saves.at(-1).cursor.segmentIndex, target.segmentIndex);
  assert.equal(h.calls.close, 1);
});

test('backlog pagination reaches the first complete canonical paragraph without generating or deleting anything', async () => {
  const operations = [], h = fixture({ messages: Array.from({ length: 110 }, (_, index) => ({ id: `m${index}`, mes: `Full backlog paragraph ${index}.` })),
    actions: { continue: async () => operations.push('continue'), submit: async () => operations.push('submit') } });
  h.reader.backlog(); const list = h.reader.panel.body.querySelector('.backlog');
  const older = list.querySelectorAll('button').find(node => node.textContent === '查看更早的剧情');
  older.listeners.get('click')[0]({ target: older });
  assert.ok(list.textContent.includes('Full backlog paragraph 0.'));
  assert.equal(h.reader.messageInput.length, 110); assert.deepEqual(operations, []);
  h.reader.destroy();
});

test('native hidden pauses auto, RAF and music while visible preserves text without restarting audio or generation', async () => {
  const operations = [], h = fixture({ actions: { continue: async () => operations.push('continue') } });
  await h.reader.restore(); await tick();
  h.reader.settings.typewriter = false; h.reader.settings.muted = false; h.reader.show({ instant: true }); h.reader.toggleAuto();
  h.reader.card = { media_assets: [{ id: 'music', kind: 'bgm', url: 'https://synthetic.invalid/bgm.wav' }] };
  await h.reader.applyScene({ bgm: 'music' });
  assert.ok(h.timers.size > 0);
  h.reader.setHostVisible(false); assert.equal(h.timers.size, 0); h.reader.setHostVisible(true);
  h.reader.settings.typewriter = true; h.reader.show();
  assert.ok(h.frames.size > 0);
  const index = h.reader.index, text = h.reader.passage.textContent, audio = h.calls.audio[0], plays = audio.plays;
  assert.equal(h.reader.setHostVisible(false), true);
  assert.equal(h.reader.current(), true, 'Backgrounding is not a canonical scope invalidation');
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0); assert.equal(audio.paused, true);
  assert.equal(h.reader.sceneAbort.signal.aborted, true); assert.equal(h.reader.settings.autoAdvance, false);
  h.reader.setHostVisible(true); h.finishFrames(); await tick();
  assert.equal(h.reader.index, index); assert.equal(h.reader.passage.textContent, text);
  assert.equal(audio.plays, plays); assert.equal(audio.paused, true); assert.deepEqual(operations, []);
  h.reader.destroy();
});

test('initially hidden lazy reader loads saved preferences without fetching scenes, speaking or scheduling RAF', async () => {
  const gate = defer(), h = fixture({ hostVisible: false, loadGate: gate });
  h.reader.card = { card_experience: { stage: { background_asset_id: 'room' } },
    media_assets: [{ id: 'room', kind: 'background', url: 'https://synthetic.invalid/room.png' }] };
  const restoring = h.reader.restore(); gate.resolve({ settings: { muted: false, voice: true, autoAdvance: true } });
  await restoring; await tick();
  assert.equal(h.reader.current(), true); assert.equal(h.calls.cacheResolves.length, 0);
  assert.equal(h.calls.speak, 0); assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  h.reader.setHostVisible(true); await tick();
  assert.equal(h.calls.cacheResolves.length, 0); assert.equal(h.calls.speak, 0); assert.equal(h.frames.size, 0);
  h.reader.destroy();
});

test('late scene download after hidden then visible cannot paint or play, while an explicit later user scene request retries', async () => {
  const gate = defer(), h = fixture({ assetGate: gate }); await tick();
  h.reader.card = { card_experience: { stage: { background_asset_id: 'room' }, bgm: { default_asset_id: 'music' } },
    media_assets: [{ id: 'room', kind: 'background', url: 'https://synthetic.invalid/room.png' },
    { id: 'music', kind: 'bgm', url: 'https://synthetic.invalid/bgm.wav' }] };
  h.reader.settings.muted = false; const cues = { background: 'room', bgm: 'music' };
  const painting = h.reader.applyScene(cues); assert.equal(h.calls.cacheResolves.length, 2);
  h.reader.setHostVisible(false); h.reader.setHostVisible(true); gate.resolve(); await painting;
  assert.equal(h.calls.audio.length, 0); assert.equal(h.reader.background.hidden, true); assert.equal(h.calls.releases.length, 2);
  h.reader.settings.typewriter = false; h.reader.revealed = h.reader.chars.length; h.reader.advance(); await tick();
  assert.equal(h.calls.cacheResolves.length, 4, 'Suspension must clear the scene signature so a user request can retry');
  assert.equal(h.reader.background.hidden, false); assert.equal(h.calls.audio.length, 1); assert.equal(h.calls.audio[0].plays, 1);
  h.reader.destroy();
});

test('late Spine await after native hidden cannot create music even if visible again before it resolves', async () => {
  const gate = defer(), h = fixture({ spineGate: gate }); await tick();
  h.reader.card = { media_assets: [{ id: 'spine', kind: 'spine', url: 'https://synthetic.invalid/spine.png' },
    { id: 'music', kind: 'bgm', url: 'https://synthetic.invalid/bgm.wav' }] };
  h.reader.settings.muted = false;
  const painting = h.reader.applyScene({ portrait: 'spine', bgm: 'music' });
  await tick(); h.reader.setHostVisible(false); h.reader.setHostVisible(true); gate.resolve(); await painting;
  assert.equal(h.calls.audio.length, 0); assert.equal(h.reader.spine, null); h.reader.destroy();
});

test('late voice result after hidden then visible cannot restart audio or retry its service call', async () => {
  const gate = defer(), h = fixture({ voiceGate: gate }); h.reader.settings.muted = false;
  const speaking = h.reader.speak(); assert.equal(h.calls.speak, 1);
  h.reader.setHostVisible(false); const aborted = h.reader.serviceAbort.signal.aborted;
  h.reader.setHostVisible(true); gate.resolve(); await speaking;
  assert.equal(aborted, true); assert.equal(h.calls.audio.length, 0); assert.equal(h.calls.speak, 1); h.reader.destroy();
});

test('hidden does not cancel an already queued local reading-position save', async () => {
  const gate = defer(), h = fixture({ saveGate: gate }); await h.reader.restore();
  h.reader.settings.typewriter = false; h.reader.show({ instant: true }); h.reader.advance();
  const expected = anchorFor(h.reader.timeline[h.reader.index]); h.reader.setHostVisible(false);
  gate.resolve(); await h.reader.saveQueue;
  assert.equal(h.calls.saves.at(-1).cursor.segmentIndex, expected.segmentIndex);
  assert.equal(h.reader.current(), true); h.reader.destroy();
});

test('a pending complete story action can finish its local save while the native page is hidden', async () => {
  const gate = defer(), saves = [], h = fixture({ actions: { listStories: async () => [], saveStory: async value => {
    saves.push(value); await gate.promise; return { id: 'saved-full-story' }; } } });
  await h.reader.restore(); await h.reader.storySaves();
  h.reader.panel.body.querySelector('input').value = 'Synthetic full story';
  const save = h.reader.panel.body.querySelectorAll('button').find(node => node.textContent === '保存完整剧情');
  save.listeners.get('click')[0]({ target: save }); await tick(); assert.equal(h.reader.storyPending, true);
  h.reader.setHostVisible(false); gate.resolve(); await tick();
  assert.equal(h.reader.current(), true); assert.equal(h.reader.storyPending, false); assert.equal(saves.length, 1);
  assert.equal(saves[0].name, 'Synthetic full story'); h.reader.destroy();
});

test('internal native visibility event accepts only a still-current captured guard and never reactivates a stale owner', () => {
  let ownerCurrent = true; const h = fixture({ isCurrent: () => ownerCurrent });
  const dispatch = (visible, guard = () => true) => { for (const listener of h.document.listeners.get('homer-presentation-visibility') || [])
    listener({ detail: { visible, isCurrent: guard } }); };
  dispatch(false, () => false); assert.equal(h.reader.hostVisible, true);
  dispatch(false); assert.equal(h.reader.hostVisible, false);
  ownerCurrent = false; dispatch(true); assert.equal(h.reader.hostVisible, false);
  assert.equal(h.reader.setHostVisible('true'), false); h.reader.destroy();
});
