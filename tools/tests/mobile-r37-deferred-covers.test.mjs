import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeferredListCovers } from '../../.web-cache/tree/frontend/assets/js/deferred-list-covers.mjs';

function environment({ io = true, separateRoot = false } = {}) {
  const writes = [], observers = [], timers = new Map(), rows = new Set();
  let opened = false, nextTimer = 0;
  const events = () => ({ handlers: new Map(), addEventListener(k, f) { this.handlers.set(k, f); },
    removeEventListener(k, f) { if (this.handlers.get(k) === f) this.handlers.delete(k); } });
  const view = { ...events(), innerWidth: 390, innerHeight: 844,
    setTimeout(f) { timers.set(++nextTimer, f); return nextTimer; }, clearTimeout(id) { timers.delete(id); } };
  if (io) view.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.nodes = new Set(); observers.push(this); }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); this.disconnected = true; }
    emit(...nodes) { this.callback(nodes.map(target => ({ target, isIntersecting: true }))); }
  };
  const document = { defaultView: view };
  const list = { ...events(), isConnected: true, ownerDocument: document,
    contains(node) { return node === this || rows.has(node); },
    getBoundingClientRect() { return { left: 0, right: 320, top: 100, bottom: 700 }; } };
  const root = separateRoot ? { ...events(), isConnected: true, ownerDocument: document,
    getBoundingClientRect: list.getBoundingClientRect } : list;
  const loader = createDeferredListCovers({ list, scrollRoot: root, isOpen: () => opened,
    setCover: (node, url) => writes.push({ node, url }) });
  const node = (top = 110, connected = true) => {
    const value = { isConnected: connected, getBoundingClientRect() {
      return { left: 15, right: 57, top, bottom: top + 42, width: 42, height: 42 };
    } };
    rows.add(value); return value;
  };
  return { loader, writes, observers, timers, rows, list, root, view, node,
    open() { opened = true; loader.open(); }, close() { opened = false; loader.close(); },
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(f => f()); } };
}

test('600 closed rows register without image writes or observer creation', () => {
  const e = environment(), nodes = Array.from({ length: 600 }, (_, i) => e.node(i * 70));
  nodes.forEach((node, i) => e.loader.set(node, `cover-${i}.png`)); e.loader.retain(nodes);
  assert.equal(e.writes.length, 0); assert.equal(e.observers.length, 0);
});

test('only intersecting covers load and use actual scroll root', () => {
  const e = environment({ separateRoot: true }), a = e.node(), b = e.node(6000);
  e.loader.set(a, 'a.png'); e.loader.set(b, 'b.png'); e.loader.retain([a, b]); e.open();
  const observer = e.observers[0];
  assert.equal(observer.options.root, e.root); assert.equal(observer.options.rootMargin, '100px 0px');
  observer.emit(a); observer.emit(a);
  assert.deepEqual(e.writes.map(x => x.url), ['a.png']); assert.ok(observer.nodes.has(b));
  e.close(); e.open(); e.observers[1].emit(a, b);
  assert.deepEqual(e.writes.map(x => x.url), ['a.png', 'b.png']);
});

test('closed and obsolete observer callbacks never request images, including after reopen', () => {
  const e = environment(), a = e.node(); e.loader.set(a, 'a.png'); e.open(); const old = e.observers[0];
  e.close(); old.emit(a); e.open(); old.emit(a); assert.equal(e.writes.length, 0);
  e.observers[1].emit(a); assert.equal(e.writes.length, 1);
});

test('queued callbacks read newest URL, changed loaded cover is cleared but not loaded while closed', () => {
  const e = environment(), a = e.node(); e.loader.set(a, 'old.png'); e.open();
  e.loader.set(a, 'new.png'); e.loader.retain([a]); e.observers[0].emit(a);
  assert.deepEqual(e.writes.map(x => x.url), ['new.png']);
  e.close(); e.loader.set(a, 'later.png'); e.loader.set(a, 'later.png');
  assert.deepEqual(e.writes.map(x => x.url), ['new.png', '']);
  e.open(); e.observers[1].emit(a); e.loader.set(a, ''); e.observers[1].emit(a);
  assert.deepEqual(e.writes.map(x => x.url), ['new.png', '', 'later.png', '']);
});

