import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const runtimeSource = readFileSync(new URL('../../frontend/app/assets/js/card-experience-runtime.mjs', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');

function extract(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Shipping source boundaries: ${start}`);
    return source.slice(first, last);
}

// This DOM is deliberately local and small. It executes the shipping class,
// its actual close/declarative click listeners, and the shipping bridge observer.
// It does not claim to validate browser geometry, focus order or pointer hits.
class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.attributes = new Map(); this.style = {}; this.dataset = {}; this.listeners = new Map();
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
            remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
        };
    }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get hidden() { return this.attributes.has('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get isConnected() { return this.connected === true || Boolean(this.parentNode?.isConnected); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of [...nodes].reverse()) { node.remove(); node.parentNode = this; this.children.unshift(node); } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) {
        return selector.split(',').some(part => {
            let term = part.trim();
            const not = [...term.matchAll(/:not\(([^)]+)\)/g)];
            if (not.some(match => this.matches(match[1]))) return false;
            term = term.replace(/:not\([^)]+\)/g, '');
            const attributes = [...term.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]/g)];
            if (attributes.some(([, name, value]) => !this.attributes.has(name) || (value !== undefined && this.getAttribute(name) !== value))) return false;
            term = term.replace(/\[[^\]]+\]/g, '');
            const id = term.match(/#([\w-]+)/)?.[1];
            if (id && this.id !== id) return false;
            if ([...term.matchAll(/\.([\w-]+)/g)].some(([, name]) => !this.classList.contains(name))) return false;
            const tag = term.match(/^[\w-]+/)?.[0];
            return !tag || this.tagName.toLowerCase() === tag;
        });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest?.(selector) || null; }
    querySelectorAll(selector) {
        const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return descendants.filter(node => selector.split(',').some(part => {
            const terms = part.trim().split(/\s+/);
            if (!node.matches(terms.pop())) return false;
            let ancestor = node.parentNode;
            for (const term of terms.reverse()) { while (ancestor && !ancestor.matches?.(term)) ancestor = ancestor.parentNode; if (!ancestor) return false; ancestor = ancestor.parentNode; }
            return true;
        }));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get innerHTML() { return this.html || ''; }
    set innerHTML(value) {
        this.html = String(value); this.replaceChildren();
        const stack = [this];
        for (const match of this.html.matchAll(/<\/?([\w-]+)([^>]*)>/g)) {
            if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
            const child = new Element(match[1]);
            for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) child.setAttribute(attr[1], attr[2] ?? '');
            stack.at(-1).append(child);
            if (!['img', 'input', 'br', 'hr', 'source', 'meta', 'link'].includes(match[1])) stack.push(child);
        }
    }
    attachShadow() {
        const shadow = new Element('shadow-root'); shadow.parentNode = this;
        this.shadowRoot = shadow; return shadow;
    }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
    dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); return !event.defaultPrevented; }
    click() { this.dispatchEvent({ type: 'click', target: this, currentTarget: this }); }
    focus() { this.focused = true; }
    getClientRects() { return this.hidden ? [] : [{}]; }
}

class HTMLDialogElement extends Element { constructor() { super('dialog'); this.open = false; } }

function runtimeHarness() {
    const body = new Element('body'); body.connected = true;
    const raf = [], timers = [], document = {
        body, createElement: tag => new Element(tag), getElementById: id => body.querySelector('#' + id),
        addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    };
    const normalizeCardExperience = input => ({ bgm: { enabled: false, loop: true, volume: 0.5 }, sidebars: [], ...input });
    const scope = vm.createContext({ document, window: { setTimeout: callback => timers.push(callback) },
        requestAnimationFrame: callback => raf.push(callback), clearTimeout() {}, clearInterval() {},
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        normalizeCardExperience, normalizeMediaAssets: () => [], normalizeLegacyRpHub: () => ({ bgm_playlist: [] }),
        BASE_STYLE: '', Audio: class { pause() {} removeAttribute() {} load() {} },
        sanitizeScopedCss: value => String(value || ''), sanitizeCardHtml: value => String(value || ''),
        template: value => String(value || ''), escapeText: value => String(value || ''),
    });
    vm.runInContext(extract(runtimeSource, 'class CardExperienceRuntime {', 'function escapeText(') + '\nthis.Runtime = CardExperienceRuntime;', scope);
    const runtime = new scope.Runtime();
    for (const method of ['renderSidebarTriggers', 'setupGalgame', 'loadAssetBundle', 'renderBgmPlayer', 'syncLiveElements', 'bindCardSearchFilter']) runtime[method] = () => {};
    const config = { sidebars: [{ enabled: true, id: 'panel-a', position: 'left', width: 280,
        name: 'Fixture panel', content_html: '<span>Fixture</span>', scoped_css: '' }] };
    const mount = () => { const host = new Element(); host.id = 'homerCardExperienceRoot'; body.append(host); runtime.mount({ card_experience: config }, host); return host; };
    const host = mount();
    return { runtime, host, body, mount, raf, timers,
        flushRaf() { for (const callback of raf.splice(0)) callback(); },
        popup() { runtime.openPopup({ scoped_css: '', template_html: '<span>Fixture popup</span>' }, {}); },
        active: () => runtime.host?.getAttribute('data-homer-overlay-active'),
    };
}

test('mount publishes closed state; floating/player visibility alone does not cover host chrome', () => {
    const h = runtimeHarness(); assert.equal(h.active(), 'false');
    h.runtime.shadow.querySelector('.ce-player').hidden = false;
    h.runtime.shadow.querySelector('.ce-floats').append(new Element());
    h.runtime.syncOverlayState(); assert.equal(h.active(), 'false');
});

test('actual popup close button and backdrop close publish false', () => {
    const h = runtimeHarness(); h.popup(); assert.equal(h.active(), 'true');
    h.runtime.shadow.querySelector('.ce-popup__close').click(); assert.equal(h.active(), 'false');
    h.popup(); h.runtime.shadow.querySelector('.ce-backdrop').click(); assert.equal(h.active(), 'false');
});

test('sidebar is active only after its actual rAF; actual close button restores host chrome', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a'); assert.equal(h.active(), 'false');
    h.flushRaf(); assert.equal(h.active(), 'true');
    h.runtime.shadow.querySelector('.ce-sidebar__close').click(); assert.equal(h.active(), 'false');
});

test('closing popup while sidebar remains open keeps host chrome hidden, then sidebar close restores it', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a'); h.flushRaf(); h.popup();
    h.runtime.closePopup(); assert.equal(h.active(), 'true');
    h.runtime.shadow.querySelector('.ce-sidebar__close').click(); assert.equal(h.active(), 'false');
});

test('closing sidebar while popup remains open keeps host chrome hidden', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a'); h.flushRaf(); h.popup();
    h.runtime.shadow.querySelector('.ce-sidebar__close').click(); assert.equal(h.active(), 'true');
    h.runtime.closePopup(); assert.equal(h.active(), 'false');
});

test('actual declarative sidebar close also publishes aggregate state', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a'); h.flushRaf();
    const panel = h.runtime.shadow.querySelector('.ce-sidebar');
    const control = new Element('button'); control.setAttribute('data-card-action', 'close-sidebar'); panel.append(control);
    panel.dispatchEvent({ type: 'click', target: control, currentTarget: panel });
    assert.equal(h.active(), 'false');
});

test('declarative sidebar close without an associated panel retains its previous no-op behavior', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a'); h.flushRaf(); h.popup();
    const content = h.runtime.shadow.querySelector('.ce-popup__content');
    const control = new Element('button'); control.setAttribute('data-card-action', 'close-sidebar'); content.append(control);
    content.dispatchEvent({ type: 'click', target: control, currentTarget: content });
    assert.equal(h.runtime.shadow.querySelectorAll('.ce-sidebar.is-open').length, 1); assert.equal(h.active(), 'true');
});

test('composer cancel and submit close aggregate state without bypassing existing input handlers', () => {
    const h = runtimeHarness(); h.runtime.openComposer(); assert.equal(h.active(), 'true');
    h.runtime.shadow.querySelector('[data-stage-action="cancel-input"]').click(); assert.equal(h.active(), 'false');
    h.runtime.openComposer(); const form = h.runtime.shadow.querySelector('.ce-composer');
    form.querySelector('textarea').value = 'Fixture typed'; let prevented = false;
    form.dispatchEvent({ type: 'submit', currentTarget: form, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(form.querySelector('textarea').value, ''); assert.equal(h.active(), 'false');
});

test('Back closes one visual top overlay at a time: composer, popup, sidebar, then false', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a'); h.flushRaf(); h.popup(); h.runtime.openComposer();
    assert.equal(h.runtime.closeTopOverlay(), true); assert.equal(h.runtime.shadow.querySelector('.ce-composer').hidden, true);
    assert.equal(h.runtime.shadow.querySelector('.ce-backdrop').classList.contains('is-open'), true); assert.equal(h.active(), 'true');
    assert.equal(h.runtime.closeTopOverlay(), true); assert.equal(h.runtime.shadow.querySelector('.ce-backdrop').classList.contains('is-open'), false);
    assert.equal(h.active(), 'true'); assert.equal(h.runtime.closeTopOverlay(), true); assert.equal(h.active(), 'false');
    assert.equal(h.runtime.closeTopOverlay(), false);
});

test('destroy clears the old light-DOM attribute before detach and cannot reopen it from a queued rAF', () => {
    const h = runtimeHarness(); h.popup(); h.runtime.openSidebar('panel-a');
    const oldPanel = h.runtime.shadow.querySelector('.ce-sidebar'); h.runtime.destroy();
    assert.equal(h.host.getAttribute('data-homer-overlay-active'), null); h.flushRaf();
    assert.equal(oldPanel.classList.contains('is-open'), false); assert.equal(h.host.getAttribute('data-homer-overlay-active'), null);
});

test('queued sidebar rAF and old close listener cannot modify a remounted target', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a');
    const oldClose = h.runtime.shadow.querySelector('.ce-sidebar__close');
    const nextHost = h.mount(); h.popup(); h.flushRaf(); oldClose.click();
    assert.equal(nextHost.getAttribute('data-homer-overlay-active'), 'true');
    assert.equal(h.runtime.shadow.querySelector('.ce-sidebar.is-open'), null);
    assert.equal(h.host.getAttribute('data-homer-overlay-active'), null);
});

test('queued sidebar rAF cannot activate retired content when the same host and shadow are reused', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a'); const oldPanel = h.runtime.shadow.querySelector('.ce-sidebar');
    h.runtime.mount({ card_experience: h.runtime.config }, h.host); h.flushRaf();
    assert.equal(oldPanel.classList.contains('is-open'), false); assert.equal(h.active(), 'false');
    h.host.remove(); assert.equal(h.runtime.closeTopOverlay(), false);
});

test('queued sidebar rAF cannot activate a replaced same-mount panel', () => {
    const h = runtimeHarness(); h.runtime.openSidebar('panel-a'); const oldPanel = h.runtime.shadow.querySelector('.ce-sidebar');
    h.runtime.openSidebar('panel-a'); h.flushRaf();
    assert.equal(oldPanel.classList.contains('is-open'), false);
    assert.equal(h.runtime.shadow.querySelectorAll('.ce-sidebar.is-open').length, 1); assert.equal(h.active(), 'true');
});

function bridgeHarness({ ready = true, initialActive = false } = {}) {
    const body = new Element('body'); body.connected = true;
    const root = new Element(); root.id = 'homerCardExperienceRoot'; body.append(root);
    root.setAttribute('data-homer-overlay-active', String(initialActive));
    const posts = [], microtasks = [], observers = [], listeners = new Map();
    const document = { body, querySelectorAll: selector => body.querySelectorAll(selector),
        addEventListener(name, callback) { listeners.set(name, callback); } };
    const scope = vm.createContext({ document, Element, HTMLDialogElement,
        launch: { app_id: 'fixture-card', conversation_id: 'fixture-chat', admin_preview: false },
        hostOverlayActive: false, hostOverlaySignature: '', hostOverlayObserver: null, hostOverlaySyncQueued: false, messageSelection: null,
        canNotifyHost: () => ready, notifyHost: (type, payload) => posts.push({ type, payload: JSON.parse(JSON.stringify(payload)) }),
        queueMicrotask: callback => microtasks.push(callback),
        MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target, options) { this.target = target; this.options = options; } },
    });
    vm.runInContext(extract(bridgeSource, 'const HOST_OVERLAY_SELECTOR =', 'function currentRoleName('), scope);
    scope.installHostOverlayTracking();
    return { root, body, scope, posts, observers, listeners,
        flush() { for (const callback of microtasks.splice(0)) callback(); },
        change(active) { root.setAttribute('data-homer-overlay-active', String(active)); observers[0].callback([{ type: 'attributes', target: root, attributeName: 'data-homer-overlay-active' }]); },
    };
}

test('bridge initial sync discovers an already-open stage and keeps existing scoped protocol', () => {
    const h = bridgeHarness({ initialActive: true });
    assert.deepEqual(h.posts.at(-1), { type: 'overlay-state', payload: { active: true, admin_preview: false, app_id: 'fixture-card', conversation_id: 'fixture-chat' } });
    assert.equal(h.observers.length, 1); h.scope.installHostOverlayTracking(); assert.equal(h.observers.length, 1);
});

test('bridge observes true and false transitions, coalesces, and does not treat merely mounted stage as open', () => {
    const h = bridgeHarness(); assert.equal(h.posts.at(-1).payload.active, false);
    assert.ok(Array.from(h.observers[0].options.attributeFilter).includes('data-homer-overlay-active'));
    h.change(true); h.change(true); h.flush(); assert.equal(h.posts.at(-1).payload.active, true);
    assert.equal(h.posts.length, 2); h.change(false); h.flush(); assert.equal(h.posts.at(-1).payload.active, false);
    assert.equal(h.posts.length, 3);
});

test('removing an active or already-cleared stage propagates the aggregate false state', () => {
    for (const clearFirst of [false, true]) {
        const h = bridgeHarness(); h.change(true); h.flush();
        assert.equal(h.posts.at(-1).payload.active, true);
        if (clearFirst) h.root.removeAttribute('data-homer-overlay-active');
        h.root.remove(); h.observers[0].callback([{ type: 'childList', addedNodes: [], removedNodes: [h.root] }]); h.flush();
        assert.equal(h.posts.at(-1).payload.active, false);
    }
});

test('stage closure does not hide remaining full dialog/selection state; anchored panels stay excluded', () => {
    const h = bridgeHarness(); const dialog = new HTMLDialogElement(); dialog.open = true; h.body.append(dialog);
    h.change(true); h.flush(); h.change(false); h.flush(); assert.equal(h.posts.at(-1).payload.active, true);
    dialog.open = false; h.scope.messageSelection = {}; h.scope.syncHostOverlayState(); assert.equal(h.posts.at(-1).payload.active, true);
    h.scope.messageSelection = null;
    const panel = new Element(); panel.id = 'homer-preset-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); h.body.append(panel);
    h.scope.syncHostOverlayState(); assert.equal(h.posts.at(-1).payload.active, false);
});

test('bridge does not emit outside embedding or without a conversation; late jobs use the current scope', () => {
    const outside = bridgeHarness({ ready: false }); outside.change(true); outside.flush(); assert.equal(outside.posts.length, 0);
    const h = bridgeHarness(); h.change(true); h.scope.launch = { app_id: 'next-card', conversation_id: 'next-chat', admin_preview: true }; h.flush();
    assert.equal(h.posts.at(-1).payload.app_id, 'next-card'); assert.equal(h.posts.at(-1).payload.conversation_id, 'next-chat'); assert.equal(h.posts.at(-1).payload.admin_preview, true);
    h.scope.launch.conversation_id = ''; const count = h.posts.length; h.change(false); h.flush(); assert.equal(h.posts.length, count);
});