test('removed/detached rows are ignored, duplicate IDs and URLs retain independent nodes', () => {
  const e = environment(), a = e.node(), b = e.node(); a.id = b.id = 'duplicate';
  e.loader.set(a, 'same.png'); e.loader.set(b, 'same.png'); e.open(); const observer = e.observers[0];
  e.loader.retain([b]); observer.emit(a, b); assert.equal(e.writes.length, 1); assert.equal(e.writes[0].node, b);
  e.loader.set(a, 'detached.png'); a.isConnected = false; e.loader.retain([a, b]); observer.emit(a);
  assert.equal(e.writes.length, 1);
});

test('dispose disconnects old root, callbacks, timers and listeners without clearing loaded covers', () => {
  const e = environment(), a = e.node(), b = e.node(); e.loader.set(a, 'a.png'); e.loader.set(b, 'b.png'); e.open();
  const observer = e.observers[0]; observer.emit(a); e.loader.dispose(); e.loader.dispose(); observer.emit(b);
  e.loader.set(b, 'other.png'); e.loader.retain([b]); e.open();
  assert.equal(e.writes.length, 1); assert.ok(observer.disconnected);
  assert.equal(e.root.handlers.size, 0); assert.equal(e.view.handlers.size, 0); assert.equal(e.timers.size, 0);
});

test('fallback loads bounded geometry only, then scroll/resize brings new rows into view', () => {
  const e = environment({ io: false, separateRoot: true }), a = e.node(120), b = e.node(4000);
  e.loader.set(a, 'a.png'); e.loader.set(b, 'b.png'); e.loader.retain([a, b]); e.open();
  assert.deepEqual(e.writes.map(x => x.url), ['a.png']);
  b.getBoundingClientRect = a.getBoundingClientRect; e.root.handlers.get('scroll')();
  assert.deepEqual(e.writes.map(x => x.url), ['a.png', 'b.png']);
  e.close(); assert.equal(e.timers.size, 0); e.tick(); assert.equal(e.writes.length, 2);
});

test('fallback rejects offscreen root and rechecks one opening transition without whole-list eager fallback', () => {
  const e = environment({ io: false }), a = e.node(), b = e.node(5000);
  e.loader.set(a, 'a.png'); e.loader.set(b, 'b.png');
  e.list.getBoundingClientRect = () => ({ left: -340, right: -20, top: 100, bottom: 700 }); e.open();
  assert.equal(e.writes.length, 0); assert.equal(e.timers.size, 1);
  e.list.getBoundingClientRect = () => ({ left: 0, right: 320, top: 100, bottom: 700 }); e.tick();
  assert.deepEqual(e.writes.map(x => x.url), ['a.png']); assert.equal(e.timers.size, 0);
});

test('rows may register before append; disconnected list cannot load', () => {
  const e = environment(), a = e.node(120, false); e.rows.delete(a);
  e.loader.set(a, 'a.png'); e.open(); assert.equal(e.observers[0].nodes.size, 0);
  a.isConnected = true; e.rows.add(a); e.loader.retain([a]); e.list.isConnected = false; e.observers[0].emit(a);
  assert.equal(e.writes.length, 0); e.list.isConnected = true; e.observers[0].emit(a); assert.equal(e.writes.length, 1);
});

test('invalid constructor and setter failures remain visible instead of silently faking a loaded cover', () => {
  assert.throws(() => createDeferredListCovers({}), TypeError);
  const e = environment(), a = e.node();
  const loader = createDeferredListCovers({ list: e.list, isOpen: () => true, setCover() { throw Error('setter failed'); } });
  loader.set(a, 'a.png'); loader.open(); assert.throws(() => e.observers[0].emit(a), /setter failed/); loader.dispose();
});
